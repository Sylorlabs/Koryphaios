import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { OPENCODE_DEFAULT_BASE_URL } from '../../providers/constants';
import { buildSoftJail } from '../../collaboration/sandbox-runner';
import { spawnSandboxed } from '../../security/os-sandbox';
import { findExecutableOnPath, isWindows } from '../../runtime/platform';
import type { SkillEvalExecutionObservation, SkillEvalExecutor } from './skill-eval-execution';
import type { SkillInfrastructureFailure } from '../../kory/skill-evaluations';

/**
 * Agentic candidate executor: the OpenCode CLI driving a Logfare model.
 *
 * The accepted evidence family is the Codex CLI, so a spent Codex credential stops
 * every native and device scenario at once. This executor removes that dependency
 * without weakening isolation, which the text-patch Logfare adapter cannot do: a
 * text-only patch has no tools, so a device fixture can never be exercised by it and
 * the campaign refuses those environments outright.
 *
 * Three properties make the evidence admissible rather than convenient:
 *
 * 1. The child is confined by the host kernel, not by the CLI's cooperation. The
 *    process runs inside `spawnSandboxed` with exactly two writable roots: the
 *    fixture workspace and a throwaway jail HOME. Everything else on the host is
 *    read-only or invisible.
 * 2. The child never inherits the user's OpenCode configuration. A minimal config is
 *    generated in the jail from the user's Logfare provider block alone, so no MCP
 *    server, plugin, agent prompt or `AGENTS.md` from the operator's own setup can
 *    enter the candidate's context. That inheritance is why the text-patch OpenCode
 *    mode is quarantined, and it is the reason this one is not.
 * 3. Nothing here decides a pass. The run records the exit, the wall clock, and the
 *    files that actually changed; the scenario's deterministic scorer judges the
 *    result.
 */

/** A CLI run must report progress within this budget or it is torn down. */
const DEFAULT_WALL_CLOCK_MS = 900_000;
const CONFIG_DIR_NAME = '.config/opencode';
const PROMPT_FILE_NAME = 'kory-opencode-prompt.txt';
/** Directories that hold no candidate evidence. */
const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules', '.kory-tmp', '.build', '.swiftpm']);
/** Directories inside the jail HOME the CLI owns and may write. */
const JAIL_WRITABLE = ['.config', '.local', '.cache'];

export const OPENCODE_AGENTIC_MODE = 'opencode-logfare-agentic';

export interface OpenCodeLogfareModel {
  /** Bare model id inside the provider, e.g. `auto` or `glm-5.3-flash`. */
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly npm: string;
  readonly providerName: string;
  /** Operator config key the block came from, e.g. `logfare` or `vyceai`. */
  readonly providerId?: string;
}

/** The provider block an operator has configured for the OpenCode CLI. */
export const OPENCODE_PROVIDER_ENV = 'KORY_SKILL_EVAL_OPENCODE_PROVIDER';

export function operatorProviderKey(): string {
  return process.env[OPENCODE_PROVIDER_ENV]?.trim() || 'logfare';
}

interface OperatorOpenCodeConfig {
  $schema?: string;
  provider?: Record<
    string,
    {
      npm?: string;
      name?: string;
      options?: { apiKey?: string; baseURL?: string };
      models?: Record<string, unknown>;
    }
  >;
}

/**
 * Read the operator's Logfare provider block from their own OpenCode config.
 *
 * The credential is read, never invented or re-typed into a file, and only the keys
 * that describe *how to reach Logfare* survive. `mcp`, `plugin`, `agent` and
 * `permission` are dropped by construction because this function returns a shape
 * that has no field for them.
 */
export function readLogfareProviderFromOperatorConfig(
  configPath = join(homedir(), '.config/opencode/opencode.json'),
  modelName?: string,
  providerKey = 'logfare',
): OpenCodeLogfareModel | null {
  let parsed: OperatorOpenCodeConfig;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8')) as OperatorOpenCodeConfig;
  } catch {
    return null;
  }
  const logfare = parsed.provider?.[providerKey];
  // Koryphaios already resolves provider keys from the environment, so an operator who has the
  // key exported does not also have to duplicate it into the CLI's config file.
  const envKey = process.env[`${providerKey.toUpperCase()}_API_KEY`]?.trim();
  const apiKey = logfare?.options?.apiKey?.trim() || envKey;
  const baseUrl = logfare?.options?.baseURL?.trim() ||
    OPENCODE_DEFAULT_BASE_URL[providerKey];
  if (!apiKey || !baseUrl) return null;
  const declared = Object.keys(logfare?.models ?? {});
  // Resolution order is deliberate. A caller override and the environment variable win,
  // then the provider's own routing alias. Taking `declared[0]` alone made the model
  // depend on the key order of a config file the operator's tools rewrite, so a run
  // could silently ask for a model that is no longer declared and fail auth-style.
  // Only the Logfare block carries the shared routing alias, so a provider whose catalog is
  // known only to the operator must be named explicitly rather than defaulted to `auto`.
  const requested = modelName?.trim() ||
    process.env.KORY_SKILL_EVAL_LOGFARE_MODEL?.trim();
  const model = requested && (declared.includes(requested) || declared.length === 0)
    ? requested
    : declared.includes('auto')
      ? 'auto'
      : declared[0] || requested || 'auto';
  if (!model) return null;
  return {
    model,
    baseUrl,
    apiKey,
    npm: logfare?.npm?.trim() || '@ai-sdk/openai-compatible',
    providerName: logfare?.name?.trim() || (providerKey === 'logfare' ? 'Logfare' : providerKey),
    providerId: providerKey,
  };
}

/** Read whichever provider block the operator selected, defaulting to Logfare. */
export function readProviderFromOperatorConfig(
  configPath = join(homedir(), '.config/opencode/opencode.json'),
  modelName?: string,
  providerKey = operatorProviderKey(),
): OpenCodeLogfareModel | null {
  return readLogfareProviderFromOperatorConfig(configPath, modelName, providerKey);
}

/**
 * The exact config the candidate CLI is given.
 *
 * It has a field for the provider and for permissions and nothing else. The operator's
 * `mcp`, `plugin`, `agent` and `permission: allow` blocks are not copied, because an
 * inherited MCP server or plugin prompt is contamination the scorer cannot see.
 */
export function minimalOpenCodeConfig(
  model: OpenCodeLogfareModel,
  schema?: string,
): Record<string, unknown> {
  return {
    ...(schema ? { $schema: schema } : {}),
    permission: 'allow',
    provider: {
      [model.providerId ?? 'logfare']: {
        npm: model.npm,
        name: model.providerName,
        options: { apiKey: model.apiKey, baseURL: model.baseUrl },
        models: {
          [model.model]: {
            // The id is what the CLI sends upstream as the request model, so it must be the
            // provider's own id and not a provider-prefixed one. The operator's config carries
            // ids like `logfare/glm-5.3`, and repeating that prefix here makes the CLI post
            // `logfare/glm-5.3` to an endpoint that only serves `glm-5.3`; the router alias
            // `auto` masks the bug because the server does serve `logfare/auto`.
            id: model.model,
            name: `${model.providerName} ${model.model}`,
            tool_call: true,
            temperature: true,
          },
        },
      },
    },
  };
}

/** Model ids the operator's configured OpenCode provider actually declares. */
export function readLogfareDeclaredModels(
  configPath = join(homedir(), '.config/opencode/opencode.json'),
  providerKey = 'logfare',
): string[] {
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as OperatorOpenCodeConfig;
    return Object.keys(parsed.provider?.[providerKey]?.models ?? {});
  } catch {
    return [];
  }
}

/** Model ids a provider documents, read from its own published catalog listing. */
export function readDeclaredModelsFromProvider(
  configPath = join(homedir(), '.config/opencode/opencode.json'),
  providerKey = operatorProviderKey(),
): string[] {
  return readLogfareDeclaredModels(configPath, providerKey);
}

export interface ProviderPreflightFailure {
  readonly kind: 'setup' | 'budget';
  readonly retryable: boolean;
  readonly detail: string;
}

/**
 * Ask the provider for one token before spending a wall clock on it.
 *
 * The CLI retries a hard rejection silently, so an exhausted quota or a bad key looks like a model that
 * never finishes: three arms once burned three hours against `request budget reached` while reporting only
 * `build`. One small request turns that into a recorded infrastructure failure in seconds, and no candidate
 * is ever charged for it.
 */
// A throttled provider answers 429 or 503 for a few seconds at a time, and refusing an arm on the
// first such answer discarded whole paired runs at the provider's convenience. Transient statuses
// are retried with backoff, honouring retry-after when the provider sends one.
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);
const PREFLIGHT_BACKOFF_MS = [0, 5_000, 15_000, 45_000, 60_000];

export async function preflightProviderAccess(
  model: OpenCodeLogfareModel,
  fetchImpl: typeof fetch = fetch,
  backoff: readonly number[] = PREFLIGHT_BACKOFF_MS,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<ProviderPreflightFailure | null> {
  let last: ProviderPreflightFailure | null = null;
  for (let index = 0; index < backoff.length; index++) {
    if (backoff[index]) await sleep(backoff[index]!);
    const failure = await preflightOnce(model, fetchImpl);
    if (!failure) return null;
    // Only a transient status is worth another attempt; a missing credential or an unknown model
    // will answer the same way however long the harness waits.
    last = { kind: failure.kind, retryable: failure.retryable, detail: failure.detail };
    if (!failure.transient) return last;
  }
  return last;
}

async function preflightOnce(
  model: OpenCodeLogfareModel,
  fetchImpl: typeof fetch,
): Promise<(ProviderPreflightFailure & { transient?: boolean }) | null> {
  let response: Response;
  try {
    response = await fetchImpl(`${model.baseUrl.replace(/\/+$/u, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${model.apiKey}` },
      body: JSON.stringify({
        model: model.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      }),
    });
  } catch (error: unknown) {
    return {
      kind: 'setup',
      retryable: true,
      detail: `${model.providerId ?? 'provider'} is unreachable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (response.ok) return null;
  let message = '';
  try {
    const body = await response.text();
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    message = parsed.error?.message ?? body;
  } catch {
    message = '';
  }
  const text = message.slice(0, 300) || `HTTP ${response.status}`;
  const budget = response.status === 429 || /budget|quota|rate limit/iu.test(text);
  return {
    kind: budget ? 'budget' : 'setup',
    retryable: budget || response.status >= 500,
    detail: `${model.providerId ?? 'provider'} refused ${model.model}: ${text}`,
    transient: TRANSIENT_STATUSES.has(response.status),
  };
}

function writeJailConfig(jailHome: string, model: OpenCodeLogfareModel, schema?: string): void {
  const configDir = join(jailHome, CONFIG_DIR_NAME);
  mkdirSync(configDir, { recursive: true });
  const operatorModules = join(homedir(), '.config/opencode/node_modules');
  if (existsSync(operatorModules)) {
    try {
      symlinkSync(operatorModules, join(configDir, 'node_modules'), 'dir');
    } catch {
      // A missing provider package surfaces as a CLI error, which is recorded.
    }
  }
  const config = minimalOpenCodeConfig(model, schema);
  writeFileSync(join(configDir, 'opencode.json'), JSON.stringify(config, null, 2), {
    mode: 0o600,
  });
}

interface FileFingerprint {
  readonly sha256: string;
  readonly bytes: number;
}

function fingerprintWorkspace(root: string): Map<string, FileFingerprint> {
  const files = new Map<string, FileFingerprint>();
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
      const bytes = readFileSync(path);
      files.set(relative(root, path), {
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.byteLength,
      });
    }
  };
  walk(root);
  return files;
}

function changedPaths(
  before: Map<string, FileFingerprint>,
  after: Map<string, FileFingerprint>,
): string[] {
  const changed: string[] = [];
  for (const [path, fingerprint] of after) {
    const previous = before.get(path);
    if (!previous || previous.sha256 !== fingerprint.sha256) changed.push(path);
  }
  for (const path of before.keys()) {
    if (!after.has(path)) changed.push(`${path} (removed)`);
  }
  return changed.sort();
}

export function opencodeAgenticPrompt(taskPrompt: string, skillContext: string | null): string {
  return [
    'You are completing one evaluation task inside the current working directory.',
    'Work only inside this directory. Never modify or create anything under .kory-eval, ' +
      'and never edit a file the task materials describe as evaluator owned.',
    '',
    '## Task',
    taskPrompt,
    ...(skillContext ? ['', '## Skill guidance', skillContext] : []),
    '',
    '## Finish',
    'Implement the change. When you are done, print a short summary of what you changed. ' +
      'Do not ask questions; there is nobody to answer them.',
  ].join('\n');
}

export interface OpenCodeLogfareAgenticOptions {
  /** Fully resolved provider model, used by tests. */
  model?: OpenCodeLogfareModel;
  /** Requested model name, resolved against the operator's declared catalog. */
  modelName?: string;
  /** Declared model ids injected by tests; defaults to the operator's config file. */
  declaredModels?: string[];
  wallClockMs?: number;
  binary?: string;
  /** Provider check injected by tests; `null` skips it for sandbox-only cases. */
  preflight?: ((model: OpenCodeLogfareModel) => Promise<ProviderPreflightFailure | null>) | null;
  /**
   * How often to re-ask the provider while the CLI is running. OpenCode swallows a 429 and keeps
   * retrying with no output, so the CLI stream never reveals it and the arm dies on the wall clock.
   * `0` disables the heartbeat.
   */
  providerHeartbeatMs?: number;
  /**
   * How long the CLI must be silent before a refused provider probe may end the arm. A throttled
   * provider answers 503 for a few seconds while the CLI is still working, and ending the arm on
   * that threw away a live candidate arm.
   */
  providerStallMs?: number;
}

export function opencodeBinary(): string | null {
  const override = process.env.KORY_SKILL_EVAL_OPENCODE_BINARY?.trim();
  if (override) return override;
  return findExecutableOnPath('opencode', process.env.PATH ?? '');
}

export function createOpenCodeLogfareAgenticExecutor(
  options: OpenCodeLogfareAgenticOptions = {},
): SkillEvalExecutor {
  const providerKey = operatorProviderKey();
  const model = options.model ??
    readProviderFromOperatorConfig(undefined, options.modelName, providerKey);
  if (!model) {
    throw new Error(
      'OpenCode agentic executor is unavailable: no ' + providerKey +
        ' provider is configured for the OpenCode CLI.',
    );
  }
  const declared = options.declaredModels ?? readLogfareDeclaredModels(undefined, providerKey);
  if (declared.length && !declared.includes(model.model)) {
    throw new Error(
      `OpenCode agentic executor is unavailable: the resolved model ${model.model} is not declared by the operator's ${providerKey} provider.`,
    );
  }
  const wallClockMs = options.wallClockMs ?? DEFAULT_WALL_CLOCK_MS;
  return {
    id: `opencode-logfare:${model.model}:agentic`,
    subject: 'other',
    provider: model.providerId ?? 'logfare',
    model: model.model,
    runtimeIdentity: `opencode-cli:${model.providerId ?? 'logfare'}/${model.model}:agentic-sandboxed`,
    tools: ['read', 'write', 'exec'],
    budget: { wallClockMs },
    execute: async (input) => {
      const started = Date.now();
      const preflight = options.preflight === null
        ? null
        : await (options.preflight ?? preflightProviderAccess)(model);
      if (preflight) {
        const infrastructureFailure: SkillInfrastructureFailure = {
          kind: 'provider',
          retryable: preflight.retryable,
          evidence: [preflight.detail],
          detail: preflight.detail,
        };
        return { output: '', evidence: [...infrastructureFailure.evidence], artifacts: [], durationMs: 0, infrastructureFailure };
      }
      const binary = options.binary ?? opencodeBinary();
      if (!binary) {
        const infrastructureFailure: SkillInfrastructureFailure = {
          kind: 'setup',
          retryable: false,
          evidence: ['OpenCode CLI binary could not be resolved on PATH'],
          detail: 'OpenCode CLI binary could not be resolved on PATH',
        };
        return { output: '', evidence: [...infrastructureFailure.evidence], artifacts: [], durationMs: 0, infrastructureFailure };
      }
      const before = fingerprintWorkspace(input.workingDirectory);
      const jail = buildSoftJail(process.env as Record<string, string>, []);
      const jailHome = jail.env.HOME ?? '';
      let promptDirectory: string | null = null;
      try {
        writeJailConfig(jailHome, model);
        promptDirectory = mkdtempSync(join(tmpdir(), 'kory-oc-prompt-'));
        writeFileSync(
          join(promptDirectory, PROMPT_FILE_NAME),
          opencodeAgenticPrompt(input.taskPrompt, input.skillContext),
          { mode: 0o600 },
        );
      } catch (error: unknown) {
        jail.cleanup();
        const detail = error instanceof Error ? error.message : String(error);
        const infrastructureFailure: SkillInfrastructureFailure = {
          kind: 'setup',
          retryable: false,
          evidence: [`Jail preparation failed: ${detail}`],
          detail: 'Jail preparation failed',
        };
        return { output: '', evidence: [...infrastructureFailure.evidence], artifacts: [], durationMs: 0, infrastructureFailure };
      }
      const promptPath = join(promptDirectory, PROMPT_FILE_NAME);
      const allowedRoots = [input.workingDirectory, jailHome, promptDirectory];
      const operatorModules = join(homedir(), '.config/opencode/node_modules');
      const env: Record<string, string> = {
        ...(jail.env as Record<string, string>),
        PWD: input.workingDirectory,
        OLDPWD: input.workingDirectory,
        NO_COLOR: '1',
        TERM: 'dumb',
      };
      // A desktop or systems scenario may need to compile what it changed. Without these the
      // jail HOME makes rustup fail with "could not create home directory ... Operation not
      // permitted", which reads as a broken toolchain and burns a whole turn. The toolchains
      // stay read-only on the host; the registry cache lives inside the jail home.
      const hostRustup = join(homedir(), '.rustup');
      if (existsSync(hostRustup)) {
        env.RUSTUP_HOME = hostRustup;
        env.CARGO_HOME = join(jailHome, '.cargo');
        const hostCargoBin = join(homedir(), '.cargo', 'bin');
        const pathParts = [hostCargoBin, env.PATH ?? ''].filter(Boolean);
        env.PATH = pathParts.join(':');
      }
      let outcome: {
        code: number | null;
        signal: NodeJS.Signals | null;
        stdout: string;
        timedOut: boolean;
        abortReason?: string | null;
      };
      try {
        const { proc, cleanup } = spawnSandboxed(
          [
            binary,
            'run',
            '--standalone',
            '--auto',
            '-m',
            // The provider prefix must be the block the CLI was actually given, otherwise the
            // CLI looks up a provider that does not exist in the staged config.
            `${model.providerId ?? 'logfare'}/${model.model}`,
            readFileSync(promptPath, 'utf8'),
          ],
          {
            allowedRoots,
            readOnlyRoots: existsSync(operatorModules) ? [operatorModules] : [],
            cwd: input.workingDirectory,
            blockNetwork: false,
            blockSubprocesses: false,
            env,
            // Its own process group, so an abort can kill the CLI and everything it started. Killing
            // only the sandbox wrapper left the grandchild holding the pipes: the arm settled after
            // the grandchild's own exit instead of at the abort, and stray children accumulated.
            detached: true,
          },
        );
        outcome = await new Promise((resolve) => {
          let stdout = '';
          let settled = false;
          let lastOutputAt = Date.now();
          const heartbeatMs = options.providerHeartbeatMs ?? 120_000;
          const stallMs = options.providerStallMs ?? 180_000;
          let heartbeat: ReturnType<typeof setInterval> | undefined;
          const stopHeartbeat = (): void => {
            if (heartbeat) clearInterval(heartbeat);
            heartbeat = undefined;
          };
          // A provider that rate limits or disappears mid-turn leaves the CLI retrying with no
          // output until the wall clock expires. Reading its own error stream lets the arm end in
          // seconds and be recorded as the retryable provider failure it is, instead of burning
          // the whole budget per attempt.
          let abortReason: string | null = null;
          const finish = (
            code: number | null,
            signal: NodeJS.Signals | null,
            timedOut: boolean,
          ): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            stopHeartbeat();
            try {
              cleanup();
            } catch {
              // Cleanup is best effort; the scratch roots are private.
            }
            resolve({ code, signal, stdout, timedOut, abortReason });
          };
          // Killing the sandbox wrapper does not close its pipes: the grandchild `sh`/tool keeps
          // stdout open, so `close` only fires when that process exits on its own. Waiting for it
          // made an aborted arm look like it ran for its whole budget. The kill is followed by a
          // bounded fallback that settles the promise regardless of the survivor.
          const killAndSettle = (reason: string | null, timedOut: boolean): void => {
            if (reason) abortReason = reason;
            const pid = proc.pid;
            // The group carries the wrapper and every descendant it spawned. A negative pid is not a
            // valid signal target on Windows, so that case falls back to the single process.
            if (pid && !isWindows()) {
              try {
                process.kill(-pid, 'SIGKILL');
              } catch {
                // The group may already be gone.
              }
            }
            try {
              proc.kill('SIGKILL');
            } catch {
              // The process may have already exited.
            }
            setTimeout(() => finish(null, 'SIGKILL', timedOut), 1_500).unref?.();
          };
          const watchForProviderAbort = (chunk: string): void => {
            if (abortReason) return;
            if (!/429|rate limit|free model request limit|provider became unavailable|no provider is available|quota/iu.test(chunk))
              return;
            killAndSettle(chunk.trim().slice(-300) || 'provider limit reached', false);
          };
          const timer = setTimeout(() => killAndSettle(null, true), wallClockMs);
          if (heartbeatMs > 0 && options.preflight !== null) {
            const probe = options.preflight ?? preflightProviderAccess;
            // One refused probe is not proof the arm is dead: the probe is itself a request and
            // can be the one that trips a rate limit. Two consecutive refusals are.
            let consecutiveFailures = 0;
            heartbeat = setInterval(() => {
              void probe(model)
                .then((failure) => {
                  if (!failure) {
                    consecutiveFailures = 0;
                    return;
                  }
                  consecutiveFailures += 1;
                  if (abortReason || consecutiveFailures < 3) return;
                  // Only a stalled CLI is evidence that the provider stopped serving this arm. A
                  // probe refusal while the CLI keeps producing output is the provider throttling.
                  if (Date.now() - lastOutputAt < stallMs) return;
                  killAndSettle(`provider probe: ${failure.detail}`, false);
                })
                .catch(() => {
                  // A probe that cannot answer is not evidence of a provider fault.
                });
            }, heartbeatMs);
            heartbeat.unref?.();
          }
          proc.stdout?.on('data', (chunk: Buffer) => {
            lastOutputAt = Date.now();
            const text = chunk.toString('utf8');
            stdout += text;
            watchForProviderAbort(text);
          });
          proc.stderr?.on('data', (chunk: Buffer) => {
            lastOutputAt = Date.now();
            const text = chunk.toString('utf8');
            stdout += text;
            watchForProviderAbort(text);
          });
          proc.on('error', (error: Error) => {
            stdout += `\n${error.message}`;
            finish(null, null, false);
          });
          proc.on('close', (code, signal) => finish(code, signal, false));
        });
      } catch (error: unknown) {
        jail.cleanup();
        if (promptDirectory) rmSync(promptDirectory, { recursive: true, force: true });
        const detail = error instanceof Error ? error.message : String(error);
        const infrastructureFailure: SkillInfrastructureFailure = {
          kind: 'setup',
          retryable: false,
          evidence: [`OS sandbox unavailable for the candidate: ${detail}`],
          detail: 'The candidate could not be confined, so the run was refused',
        };
        return { output: '', evidence: [...infrastructureFailure.evidence], artifacts: [], durationMs: 0, infrastructureFailure };
      }
      jail.cleanup();
      if (promptDirectory) rmSync(promptDirectory, { recursive: true, force: true });
      const durationMs = Date.now() - started;
      const after = fingerprintWorkspace(input.workingDirectory);
      const changed = changedPaths(before, after);
      const output = outcome.stdout.replace(/\u001b\[[0-9;]*m/gu, '');
      const diagnostic = output.trim().slice(-1200);
      const evidence = [
        `OpenCode CLI exit=${String(outcome.code)} signal=${outcome.signal ?? 'none'}`,
        `OpenCode CLI changed ${String(changed.length)} file(s) in ${String(durationMs)}ms`,
        ...(changed.length ? [`OpenCode CLI modified: ${changed.slice(0, 12).join(', ')}`] : []),
        ...(diagnostic ? [diagnostic] : []),
      ];
      if (outcome.abortReason) {
        const infrastructureFailure: SkillInfrastructureFailure = {
          kind: 'provider',
          retryable: true,
          evidence: [`Provider aborted the run: ${outcome.abortReason}`],
          // The reason is the only thing that tells a genuine provider limit apart from an
          // over-eager probe, so it must reach the campaign report instead of staying in memory.
          detail: `The provider rate limited or dropped this run, so it produced no candidate evidence: ${outcome.abortReason.slice(0, 200)}`,
        };
        return { output, evidence, artifacts: [], durationMs, infrastructureFailure };
      }
      if (outcome.timedOut) {
        const infrastructureFailure: SkillInfrastructureFailure = {
          kind: 'timeout',
          retryable: true,
          evidence: [`OpenCode exceeded ${String(wallClockMs)}ms wall-clock budget`],
          detail: `OpenCode exceeded ${String(wallClockMs)}ms wall-clock budget`,
        };
        return { output, evidence, artifacts: [], durationMs, infrastructureFailure };
      }
      // The CLI's own runtime failed before it could do candidate work. A Unix socket path over the
      // macOS limit, a port already bound by another instance and a missing module are all harness
      // conditions: they read as "the candidate changed nothing" if they are not named.
      if (/Unix socket path exceeds|address already in use|EADDRINUSE|Cannot find module/u.test(diagnostic)) {
        const infrastructureFailure: SkillInfrastructureFailure = {
          kind: 'environment-drift',
          retryable: true,
          evidence: [`OpenCode CLI runtime failed: ${diagnostic.slice(-300)}`],
          detail: 'The OpenCode CLI failed in its own runtime, not in the candidate workspace',
        };
        return { output, evidence, artifacts: [], durationMs, infrastructureFailure };
      }
      // A provider that goes away mid-turn is an outage, not a candidate that did nothing. OpenCode
      // reports it as "Error: provider became unavailable" and exits 1 with no file writes, which the
      // task-failure branch below would have recorded as a zero-quality candidate result.
      if (/not logged in|log in|unauthori[sz]ed|invalid api key|401|provider (?:became |is )?unavailable|no provider is available|model (?:is )?not available|rate limit|quota|429/u.test(diagnostic)) {
        const infrastructureFailure: SkillInfrastructureFailure = {
          kind: 'provider',
          retryable: false,
          evidence: [`Logfare rejected the candidate run: ${diagnostic.slice(-300)}`],
          detail: 'Logfare rejected the candidate run',
        };
        return { output, evidence, artifacts: [], durationMs, infrastructureFailure };
      }
      // A stream that ends mid-turn is a dropped connection, not a candidate verdict. The CLI
      // prints "OpenAI Chat stream ended without ..." and exits 1 with a half-written tree, and the
      // scorer then records the incompleteness as the candidate's own failure. The transport
      // signature is the only thing that separates that from a subject that genuinely stopped, so it
      // is matched before the task-failure branch and retried like any other outage.
      if (
        /stream ended without|stream (?:error|closed)|ECONNRESET|socket hang up|fetch failed|upstream connect error|terminated/iu.test(
          diagnostic,
        )
      ) {
        const infrastructureFailure: SkillInfrastructureFailure = {
          kind: 'provider',
          retryable: true,
          evidence: [`Provider stream dropped mid-run: ${diagnostic.slice(-300)}`],
          detail:
            'The provider stream ended before the turn finished, so the workspace is not a candidate result',
        };
        return { output, evidence, artifacts: [], durationMs, infrastructureFailure };
      }
      // A process that did not exit on its own cannot be judged. When the harness, the host or a
      // signal the executor did not raise ends the CLI, the workspace is a half-written tree and the
      // scorer reads the incompleteness as the candidate's fault: it records an integrity failure on
      // an arm that has no artifact to inspect. That is a harness kill and belongs in the timeout
      // channel, which the campaign retries, not in the candidate column. It sits after the named
      // classifications so a provider limit or a runtime drift keeps its own, more specific cause.
      if (outcome.code === null && outcome.signal != null) {
        const infrastructureFailure: SkillInfrastructureFailure = {
          kind: 'timeout',
          retryable: true,
          evidence: [`OpenCode CLI was killed (exit=null signal=${outcome.signal ?? 'none'})`],
          detail: `The OpenCode CLI did not exit on its own (signal=${outcome.signal ?? 'none'}), so its workspace is not a candidate result`,
        };
        return { output, evidence, artifacts: [], durationMs, infrastructureFailure };
      }

      if (!changed.length) {
        return {
          output,
          evidence,
          artifacts: [],
          durationMs,
          taskFailure: 'OpenCode exited without changing any file',
        };
      }
      return { output, evidence, artifacts: [], durationMs };
    },
  };
}

/** Write-access probe used by readiness checks: the jail must be writable. */
export function opencodeJailWritable(): boolean {
  let probe: string | null = null;
  try {
    probe = mkdtempSync(join(tmpdir(), 'kory-oc-jail-probe-'));
    for (const name of JAIL_WRITABLE) mkdirSync(join(probe, name), { recursive: true });
    writeFileSync(join(probe, '.config/opencode/probe'), 'ok');
    return true;
  } catch {
    return false;
  } finally {
    if (probe) rmSync(probe, { recursive: true, force: true });
  }
}

/** A throwaway handle, kept so callers can await nothing by accident. */
export async function runOpenCodeAgenticOnce(
  executor: SkillEvalExecutor,
  input: Parameters<SkillEvalExecutor['execute']>[0],
): Promise<SkillEvalExecutionObservation> {
  return executor.execute(input);
}

export { spawn };
