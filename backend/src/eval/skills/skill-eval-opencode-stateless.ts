import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  canonicalizePath,
  findExecutableOnPath,
  isContainedBy,
  looksLikePath,
  providerProcessGroupOptions,
  terminateProviderProcessGroup,
} from '../../runtime/platform';
import type { SkillEvalExecutionObservation, SkillEvalExecutor } from './skill-eval-execution';
import type { SkillInfrastructureFailure } from '../../kory/skill-evaluations';
import {
  applySkillEvalTextPatch,
  parseSkillEvalTextPatch,
  snapshotSkillEvalWorkspace,
  textPatchPrompt,
} from './skill-eval-text-patch';

// Source-inspected v2.0.32 operation: direct LLM generate, empty system, one user
// prompt, tools:[], no session/agent/context or local model-tool dispatch. This
// is a version-dependent API boundary, NOT a sandbox or signed upstream identity.
const INSPECTED_VERSION = '2.0.32';
const DEFAULT_MODEL = 'openrouter/openrouter/free';
const DEFAULT_TIMEOUT_MS = 300_000;
const VERSION_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 4_000_000;
const MAX_STDERR_BYTES = 64_000;
export const MAX_SERIALIZED_REQUEST_BYTES = 24_000;
const DRAIN_MS = 500;

function modelRequest(model: string): { providerID: string; id: string } {
  // Split once: openrouter/openrouter/free is provider openrouter, id openrouter/free.
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(model) ||
    model.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('OpenCode stateless model must be a provider/model identifier.');
  }
  const slash = model.indexOf('/');
  return { providerID: model.slice(0, slash), id: model.slice(slash + 1) };
}

function unavailable(): Error {
  return new Error(
    `OpenCode stateless text-patch executor is unavailable: requires an executable source-inspected CLI v${INSPECTED_VERSION} (probe details redacted).`,
  );
}

function resolveBinary(): string {
  const configured = process.env.KORY_SKILL_EVAL_OPENCODE_BINARY?.trim() || 'opencode';
  const candidate = looksLikePath(configured)
    ? resolve(configured)
    : findExecutableOnPath(configured);
  try {
    if (!candidate || !statSync(candidate).isFile()) throw unavailable();
    accessSync(candidate, constants.X_OK);
    return canonicalizePath(candidate);
  } catch {
    throw unavailable();
  }
}

function disposableCwd(workingDirectory?: string): string {
  const parent = canonicalizePath(tmpdir());
  for (const root of [resolve(import.meta.dir, '../../../..'), process.cwd(), workingDirectory].filter(
    (value): value is string => !!value,
  )) {
    if (isContainedBy(canonicalizePath(root), parent)) throw unavailable();
  }
  // No configuration, authentication, prompt, or workspace files are staged here.
  return mkdtempSync(join(parent, 'kory-opencode-stateless-'));
}

function inspectedVersion(stdout: string): boolean {
  return [INSPECTED_VERSION, `v${INSPECTED_VERSION}`, `opencode v${INSPECTED_VERSION}`].includes(
    stdout.trim(),
  );
}

function checkVersion(binary: string, wallClockMs: number): void {
  const cwd = disposableCwd();
  try {
    const result = spawnSync(binary, ['--version'], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: Math.min(VERSION_TIMEOUT_MS, wallClockMs),
      killSignal: 'SIGKILL',
      maxBuffer: 8_192,
      ...providerProcessGroupOptions(),
      shell: false,
    });
    terminateProviderProcessGroup(result.pid);
    if (result.error || result.status !== 0 || !inspectedVersion(result.stdout))
      throw unavailable();
  } catch {
    throw unavailable();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

interface ProcessResult {
  code: number | null;
  stdout: Buffer;
  responseSha256: string;
  responseBytes: number;
  timedOut: boolean;
  overflow: boolean;
  failed: boolean;
  closed: boolean;
}

function runCli(
  binary: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  maxStdoutBytes = MAX_RESPONSE_BYTES,
): Promise<ProcessResult> {
  return new Promise((resolveResult) => {
    const child = spawn(binary, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...providerProcessGroupOptions(),
      shell: false,
    });
    const chunks: Buffer[] = [];
    const hash = createHash('sha256');
    let responseBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let overflow = false;
    let failed = false;
    let settled = false;
    let drain: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number | null, closed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drain);
      terminateProviderProcessGroup(child.pid);
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      resolveResult({
        code,
        stdout: Buffer.concat(chunks),
        responseSha256: hash.digest('hex'),
        responseBytes,
        timedOut,
        overflow,
        failed,
        closed,
      });
    };
    const stop = () => {
      if (drain) return;
      // Bound settlement even if a descendant retains inherited pipes. Continue
      // draining until close/deadline; process cleanup is not upstream cancellation.
      drain = setTimeout(() => finish(null, false), DRAIN_MS);
      terminateProviderProcessGroup(child.pid);
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      responseBytes += chunk.length;
      hash.update(chunk);
      if (responseBytes <= maxStdoutBytes) chunks.push(chunk);
      else {
        overflow = true;
        stop();
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      // Never retain or publish provider diagnostics, including credentials.
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_STDERR_BYTES) {
        overflow = true;
        stop();
      }
    });
    child.on('error', () => {
      failed = true;
      stop();
    });
    child.on('close', (code) => finish(code, true));
  });
}

function responseText(bytes: Buffer): string {
  const json = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  // Deliberately narrow grammar: one complete envelope with exactly data.text.
  // Unlike JSON.parse + key checks alone, this also rejects duplicate keys (an
  // overwritten data/error/tool payload must never disappear during validation).
  if (
    !/^[\x20\t\r\n]*\{[\x20\t\r\n]*"data"[\x20\t\r\n]*:[\x20\t\r\n]*\{[\x20\t\r\n]*"text"[\x20\t\r\n]*:[\x20\t\r\n]*"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"[\x20\t\r\n]*\}[\x20\t\r\n]*\}[\x20\t\r\n]*$/u.test(
      json,
    )
  ) {
    throw new Error('Invalid stateless envelope');
  }
  const text = (JSON.parse(json) as { data: { text: string } }).data.text;
  if (!text.trim()) throw new Error('Empty stateless text');
  return text;
}

/** Report only recognized failure categories; upstream errors may contain secrets. */
function safeProcessFailureDetail(bytes: Buffer): string {
  const generic = 'OpenCode stateless process failed (details redacted).';
  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return generic;
    const error = parsed as Record<string, unknown>;
    if (error._tag !== 'ServiceUnavailableError' || typeof error.message !== 'string')
      return generic;
    if (error.message.includes('UNABLE_TO_GET_ISSUER_CERT_LOCALLY')) {
      return 'OpenCode stateless provider TLS certificate verification failed: a trusted issuer certificate is unavailable. Configure a valid trust chain; do not disable verification.';
    }
    if (error.message.startsWith('Free usage limit reached.')) {
      return 'OpenCode stateless provider free usage limit reached; this route cannot supply qualification evidence until access is restored.';
    }
  } catch {
    // Malformed provider responses are untrusted. Never echo their content.
  }
  return generic;
}

export function createOpenCodeStatelessTextPatchSkillEvalExecutor(options?: {
  model?: string;
  wallClockMs?: number;
}): SkillEvalExecutor {
  const model = options?.model ?? process.env.KORY_SKILL_EVAL_OPENCODE_MODEL ?? DEFAULT_MODEL;
  const requestModel = modelRequest(model);
  const wallClockMs = options?.wallClockMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(wallClockMs) || wallClockMs <= 0 || wallClockMs > 2_147_483_647) {
    throw new Error('OpenCode stateless wall-clock budget must be a positive timer-safe integer.');
  }
  const binary = resolveBinary();
  checkVersion(binary, wallClockMs);
  return {
    id: `opencode-stateless-text-patch:${model}:${binary}`,
    subject: 'other',
    provider: 'opencode',
    model,
    runtimeIdentity: `opencode-cli:${binary}:v${INSPECTED_VERSION}:stateless-generate-v1`,
    tools: ['workspace-snapshot', 'patch-apply'],
    budget: { wallClockMs },
    execute: async ({ scenario, workingDirectory, taskPrompt, skillContext }) => {
      const started = performance.now();
      const elapsed = () => Math.round(performance.now() - started);
      const evidence: string[] = [];
      const failure = (
        kind: SkillInfrastructureFailure['kind'],
        detail: string,
      ): SkillEvalExecutionObservation => ({
        output: '',
        evidence: [...evidence, detail],
        artifacts: [],
        durationMs: elapsed(),
        infrastructureFailure: { kind, detail, retryable: false, evidence: [detail] },
      });
      if (!['repository', 'synthetic', 'cli'].includes(scenario.environment.kind)) {
        return failure(
          'tool',
          'OpenCode stateless text-patch supports only repository, synthetic, and cli environments.',
        );
      }
      let cwd: string | undefined;
      try {
        const snapshot = snapshotSkillEvalWorkspace(workingDirectory);
        const request = JSON.stringify({
          prompt: textPatchPrompt(taskPrompt, skillContext, snapshot),
          model: requestModel,
        });
        cwd = disposableCwd(workingDirectory);
        if (elapsed() >= wallClockMs)
          return failure('timeout', 'OpenCode stateless setup exceeded the wall-clock budget.');
        // Re-probe each execution: a CLI upgrade after selection is not qualified.
        const version = await runCli(
          binary,
          ['--version'],
          cwd,
          Math.min(VERSION_TIMEOUT_MS, wallClockMs - elapsed()),
          8_192,
        );
        if (version.timedOut)
          return failure('timeout', 'OpenCode stateless version probe timed out.');
        if (
          version.failed ||
          version.overflow ||
          version.code !== 0 ||
          !inspectedVersion(version.stdout.toString('utf8'))
        ) {
          return failure(
            'setup',
            `OpenCode stateless requires source-inspected CLI v${INSPECTED_VERSION}; version probe rejected (details redacted).`,
          );
        }
        if (elapsed() >= wallClockMs)
          return failure(
            'timeout',
            'OpenCode stateless version probe exhausted the wall-clock budget.',
          );
        const requestBytes = Buffer.byteLength(request, 'utf8');
        if (requestBytes > MAX_SERIALIZED_REQUEST_BYTES)
          return failure(
            'setup',
            `OpenCode stateless serialized request is ${requestBytes} UTF-8 bytes, above the conservative ${MAX_SERIALIZED_REQUEST_BYTES}-byte argv limit; generation was not dispatched (request details redacted).`,
          );
        const result = await runCli(
          binary,
          ['api', 'experimental.generate.text', '--data', request],
          cwd,
          wallClockMs - elapsed(),
        );
        evidence.push(
          `OpenCode stateless host receipt: ${JSON.stringify({
            kind: 'host-observed-unsigned',
            runtime: 'stateless-generate-v1',
            cliVersion: INSPECTED_VERSION,
            requestedModel: model,
            boundary: 'no-local-tools',
            boundaryBasis: 'source-inspected-version-dependent',
            providerRoute: 'base-configured-route',
            upstreamIdentityVerified: false,
            upstreamCancellationAcknowledged: false,
            request: {
              sha256: createHash('sha256').update(request).digest('hex'),
              bytes: Buffer.byteLength(request),
            },
            response: {
              sha256: result.responseSha256,
              bytes: result.responseBytes,
              complete:
                result.closed &&
                !result.timedOut &&
                !result.overflow &&
                !result.failed &&
                result.code === 0,
            },
            exitCode: result.code,
            elapsedMs: elapsed(),
          })}`,
        );
        if (result.timedOut)
          return failure(
            'timeout',
            'OpenCode stateless exceeded the wall-clock budget; local process cleanup does not certify upstream cancellation.',
          );
        if (result.overflow)
          return failure(
            'provider',
            'OpenCode stateless exceeded the output byte budget (details redacted).',
          );
        if (result.failed || result.code !== 0)
          return failure('provider', safeProcessFailureDetail(result.stdout));
        let text: string;
        try {
          text = responseText(result.stdout);
        } catch {
          return failure(
            'provider',
            'OpenCode stateless response must be one complete JSON envelope containing only data.text; error/tool/extra fields rejected (details redacted).',
          );
        }
        try {
          const patch = parseSkillEvalTextPatch(text);
          const changed = applySkillEvalTextPatch(workingDirectory, patch.operations);
          return {
            output: text,
            evidence: [...evidence, `Applied ${changed.length} text-patch operation(s).`],
            artifacts: [],
            durationMs: elapsed(),
          };
        } catch {
          const detail =
            'OpenCode stateless output violated the patch contract (details redacted).';
          return {
            // The validated data.text is candidate evidence, not provider error
            // diagnostics. Preserve failed responses for independent review.
            output: text,
            evidence: [...evidence, detail],
            artifacts: [],
            durationMs: elapsed(),
            taskFailure: detail,
          };
        }
      } catch {
        return failure('setup', 'OpenCode stateless setup or transport failed (details redacted).');
      } finally {
        if (cwd) rmSync(cwd, { recursive: true, force: true });
      }
    },
  };
}
