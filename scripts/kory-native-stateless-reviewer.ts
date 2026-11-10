import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  canonicalizePath,
  findExecutableOnPath,
  isContainedBy,
  looksLikePath,
  providerProcessGroupOptions,
  terminateProviderProcessGroup,
} from '../backend/src/runtime/platform';
import { validateAdjudication } from './reviewer-json';
import { parseNativeTextEvents } from './native-text-events';
export { parseNativeTextEvents } from './native-text-events';
import {
  createNativeMacReviewerSandbox,
  NATIVE_MAC_STAGE_MODE,
  type NativeMacReviewerSandbox,
} from './native-reviewer-sandbox';
import { archiveNativeStageBytes, nativeArchiveDirectory } from './native-reviewer-archive';

// Stage-only adapter for the measured CLI flags. This prevents local model-tool
// dispatch/config discovery; it does not assert OS isolation or upstream identity.
export const NATIVE_REVIEW_VERSION = '2.1.309';
// Sealed review packets are larger than candidate text-patch API requests. This
// separate stdin/host-serialization bound never changes the executor's 24k cap.
export const MAX_NATIVE_REVIEW_REQUEST_BYTES = 128_000;
export const MAX_NATIVE_REVIEW_RESPONSE_BYTES = 1_048_576;
const MAX_STDERR_BYTES = 64_000;
const DRAIN_MS = 500;
export const NATIVE_REVIEW_SYSTEM_PROMPT = 'You are an independent artifact reviewer. Use only the anonymous sealed prompt supplied on stdin. Do not use tools, files, inherited context, or outside knowledge to invent verification. Return exactly one JSON object with artifactA and artifactB (passed, quality, verification, integrityFailure, evidence), preference (A, B, or tie), and rationale. No fences or extra prose.';
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
function fail(): never {
  throw new Error('Native stateless reviewer failed (details redacted).');
}

export function parseNativeReviewEvents(bytes: Buffer, model: string): { sessionId: string; output: string } {
  const parsed = parseNativeTextEvents(bytes, model);
  validateAdjudication(parsed.output);
  return parsed;
}

export function nativeReviewerEnvironment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: home,
    CLAUDE_CODE_TMPDIR: join(home, 'temp'),
    TMPDIR: home,
    TMP: home,
    TEMP: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_CACHE_HOME: join(home, 'cache'),
    XDG_STATE_HOME: join(home, 'state'),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
  // --bare uses the explicit API-key route, not Keychain/login/config discovery.
  // AUTH_TOKEN, helpers, NODE_OPTIONS and all ambient provider/settings vars stay out.
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

async function readPrompt(deadline: number): Promise<string> {
  return new Promise((resolvePrompt, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        process.stdin.destroy();
        reject(error);
        return;
      }
      try {
        const prompt = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
        if (!prompt.trim()) fail();
        resolvePrompt(prompt);
      } catch { reject(new Error('Invalid native reviewer stdin (details redacted).')); }
    };
    const timer = setTimeout(() => finish(new Error('Native reviewer stdin exceeded its deadline.')), Math.max(1, deadline - performance.now()));
    process.stdin.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_NATIVE_REVIEW_REQUEST_BYTES) finish(new Error('Native reviewer request exceeds its byte limit; no dispatch.'));
      else chunks.push(chunk);
    });
    process.stdin.on('end', () => finish());
    process.stdin.on('error', () => finish(new Error('Native reviewer stdin failed (details redacted).')));
  });
}

function run(binary: string, args: string[], home: string, env: NodeJS.ProcessEnv,
  timeoutMs: number, limit: number, input?: string, sandbox?: NativeMacReviewerSandbox): Promise<Buffer> {
  if (timeoutMs <= 0) fail();
  const command = sandbox?.command(binary, args) ?? { binary, args };
  return new Promise((resolveRun, reject) => {
    const child = spawn(command.binary, command.args, {
      cwd: home,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...providerProcessGroupOptions(),
      shell: false,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let diagnosticsSize = 0;
    let problem: string | undefined;
    let settled = false;
    let drain: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drain);
      terminateProviderProcessGroup(child.pid);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      if (problem || code !== 0) reject(new Error(problem ?? 'Native reviewer process failed (details redacted).'));
      else resolveRun(Buffer.concat(chunks));
    };
    const stop = (message: string) => {
      problem ??= message;
      if (drain) return;
      drain = setTimeout(() => finish(null), DRAIN_MS);
      terminateProviderProcessGroup(child.pid);
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => stop('Native reviewer exceeded its deadline; local cleanup does not acknowledge upstream cancellation.'), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) stop('Native reviewer response exceeds its byte limit (details redacted).');
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      // Credentials/prompt/provider diagnostics are never retained or published.
      diagnosticsSize += chunk.length;
      if (diagnosticsSize > MAX_STDERR_BYTES) stop('Native reviewer diagnostics exceed their byte limit (details redacted).');
    });
    child.stdin.on('error', () => stop('Native reviewer input failed (details redacted).'));
    child.on('error', () => stop('Native reviewer spawn failed (details redacted).'));
    child.on('close', finish);
    child.stdin.end(input);
  });
}

export async function runNativeStatelessReviewer(): Promise<void> {
  const budget = Number(process.env.KORY_NATIVE_REVIEW_TIMEOUT_MS ?? 300_000);
  if (!Number.isSafeInteger(budget) || budget <= 0 || budget > 550_000) fail();
  const stageMode = process.env.KORY_NATIVE_REVIEW_STAGE_SANDBOX?.trim();
  if (stageMode && stageMode !== NATIVE_MAC_STAGE_MODE) fail();
  if (stageMode && !process.env.HOME?.trim()) fail();
  const archiveConfigured = process.env.KORY_NATIVE_REVIEW_ARCHIVE_DIR?.trim();
  // Archival is an opt-in future stage. Never produce a profile-less archive or
  // weaken this to an unsandboxed fallback; legacy generic routes stay intact.
  if (archiveConfigured && stageMode !== NATIVE_MAC_STAGE_MODE) fail();
  const deadline = performance.now() + budget;
  const prompt = await readPrompt(deadline);
  const model = process.env.KORY_NATIVE_REVIEW_MODEL?.trim();
  if (!model || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,149}$/u.test(model)) fail();
  if (!process.env.ANTHROPIC_API_KEY?.trim()) fail();
  const request = JSON.stringify({ system: NATIVE_REVIEW_SYSTEM_PROMPT, prompt, model });
  const requestBytes = Buffer.byteLength(request);
  if (requestBytes > MAX_NATIVE_REVIEW_REQUEST_BYTES) fail();
  const configured = process.env.KORY_NATIVE_REVIEW_BINARY?.trim() || 'claude';
  const candidate = looksLikePath(configured) ? resolve(configured) : findExecutableOnPath(configured);
  if (!candidate || !statSync(candidate).isFile()) fail();
  accessSync(candidate, constants.X_OK);
  const binary = canonicalizePath(candidate);
  const parent = canonicalizePath(tmpdir());
  for (const root of [process.cwd(), resolve(import.meta.dir, '..')]) {
    if (isContainedBy(canonicalizePath(root), parent)) fail();
  }
  const protectedPaths = [process.cwd(), resolve(import.meta.dir, '..')];
  for (const key of ['HOME', 'USERPROFILE', 'KORYPHAIOS_DATA_DIR', 'KORYPHAIOS_SKILLS_HOME', 'CLAUDE_CONFIG_DIR', 'KORY_NATIVE_REVIEW_PENDING_ROOT']) {
    const path = stageMode ? process.env[key]?.trim() : undefined;
    if (path) {
      if (!existsSync(path)) fail();
      const protectedRoot = canonicalizePath(path);
      if (isContainedBy(protectedRoot, parent)) fail();
      protectedPaths.push(protectedRoot);
    }
  }
  const home = canonicalizePath(mkdtempSync(join(parent, 'kory-native-reviewer-')));
  let sandbox: NativeMacReviewerSandbox | undefined;
  try {
    const archiveDirectory = archiveConfigured
      ? nativeArchiveDirectory(archiveConfigured, home, canonicalizePath(resolve(import.meta.dir, '..')))
      : undefined;
    if (archiveDirectory) protectedPaths.push(archiveDirectory);
    if (stageMode) sandbox = createNativeMacReviewerSandbox(home, protectedPaths);
    const env = nativeReviewerEnvironment(home);
    const version = new TextDecoder('utf-8', { fatal: true }).decode(await run(binary,
      ['--version'], home, env, Math.min(5_000, deadline - performance.now()), 8_192, undefined, sandbox)).trim();
    if (version !== `${NATIVE_REVIEW_VERSION} (Claude Code)`) fail();
    const response = await run(binary, [
      '--bare', '--restricted', '--strict-mcp-config', '--disable-slash-commands',
      '--no-session-persistence', '--tools', '', '--system-prompt', NATIVE_REVIEW_SYSTEM_PROMPT,
      '--model', model, '--output-format', 'stream-json', '--verbose',
      '--max-turns', '1', '--print',
    ], home, env, deadline - performance.now(), MAX_NATIVE_REVIEW_RESPONSE_BYTES, prompt, sandbox);
    const { sessionId, output } = parseNativeReviewEvents(response, model);
    if (archiveDirectory && nativeArchiveDirectory(archiveConfigured!, home, canonicalizePath(resolve(import.meta.dir, '..'))) !== archiveDirectory) fail();
    // Read the actual policy used by sandbox-exec, not a reconstructed profile.
    const profileBytes = sandbox?.readProfileBytes();
    const rawEventArchive = archiveDirectory
      ? archiveNativeStageBytes(archiveDirectory, 'native-cli-events.jsonl', response, MAX_NATIVE_REVIEW_RESPONSE_BYTES)
      : undefined;
    const profileArchive = archiveDirectory && profileBytes
      ? archiveNativeStageBytes(archiveDirectory, 'native-kernel-profile.sb', profileBytes, 64_000)
      : undefined;
    const reviewerId = `native-cli:${sessionId}`;
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      reviewerId,
      completed: true,
      output,
      events: [
        { type: 'review.started', reviewerId },
        { type: 'review.completed', reviewerId, outputSha256: hash(output) },
      ],
      hostReceipt: {
        schemaVersion: 1,
        stageOnly: true,
        identitySource: 'host-observed-native-cli-session-id',
        runtimeVersion: NATIVE_REVIEW_VERSION,
        requestedModel: model,
        observedModel: model,
        boundary: 'native-no-tools-bare-restricted-explicit-stdin',
        tools: [], mcpServers: [], skills: [],
        promptSha256: hash(prompt),
        systemPromptSha256: hash(NATIVE_REVIEW_SYSTEM_PROMPT),
        requestSerialization: 'host-declared-system-prompt-model-not-upstream-wire',
        requestBytes,
        requestSha256: hash(request),
        responseSha256: hash(response),
        responseBytes: response.length,
        rawEventArchive,
        outputSha256: hash(output),
        osIsolationVerified: false,
        kernelStage: sandbox ? {
          mode: sandbox.mode,
          enforcement: 'sandbox-exec',
          readPolicy: 'broad-runtime-reads-with-explicit-canonical-private-root-denies',
          privateRoot: sandbox.privateRoot,
          readDenyRoots: sandbox.readDenyRoots,
          protectedRoots: sandbox.protectedRoots,
          profileSha256: sandbox.profileSha256,
          profileArchive,
          writableRoots: [sandbox.privateRoot],
          writableDevice: '/dev/null',
          universalReadAllowlist: false,
        } : { mode: 'none', enforcement: 'none' },
        upstreamIdentityVerified: false,
        upstreamCancellationAcknowledged: false,
        signed: false,
      },
    })}\n`);
  } finally {
    sandbox?.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  runNativeStatelessReviewer().catch(() => {
    process.stderr.write('kory-native-stateless-reviewer: failed; diagnostics redacted. No completed review emitted.\n');
    process.exitCode = 1;
  });
}
