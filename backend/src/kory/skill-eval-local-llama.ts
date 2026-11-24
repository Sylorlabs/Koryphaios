import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  canonicalizePath,
  findExecutableOnPath,
  isContainedBy,
  looksLikePath,
  providerProcessGroupOptions,
  terminateProviderProcessGroup,
} from '../runtime/platform';
import { osSandboxEnabled, spawnSandboxed } from '../security/os-sandbox';
import type { SkillEvalExecutor, SkillEvalExecutionObservation } from './skill-eval-execution';
import type { SkillInfrastructureFailure } from './skill-evaluations';
import {
  applySkillEvalTextPatch,
  parseSkillEvalTextPatch,
  snapshotSkillEvalWorkspace,
  textPatchPrompt,
} from './skill-eval-text-patch';

// This mode invokes a local, tool-free llama.cpp completion. It is opt-in only.
// Neither a model file name nor a local process receipt attests upstream identity,
// independent blind review, or the quality of any produced candidate.
const INSPECTED_CLI_VERSION = '0.5.0 (build 11146, commit 7fe450e19)';
const MAX_PROMPT_BYTES = 48_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const DEFAULT_MODEL = 'qwen2.5-coder-14b-instruct-q4_k_m';
// Hugging Face Qwen/Qwen2.5-Coder-14B-Instruct-GGUF LFS object digest.
// A caller-provided checksum alone cannot establish the model's identity.
const PINNED_MODEL_SHA256 = 'c1e659736d89ac1065fb495330fb824d94001974a4bfa78e7270e43476a8d940';
const PINNED_MODEL_BYTES = 8_988_110_272;

function unavailable(message: string): Error {
  return new Error(`Local llama text-patch executor is unavailable: ${message}`);
}

function binaryOnPath(name: string): string {
  const candidate = looksLikePath(name) ? resolve(name) : findExecutableOnPath(name);
  if (!candidate) throw unavailable('configured executable not found.');
  try {
    accessSync(candidate, constants.X_OK);
    if (!statSync(candidate).isFile()) throw unavailable('configured executable is not a file.');
    // Preserve the executable's launch path: llama.cpp's Homebrew-linked binary
    // hangs during startup when invoked via its canonical Cellar pathname.
    return candidate;
  } catch {
    throw unavailable('configured executable is not accessible.');
  }
}

function checkVersion(binary: string): void {
  const result = spawnSync(binary, ['--version'], {
    encoding: 'utf8',
    timeout: 20_000,
    maxBuffer: 8_192,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...providerProcessGroupOptions(),
  });
  terminateProviderProcessGroup(result.pid);
  const reportedVersion = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (
    result.error ||
    result.status !== 0 ||
    !reportedVersion.includes(`version: ${INSPECTED_CLI_VERSION}`)
  ) {
    throw unavailable(
      `pinned llama.cpp completion version is not installed (exit ${result.status ?? 'none'}, ` +
        `error ${(result.error as NodeJS.ErrnoException | undefined)?.code ?? 'none'}, ` +
        `matched ${reportedVersion.includes(`version: ${INSPECTED_CLI_VERSION}`)}).`,
    );
  }
}

function verifiedModel(): { path: string; sha256: string; size: number; modified: number } {
  const configured = process.env.KORY_SKILL_EVAL_LLAMA_MODEL_PATH?.trim();
  const expected = process.env.KORY_SKILL_EVAL_LLAMA_MODEL_SHA256?.trim()?.toLowerCase();
  if (!configured || !expected || !/^[0-9a-f]{64}$/u.test(expected)) {
    throw unavailable('set a local model path and its independently obtained SHA-256.');
  }
  if (expected !== PINNED_MODEL_SHA256)
    throw unavailable('model checksum does not match the pinned Qwen GGUF artifact.');
  let path: string;
  let before;
  try {
    path = canonicalizePath(resolve(configured));
    before = statSync(path);
    if (!before.isFile() || before.size !== PINNED_MODEL_BYTES)
      throw unavailable('model size does not match the pinned Qwen GGUF artifact.');
  } catch {
    throw unavailable('model file is unavailable.');
  }
  const shasum = binaryOnPath('shasum');
  const result = spawnSync(shasum, ['-a', '256', path], {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 4_096,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...providerProcessGroupOptions(),
  });
  terminateProviderProcessGroup(result.pid);
  const actual = /^([0-9a-f]{64})\s/u.exec(result.stdout ?? '')?.[1];
  let after;
  try {
    after = statSync(path);
  } catch {
    throw unavailable('model checksum or file stability verification failed.');
  }
  if (
    result.error ||
    result.status !== 0 ||
    actual !== expected ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  ) {
    throw unavailable('model checksum or file stability verification failed.');
  }
  return { path, sha256: actual, size: after.size, modified: after.mtimeMs };
}

// With --no-conversation, llama-completion does not apply the model's chat
// template. Qwen2.5-Coder-Instruct expects these role delimiters explicitly.
// Keeping the assistant prefix open makes the generated bytes a continuation
// of the assistant turn rather than a continuation of the task text.
export function qwenInstructPrompt(prompt: string): string {
  return `<|im_start|>user\n${prompt}\n<|im_end|>\n<|im_start|>assistant\n`;
}

async function runCompletion(
  binary: string,
  args: string[],
  cwd: string,
  budgetMs: number,
  modelPath: string,
): Promise<{
  code: number | null;
  output: Buffer;
  bytes: number;
  sha256: string;
  timedOut: boolean;
  overflow: boolean;
  failed: boolean;
}> {
  return new Promise((resolveResult) => {
    const { proc: child, cleanup } = spawnSandboxed([binary, ...args], {
      cwd,
      allowedRoots: [cwd],
      readOnlyRoots: [modelPath],
      blockNetwork: true,
      blockSubprocesses: true,
      detached: providerProcessGroupOptions().detached,
    });
    const chunks: Buffer[] = [];
    const hash = createHash('sha256');
    let bytes = 0;
    let timedOut = false;
    let overflow = false;
    let failed = false;
    let settled = false;
    let drain: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drain);
      terminateProviderProcessGroup(child.pid);
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      cleanup();
      resolveResult({
        code,
        output: Buffer.concat(chunks),
        bytes,
        sha256: hash.digest('hex'),
        timedOut,
        overflow,
        failed,
      });
    };
    const stop = () => {
      if (drain) return;
      terminateProviderProcessGroup(child.pid);
      child.kill('SIGKILL');
      drain = setTimeout(() => finish(null), 500);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, budgetMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      hash.update(chunk);
      if (bytes <= MAX_RESPONSE_BYTES) chunks.push(chunk);
      else {
        overflow = true;
        stop();
      }
    });
    let stderrBytes = 0;
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 65_536) {
        overflow = true;
        stop();
      }
    });
    child.on('error', () => {
      failed = true;
      stop();
    });
    child.on('close', finish);
  });
}

export function createLocalLlamaTextPatchSkillEvalExecutor(options?: {
  model?: string;
  wallClockMs?: number;
}): SkillEvalExecutor {
  if (!osSandboxEnabled()) throw unavailable('OS-enforced sandbox is unavailable.');
  const binary = binaryOnPath(
    process.env.KORY_SKILL_EVAL_LLAMA_BINARY?.trim() || 'llama-completion',
  );
  checkVersion(binary);
  const model = verifiedModel();
  const name = options?.model ?? DEFAULT_MODEL;
  if (name !== DEFAULT_MODEL)
    throw unavailable('only the pinned Qwen model identity is supported.');
  const wallClockMs = options?.wallClockMs ?? 300_000;
  if (!Number.isSafeInteger(wallClockMs) || wallClockMs < 1 || wallClockMs > 2_147_483_647)
    throw new Error('Local llama wall-clock budget must be a timer-safe positive integer.');
  return {
    id: `local-llama-text-patch:${model.sha256}:${name}`,
    subject: 'other',
    provider: 'local-llama',
    model: name,
    runtimeIdentity: `llama-completion:${INSPECTED_CLI_VERSION}:${model.sha256}:os-sandbox-unsigned-local-v4`,
    tools: ['workspace-snapshot', 'patch-apply'],
    budget: { wallClockMs },
    execute: async ({ scenario, workingDirectory, taskPrompt, skillContext }) => {
      const start = performance.now();
      const elapsed = () => Math.round(performance.now() - start);
      const evidence: string[] = [];
      const fail = (
        kind: SkillInfrastructureFailure['kind'],
        detail: string,
      ): SkillEvalExecutionObservation => ({
        output: '',
        evidence: [...evidence, detail],
        artifacts: [],
        durationMs: elapsed(),
        infrastructureFailure: { kind, detail, retryable: false, evidence: [detail] },
      });
      if (!['repository', 'synthetic', 'cli'].includes(scenario.environment.kind))
        return fail(
          'tool',
          'Local llama patch mode supports repository, synthetic and cli fixtures only.',
        );
      let cwd: string | undefined;
      try {
        const metadata = statSync(model.path);
        if (metadata.size !== model.size || metadata.mtimeMs !== model.modified)
          return fail('setup', 'Verified local model changed since selection.');
        const snapshot = snapshotSkillEvalWorkspace(workingDirectory);
        const prompt = qwenInstructPrompt(textPatchPrompt(taskPrompt, skillContext, snapshot));
        const promptBytes = Buffer.byteLength(prompt, 'utf8');
        if (promptBytes > MAX_PROMPT_BYTES)
          return fail(
            'setup',
            `Local model prompt exceeds conservative ${MAX_PROMPT_BYTES}-byte limit; no generation dispatched.`,
          );
        cwd = mkdtempSync(join(tmpdir(), 'kory-local-llama-'));
        if (isContainedBy(canonicalizePath(workingDirectory), canonicalizePath(cwd)))
          return fail('setup', 'Evaluation workspace must be outside model execution directory.');
        const promptPath = join(cwd, 'prompt.txt');
        writeFileSync(promptPath, prompt, { mode: 0o600, flag: 'wx' });
        if (elapsed() >= wallClockMs) return fail('timeout', 'Setup exhausted local model budget.');
        const result = await runCompletion(
          binary,
          [
            '--model',
            model.path,
            '--file',
            promptPath,
            // llama-completion auto-enables interactive conversation mode for
            // models with a chat template. With stdin ignored, that mode exits
            // successfully without emitting a candidate patch.
            '--no-conversation',
            '--single-turn',
            // On llama-completion 0.5.0, --log-disable also suppresses generated
            // stdout; that produced false successful-but-empty host receipts.
            '--offline',
            '--no-display-prompt',
            '--simple-io',
            '--no-context-shift',
            '--ctx-size',
            '32768',
            '--predict',
            '4096',
            '--temp',
            '0.1',
            '--seed',
            '42',
            '--no-perf',
          ],
          cwd,
          wallClockMs - elapsed(),
          model.path,
        );
        evidence.push(
          `Local llama host receipt: ${JSON.stringify({
            kind: 'host-observed-unsigned',
            boundary: 'os-sandboxed-process-without-tools',
            macReadIsolationAttested: false,
            networkDeniedBySandbox: true,
            modelSha256: model.sha256,
            verifiedModelBytes: model.size,
            cliVersion: INSPECTED_CLI_VERSION,
            upstreamModelIdentityAttested: false,
            requestedModel: name,
            input: {
              sha256: createHash('sha256').update(prompt).digest('hex'),
              bytes: promptBytes,
            },
            output: { sha256: result.sha256, bytes: result.bytes },
            exitCode: result.code,
            complete: !result.timedOut && !result.overflow && !result.failed && result.code === 0,
          })}`,
        );
        if (result.timedOut)
          return fail('timeout', 'Local llama completion exceeded wall-clock budget.');
        if (result.overflow || result.failed || result.code !== 0)
          return fail(
            'provider',
            'Local llama completion failed or exceeded output budget; diagnostics redacted.',
          );
        const output = new TextDecoder('utf-8', { fatal: true }).decode(result.output);
        try {
          const patch = parseSkillEvalTextPatch(output);
          const changed = applySkillEvalTextPatch(workingDirectory, patch.operations);
          return {
            output,
            evidence: [...evidence, `Applied ${changed.length} patch operations.`],
            artifacts: [],
            durationMs: elapsed(),
          };
        } catch {
          const detail = 'Local llama output violated the patch contract; diagnostics redacted.';
          return {
            output,
            evidence: [...evidence, detail],
            artifacts: [],
            durationMs: elapsed(),
            taskFailure: detail,
          };
        }
      } catch {
        return fail('setup', 'Local llama setup or transport failed; diagnostics redacted.');
      } finally {
        if (cwd) rmSync(cwd, { recursive: true, force: true });
      }
    },
  };
}
