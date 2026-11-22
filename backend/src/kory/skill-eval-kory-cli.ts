import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, lstatSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { SkillEvalExecutor } from './skill-eval-execution';
import type { SkillInfrastructureFailure } from './skill-evaluations';

/**
 * Koryphaios' own CLI as the evaluation subject.
 *
 * `scripts/kory-cli.ts run` creates a chat in the running backend, sends one agent
 * turn, and follows it to completion. Unlike the OpenCode adapter, the process that
 * does the work is the backend, not the CLI: the CLI is an HTTP client, so wrapping it
 * in `sandbox-exec` would confine nothing. The turn runs inside the session workspace
 * named by `--cwd`, which is the pair's private directory.
 *
 * That difference is recorded rather than hidden: the runtime identity says the
 * subject is the Kory backend, and every evidence line names the CLI, the model and
 * the reasoning level that produced the turn. Nothing about this adapter can make a
 * turn look sandboxed when it is not.
 */

const BACKEND = `http://${process.env.KORYPHAIOS_HOST?.trim() || '127.0.0.1'}:${process.env.KORYPHAIOS_PORT?.trim() || '3001'}`;
const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  '.cache',
  '.turbo',
  '.svelte-kit',
]);

export const KORY_CLI_AGENTIC_MODE = 'kory-cli-agentic';
export const KORY_CLI_DEFAULT_MODEL = 'logfare/deepseek-v4.1-flash-1017';
/** The operator's stated fallback when the primary provider is down. */
export const KORY_CLI_FALLBACK_MODEL = 'logfare/glm-5.3-flash';

/**
 * The operator's ordering for a subject that has to keep working when a provider is out:
 * deepseek on logfare, the cheaper logfare model next, and vyceai's GLM flash when logfare
 * itself is unavailable. Only a provider the backend has actually verified for this account
 * is eligible, so an exhausted budget or an unconfigured key is a subject failure rather
 * than a scored candidate answer.
 */
export const KORY_CLI_FALLBACK_CHAIN = [
  'logfare/deepseek-v4.1-flash-1017',
  'logfare/glm-5.3-flash',
  'vyceai/glm-5.3-flash',
] as const;

export interface KoryCliAgenticOptions {
  model?: string;
  reasoning?: string;
  wallClockMs?: number;
  runnerPath?: string;
  backendBaseUrl?: string;
}

type Fingerprint = { size: number; mtimeMs: number };

function fingerprintWorkspace(root: string): Map<string, Fingerprint> {
  const files = new Map<string, Fingerprint>();
  const walk = (directory: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return;
    }
    for (const name of entries) {
      if (SKIPPED_DIRECTORIES.has(name)) continue;
      const path = join(directory, name);
      let stat;
      try {
        stat = lstatSync(path);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        walk(path);
        continue;
      }
      if (!stat.isFile()) continue;
      files.set(path.slice(root.length + 1), { size: stat.size, mtimeMs: stat.mtimeMs });
    }
  };
  walk(root);
  return files;
}

function changedPaths(before: Map<string, Fingerprint>, after: Map<string, Fingerprint>): string[] {
  const changed: string[] = [];
  for (const [path, stat] of after) {
    const previous = before.get(path);
    if (!previous || previous.size !== stat.size || previous.mtimeMs !== stat.mtimeMs)
      changed.push(path);
  }
  for (const path of before.keys()) if (!after.has(path)) changed.push(`${path} (deleted)`);
  return changed.sort();
}

async function backendHealthy(base: string): Promise<boolean> {
  try {
    const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2_500) });
    if (!response.ok) return false;
    const body = (await response.json()) as { ok?: boolean };
    return body.ok !== false;
  } catch {
    return false;
  }
}

interface UsableProvider {
  name: string;
  model: string;
}

/**
 * Reads the backend's own provider status. A model is only usable when its provider is
 * authenticated, verified and publishing that exact model, which is the same bar the
 * manager's `resolveProvider` applies before it accepts a turn.
 */
async function usableProviderFor(base: string, model: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const separator = model.indexOf('/');
  if (separator <= 0) return { ok: false, reason: `${model} is not a provider/model id` };
  const provider = model.slice(0, separator);
  const modelId = model.slice(separator + 1);
  try {
    const tokenResponse = await fetch(`${base}/api/auth/session`, { method: 'POST' });
    if (!tokenResponse.ok) return { ok: false, reason: `backend refused a local session token (${tokenResponse.status})` };
    const tokenPayload = (await tokenResponse.json()) as { data?: { bearerToken?: string }; bearerToken?: string };
    const bearer = tokenPayload.data?.bearerToken ?? tokenPayload.bearerToken;
    if (!bearer) return { ok: false, reason: 'backend returned no local session token' };
    const response = await fetch(`${base}/api/providers`, { headers: { authorization: bearer } });
    if (!response.ok) return { ok: false, reason: `provider status request failed (${response.status})` };
    const payload = (await response.json()) as { data?: unknown };
    const rows = Array.isArray(payload.data) ? (payload.data as Array<Record<string, unknown>>) : [];
    const row = rows.find((item) => item?.name === provider);
    if (!row) return { ok: false, reason: `provider ${provider} is not configured on this backend` };
    if (row.authenticated !== true) return { ok: false, reason: `provider ${provider} has no verified credential` };
    if (row.connectionState !== 'verified') {
      return { ok: false, reason: `provider ${provider} is ${String(row.connectionState ?? 'unknown')}, not verified` };
    }
    const models = Array.isArray(row.models) ? (row.models as string[]) : [];
    if (models.length > 0 && !models.includes(modelId)) {
      return { ok: false, reason: `provider ${provider} does not publish ${modelId}` };
    }
    return { ok: true };
  } catch (error: unknown) {
    return { ok: false, reason: `provider status request failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Reports the availability of every model the operator approved. The run keeps the model it
 * was told to use, so the ledger never claims a fallback model did work it did not do; when
 * the named model is unusable this list tells the operator which approved model to re-run.
 */
async function describeModelAvailability(base: string, preferred: string): Promise<string[]> {
  const candidates = [preferred, ...KORY_CLI_FALLBACK_CHAIN.filter((item) => item !== preferred)];
  const lines: string[] = [];
  for (const candidate of candidates) {
    const usable = await usableProviderFor(base, candidate);
    lines.push(`${candidate}: ${usable.ok ? 'available' : usable.reason}`);
  }
  return lines;
}

function runnerPath(options: KoryCliAgenticOptions): string {
  if (options.runnerPath) return options.runnerPath;
  // The repository root is two levels above backend/src/eval/skills.
  return resolve(dirname(new URL(import.meta.url).pathname), '../../../../scripts/kory-cli.ts');
}

export function createKoryCliAgenticExecutor(options: KoryCliAgenticOptions = {}): SkillEvalExecutor {
  const model = (options.model ?? KORY_CLI_DEFAULT_MODEL).trim();
  const reasoning = (options.reasoning ?? 'high').trim();
  const wallClockMs = options.wallClockMs ?? 3_600_000;
  const base = options.backendBaseUrl ?? BACKEND;
  return {
    id: `kory-cli:${model}:${reasoning}`,
    subject: 'other',
    provider: model.includes('/') ? model.slice(0, model.indexOf('/')) : 'koryphaios',
    // The full provider/model id is what the operator named and what the CLI is given, so
    // it is also the identity recorded against the run.
    model,
    runtimeIdentity: `kory-backend:${model}:reasoning-${reasoning}:session-workspace`,
    tools: ['read', 'write', 'exec'],
    budget: { wallClockMs },
    execute: async (input) => {
      const started = Date.now();
      if (!(await backendHealthy(base))) {
        const infrastructureFailure: SkillInfrastructureFailure = {
          kind: 'setup',
          retryable: true,
          evidence: [`Kory backend is not reachable at ${base}`],
          detail: `Kory backend is not reachable at ${base}; start it with \`bun run user -- --no-window\``,
        };
        return {
          output: '',
          evidence: [...infrastructureFailure.evidence],
          artifacts: [],
          durationMs: 0,
          infrastructureFailure,
        };
      }
      const availability = await usableProviderFor(base, model);
      if (!availability.ok) {
        const lines = await describeModelAvailability(base, model);
        const infrastructureFailure: SkillInfrastructureFailure = {
          kind: 'provider',
          retryable: true,
          evidence: [`The named subject ${model} cannot run on this backend: ${availability.reason}`, ...lines],
          detail: `The named subject ${model} cannot run: ${availability.reason}`,
        };
        return {
          output: '',
          evidence: [...infrastructureFailure.evidence],
          artifacts: [],
          durationMs: Date.now() - started,
          infrastructureFailure,
        };
      }
      const before = fingerprintWorkspace(input.workingDirectory);
      let promptDirectory: string | null = null;
      try {
        promptDirectory = mkdtempSync(join(tmpdir(), 'kory-cli-prompt-'));
        writeFileSync(join(promptDirectory, 'prompt.md'), input.taskPrompt, { mode: 0o600 });
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        const infrastructureFailure: SkillInfrastructureFailure = {
          kind: 'setup',
          retryable: false,
          evidence: [`Prompt staging failed: ${detail}`],
          detail: 'Prompt staging failed',
        };
        return {
          output: '',
          evidence: [...infrastructureFailure.evidence],
          artifacts: [],
          durationMs: 0,
          infrastructureFailure,
        };
      }
      const promptPath = join(promptDirectory!, 'prompt.md');
      const timeoutSeconds = Math.max(60, Math.floor(wallClockMs / 1_000));
      const outcome = await new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
        stdout: string;
        timedOut: boolean;
      }>((resolveOutcome) => {
        const child = spawn(
          process.execPath,
          [
            runnerPath(options),
            'run',
            '--cwd',
            input.workingDirectory,
            '--prompt-file',
            promptPath,
            '--model',
            model,
            '--reasoning',
            reasoning,
            '--timeout',
            String(timeoutSeconds),
            '--title',
            `skill-eval ${input.scenario.id}`,
            '--json',
            '--quiet',
          ],
          {
            cwd: input.workingDirectory,
            env: {
              ...process.env,
              NO_COLOR: '1',
              KORYPHAIOS_HOST: new URL(base).hostname,
              KORYPHAIOS_PORT: new URL(base).port,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let stdout = '';
        let settled = false;
        const finish = (
          code: number | null,
          signal: NodeJS.Signals | null,
          timedOut: boolean,
        ): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolveOutcome({ code, signal, stdout, timedOut });
        };
        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // The child may already have exited.
          }
          finish(null, 'SIGKILL', true);
        }, wallClockMs);
        child.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
        });
        child.on('error', (error: Error) => {
          stdout += `\n${error.message}`;
          finish(null, null, false);
        });
        child.on('close', (code, signal) => finish(code, signal, false));
      });
      if (promptDirectory) rmSync(promptDirectory, { recursive: true, force: true });

      const durationMs = Date.now() - started;
      const after = fingerprintWorkspace(input.workingDirectory);
      const changed = changedPaths(before, after);
      const output = outcome.stdout.replace(/\u001b\[[0-9;]*m/gu, '');
      const diagnostic = output.trim().slice(-1_500);
      const evidence = [
        `Kory CLI run: model=${model} reasoning=${reasoning} exit=${String(outcome.code)} signal=${outcome.signal ?? 'none'}`,
        `Kory CLI changed ${String(changed.length)} file(s) in ${String(durationMs)}ms`,
        ...(changed.length ? [`Kory CLI modified: ${changed.slice(0, 12).join(', ')}`] : []),
        ...(diagnostic ? [diagnostic] : []),
      ];
      // The CLI reports the turn it followed. An `ok: false` result with no text means the
      // backend never produced an assistant message at all: nothing was attempted against
      // the workspace, so this is a subject failure, not a candidate failure.
      const reply = (() => {
        const start = output.lastIndexOf('{\n  "ok"');
        if (start < 0) return null;
        try {
          return JSON.parse(output.slice(start)) as { ok?: boolean; status?: string; text?: string; error?: string };
        } catch {
          return null;
        }
      })();
      if (reply && reply.ok === false && !String(reply.text ?? '').trim() && !changed.some((path) => !path.startsWith('.koryphaios/'))) {
        const timedOut = reply.status === 'timeout';
        const infrastructureFailure: SkillInfrastructureFailure = {
          kind: timedOut ? 'timeout' : 'setup',
          retryable: timedOut,
          evidence: [
            `Kory CLI turn produced no assistant message on ${model}: status=${String(reply.status ?? 'unknown')} error=${String(reply.error ?? 'none')}`,
            JSON.stringify(reply).slice(0, 400),
          ],
          detail: `The Kory backend produced no assistant message for this turn (${String(reply.status ?? 'unknown')})`,
        };
        return { output, evidence, artifacts: [], durationMs, infrastructureFailure };
      }
      // Koryphaios withholds a turn whose provider generation did not complete. The arm never got
      // to write its artifact, so this is the harness refusing to ship a response, not a candidate
      // that produced nothing. Score it as infrastructure and let the campaign retry the pair.
      if (
        reply &&
        reply.ok === false &&
        /withheld|did not complete/iu.test(`${String(reply.error ?? '')} ${String(reply.text ?? '')}`)
      ) {
        const withheld: SkillInfrastructureFailure = {
          kind: 'setup',
          retryable: true,
          evidence: [
            `Kory CLI withheld the turn on ${model}: ${JSON.stringify(reply).slice(0, 400)}`,
          ],
          detail: 'The Kory backend withheld the turn because the provider generation did not complete',
        };
        return { output, evidence, artifacts: [], durationMs, infrastructureFailure: withheld };
      }
      if (outcome.timedOut) {
        const infrastructureFailure: SkillInfrastructureFailure = {
          kind: 'timeout',
          retryable: true,
          evidence: [`Kory CLI exceeded ${String(wallClockMs)}ms wall-clock budget on ${model}`],
          detail: `Kory CLI exceeded ${String(wallClockMs)}ms wall-clock budget`,
        };
        return { output, evidence, artifacts: [], durationMs, infrastructureFailure };
      }
      if (/backend is not reachable|ECONNREFUSED/u.test(diagnostic)) {
        const infrastructureFailure: SkillInfrastructureFailure = {
          kind: 'setup',
          retryable: true,
          evidence: [`Kory backend became unreachable during the turn: ${diagnostic.slice(-300)}`],
          detail: 'Kory backend became unreachable during the turn',
        };
        return { output, evidence, artifacts: [], durationMs, infrastructureFailure };
      }
      if (/401|unauthori[sz]ed|invalid api key|not configured|no provider|model .* not found/iu.test(diagnostic)) {
        const infrastructureFailure: SkillInfrastructureFailure = {
          kind: 'provider',
          retryable: false,
          evidence: [`The provider rejected the kory-cli turn on ${model}: ${diagnostic.slice(-300)}`],
          detail: `The provider rejected the kory-cli turn on ${model}`,
        };
        return { output, evidence, artifacts: [], durationMs, infrastructureFailure };
      }
      if (!changed.length) {
        return {
          output,
          evidence,
          artifacts: [],
          durationMs,
          taskFailure: 'The Kory CLI turn exited without changing any file',
        };
      }
      return { output, evidence, artifacts: [], durationMs };
    },
  };
}

/** Read-only helper used by readiness: is a backend reachable for this subject? */
export async function koryCliBackendReachable(base = BACKEND): Promise<boolean> {
  return backendHealthy(base);
}

/** Model identifiers the operator has approved for this subject, in preference order. */
/**
 * Measured substitute for the day logfare's daily request budget is exhausted. It is the same
 * deepseek flash family the operator named, reached through a provider this backend has a
 * verified credential for, and it is only ever used when the operator passes it explicitly.
 */
export const KORY_CLI_SUBSTITUTE_MODEL = 'opencode/opencode/deepseek-v4.1-flash-free';

/** Second measured substitute, used when the deepseek free tier is itself rate limited. */
export const KORY_CLI_SUBSTITUTE_MODEL_FALLBACK = 'opencode/opencode/hy4-flash-free';

export const KORY_CLI_APPROVED_MODELS = [
  KORY_CLI_DEFAULT_MODEL,
  KORY_CLI_FALLBACK_MODEL,
  ...KORY_CLI_FALLBACK_CHAIN,
  KORY_CLI_SUBSTITUTE_MODEL,
  KORY_CLI_SUBSTITUTE_MODEL_FALLBACK,
] as const;

/** Guard against a typo silently evaluating a different model than the operator named. */
export function assertApprovedKoryCliModel(model: string): void {
  if (KORY_CLI_APPROVED_MODELS.includes(model as (typeof KORY_CLI_APPROVED_MODELS)[number])) return;
  throw new Error(
    `kory-cli-agentic model "${model}" is not one of the approved subjects: ${KORY_CLI_APPROVED_MODELS.join(', ')}`,
  );
}

/** Exposed for tests: the file-change report a turn produces. */
export function computeChangedPaths(root: string, before: Map<string, Fingerprint>): string[] {
  return changedPaths(before, fingerprintWorkspace(root));
}

export function fileStatSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function readPromptFile(path: string): string {
  return readFileSync(path, 'utf8');
}
