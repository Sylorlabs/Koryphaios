// Official Omnirush CLI transport. Model limits/efforts come from the CLI-owned
// catalog. Omnirush 1.x exposed that catalog over RPC; current 2.x releases
// cache it as model-catalog.json and expose GPT turns through --print. Claude
// models use the normal managed engine because Omnirush deliberately refuses
// Claude in --print mode. Kory tools use a per-turn OpenCode custom-tool plugin
// on both paths because the managed engine denies ambient MCP/native authority.
import type { ModelDef, ProviderConfig } from '@koryphaios/shared';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  closeSync,
  copyFileSync,
  cpSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPrivateCliTextArtifact, type PrivateCliArtifact } from './private-cli-transport';
import { buildProviderCliEnv } from './cli-environment';
import { detectOmnirushCLILogin, omnirushStateDirectory } from './auth-utils';
import { buildKoryCliMcpConfig } from './kory-cli-mcp-config';
import { createKoryBridgeGrantLease, type KoryBridgeGrantLease } from './bridge-grant';
import {
  createOmnirushKoryToolsArtifact,
  type OmnirushKoryToolsArtifact,
} from './omnirush-kory-tools';
import { KORY_HARNESS_NOTE_EXTENDED } from './cli-bridges';
import {
  hasHardLinks,
  hasUnexpectedOwner,
  findExecutableOnPath,
  isContainedBy,
  providerProcessGroupOptions,
  terminateProviderProcessGroup,
  hostOS,
} from '../runtime/platform';
import {
  appendPrivateDiagnostic,
  isTransientStreamErrorText,
  safeProviderDiagnostic,
  safeProviderFailureMessage,
} from './provider-diagnostics';
import { recordedToolOutput } from './recorded-tool';
import type { Provider, ProviderEvent, StreamRequest } from './types';

const CATALOG_TTL_MS = 5 * 60_000;
const RPC_TIMEOUT_MS = 20_000;
const TURN_TIMEOUT_MS = 300_000;
const UPDATE_TIMEOUT_MS = 120_000;
const PRINT_TEARDOWN_TIMEOUT_MS = 1_000;
const RPC_TEARDOWN_TIMEOUT_MS = 1_000;
const MAX_FRAME_CHARS = 16 * 1024 * 1024;
const RUNTIME_PROBE_TIMEOUT_MS = 8_000;
const MAX_INTERACTIVE_PROMPT_CHARS = 120_000;
const INTERACTIVE_ENGINE_START_WAIT_MS = 15_000;
const OMNIRUSH_REGISTRY = 'https://registry.npmjs.org';
type Row = Record<string, any>;

/** Resolve the provider turn budget from the host-owned request budget. */
export function resolveOmnirushTurnTimeoutMs(request: Pick<StreamRequest, 'sandbox'>): number {
  const seconds = request.sandbox?.maxRuntimeSeconds;
  return Number.isFinite(seconds) && seconds !== undefined && seconds > 0
    ? seconds * 1000
    : TURN_TIMEOUT_MS;
}

/**
 * Immutable process boundary for a qualification run. The auth directory is a
 * path only; credentials are owned by the CLI and never enter this value or its
 * identity string.
 */
export interface OmnirushRuntimeBinding {
  readonly binary: string;
  readonly stateRoot: string;
  readonly version: string;
  readonly launcherDigest: string;
  readonly identity: string;
}

function isInternalOmnirushEngine(binary: string): boolean {
  // The platform package ships an internal engine below this path. It is not
  // the repository-supported `omnirush` launcher and must never become the
  // provider transport merely because it is executable.
  return /(?:^|\/)@omnirush-ai\/cli-[^/]+\/bin(?:\/|$)/u.test(binary.replaceAll('\\', '/'));
}

function resolveOmnirushLauncher(pathEnv = process.env.PATH): string | null {
  const candidate = findExecutableOnPath('omnirush', pathEnv);
  if (!candidate || isInternalOmnirushEngine(candidate)) return null;
  return resolve(candidate);
}

function usableOmnirushStateRoot(stateRoot: string): string {
  const root = resolve(stateRoot);
  try {
    const rootMetadata = statSync(root);
    const authPath = join(root, 'auth.json');
    const authMetadata = statSync(authPath);
    accessSync(authPath);
    if (!rootMetadata.isDirectory() || !authMetadata.isFile()) throw new Error('invalid state');
  } catch {
    throw new Error('Omnirush CLI auth state is unavailable.');
  }
  return root;
}

function launcherDigest(binary: string): string {
  try {
    return createHash('sha256').update(readFileSync(binary)).digest('hex');
  } catch {
    throw new Error('Omnirush CLI launcher is unavailable.');
  }
}

function probeOmnirush(binary: string, args: string[], stateRoot: string): string {
  const result = spawnSync(binary, args, {
    env: buildProviderCliEnv('omnirush', omnirushReleaseEnvironment(stateRoot, true)),
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: RUNTIME_PROBE_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error('Omnirush CLI verification failed.');
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
  if (!output || /not authenticated|not logged in|logged out|login required/iu.test(output)) {
    throw new Error('Omnirush CLI authentication verification failed.');
  }
  return output;
}

function probeOmnirushVersion(binary: string, stateRoot: string): string {
  return probeOmnirush(binary, ['--version'], stateRoot);
}

/** Resolve and verify the exact launcher/auth root once for qualification. */
export function resolveOmnirushRuntimeBinding(options?: {
  pathEnv?: string;
  stateRoot?: string;
}): OmnirushRuntimeBinding {
  const binary = resolveOmnirushLauncher(options?.pathEnv);
  if (!binary) throw new Error('Omnirush repository-supported launcher is unavailable.');
  const stateRoot = usableOmnirushStateRoot(options?.stateRoot ?? omnirushStateDirectory());
  const version = probeOmnirushVersion(binary, stateRoot);
  // `whoami` is deliberately checked on the exact path and bound state root.
  // Its output is only used as a non-empty/authenticated signal and is never
  // included in an error, receipt, or runtime identity.
  probeOmnirush(binary, ['whoami'], stateRoot);
  const digest = launcherDigest(binary);
  const stateDigest = createHash('sha256').update(stateRoot).digest('hex').slice(0, 16);
  return Object.freeze({
    binary,
    stateRoot,
    version,
    launcherDigest: digest,
    identity: `omnirush-cli:${version}:launcher-${digest.slice(0, 16)}:state-${stateDigest}`,
  });
}

/** Fail closed if a qualification-bound launcher changed before dispatch. */
export function assertOmnirushRuntimeBinding(binding: OmnirushRuntimeBinding): void {
  if (resolve(binding.binary) !== binding.binary || isInternalOmnirushEngine(binding.binary)) {
    throw new Error('Omnirush qualification runtime identity changed; refusing to dispatch.');
  }
  if (launcherDigest(binding.binary) !== binding.launcherDigest) {
    throw new Error('Omnirush qualification runtime identity changed; refusing to dispatch.');
  }
  if (probeOmnirushVersion(binding.binary, binding.stateRoot) !== binding.version) {
    throw new Error('Omnirush qualification runtime identity changed; refusing to dispatch.');
  }
  usableOmnirushStateRoot(binding.stateRoot);
}

/** Version-only identity used by normal diagnostics and qualification provenance. */
export function omnirushCliRuntimeIdentity(binding?: OmnirushRuntimeBinding): string {
  if (binding) return binding.identity;
  const binary = resolveOmnirushLauncher();
  if (!binary) throw new Error('Omnirush CLI not found on PATH.');
  const stateRoot = resolve(omnirushStateDirectory());
  const version = probeOmnirushVersion(binary, stateRoot);
  const digest = launcherDigest(binary);
  const stateDigest = createHash('sha256').update(stateRoot).digest('hex').slice(0, 16);
  return `omnirush-cli:${version}:launcher-${digest.slice(0, 16)}:state-${stateDigest}`;
}

let omnirushUpdateInFlight: Promise<boolean> | null = null;
let omnirushRpcConfigTail = Promise.resolve();

function acquireOmnirushRpcConfigLease(signal?: AbortSignal): Promise<(() => void) | undefined> {
  const previous = omnirushRpcConfigTail;
  let release!: () => void;
  omnirushRpcConfigTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  if (!signal) return previous.then(() => release);
  return new Promise<(() => void) | undefined>((resolve) => {
    let cancelled = false;
    let listenerRemoved = false;
    const removeListener = () => {
      if (listenerRemoved) return;
      listenerRemoved = true;
      signal.removeEventListener('abort', onAbort);
    };
    const handoffAfterPrevious = () => {
      void previous.then(() => release());
    };
    const onAbort = () => {
      if (cancelled) return;
      cancelled = true;
      removeListener();
      handoffAfterPrevious();
      resolve(undefined);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void previous.then(() => {
      if (cancelled) return;
      removeListener();
      resolve(release);
    });
    if (signal.aborted) onAbort();
  });
}

function omnirushReleaseEnvironment(
  authDirectory: string,
  bindStateRoot = false,
  includeDocker = false,
): NodeJS.ProcessEnv {
  const packageRoot = process.env.OMNIRUSH_PACKAGE_ROOT?.trim();
  const releaseBinary = process.env.OMNIRUSH_OPENCODE_BIN?.trim();
  return {
    OMNIRUSH_DIR: authDirectory,
    OMNIRUSH_AGENT_DIR: bindStateRoot
      ? join(authDirectory, 'agent')
      : process.env.OMNIRUSH_AGENT_DIR?.trim() || join(authDirectory, 'agent'),
    OMNIRUSH_AUTO_UPDATE: '0',
    // The RPC protocol is part of the installed CLI generation. Do not let the
    // launcher silently hand this process to a newer print-only release.
    OMNIRUSH_UPDATE_DELEGATED: '1',
    ...(releaseBinary
      ? {
          OMNIRUSH_OPENCODE_BIN: releaseBinary,
        }
      : {}),
    ...(process.env.OMNIRUSH_OPENCODE_CWD
      ? { OMNIRUSH_OPENCODE_CWD: process.env.OMNIRUSH_OPENCODE_CWD }
      : {}),
    ...(packageRoot ? { OMNIRUSH_PACKAGE_ROOT: packageRoot } : {}),
    ...(process.env.OMNIRUSH_CODING_AGENT_DIR
      ? { OMNIRUSH_CODING_AGENT_DIR: process.env.OMNIRUSH_CODING_AGENT_DIR }
      : {}),
    ...(process.env.OMNIRUSH_ENGINE_VERSION
      ? { OMNIRUSH_ENGINE_VERSION: process.env.OMNIRUSH_ENGINE_VERSION }
      : {}),
    ...(process.env.OMNIRUSH_VERSION ? { OMNIRUSH_VERSION: process.env.OMNIRUSH_VERSION } : {}),
    ...(process.env.OMNIRUSH_GATEWAY_URL
      ? { OMNIRUSH_GATEWAY_URL: process.env.OMNIRUSH_GATEWAY_URL }
      : {}),
    ...(process.env.OMNIRUSH_ORIGIN ? { OMNIRUSH_ORIGIN: process.env.OMNIRUSH_ORIGIN } : {}),
    ...(process.env.OMNIRUSH_PROJECT_CONFIG_DIR
      ? { OMNIRUSH_PROJECT_CONFIG_DIR: process.env.OMNIRUSH_PROJECT_CONFIG_DIR }
      : {}),
    ...(includeDocker ? omnirushDockerEnvironment() : {}),
    // Kory's disposable OpenCode project contains the provider-owned plugin;
    // without this gate the 2.x engine intentionally ignores project plugins.
    ...(process.env.OMNIRUSH_PROJECT_CODE
      ? { OMNIRUSH_PROJECT_CODE: process.env.OMNIRUSH_PROJECT_CODE }
      : {}),
    ...(process.env.PI_CODING_AGENT_DIR
      ? { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR }
      : {}),
    PI_OFFLINE: '1',
    PI_TELEMETRY: '0',
  };
}

/**
 * A per-turn HOME intentionally hides the user's Docker config. Preserve only
 * the active daemon endpoint so the normal Omnirush launcher can bring up its
 * sandbox without inheriting registry credentials or unrelated Docker context
 * state. Context inspection is best effort; a missing runtime is reported by
 * Omnirush's own sandbox diagnostics.
 */
function omnirushDockerEnvironment(): NodeJS.ProcessEnv {
  const configured = process.env.DOCKER_HOST?.trim();
  if (configured) return { DOCKER_HOST: configured };
  const docker = findExecutableOnPath('docker');
  if (docker) {
    const result = spawnSync(
      docker,
      ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
      {
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
        timeout: 2_000,
        maxBuffer: 16 * 1024,
      },
    );
    const host = typeof result.stdout === 'string' ? result.stdout.trim() : '';
    if (
      (/^unix:\/\//u.test(host) && existsSync(host.slice('unix://'.length))) ||
      /^(?:npipe|tcp):\/\//u.test(host)
    )
      return { DOCKER_HOST: host };
  }
  const colima = findExecutableOnPath('colima');
  if (!colima) return {};
  const result = spawnSync(colima, ['status', '--json'], {
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf8',
    timeout: 2_000,
    maxBuffer: 32 * 1024,
  });
  try {
    const socket = JSON.parse(typeof result.stdout === 'string' ? result.stdout : '').docker_socket;
    if (
      typeof socket === 'string' &&
      /^unix:\/\//u.test(socket) &&
      existsSync(socket.slice('unix://'.length))
    )
      return { DOCKER_HOST: socket };
  } catch {
    // The Omnirush sandbox will report the unavailable runtime with its normal
    // diagnostic if the host runtime is not installed or has no JSON status.
  }
  return {};
}

export function parseOmnirushContainerArchitecture(value: string): 'amd64' | 'arm64' | null {
  const normalized = value.trim().toLowerCase();
  if (/^(?:amd64|x86_64|x86-64)$/u.test(normalized)) return 'amd64';
  if (/^(?:arm64|aarch64)$/u.test(normalized)) return 'arm64';
  return null;
}

function omnirushContainerArchitecture(): 'amd64' | 'arm64' {
  const docker = findExecutableOnPath('docker');
  const dockerEnvironment = omnirushDockerEnvironment();
  if (docker) {
    const result = spawnSync(docker, ['info', '--format', '{{.Architecture}}'], {
      env: { ...process.env, ...dockerEnvironment },
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 16 * 1024,
    });
    const architecture = parseOmnirushContainerArchitecture(
      typeof result.stdout === 'string' ? result.stdout : '',
    );
    if (architecture) return architecture;
  }
  return process.arch === 'x64' ? 'amd64' : 'arm64';
}

function stopOmnirushDockerBox(workspace: string): void {
  const docker = findExecutableOnPath('docker');
  if (!docker) return;
  const listed = spawnSync(
    docker,
    ['ps', '-aq', '--filter', `label=ai.omnirush.box.root=${workspace}`],
    {
      env: { ...process.env, ...omnirushDockerEnvironment() },
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 16 * 1024,
    },
  );
  const ids = typeof listed.stdout === 'string' ? listed.stdout.split(/\s+/u).filter(Boolean) : [];
  if (!ids.length) return;
  spawnSync(docker, ['rm', '-f', ...ids], {
    env: { ...process.env, ...omnirushDockerEnvironment() },
    stdio: 'ignore',
    timeout: 10_000,
  });
}

/**
 * Ensure the helper set matches the Linux runtime that Omnirush selected.
 * macOS installs commonly contain only linux-arm64 while Colima runs an x64
 * VM, so relying on the host package silently disables the sandbox. Download
 * the exact CLI-version helper package, verify npm's published integrity, and
 * expose it through Omnirush's supported helper override.
 */
export async function ensureOmnirushBoxHelpers(
  binary: string,
  stateRoot: string,
  signal?: AbortSignal,
): Promise<string> {
  const versionOutput = probeOmnirushVersion(binary, stateRoot);
  const version = /\b(\d+\.\d+\.\d+)\b/u.exec(versionOutput)?.[1];
  if (!version)
    throw new Error('Could not determine the installed Omnirush version for sandbox helpers.');
  const architecture = omnirushContainerArchitecture();
  const relative = `linux-${architecture}`;
  const helperRoot = join(stateRoot, 'box-helpers', version, 'box');
  const helperFiles = ['boxd', 'boxrun', 'boxsh'].map((name) => join(helperRoot, relative, name));
  if (helperFiles.every((file) => existsSync(file))) return helperRoot;
  if (signal?.aborted) throw new Error('Omnirush request cancelled.');

  const packageName = `@omnirush-ai/cli-linux-${architecture === 'amd64' ? 'x64' : 'arm64'}`;
  const encodedName = packageName.replace('/', '%2f');
  const metadataResponse = await fetch(
    `${OMNIRUSH_REGISTRY}/${encodedName}/${encodeURIComponent(version)}`,
    { headers: { accept: 'application/json' }, signal: signal ?? AbortSignal.timeout(30_000) },
  );
  if (!metadataResponse.ok) {
    await metadataResponse.body?.cancel().catch(() => undefined);
    throw new Error(`Omnirush sandbox helper package ${packageName}@${version} is unavailable.`);
  }
  const metadata = (await metadataResponse.json()) as Row;
  const tarball = metadata.dist?.tarball;
  const integrity = metadata.dist?.integrity;
  if (
    typeof tarball !== 'string' ||
    typeof integrity !== 'string' ||
    !/^sha512-[A-Za-z0-9+/=]+$/u.test(integrity)
  )
    throw new Error('Omnirush sandbox helper package metadata is invalid.');

  const tarResponse = await fetch(tarball, {
    redirect: 'error',
    signal: signal ?? AbortSignal.timeout(120_000),
  });
  if (!tarResponse.ok || !tarResponse.body)
    throw new Error(`Could not download Omnirush sandbox helpers (${tarResponse.status}).`);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of tarResponse.body) {
    bytes += chunk.byteLength;
    if (bytes > 256 * 1024 * 1024)
      throw new Error('Omnirush sandbox helper download is too large.');
    chunks.push(chunk);
  }
  const archive = Buffer.concat(chunks);
  const actualIntegrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`;
  if (actualIntegrity !== integrity)
    throw new Error('Omnirush sandbox helper integrity verification failed.');

  const staging = join(
    stateRoot,
    'box-helpers',
    `.staging-${process.pid}-${randomBytes(8).toString('hex')}`,
  );
  try {
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    const archivePath = join(staging, 'package.tgz');
    writeFileSync(archivePath, archive, { mode: 0o600 });
    const extracted = spawnSync(
      'tar',
      ['-xzf', archivePath, '-C', staging, `package/box/${relative}`],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 64 * 1024,
      },
    );
    if (extracted.error || extracted.status !== 0)
      throw new Error('Could not unpack Omnirush sandbox helpers.');
    const source = join(staging, 'package', 'box', relative);
    mkdirSync(join(helperRoot, relative), { recursive: true, mode: 0o700 });
    for (const name of ['boxd', 'boxrun', 'boxsh']) {
      const sourceFile = join(source, name);
      const targetFile = join(helperRoot, relative, name);
      if (!existsSync(sourceFile))
        throw new Error(`Downloaded Omnirush package lacks ${relative}/${name}.`);
      copyFileSync(sourceFile, targetFile);
      chmodSync(targetFile, 0o700);
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  if (!helperFiles.every((file) => existsSync(file)))
    throw new Error('Omnirush sandbox helpers were not installed completely.');
  return helperRoot;
}

function isOmnirushStartupFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /initiali[sz]ation timed out|RPC (?:initiali[sz]ation|transport|input pipe|closed)|could not be started|closed before completion|invalid protocol|did not accept/i.test(
    message,
  );
}

/** Older Omnirush launchers print this to stderr and exit before the normal
 * RPC/print protocol can start. Treat it as a compatibility failure, not as a
 * user-facing model error: the provider owns the CLI and can perform its
 * already-supported self-update once, then retry the same request. */
function isOmnirushUpdateRequired(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  // This is the exact one-shot output of the 2.x update gate. Do not infer an
  // update from arbitrary model/provider text (or execute a command copied
  // from that text). The gate has already performed the CLI-owned update and
  // explicitly says that this request was not started again.
  const installed =
    /^omnirush\s+\d+\.\d+\.\d+\s+is installed\. This run was not started again(?:; it stopped in session (ses_[A-Za-z0-9]+)\. Go on with it: omnirush -s (ses_[A-Za-z0-9]+))?\.$/im.exec(
      message,
    );
  if (!installed) return false;
  return !installed[1] || installed[1] === installed[2];
}

type OmnirushPrintUsage = {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
};

type OmnirushPrintTelemetry = {
  model?: string;
  usage?: OmnirushPrintUsage;
  text?: string;
  partId?: string;
  toolActivity?: boolean;
};

type OmnirushEngineTelemetry = OmnirushPrintTelemetry & {
  complete?: boolean;
  error?: string;
  tool?: {
    id?: string;
    name?: string;
    input?: unknown;
    output?: unknown;
    isError?: boolean;
  };
};

/**
 * OpenCode's supported plugin event hook gives the 2.x print launcher a
 * private, structured usage side channel. The launcher itself deliberately
 * exposes only final text on stdout, so this is kept separate from the text
 * stream and is never treated as a token estimate.
 */
export function parseOmnirushPrintTelemetry(value: unknown): OmnirushPrintTelemetry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Row;
  const info = row.info && typeof row.info === 'object' ? row.info : {};
  const part = row.part && typeof row.part === 'object' ? row.part : {};
  const model = [info.modelID, info.modelId, info.model].find(
    (candidate) => typeof candidate === 'string' && candidate.trim(),
  ) as string | undefined;
  const text =
    typeof part.text === 'string'
      ? part.text
      : typeof part.delta === 'string'
        ? part.delta
        : undefined;
  const partId = typeof part.id === 'string' ? part.id : undefined;
  const raw = info.tokens ?? info.usage;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return typeof part.type === 'string' && /tool/i.test(part.type)
      ? { ...(model ? { model } : {}), toolActivity: true }
      : model
        ? { model, ...(text !== undefined ? { text } : {}), ...(partId ? { partId } : {}) }
        : text !== undefined
          ? { text, ...(partId ? { partId } : {}) }
          : null;
  }
  const tokens = raw as Row;
  const cache = tokens.cache && typeof tokens.cache === 'object' ? tokens.cache : {};
  const number = (...candidates: unknown[]) => {
    const candidate = candidates.find(
      (entry) => typeof entry === 'number' && Number.isFinite(entry) && entry >= 0,
    );
    return typeof candidate === 'number' ? candidate : undefined;
  };
  const input = number(tokens.input, tokens.input_tokens, tokens.prompt_tokens);
  const output = number(tokens.output, tokens.output_tokens, tokens.completion_tokens);
  if (input === undefined && output === undefined) {
    return typeof part.type === 'string' && /tool/i.test(part.type)
      ? { ...(model ? { model } : {}), toolActivity: true }
      : model
        ? { model, ...(text !== undefined ? { text } : {}), ...(partId ? { partId } : {}) }
        : text !== undefined
          ? { text, ...(partId ? { partId } : {}) }
          : null;
  }
  const cacheRead = number(cache.read, tokens.cache_read, tokens.cache_read_input_tokens);
  const cacheWrite = number(cache.write, tokens.cache_write, tokens.cache_creation_input_tokens);
  return {
    ...(model ? { model } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(partId ? { partId } : {}),
    usage: {
      input: input ?? 0,
      output: output ?? 0,
      ...(cacheRead !== undefined ? { cacheRead } : {}),
      ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    },
  };
}

/**
 * The normal OpenCode engine emits the same info/part records as print mode,
 * plus session.idle and tool-part state transitions. Keep this parser narrow:
 * it accepts only fields needed by the provider stream and never forwards an
 * engine event or a native tool payload wholesale.
 */
export function parseOmnirushEngineTelemetry(value: unknown): OmnirushEngineTelemetry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Row;
  const properties = row.properties && typeof row.properties === 'object' ? row.properties : {};
  const info = row.info && typeof row.info === 'object' ? row.info : properties.info;
  const part = row.part && typeof row.part === 'object' ? row.part : properties.part;
  const eventType = [row.type, row.event, properties.type].find(
    (candidate) => typeof candidate === 'string',
  ) as string | undefined;
  const rawError = [row.error, properties.error, row.message, properties.message].find(
    (candidate) => typeof candidate === 'string' && candidate.trim(),
  ) as string | undefined;
  const base = parseOmnirushPrintTelemetry({ info, part });
  const terminal = /session\.idle|session\.completed|turn\.completed|agent_(?:end|settled)/i.test(
    eventType ?? '',
  );
  const failed = /error|failed|rejected/i.test(eventType ?? '') && rawError;
  if (!base && !terminal && !failed) return null;

  const result: OmnirushEngineTelemetry = { ...(base ?? {}) };
  if (terminal) result.complete = true;
  if (failed) result.error = rawError.slice(0, 500).replace(/\s+/g, ' ').trim();
  if (part && typeof part === 'object') {
    const state = part.state && typeof part.state === 'object' ? part.state : {};
    const kind = [part.type, part.kind, part.toolName, state.status].find(
      (candidate) => typeof candidate === 'string',
    ) as string | undefined;
    if (kind && /tool|function/i.test(kind)) {
      const input = state.input ?? part.input ?? part.args ?? part.arguments;
      const output = state.output ?? part.output ?? part.result;
      const status = String(state.status ?? part.status ?? '').toLowerCase();
      result.toolActivity = true;
      if (/complete|success|error|failed/.test(status)) {
        result.tool = {
          id:
            typeof part.callID === 'string'
              ? part.callID
              : typeof part.id === 'string'
                ? part.id
                : undefined,
          name:
            typeof part.tool === 'string'
              ? part.tool
              : typeof part.toolName === 'string'
                ? part.toolName
                : typeof part.name === 'string'
                  ? part.name
                  : undefined,
          input,
          output,
          isError: /error|failed/.test(status),
        };
      }
    }
  }
  return result;
}

function omnirushTelemetryPluginSource(eventsPath: string): string {
  return `import { appendFileSync } from "node:fs";
const eventsPath = ${JSON.stringify(eventsPath)};
const record = (event) => {
  const properties = event && typeof event === "object" && event.properties && typeof event.properties === "object"
    ? event.properties : {};
  const info = properties.info && typeof properties.info === "object" ? properties.info :
    event && typeof event === "object" && event.info && typeof event.info === "object" ? event.info : null;
  const rawPart = properties.part && typeof properties.part === "object" ? properties.part :
    event && typeof event === "object" && event.part && typeof event.part === "object" ? event.part : null;
  const eventType = event && typeof event === "object" && typeof event.type === "string" ? event.type :
    typeof properties.type === "string" ? properties.type : null;
  const rawError = event && typeof event === "object" && typeof event.error === "string" ? event.error :
    typeof properties.error === "string" ? properties.error :
    event && typeof event === "object" && typeof event.message === "string" ? event.message :
    typeof properties.message === "string" ? properties.message : null;
  const terminal = typeof eventType === "string" && /session\\.idle|session\\.completed|turn\\.completed|agent_(?:end|settled)/i.test(eventType);
  const failed = typeof eventType === "string" && /error|failed|rejected/i.test(eventType) && rawError;
  if (!info && !rawPart && !terminal && !failed) return;
  const state = rawPart?.state && typeof rawPart.state === "object" ? rawPart.state : null;
  const part = rawPart ? {
    id: rawPart.id, callID: rawPart.callID, type: rawPart.type, kind: rawPart.kind,
    text: rawPart.text, delta: rawPart.delta, tool: rawPart.tool, toolName: rawPart.toolName,
    name: rawPart.name, input: rawPart.input, args: rawPart.args, arguments: rawPart.arguments,
    output: rawPart.output, result: rawPart.result,
    state: state ? { status: state.status, input: state.input, output: state.output } : undefined,
  } : null;
  const safeInfo = info ? {
    modelID: info.modelID,
    modelId: info.modelId,
    model: info.model,
    tokens: info.tokens,
    usage: info.usage,
  } : null;
  try { appendFileSync(eventsPath, JSON.stringify({ type: eventType, error: rawError?.slice(0, 500), info: safeInfo, part }) + "\\n", { mode: 0o600 }); } catch {}
};
export default async function OmnirushTelemetry() {
  return { event: async ({ event }) => record(event) };
}
`;
}

export function isOmnirushSeatWait(value: string): boolean {
  return /\bwaiting\s+for\s+(?:an?\s+)?(?:available\s+)?seat\b/i.test(value);
}

/** Update only when the installed CLI has failed its RPC compatibility probe. */
export function updateOmnirushCli(
  binary: string,
  stateRoot: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return Promise.reject(new Error('Omnirush request cancelled.'));
  if (!omnirushUpdateInFlight) {
    omnirushUpdateInFlight = new Promise<boolean>((resolve) => {
      const child = spawn(binary, ['update', '--self', '--no-approve'], {
        cwd: process.cwd(),
        env: buildProviderCliEnv('omnirush', {
          ...omnirushReleaseEnvironment(stateRoot),
          // Updating is explicit here; do not launch a second background updater.
          OMNIRUSH_AUTO_UPDATE: '0',
          OMNIRUSH_UPDATE_DELEGATED: '1',
        }),
        stdio: ['ignore', 'ignore', 'pipe'],
        ...providerProcessGroupOptions(),
      });
      let settled = false;
      let spawnFailed = false;
      const finish = (success: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(success);
      };
      const timer = setTimeout(() => {
        terminateProviderProcessGroup(child.pid);
      }, UPDATE_TIMEOUT_MS);
      child.once('error', () => {
        spawnFailed = true;
      });
      child.once('close', (code) => finish(!spawnFailed && code === 0));
    }).finally(() => {
      omnirushUpdateInFlight = null;
    });
  }
  const update = omnirushUpdateInFlight;
  if (!signal) return update;
  return new Promise<boolean>((resolve, reject) => {
    const abort = () => reject(new Error('Omnirush request cancelled.'));
    signal.addEventListener('abort', abort, { once: true });
    update.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
    if (signal.aborted) abort();
  });
}

/**
 * Omnirush's extension reads MCP configuration from its real CLI state root.
 * That root intentionally remains outside Koryphaios-managed storage so the
 * CLI can atomically refresh its own auth.json. Keep the exception narrow: only
 * the exact state root may be used, and the config file is still written as a
 * private, no-follow atomic replacement.
 */
function writeOmnirushCliOwnedFile(path: string, content: string, stateRoot: string): void {
  const root = resolve(stateRoot);
  const target = resolve(path);
  if (!isContainedBy(root, target) || dirname(target) !== root) {
    throw new Error('Omnirush CLI config escaped its CLI-owned state root');
  }
  const rootMetadata = lstatSync(root);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error('Omnirush CLI state root is not a real directory');
  }
  if (hasUnexpectedOwner(rootMetadata)) {
    throw new Error('Omnirush CLI state root has an unexpected owner');
  }
  if (existsSync(target)) {
    const metadata = lstatSync(target);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error('Omnirush CLI config target is not a regular file');
    }
    if (hasUnexpectedOwner(metadata) || hasHardLinks(metadata)) {
      throw new Error('Omnirush CLI config target is not privately owned');
    }
  }

  const temp = resolve(
    root,
    `.mcp.json.kory-write-${process.pid}-${randomBytes(12).toString('hex')}`,
  );
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let fd: number | null = null;
  let renamed = false;
  try {
    fd = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600,
    );
    writeFileSync(fd, content, { encoding: 'utf8' });
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temp, target);
    renamed = true;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the original write error.
      }
    }
    if (!renamed) {
      try {
        unlinkSync(temp);
      } catch {
        // Preserve the original write error.
      }
    }
  }
}

function parseSize(value: string): number {
  const match = /^([0-9]+(?:\.[0-9]+)?)([KMG])?$/i.exec(value.trim());
  if (!match) return 0;
  const amount = Number(match[1]);
  const multiplier = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[match[2]?.toLowerCase() ?? ''] ?? 1;
  const result = Math.round(amount * multiplier);
  return Number.isSafeInteger(result) && result > 0 ? result : 0;
}

/** Parse the human-readable catalog printed by `omnirush --list-models`.
 * This is kept as a compatibility parser for diagnostics and older CLIs. The
 * provider still uses the RPC catalog for model metadata and effort levels. */
export function parseOmnirushModelList(value: string): ModelDef[] {
  const models: ModelDef[] = [];
  for (const line of value.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 6 || columns[0] !== 'omnirush' || columns[1] === 'model') continue;
    const [provider, id, context, output, thinking, images] = columns;
    if (!id || !context || !output) continue;
    models.push({
      id,
      apiModelId: id,
      name: id,
      provider,
      contextWindow: parseSize(context),
      contextVerified: parseSize(context) > 0,
      maxOutputTokens: parseSize(output),
      canReason: thinking.toLowerCase() === 'yes',
      reasoningLevels: [],
      vision: images.toLowerCase() === 'yes',
      supportsAttachments: images.toLowerCase() === 'yes',
      supportsStreaming: true,
      functionCall: true,
    });
  }
  return models;
}

/** Extract the effort values advertised by an installed CLI help surface. */
export function parseOmnirushThinkingLevels(value: string): string[] {
  const match = /(?:thinking\s+(?:level|levels)|effort(?:\s+levels?)?)\s*:\s*([^\n\r]+)/i.exec(
    value,
  );
  if (!match) return [];
  return [
    ...new Set(
      match[1]
        .split(/[,|]/)
        .map((level) => level.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

function reportedReasoningLevels(row: Row): string[] {
  const map = row.thinkingLevelMap;
  const mapLevels =
    map && typeof map === 'object' && !Array.isArray(map)
      ? Object.entries(map)
          .filter(([, value]) => typeof value === 'string')
          .map(([key]) => key)
      : [];
  const arrayLevels = [
    row.reasoningLevels,
    row.thinkingLevels,
    row.supportedReasoningEfforts,
    row.reasoningEfforts,
  ].find((levels) => Array.isArray(levels)) as unknown;
  const levels = Array.isArray(arrayLevels)
    ? arrayLevels.filter((level): level is string => typeof level === 'string')
    : [];
  return [...new Set([...mapLevels, ...levels])];
}

/**
 * Keep the value shown to Koryphaios separate from the value sent to the CLI.
 * Omnirush can expose provider-specific states through thinkingLevelMap (for
 * example, `balanced` -> `deliberate`) and those states must not be reduced to
 * Koryphaios's standard low/medium/high vocabulary.
 */
function reportedReasoningVariants(row: Row): Record<string, string> {
  const variants: Record<string, string> = {};
  const map = row.thinkingLevelMap;
  if (map && typeof map === 'object' && !Array.isArray(map)) {
    for (const [label, native] of Object.entries(map)) {
      if (typeof native !== 'string' || !label.trim() || !native.trim()) continue;
      // Omnirush 1.0.2 advertises `minimal` in the CLI catalog, but its
      // gateway contract accepts `none` as the no-budget equivalent and rejects
      // `minimal` during generation. The CLI's RPC state calls that same
      // no-budget state `off`. Preserve the label in the picker while
      // translating only the provider's known alias at the wire boundary.
      variants[label] =
        label.toLowerCase() === 'minimal' && native.toLowerCase() === 'minimal' ? 'off' : native;
    }
  }
  const arrayLevels = [
    row.reasoningLevels,
    row.thinkingLevels,
    row.supportedReasoningEfforts,
    row.reasoningEfforts,
  ].find((levels) => Array.isArray(levels)) as unknown;
  if (Array.isArray(arrayLevels)) {
    for (const level of arrayLevels) {
      if (typeof level === 'string' && level.trim() && !variants[level]) variants[level] = level;
    }
  }
  return variants;
}

/** Resolve a user-facing level to the exact native state accepted by Omnirush. */
export function resolveOmnirushReasoningLevel(
  model: ModelDef,
  requested: string,
): string | undefined {
  const value = requested.trim();
  if (!value) return undefined;
  const variants = model.reasoningVariants ?? {};
  const entry = Object.entries(variants).find(
    ([label]) => label.toLowerCase() === value.toLowerCase(),
  );
  if (entry) return entry[1];
  const native = Object.values(variants).find(
    (level) => level.toLowerCase() === value.toLowerCase(),
  );
  if (native) return native;
  const reported = model.reasoningLevels ?? [];
  return reported.find((level) => level.toLowerCase() === value.toLowerCase());
}

function positiveInteger(...values: unknown[]): number {
  for (const value of values) {
    const number =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && /^\d+$/.test(value.trim())
          ? Number(value)
          : 0;
    if (Number.isSafeInteger(number) && number > 0) return number;
  }
  return 0;
}

/** Exact CLI-owned model metadata. Unknown schema is a discovery failure, not
 * an excuse to invent limits, prices, effort values, or another model. */
export function parseOmnirushRpcCatalog(value: unknown): ModelDef[] {
  if (!Array.isArray(value))
    throw new Error('Omnirush returned an invalid RPC model catalog. Update the CLI and refresh.');
  const models: ModelDef[] = [];
  for (const row of value) {
    if (!row || row.provider !== 'omnirush' || typeof row.id !== 'string' || !row.id) continue;
    const context = positiveInteger(row.contextWindow, row.context_window, row.contextLength);
    const output = positiveInteger(row.maxTokens, row.maxOutputTokens, row.max_output_tokens);
    const levels = reportedReasoningLevels(row);
    const variants = reportedReasoningVariants(row);
    models.push({
      id: row.id,
      apiModelId: row.id,
      name: typeof row.name === 'string' ? row.name : row.id,
      provider: 'omnirush',
      contextWindow: context,
      contextVerified: context > 0,
      maxOutputTokens: output,
      canReason: row.reasoning === true,
      reasoningLevels: row.reasoning === true ? levels : [],
      ...(row.reasoning === true && Object.keys(variants).length
        ? { reasoningVariants: variants }
        : {}),
      vision: Array.isArray(row.input) && row.input.includes('image'),
      supportsAttachments: Array.isArray(row.input) && row.input.includes('image'),
      supportsStreaming: true,
      functionCall: true,
      // The CLI's synthetic dollar costs are not subscription billing prices.
    });
  }
  return models;
}

/** Parse the catalog cached by Omnirush 2.x after it moved to the OpenCode engine. */
export function parseOmnirushCliCatalog(value: unknown): ModelDef[] {
  const rows =
    value && typeof value === 'object' && !Array.isArray(value) && 'payload' in value
      ? (value as Row).payload?.data
      : value && typeof value === 'object' && !Array.isArray(value) && 'data' in value
        ? (value as Row).data
        : value;
  if (!Array.isArray(rows)) throw new Error('Omnirush returned an invalid model catalog.');
  return rows.flatMap((row: Row) => {
    if (!row || typeof row.id !== 'string' || !row.id.trim()) return [];
    const limits = row.limits && typeof row.limits === 'object' ? row.limits : {};
    const capabilities =
      row.capabilities && typeof row.capabilities === 'object' ? row.capabilities : {};
    const levels = Array.isArray(row.reasoning_levels)
      ? row.reasoning_levels.filter((level: unknown): level is string => typeof level === 'string')
      : [];
    const variants = Object.fromEntries(levels.map((level) => [level, level]));
    if (levels.includes('minimal')) variants.minimal = 'off';
    return [
      {
        id: row.id,
        apiModelId: row.id,
        name:
          typeof row.display_name === 'string' && row.display_name.trim()
            ? row.display_name
            : row.id,
        provider: 'omnirush',
        contextWindow: positiveInteger(limits.context),
        contextVerified: positiveInteger(limits.context) > 0,
        maxOutputTokens: positiveInteger(limits.output),
        canReason: capabilities.reasoning !== false,
        reasoningLevels: capabilities.reasoning === false ? [] : levels,
        ...(capabilities.reasoning !== false && Object.keys(variants).length
          ? { reasoningVariants: variants }
          : {}),
        vision: capabilities.image_input === true,
        supportsAttachments: capabilities.image_input === true,
        supportsStreaming: true,
        functionCall: capabilities.tool_call !== false,
      } satisfies ModelDef,
    ];
  });
}

export function readOmnirushCliCatalog(stateRoot = omnirushStateDirectory()): ModelDef[] {
  const file = join(stateRoot, 'model-catalog.json');
  return parseOmnirushCliCatalog(JSON.parse(readFileSync(file, 'utf8')));
}

/**
 * Claude is intentionally absent from model-catalog.json: Omnirush keeps its
 * account-wide Claude picker in claude-code.json because Claude turns use the
 * managed sandbox/relay rather than the account's OpenAI Responses gateway.
 * The file is CLI-owned evidence, so it is safe to show every listed model;
 * eligibility is checked again by the relay when a turn starts.
 */
export function parseOmnirushClaudeCatalog(value: unknown): ModelDef[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const raw = value as Row;
  if (!Array.isArray(raw.catalog)) return [];
  const models: ModelDef[] = [];
  const seen = new Set<string>();
  for (const entry of raw.catalog.slice(0, 16)) {
    if (!entry || typeof entry !== 'object') continue;
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (!/^claude-[a-z0-9][a-z0-9.-]{0,62}$/u.test(id) || seen.has(id)) continue;
    seen.add(id);
    const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : id;
    models.push({
      id,
      apiModelId: id,
      name,
      provider: 'omnirush',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      contextVerified: true,
      canReason: true,
      reasoningLevels: [],
      vision: true,
      supportsAttachments: true,
      supportsStreaming: true,
      functionCall: true,
    });
  }
  return models;
}

export function parseOmnirushClaudeAccess(value: unknown): {
  offered: boolean;
  allowedModels: string[];
  reason: string | null;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return { offered: false, allowedModels: [], reason: 'unavailable' };
  const raw = value as Row;
  const catalog = Array.isArray(raw.catalog) ? raw.catalog : [];
  const allowedModels = catalog
    .filter(
      (entry): entry is Row =>
        Boolean(entry) && typeof entry === 'object' && entry.allowed === true,
    )
    .map((entry) => (typeof entry.id === 'string' ? entry.id.trim() : ''))
    .filter((id): id is string => /^claude-[a-z0-9][a-z0-9.-]{0,62}$/u.test(id));
  const offered = raw.offered === true;
  return {
    offered,
    allowedModels: [...new Set(allowedModels)],
    reason:
      typeof raw.reason === 'string' && raw.reason.trim()
        ? raw.reason.trim()
        : offered
          ? null
          : 'not_allowed',
  };
}

export function readOmnirushClaudeAccess(stateRoot = omnirushStateDirectory()): {
  offered: boolean;
  allowedModels: string[];
  reason: string | null;
} {
  const file = join(stateRoot, 'claude-code.json');
  return parseOmnirushClaudeAccess(JSON.parse(readFileSync(file, 'utf8')));
}

export function readOmnirushClaudeCatalog(stateRoot = omnirushStateDirectory()): ModelDef[] {
  const file = join(stateRoot, 'claude-code.json');
  return parseOmnirushClaudeCatalog(JSON.parse(readFileSync(file, 'utf8')));
}

function mergeOmnirushCatalog(stateRoot: string, catalog: ModelDef[]): ModelDef[] {
  const claude = (() => {
    try {
      return readOmnirushClaudeCatalog(stateRoot);
    } catch {
      return [];
    }
  })();
  const ids = new Set(catalog.map((model) => model.id));
  return [...catalog, ...claude.filter((model) => !ids.has(model.id))];
}

function readOmnirushAvailableCatalog(stateRoot: string): ModelDef[] {
  let catalog: ModelDef[] = [];
  try {
    catalog = readOmnirushCliCatalog(stateRoot);
  } catch {
    // A Claude-only capability cache is still useful when the GPT gateway cache
    // has not been written on a new install.
  }
  return mergeOmnirushCatalog(stateRoot, catalog);
}

class OmnirushPrintEventQueue {
  private values: ProviderEvent[] = [];
  private waiters: Array<{
    resolve(value: IteratorResult<ProviderEvent>): void;
    reject(error: Error): void;
  }> = [];
  private ended = false;
  private terminalError?: Error;

  push(value: ProviderEvent): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ done: false, value });
    else this.values.push(value);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
  }

  fail(error: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.terminalError = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  async next(): Promise<IteratorResult<ProviderEvent>> {
    const value = this.values.shift();
    if (value) return { done: false, value };
    if (this.terminalError) throw this.terminalError;
    if (this.ended) return { done: true, value: undefined };
    return new Promise<IteratorResult<ProviderEvent>>((resolve, reject) =>
      this.waiters.push({ resolve, reject }),
    );
  }
}

type OmnirushPrintAttempt = {
  sideEffect: boolean;
};

async function* runOmnirushPrint(
  binary: string,
  stateRoot: string,
  bindStateRoot: boolean,
  request: StreamRequest,
  model: ModelDef,
  prompt: string,
  signal: AbortSignal,
  attempt: OmnirushPrintAttempt,
): AsyncGenerator<ProviderEvent> {
  if (prompt.trim() === '') throw new Error('Omnirush received an empty prompt.');
  let toolsArtifact: OmnirushKoryToolsArtifact | undefined;
  let textOnlyArtifact: PrivateCliArtifact | undefined;
  let bridgeLease: KoryBridgeGrantLease | undefined;
  let telemetryArtifact: PrivateCliArtifact | undefined;
  let waitForChildExit: (() => Promise<boolean>) | undefined;
  try {
    if (request.tools?.length) {
      if (!request.sessionId)
        throw new Error('Omnirush Kory tools require a session-scoped grant.');
      bridgeLease = createKoryBridgeGrantLease(request.sessionId, request.harnessRole ?? 'manager');
      const grant = bridgeLease.grant(['mcp:execute']);
      const allowed = request.allowedToolNames
        ? new Set(request.allowedToolNames.map((n) => n.replace(/^kory__/, '')))
        : null;
      toolsArtifact = createOmnirushKoryToolsArtifact(
        request.tools.filter((t) => !allowed || allowed.has(t.name.replace(/^kory__/, ''))),
        grant.path,
        `http://${process.env.KORYPHAIOS_HOST?.trim() || '127.0.0.1'}:${process.env.KORYPHAIOS_PORT?.trim() || '3001'}`,
        request.systemPrompt,
      );
    }
    const activeToolsArtifact = toolsArtifact;
    if (request.nativeToolsDisabled && activeToolsArtifact) {
      throw new Error('Omnirush text-only mode cannot combine native-tool denial with Kory tools.');
    }
    if (request.nativeToolsDisabled) {
      textOnlyArtifact = createPrivateCliTextArtifact('omnirush-text-only', '', 'json');
      mkdirSync(join(textOnlyArtifact.directory, 'home'), { recursive: true, mode: 0o700 });
    }
    telemetryArtifact = createPrivateCliTextArtifact('omnirush-telemetry', '', 'mjs');
    const telemetryPath = join(telemetryArtifact.directory, 'events.ndjson');
    writeFileSync(telemetryArtifact.path, omnirushTelemetryPluginSource(telemetryPath), {
      mode: 0o600,
    });
    const config = activeToolsArtifact
      ? JSON.parse(activeToolsArtifact.configContent)
      : {
          plugin: [],
          ...(request.nativeToolsDisabled ? { permission: { '*': 'deny' } } : {}),
          formatter: false,
          lsp: false,
          compaction: { auto: false },
        };
    config.plugin = [
      ...(Array.isArray(config.plugin) ? config.plugin : []),
      pathToFileURL(telemetryArtifact.path).href,
    ];
    const configContent = JSON.stringify(config);
    const nativeReasoningLevel = request.reasoningLevel
      ? resolveOmnirushReasoningLevel(model, request.reasoningLevel)
      : undefined;
    if (request.reasoningLevel && nativeReasoningLevel === undefined) {
      throw new Error(
        'The selected Omnirush model does not advertise that reasoning level. Refresh the catalog and select a reported level.',
      );
    }
    const boxHelpers = request.sandbox
      ? await ensureOmnirushBoxHelpers(binary, stateRoot, signal)
      : undefined;
    const queue = new OmnirushPrintEventQueue();
    await new Promise<void>((resolve) => {
      const child = spawn(
        binary,
        [
          '--model',
          model.apiModelId ?? model.id,
          ...(nativeReasoningLevel ? ['--thinking', nativeReasoningLevel] : []),
          '--print',
        ],
        {
          cwd:
            activeToolsArtifact?.workspace ||
            textOnlyArtifact?.directory ||
            request.workingDirectory ||
            process.cwd(),
          env: buildProviderCliEnv('omnirush', {
            ...omnirushReleaseEnvironment(stateRoot, bindStateRoot, !!boxHelpers),
            ...(boxHelpers
              ? {
                  OMNIRUSH_BOX_HOME: join(stateRoot, 'box'),
                  OMNIRUSH_BOX_BIN_DIR: boxHelpers,
                  OMNIRUSH_INSTALL_LOG: '0',
                }
              : {}),
            ...(activeToolsArtifact
              ? {
                  ...activeToolsArtifact.environment,
                  OMNIRUSH_OPENCODE_CWD: activeToolsArtifact.workspace,
                  OMNIRUSH_PROJECT_CODE: '1',
                  KORY_BRIDGE_AUTH_FILE: activeToolsArtifact.authFile,
                  KORY_BACKEND_URL: `http://${process.env.KORYPHAIOS_HOST?.trim() || '127.0.0.1'}:${process.env.KORYPHAIOS_PORT?.trim() || '3001'}`,
                }
              : {}),
            ...(textOnlyArtifact
              ? {
                  HOME: join(textOnlyArtifact.directory, 'home'),
                  USERPROFILE: join(textOnlyArtifact.directory, 'home'),
                  XDG_CONFIG_HOME: join(textOnlyArtifact.directory, 'home', 'config'),
                  XDG_DATA_HOME: join(textOnlyArtifact.directory, 'home', 'data'),
                  XDG_CACHE_HOME: join(textOnlyArtifact.directory, 'home', 'cache'),
                  XDG_STATE_HOME: join(textOnlyArtifact.directory, 'home', 'state'),
                }
              : {}),
            OPENCODE_CONFIG_CONTENT: configContent,
          }),
          stdio: ['pipe', 'pipe', 'pipe'],
          ...providerProcessGroupOptions(),
        },
      );
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      let emittedText = '';
      let telemetryOffset = 0;
      let telemetryRemainder = '';
      let lastUsageSignature = '';
      const telemetryPartText = new Map<string, string>();
      let childExitObserved = false;
      let childExitResolve!: () => void;
      const childExited = new Promise<void>((resolve) => {
        childExitResolve = resolve;
      });
      waitForChildExit = () => {
        if (childExitObserved) return Promise.resolve(true);
        return new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), PRINT_TEARDOWN_TIMEOUT_MS);
          void childExited.then(() => {
            clearTimeout(timer);
            resolve(true);
          });
        });
      };
      const terminateChild = () => {
        terminateProviderProcessGroup(child.pid);
        // The process-group kill is authoritative on Unix, but the direct kill
        // closes the gap when the child exits between pid lookup and group kill
        // (and is the fallback for a platform-specific group failure).
        try {
          child.kill('SIGKILL');
        } catch {
          // The child may already have exited; close/error will settle it.
        }
      };
      const readTelemetry = () => {
        let contents = '';
        try {
          contents = readFileSync(telemetryPath, 'utf8');
        } catch {
          return;
        }
        if (contents.length < telemetryOffset) telemetryOffset = 0;
        const chunk = contents.slice(telemetryOffset);
        telemetryOffset = contents.length;
        telemetryRemainder += chunk;
        const lines = telemetryRemainder.split('\n');
        telemetryRemainder = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }
          const telemetry = parseOmnirushPrintTelemetry(parsed);
          if (!telemetry) continue;
          const reportedModel = telemetry.model?.split('/').pop();
          if (reportedModel && reportedModel !== (model.apiModelId ?? model.id)) {
            queue.fail(
              new Error(
                'Omnirush returned a different model than the selected model. Refresh its catalog and retry.',
              ),
            );
            terminateChild();
            return;
          }
          if (telemetry.toolActivity) attempt.sideEffect = true;
          if (telemetry.text !== undefined) {
            const previous = telemetry.partId
              ? (telemetryPartText.get(telemetry.partId) ?? '')
              : '';
            const delta = telemetry.text.startsWith(emittedText)
              ? telemetry.text.slice(emittedText.length)
              : emittedText.startsWith(telemetry.text)
                ? ''
                : telemetry.text.startsWith(previous)
                  ? telemetry.text.slice(previous.length)
                  : telemetry.text;
            if (telemetry.partId) telemetryPartText.set(telemetry.partId, telemetry.text);
            if (delta) {
              attempt.sideEffect = true;
              queue.push({ type: 'content_delta', content: delta });
              emittedText += delta;
            }
          }
          if (telemetry.usage) {
            const usage = telemetry.usage;
            const signature = JSON.stringify([reportedModel, usage]);
            if (signature === lastUsageSignature) continue;
            lastUsageSignature = signature;
            const sample = {
              tokensIn: usage.input,
              tokensOut: usage.output,
              ...(usage.cacheRead !== undefined ? { tokensCacheRead: usage.cacheRead } : {}),
              ...(usage.cacheWrite !== undefined ? { tokensCacheWrite: usage.cacheWrite } : {}),
            };
            queue.push({
              type: 'usage_update',
              tokensIn: sample.tokensIn,
              tokensOut: sample.tokensOut,
              ...(sample.tokensCacheRead !== undefined
                ? { tokensCacheRead: sample.tokensCacheRead }
                : {}),
              ...(sample.tokensCacheWrite !== undefined
                ? { tokensCacheWrite: sample.tokensCacheWrite }
                : {}),
              billingTokensIn: sample.tokensIn,
              billingTokensOut: sample.tokensOut,
              billingUsageSamples: [sample],
              usagePrecision: 'provider-reported',
            });
          }
        }
      };
      const telemetryTimer = setInterval(readTelemetry, 20);
      telemetryTimer.unref?.();
      const finish = (result: { ok: true } | { ok: false; error: Error }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(telemetryTimer);
        readTelemetry();
        signal.removeEventListener('abort', abort);
        if (result.ok) {
          queue.end();
          resolve();
        } else {
          terminateChild();
          queue.fail(result.error);
          resolve();
        }
      };
      const abort = () => {
        finish({ ok: false, error: new Error('Omnirush request cancelled.') });
      };
      timer = setTimeout(() => {
        finish({ ok: false, error: new Error('Omnirush turn timed out.') });
      }, resolveOmnirushTurnTimeoutMs(request));
      signal.addEventListener('abort', abort, { once: true });
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (stdout.length > MAX_FRAME_CHARS) {
          finish({ ok: false, error: new Error('Omnirush output exceeded the transport limit.') });
          return;
        }
        // The supported print contract ends the answer with a newline. Hold
        // one character so that newline is not surfaced as chat content, but
        // release all earlier bytes immediately as they arrive.
        const candidate = stdout.length > 0 ? stdout.slice(0, -1) : '';
        if (candidate.startsWith(emittedText)) {
          const delta = candidate.slice(emittedText.length);
          emittedText = candidate;
          if (delta) {
            attempt.sideEffect = true;
            queue.push({ type: 'content_delta', content: delta });
          }
        }
      });
      child.stderr.on('data', (chunk) => {
        stderr = appendPrivateDiagnostic(stderr, chunk);
      });
      child.once('error', (error) => finish({ ok: false, error }));
      child.stdin.on('error', () =>
        finish({ ok: false, error: new Error('Omnirush input pipe closed.') }),
      );
      child.once('close', (code) => {
        childExitObserved = true;
        childExitResolve();
        if (code === 0) {
          try {
            activeToolsArtifact?.assertReady();
            const answer = stdout.trim() || emittedText.trim();
            if (!answer) throw new Error('Omnirush ended without an assistant answer.');
            if (answer.startsWith(emittedText)) {
              const delta = answer.slice(emittedText.length);
              if (delta) {
                attempt.sideEffect = true;
                queue.push({ type: 'content_delta', content: delta });
              }
            }
            finish({ ok: true });
          } catch (error) {
            finish({ ok: false, error: error as Error });
          }
        } else {
          finish({
            ok: false,
            error: new Error(stderr || `Omnirush exited with status ${code ?? 'unknown'}.`),
          });
        }
      });
      child.stdin.end(`${prompt}\n`);
      if (signal.aborted) abort();
    });
    while (true) {
      const next = await queue.next();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    const childExited = (await waitForChildExit?.()) ?? true;
    const cleanup = () => {
      telemetryArtifact?.cleanup();
      toolsArtifact?.artifact.cleanup();
      textOnlyArtifact?.cleanup();
      bridgeLease?.cleanup();
    };
    if (childExited) cleanup();
    else void waitForChildExit?.().then((exited) => exited && cleanup());
  }
}

function renderOmnirushInteractivePrompt(request: StreamRequest): string {
  const rendered = request.messages
    .map((message) => {
      const content =
        typeof message.content === 'string'
          ? message.content
          : message.content
              .map((block) => {
                if (block.type === 'text') return block.text ?? '';
                if (block.type === 'tool_result') return block.toolOutput ?? '';
                if (block.type === 'tool_use')
                  return JSON.stringify({ tool: block.toolName, input: block.toolInput });
                return '[Attached media]';
              })
              .join('\n');
      return `${message.role}: ${content}`;
    })
    .filter((message) => message.trim())
    .join('\n\n');
  if (!rendered.trim()) throw new Error('Omnirush received an empty prompt.');
  if (rendered.length <= MAX_INTERACTIVE_PROMPT_CHARS) return rendered;
  return `[Earlier conversation omitted to keep the interactive launcher argument bounded.]\n\n${rendered.slice(-MAX_INTERACTIVE_PROMPT_CHARS)}`;
}

/**
 * Claude is served by Omnirush's normal engine, which requires a PTY even when
 * the caller is a backend process. A tiny private Python PTY relay works on
 * both supported Unix hosts without assuming the backend itself has a TTY. The
 * engine's structured events are captured by the private OpenCode telemetry
 * plugin, never by parsing terminal escape codes.
 */
async function* runOmnirushClaudeInteractive(
  binary: string,
  stateRoot: string,
  request: StreamRequest,
  model: ModelDef,
  signal: AbortSignal,
): AsyncGenerator<ProviderEvent> {
  if (!request.sessionId) throw new Error('Omnirush Claude tools require a session-scoped grant.');
  const prompt = renderOmnirushInteractivePrompt(request);
  const bridgeLease = createKoryBridgeGrantLease(
    request.sessionId,
    request.harnessRole ?? 'manager',
  );
  const grant = bridgeLease.grant(['mcp:execute']);
  let toolsArtifact: OmnirushKoryToolsArtifact | undefined;
  let telemetryArtifact: PrivateCliArtifact | undefined;
  let visibleWorkspace: string | undefined;
  let waitForChildExit: (() => Promise<boolean>) | undefined;
  const queue = new OmnirushPrintEventQueue();
  let child: ReturnType<typeof spawn> | undefined;
  let childExitObserved = false;
  let childExitResolve!: () => void;
  let settled = false;
  let succeeded = false;
  let sawAssistantText = false;
  let emittedText = '';
  let telemetryOffset = 0;
  let telemetryRemainder = '';
  const telemetryPartText = new Map<string, string>();
  const emittedTools = new Set<string>();
  try {
    const allowed = request.allowedToolNames
      ? new Set(request.allowedToolNames.map((name) => name.replace(/^kory__/, '')))
      : null;
    toolsArtifact = createOmnirushKoryToolsArtifact(
      (request.tools ?? []).filter(
        (tool) => !allowed || allowed.has(tool.name.replace(/^kory__/, '')),
      ),
      grant.path,
      `http://${process.env.KORYPHAIOS_HOST?.trim() || '127.0.0.1'}:${process.env.KORYPHAIOS_PORT?.trim() || '3001'}`,
      request.systemPrompt,
    );
    // Colima's Docker daemon cannot mount macOS's private temp hierarchy. Keep
    // the generated engine project disposable, but place the mount root under
    // the selected checkout so the active VM can see it. Secrets remain in the
    // private artifact and are never copied into this project tree.
    visibleWorkspace = join(
      request.workingDirectory || process.cwd(),
      `.koryphaios-omnirush-${process.pid}-${randomBytes(8).toString('hex')}`,
    );
    cpSync(toolsArtifact.workspace, visibleWorkspace, { recursive: true, mode: 0o700 });
    telemetryArtifact = createPrivateCliTextArtifact('omnirush-claude-telemetry', '', 'mjs');
    const visiblePluginDirectory = join(visibleWorkspace, '.opencode', 'plugins', 'kory-tools');
    const visibleTurnPath = join(visiblePluginDirectory, 'turn.json');
    const visibleGrantPath = join(visiblePluginDirectory, 'bridge-grant.json');
    const visibleTelemetryPath = join(visibleWorkspace, '.kory-omnirush-events.ndjson');
    const telemetryPath = visibleTelemetryPath;
    const visibleTelemetryPluginPath = join(visibleWorkspace, '.kory-omnirush-telemetry.mjs');
    const visibleTurn = JSON.parse(readFileSync(visibleTurnPath, 'utf8')) as Row;
    copyFileSync(grant.path, visibleGrantPath);
    visibleTurn.authFile = visibleGrantPath;
    writeFileSync(visibleTurnPath, JSON.stringify(visibleTurn), { mode: 0o600 });
    writeFileSync(telemetryArtifact.path, omnirushTelemetryPluginSource(visibleTelemetryPath), {
      mode: 0o600,
    });
    copyFileSync(telemetryArtifact.path, visibleTelemetryPluginPath);
    chmodSync(visibleTelemetryPluginPath, 0o600);
    const config = JSON.parse(toolsArtifact.configContent) as Row;
    config.plugin = [
      pathToFileURL(join(visiblePluginDirectory, 'index.mjs')).href,
      pathToFileURL(visibleTelemetryPluginPath).href,
    ];
    writeFileSync(join(visibleWorkspace, 'opencode.json'), JSON.stringify(config), {
      mode: 0o600,
    });

    const python = findExecutableOnPath('python3') ?? findExecutableOnPath('python');
    const os = hostOS();
    if (!python || (os !== 'darwin' && os !== 'linux'))
      throw new Error('Omnirush Claude requires Python 3 with PTY support on macOS or Linux.');
    const boxHelpers = await ensureOmnirushBoxHelpers(binary, stateRoot, signal);
    // Claude is a normal-engine provider, not a headless --model target. Use
    // OpenCode's documented in-session switch command after the TUI is ready;
    // this is the same path used by the model picker and preserves the Claude
    // provider's sandbox decision and relay setup.
    const command = [binary, '--sandbox'];
    const ptyRunner = join(toolsArtifact.artifact.directory, 'pty-runner.py');
    writeFileSync(
      ptyRunner,
      `import errno, fcntl, os, pty, select, signal, sys, termios

master, slave = pty.openpty()
pid = os.fork()
if pid == 0:
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    os.dup2(slave, 0)
    os.dup2(slave, 1)
    os.dup2(slave, 2)
    os.close(master)
    os.close(slave)
    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)

os.close(slave)
try:
    while True:
        ready, _, _ = select.select([master, sys.stdin.buffer], [], [])
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not data:
                break
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
        if sys.stdin.buffer in ready:
            data = sys.stdin.buffer.read1(65536)
            if not data:
                break
            os.write(master, data)
finally:
    try:
        os.killpg(pid, signal.SIGHUP)
    except OSError:
        pass
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
`,
      { mode: 0o700 },
    );
    child = spawn(python, [ptyRunner, ...command], {
      cwd: visibleWorkspace,
      env: buildProviderCliEnv('omnirush', {
        ...omnirushReleaseEnvironment(stateRoot, false, true),
        ...toolsArtifact.environment,
        OMNIRUSH_DIR: stateRoot,
        OMNIRUSH_AGENT_DIR: join(stateRoot, 'agent'),
        OMNIRUSH_BOX_HOME: join(stateRoot, 'box'),
        OMNIRUSH_BOX_BIN_DIR: boxHelpers,
        OMNIRUSH_INSTALL_LOG: '0',
        OMNIRUSH_OPENCODE_CWD: visibleWorkspace,
        OMNIRUSH_PROJECT_CODE: '1',
        KORY_BRIDGE_AUTH_FILE: toolsArtifact.authFile,
        KORY_BACKEND_URL: `http://${process.env.KORYPHAIOS_HOST?.trim() || '127.0.0.1'}:${process.env.KORYPHAIOS_PORT?.trim() || '3001'}`,
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
      ...providerProcessGroupOptions(),
    });
    childExitObserved = false;
    childExitResolve = () => undefined;
    const childExited = new Promise<void>((resolve) => {
      childExitResolve = resolve;
    });
    waitForChildExit = () => {
      if (childExitObserved) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), PRINT_TEARDOWN_TIMEOUT_MS);
        void childExited.then(() => {
          clearTimeout(timer);
          resolve(true);
        });
      });
    };
    const terminateChild = () => {
      terminateProviderProcessGroup(child?.pid);
      try {
        child?.kill('SIGKILL');
      } catch {
        // The PTY wrapper may already have exited after the engine became idle.
      }
    };
    let stderr = '';
    let terminalOutput = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      // The PTY relay's terminal bytes are intentionally not parsed. OpenCode
      // telemetry is the structured source of truth; consuming this stream
      // prevents a slow TUI render from back-pressuring the relay.
      terminalOutput = `${terminalOutput}${chunk}`.slice(-12_000);
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = appendPrivateDiagnostic(stderr, chunk);
    });

    const finish = (result: { ok: true } | { ok: false; error: Error }) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      if (result.ok) {
        succeeded = true;
        queue.end();
      } else {
        terminateChild();
        queue.fail(result.error);
      }
    };
    const abort = () => finish({ ok: false, error: new Error('Omnirush request cancelled.') });
    const promptTimer = setTimeout(() => {
      try {
        child?.stdin?.write(`/model omnirush-claude/${model.apiModelId ?? model.id}\r`);
        // The command is handled by the TUI before the next line is submitted.
        // Keep this delay short, but non-zero so a slow sandbox startup cannot
        // interpret the model command and prompt as one editor value.
        setTimeout(() => {
          try {
            child?.stdin?.write(`${prompt}\r`);
          } catch {
            // The child exit handler reports the actual startup failure.
          }
        }, 5000).unref?.();
      } catch {
        // The child exit handler reports the actual startup failure.
      }
    }, INTERACTIVE_ENGINE_START_WAIT_MS);
    promptTimer.unref?.();
    const readTelemetry = () => {
      let contents = '';
      try {
        contents = readFileSync(telemetryPath, 'utf8');
      } catch {
        return;
      }
      if (contents.length < telemetryOffset) telemetryOffset = 0;
      const chunk = contents.slice(telemetryOffset);
      telemetryOffset = contents.length;
      telemetryRemainder += chunk;
      const lines = telemetryRemainder.split('\n');
      telemetryRemainder = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        const telemetry = parseOmnirushEngineTelemetry(parsed);
        if (!telemetry) continue;
        const reportedModel = telemetry.model?.split('/').pop();
        if (reportedModel && reportedModel !== (model.apiModelId ?? model.id)) {
          finish({
            ok: false,
            error: new Error(
              'Omnirush returned a different model than the selected Claude model. Refresh the catalog and retry.',
            ),
          });
          break;
        }
        if (telemetry.error) {
          finish({ ok: false, error: new Error(telemetry.error) });
          break;
        }
        if (telemetry.text !== undefined) {
          const previous = telemetry.partId ? (telemetryPartText.get(telemetry.partId) ?? '') : '';
          const delta = telemetry.text.startsWith(previous)
            ? telemetry.text.slice(previous.length)
            : telemetry.text.startsWith(emittedText)
              ? telemetry.text.slice(emittedText.length)
              : telemetry.text;
          if (telemetry.partId) telemetryPartText.set(telemetry.partId, telemetry.text);
          if (delta) {
            emittedText += delta;
            sawAssistantText = true;
            queue.push({ type: 'content_delta', content: delta });
          }
        }
        if (telemetry.usage) {
          const usage = telemetry.usage;
          const sample = {
            tokensIn: usage.input,
            tokensOut: usage.output,
            ...(usage.cacheRead !== undefined ? { tokensCacheRead: usage.cacheRead } : {}),
            ...(usage.cacheWrite !== undefined ? { tokensCacheWrite: usage.cacheWrite } : {}),
          };
          queue.push({
            type: 'usage_update',
            tokensIn: sample.tokensIn,
            tokensOut: sample.tokensOut,
            ...(sample.tokensCacheRead !== undefined
              ? { tokensCacheRead: sample.tokensCacheRead }
              : {}),
            ...(sample.tokensCacheWrite !== undefined
              ? { tokensCacheWrite: sample.tokensCacheWrite }
              : {}),
            billingTokensIn: sample.tokensIn,
            billingTokensOut: sample.tokensOut,
            billingUsageSamples: [sample],
            usagePrecision: 'provider-reported',
          });
        }
        if (telemetry.tool) {
          const tool = telemetry.tool;
          const toolId = tool.id ?? `${tool.name ?? 'tool'}:${JSON.stringify(tool.input ?? {})}`;
          if (!emittedTools.has(toolId)) {
            emittedTools.add(toolId);
            queue.push({
              type: 'tool_executed',
              toolCallId: tool.id,
              toolName: tool.name,
              toolInput: JSON.stringify(tool.input ?? {}),
              toolOutput:
                typeof tool.output === 'string' ? tool.output : JSON.stringify(tool.output ?? ''),
              isError: tool.isError,
            });
          }
        }
        if (telemetry.complete && sawAssistantText) {
          finish({ ok: true });
          terminateChild();
          break;
        }
      }
    };
    const telemetryTimer = setInterval(readTelemetry, 20);
    telemetryTimer.unref?.();
    const timer = setTimeout(
      () => {
        const tail = terminalOutput
          .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        finish({
          ok: false,
          error: new Error(
            `Omnirush Claude turn timed out.${tail ? ` Terminal: ${tail.slice(-800)}` : ''}`,
          ),
        });
      },
      Math.max(1_000, resolveOmnirushTurnTimeoutMs(request) - 5_000),
    );
    signal.addEventListener('abort', abort, { once: true });
    child.once('error', (error) => finish({ ok: false, error }));
    child.once('close', (code) => {
      childExitObserved = true;
      childExitResolve();
      readTelemetry();
      clearTimeout(timer);
      clearTimeout(promptTimer);
      clearInterval(telemetryTimer);
      if (succeeded) return;
      if (code === 0 && sawAssistantText) finish({ ok: true });
      else
        finish({
          ok: false,
          error: new Error(stderr || `Omnirush exited with status ${code ?? 'unknown'}.`),
        });
    });
    if (signal.aborted) abort();
    while (true) {
      const next = await queue.next();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    const exited = (await waitForChildExit?.()) ?? true;
    const cleanup = () => {
      telemetryArtifact?.cleanup();
      toolsArtifact?.artifact.cleanup();
      if (visibleWorkspace) {
        stopOmnirushDockerBox(visibleWorkspace);
        rmSync(visibleWorkspace, { recursive: true, force: true });
      }
      bridgeLease.cleanup();
    };
    if (exited) cleanup();
    else void waitForChildExit?.().then((done) => done && cleanup());
  }
}

function failure(value: unknown): string {
  return safeProviderFailureMessage(
    'omnirush',
    safeProviderDiagnostic('omnirush', 'stderr', value),
    {
      authenticationAction: 'Run "omnirush login", then reconnect.',
    },
  );
}

/** Tracks individual assistant requests, so usage isn't counted again at
 * turn_end/agent_end. Cache tokens are excluded from pi's input count. */
export class OmnirushEvents {
  failed = false;
  complete = false;
  sawAnswer = false;
  private streamed = false;
  private samples: NonNullable<ProviderEvent['billingUsageSamples']> = [];
  constructor(private model: string) {}

  private acceptAssistantMessage(message: Row): ProviderEvent[] {
    const reportedModel = message.model ?? message.modelId;
    if (
      (reportedModel !== undefined && reportedModel !== this.model) ||
      (message.provider !== undefined && message.provider !== 'omnirush')
    ) {
      this.failed = true;
      return [
        {
          type: 'error',
          error:
            'Omnirush returned a different model than the selected model. Refresh its catalog and retry.',
        },
      ];
    }
    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      this.failed = true;
      const error = message.errorMessage ?? message.stopReason;
      return [
        { type: 'error', error: failure(error), errorTransient: isTransientStreamErrorText(error) },
      ];
    }
    const events: ProviderEvent[] = [];
    const text = Array.isArray(message.content)
      ? message.content
          .filter((b: Row) => b.type === 'text')
          .map((b: Row) => b.text ?? '')
          .join('')
      : typeof message.content === 'string'
        ? message.content
        : '';
    if (!this.streamed && text) events.push({ type: 'content_delta', content: text });
    // A few CLI builds replay the complete message as message_end after the
    // newer message event. Marking it consumed prevents duplicate chat text.
    this.streamed ||= !!text;
    this.sawAnswer ||= !!text;
    const usage = message.usage;
    const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
    if (usage) {
      const cacheRead = count(usage.cacheRead),
        cacheWrite = count(usage.cacheWrite);
      const input = count(usage.input) + cacheRead + cacheWrite;
      const output = count(usage.output);
      this.samples.push({
        tokensIn: input,
        tokensOut: output,
        tokensCacheRead: cacheRead,
        tokensCacheWrite: cacheWrite,
      });
      events.push({
        type: 'usage_update',
        tokensIn: input,
        tokensOut: output,
        tokensCacheRead: cacheRead,
        tokensCacheWrite: cacheWrite,
        billingTokensIn: this.samples.reduce((sum, sample) => sum + sample.tokensIn, 0),
        billingTokensOut: this.samples.reduce((sum, sample) => sum + sample.tokensOut, 0),
        billingUsageSamples: [...this.samples],
        usagePrecision: 'provider-reported',
      });
    }
    return events;
  }

  accept(row: Row): ProviderEvent[] {
    if (this.failed || this.complete) return [];
    if (row.type === 'kory_waiting') {
      return [
        {
          type: 'waiting',
          waitingReason:
            typeof row.waitingReason === 'string' && row.waitingReason.trim()
              ? row.waitingReason.trim()
              : 'Waiting for an Omnirush seat',
        },
      ];
    }
    if (row.type === 'message_start' && row.message?.role === 'assistant') this.streamed = false;
    if (row.type === 'message_update') {
      const event = row.assistantMessageEvent;
      if (event?.type === 'text_delta' && typeof event.delta === 'string') {
        this.streamed = true;
        this.sawAnswer ||= !!event.delta;
        return [{ type: 'content_delta', content: event.delta }];
      }
      if (event?.type === 'thinking_delta' && typeof event.delta === 'string') {
        return [{ type: 'thinking_delta', thinking: event.delta }];
      }
    }
    if (row.type === 'tool_execution_end') {
      return [
        {
          type: 'tool_executed',
          toolCallId: row.toolCallId,
          toolName: row.toolName,
          toolInput: JSON.stringify(row.args ?? {}),
          toolOutput: recordedToolOutput(row.result),
          isError: row.isError === true,
        },
      ];
    }
    // Omnirush 1.0 emits a complete assistant message followed by
    // `agent_settled`; older RPC builds used message_end/agent_end. Support
    // both event generations so a successful turn is not reported as empty.
    if (
      (row.type === 'message' || row.type === 'message_end') &&
      row.message?.role === 'assistant'
    ) {
      return this.acceptAssistantMessage(row.message);
    }
    if ((row.type === 'agent_end' || row.type === 'agent_settled') && !row.willRetry) {
      this.complete = this.sawAnswer;
      if (!this.complete) {
        this.failed = true;
        return [{ type: 'error', error: 'Omnirush ended without an assistant answer.' }];
      }
    }
    if (row.type === 'error' || row.type === 'kory_error') {
      this.failed = true;
      const error = row.error ?? row.message;
      return [
        { type: 'error', error: failure(error), errorTransient: isTransientStreamErrorText(error) },
      ];
    }
    return [];
  }
}

/** One private RPC process for discovery or a turn. No saved user sessions,
 * project extensions, native subagents, or built-in tools are loaded. */
export class OmnirushRpc {
  private child?: ChildProcessWithoutNullStreams;
  private artifact: PrivateCliArtifact;
  private lease?: KoryBridgeGrantLease;
  private pending = new Map<
    string,
    { resolve(value: Row): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >();
  private queue: Row[] = [];
  private waiter?: () => void;
  private sequence = 0;
  private closed = false;
  private terminalError?: Error;
  private stderr = '';
  private stderrStatusBuffer = '';
  private seatWaitReported = false;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  readonly ready: Promise<void>;
  private onAbort: () => void;
  private initialization: Promise<void>;
  private closePromise?: Promise<void>;
  private mcpConfigLeaseRelease?: () => void;
  private mcpConfigLeaseReleased = false;
  private resourcesCleaned = false;
  private configRestored = false;
  private childExitObserved = false;
  private childExited?: Promise<void>;
  private childExitResolve?: () => void;
  private initializationAbortController = new AbortController();
  private mcpConfigPath = '';
  private omnirushStateRoot = '';
  private previousMcpConfig: string | null = null;

  private restoreMcpConfig(): void {
    if (this.configRestored) return;
    this.configRestored = true;
    if (!this.mcpConfigPath || !this.omnirushStateRoot) return;
    if (this.previousMcpConfig === null) {
      rmSync(this.mcpConfigPath, { force: true });
    } else {
      writeOmnirushCliOwnedFile(this.mcpConfigPath, this.previousMcpConfig, this.omnirushStateRoot);
    }
  }

  private releaseMcpConfigLease(): void {
    if (this.mcpConfigLeaseReleased) return;
    this.mcpConfigLeaseReleased = true;
    this.mcpConfigLeaseRelease?.();
  }

  private cleanupResources(): void {
    if (this.resourcesCleaned) return;
    this.resourcesCleaned = true;
    this.restoreMcpConfig();
    this.lease?.cleanup();
    this.artifact.cleanup();
    this.releaseMcpConfigLease();
  }

  private reportSeatWait(): void {
    if (this.seatWaitReported) return;
    this.seatWaitReported = true;
    this.enqueue({
      type: 'kory_waiting',
      waitingReason: 'Waiting for an Omnirush seat',
    });
  }

  constructor(
    binary: string,
    private request?: StreamRequest,
    private stateRoot = omnirushStateDirectory(),
    private bindStateRoot = false,
  ) {
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    // A close before callers await readiness is still consumed below.
    void this.ready.catch(() => {});
    this.artifact = createPrivateCliTextArtifact(
      'omnirush-system',
      [request?.systemPrompt ?? '', KORY_HARNESS_NOTE_EXTENDED].join('\n\n'),
    );
    this.onAbort = () => this.fail(new Error('Omnirush request cancelled.'));
    this.initialization = this.initialize(binary);
    void this.initialization.catch((error: unknown) => {
      this.readyReject(error instanceof Error ? error : new Error(String(error)));
    });
  }

  private async initialize(binary: string): Promise<void> {
    const lockSignal = this.request?.signal
      ? AbortSignal.any([this.request.signal, this.initializationAbortController.signal])
      : this.initializationAbortController.signal;
    this.mcpConfigLeaseRelease = await acquireOmnirushRpcConfigLease(lockSignal);
    if (!this.mcpConfigLeaseRelease) {
      this.closed = true;
      this.readyReject(new Error('Omnirush request cancelled.'));
      this.cleanupResources();
      return;
    }
    if (this.closed) {
      this.releaseMcpConfigLease();
      return;
    }
    const root = this.artifact.directory;
    try {
      if (this.request?.sessionId)
        this.lease = createKoryBridgeGrantLease(
          this.request.sessionId,
          this.request.harnessRole ?? 'manager',
        );
      const server = this.request?.sessionId
        ? buildKoryCliMcpConfig(
            {
              provider: 'omnirush',
              role: this.request.harnessRole ?? 'manager',
              sandbox: this.request.sandbox,
              workingDirectory: this.request.workingDirectory || process.cwd(),
              sessionId: this.request.sessionId,
              systemPrompt: this.request.systemPrompt,
              tools: this.request.tools ?? [],
              bridgeGrantLease: this.lease,
            },
            'omnirush',
          )?.[0]
        : undefined;
      if (this.request?.sessionId && !server)
        throw new Error('Kory MCP bridge configuration is unavailable.');
      const authDirectory = this.stateRoot;
      this.omnirushStateRoot = authDirectory;
      this.mcpConfigPath = join(authDirectory, 'mcp.json');
      this.previousMcpConfig = existsSync(this.mcpConfigPath)
        ? readFileSync(this.mcpConfigPath, 'utf8')
        : null;
      if (server)
        writeOmnirushCliOwnedFile(
          this.mcpConfigPath,
          JSON.stringify(
            {
              mcpServers: {
                [server.name]: {
                  command: server.command,
                  args: server.args,
                  env: server.env ?? {},
                },
              },
            },
            null,
            2,
          ),
          authDirectory,
        );
      const args = [
        '--mode',
        'rpc',
        '--no-session',
        '--no-yolo',
        '--no-approve',
        '--no-builtin-tools',
        '--no-skills',
        '--no-prompt-templates',
        '--no-context-files',
        '--append-system-prompt',
        this.artifact.path,
      ];
      const env = buildProviderCliEnv(
        'omnirush',
        omnirushReleaseEnvironment(authDirectory, this.bindStateRoot),
      );
      // The CLI must retain its real refresh lock and atomic token-rotation
      // directory. A symlink to auth.json alone breaks atomic rename semantics.
      // Omnirush is an inference-only harness here: native tools are disabled
      // above, and every actionable kory__* call is executed by Koryphaios's
      // authenticated MCP bridge. The bridge's ToolRegistry applies the
      // session permission policy and sandboxOptions to the actual command.
      // Wrapping this harness again with bubblewrap/Seatbelt only sandboxes the
      // MCP client process and can prevent the bridge from starting; it does
      // not add authority protection once --no-builtin-tools is active.
      this.child = spawn(binary, args, {
        cwd: root,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        ...providerProcessGroupOptions(),
      });
      this.childExited = new Promise<void>((resolve) => {
        this.childExitResolve = resolve;
      });
      // Current Omnirush MCP uses the standard JSON-RPC stdio handshake and does
      // not emit the old private `kory_ready` event. Readiness for the RPC child
      // is therefore the successful spawn; individual calls remain bounded by
      // their own RPC timeout and surface MCP startup errors normally.
      this.readyResolve();
      this.request?.signal?.addEventListener('abort', this.onAbort, { once: true });
      let buffer = '';
      this.child.stdout.setEncoding('utf8');
      this.child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        if (buffer.length > MAX_FRAME_CHARS) {
          this.fail(new Error('Omnirush exceeded the RPC frame limit.'));
          return;
        }
        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          try {
            this.accept(JSON.parse(line));
          } catch {
            if (isOmnirushSeatWait(line)) this.reportSeatWait();
          }
        }
      });
      this.child.stderr.on('data', (chunk: Buffer) => {
        this.stderr = appendPrivateDiagnostic(this.stderr, chunk);
        if (!this.seatWaitReported) {
          this.stderrStatusBuffer = `${this.stderrStatusBuffer}${chunk.toString('utf8')}`.slice(
            -4096,
          );
          if (isOmnirushSeatWait(this.stderrStatusBuffer)) this.reportSeatWait();
        }
      });
      this.child.stdin.on('error', () => this.fail(new Error('Omnirush RPC input pipe closed.')));
      this.child.once('error', () => this.fail(new Error('Omnirush CLI could not be started.')));
      this.child.once('close', () => {
        this.childExitObserved = true;
        this.childExitResolve?.();
        if (!this.closed)
          this.fail(
            new Error(
              this.stderr ? failure(this.stderr) : 'Omnirush RPC closed before completion.',
            ),
          );
      });
      if (this.request?.signal?.aborted) this.onAbort();
    } catch (error) {
      this.cleanupResources();
      throw error;
    }
  }

  private accept(row: Row): void {
    if (this.closed) return;
    if (row.type === 'kory_ready') {
      this.readyResolve();
      return;
    }
    if (row.type === 'kory_error') {
      this.fail(new Error('Omnirush could not initialize the Kory MCP bridge.'));
      return;
    }
    if (row.type === 'response') {
      const pending = this.pending.get(row.id);
      if (!pending) return;
      this.pending.delete(row.id);
      clearTimeout(pending.timer);
      row.success === true
        ? pending.resolve(row.data ?? {})
        : pending.reject(new Error(failure(row.error)));
      return;
    }
    if (row.type === 'extension_ui_request') {
      // Headless UI requests must not silently grant native permission.
      this.child?.stdin.write(
        JSON.stringify({ type: 'extension_ui_response', id: row.id, cancelled: true }) + '\n',
      );
      return;
    }
    this.enqueue(row);
  }

  private enqueue(row: Row): void {
    if (this.queue.length > 10_000) {
      this.fail(new Error('Omnirush RPC event queue overflow.'));
      return;
    }
    this.queue.push(row);
    this.waiter?.();
    this.waiter = undefined;
  }

  call(type: string, data: Row = {}): Promise<Row> {
    if (this.closed)
      return Promise.reject(this.terminalError ?? new Error('Omnirush transport is closed.'));
    if (!this.child) return Promise.reject(new Error('Omnirush transport is not ready.'));
    const id = String(++this.sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Omnirush ${type} timed out.`));
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.child?.stdin.write(JSON.stringify({ ...data, type, id }) + '\n');
    });
  }

  async next(): Promise<Row> {
    while (!this.queue.length) {
      if (this.closed) throw this.terminalError ?? new Error('Omnirush transport closed.');
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
    return this.queue.shift()!;
  }

  private fail(error: Error): void {
    this.terminalError = error;
    void this.close();
  }

  private waitForChildExit(): Promise<boolean> {
    if (!this.child || this.childExitObserved) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), RPC_TEARDOWN_TIMEOUT_MS);
      void this.childExited?.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.initializationAbortController.abort();
    this.request?.signal?.removeEventListener('abort', this.onAbort);
    const error = this.terminalError ?? new Error('Omnirush transport closed.');
    this.readyReject(error);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.waiter?.();
    this.waiter = undefined;
    this.closePromise = (async () => {
      await this.initialization.catch(() => {});
      const child = this.child;
      if (child && !this.childExitObserved) {
        terminateProviderProcessGroup(child.pid);
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        if (!(await this.waitForChildExit())) {
          // Never restore the shared MCP config or release its lease while the
          // child may still be reading it. The close request remains bounded;
          // the exit handler completes deferred cleanup when the child dies.
          void this.childExited?.then(() => this.cleanupResources());
          return;
        }
      }
      this.cleanupResources();
    })();
    return this.closePromise;
  }
}

export class OmnirushCliProvider implements Provider {
  readonly name = 'omnirush' as const;
  readonly imageInputTransport = 'native' as const;
  readonly supportsFreshConversation = true;
  private models: ModelDef[] = [];
  private discoveryError?: string;
  private lastCatalogAttempt = 0;
  private refreshInFlight: Promise<ModelDef[]> | null = null;
  private authoritative = false;
  constructor(
    readonly config: ProviderConfig,
    private readonly runtime?: OmnirushRuntimeBinding,
  ) {}

  private binary(): string | null {
    return this.runtime?.binary ?? resolveOmnirushLauncher();
  }

  private stateRoot(): string {
    return this.runtime?.stateRoot ?? omnirushStateDirectory();
  }

  isAvailable(): boolean {
    if (this.config.disabled || !this.binary()) return false;
    return this.runtime
      ? (() => {
          try {
            usableOmnirushStateRoot(this.runtime.stateRoot);
            return true;
          } catch {
            return false;
          }
        })()
      : detectOmnirushCLILogin();
  }
  isModelCatalogAuthoritative(): boolean {
    return this.authoritative;
  }
  getModelDiscoveryError(): string | undefined {
    return this.discoveryError;
  }
  listModels(): ModelDef[] {
    // Status reads never spawn repeat probes. Scheduler/connect own refreshes.
    if (this.isAvailable() && !this.lastCatalogAttempt && !this.refreshInFlight)
      void this.refreshModels();
    return this.models;
  }
  refreshModels(force = false): Promise<ModelDef[]> {
    if (this.refreshInFlight) return this.refreshInFlight;
    if (
      this.config.disabled ||
      (!force && this.lastCatalogAttempt && Date.now() - this.lastCatalogAttempt < CATALOG_TTL_MS)
    )
      return Promise.resolve(this.models);
    this.refreshInFlight = (async () => {
      let rpc: OmnirushRpc | undefined;
      try {
        const binary = this.binary();
        if (!binary)
          throw new Error('Omnirush CLI not found on PATH. Install it and run "omnirush login".');
        const stateRoot = this.stateRoot();
        if (this.runtime) assertOmnirushRuntimeBinding(this.runtime);
        else if (!detectOmnirushCLILogin())
          throw new Error('Omnirush is not signed in. Run "omnirush login".');
        try {
          // Omnirush 2.x owns and refreshes this catalog before launching the
          // engine. Prefer it so discovery does not spawn the retired 1.x RPC
          // surface on every refresh.
          const catalog = readOmnirushAvailableCatalog(stateRoot);
          if (!catalog.length) throw new Error('Omnirush model catalog is empty.');
          this.models = catalog;
          this.authoritative = true;
          this.discoveryError = undefined;
          return this.models;
        } catch {
          // Older 1.x installations do not have model-catalog.json; use the
          // legacy RPC discovery path below for those installations.
        }
        let updated = false;
        while (true) {
          try {
            rpc = new OmnirushRpc(binary, undefined, stateRoot, !!this.runtime);
            await rpc.ready;
            this.models = parseOmnirushRpcCatalog((await rpc.call('get_available_models')).models);
            break;
          } catch (error) {
            await rpc?.close();
            rpc = undefined;
            if (
              !updated &&
              isOmnirushStartupFailure(error) &&
              !this.runtime &&
              (updated = await updateOmnirushCli(binary, stateRoot))
            ) {
              continue;
            }
            throw error;
          }
        }
        this.authoritative = true;
        this.discoveryError = undefined;
      } catch (error) {
        if (this.runtime) {
          // A qualification binding must not recover from an identity failure
          // by reading a catalog from the still-bound state root.
          this.discoveryError =
            error instanceof Error ? error.message : 'Omnirush model discovery failed.';
        } else {
          try {
            // Omnirush 2.x retired the RPC engine but keeps its authoritative
            // gateway catalog in the CLI-owned state directory.
            const catalog = readOmnirushAvailableCatalog(this.stateRoot());
            if (!catalog.length) throw new Error('Omnirush model catalog is empty.');
            this.models = catalog;
            this.authoritative = true;
            this.discoveryError = undefined;
          } catch {
            this.discoveryError =
              error instanceof Error ? error.message : 'Omnirush model discovery failed.';
          }
        }
      } finally {
        await rpc?.close();
        this.lastCatalogAttempt = Date.now();
        this.refreshInFlight = null;
      }
      return this.models;
    })();
    return this.refreshInFlight;
  }

  async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    let rpc: OmnirushRpc | undefined;
    const timeout = new AbortController();
    const signal = request.signal
      ? AbortSignal.any([request.signal, timeout.signal])
      : timeout.signal;
    const timer = setTimeout(() => timeout.abort(), resolveOmnirushTurnTimeoutMs(request));
    try {
      if (signal.aborted) return;
      const binary = this.binary();
      if (!binary)
        throw new Error('Omnirush CLI not found on PATH. Install it and run "omnirush login".');
      const stateRoot = this.stateRoot();
      if (this.runtime) assertOmnirushRuntimeBinding(this.runtime);
      if (!this.isAvailable())
        throw new Error('Omnirush is not signed in. Run "omnirush login" and reconnect.');
      if (request.tools?.length && !request.sessionId)
        throw new Error('Omnirush Kory tools require a session-scoped MCP grant.');

      // Omnirush 2.x exposes GPT models through `--print`. Claude models are
      // handled above by the normal managed engine because the CLI refuses
      // them in print mode. Both routes load the Kory custom-tool plugin.
      let currentCatalog: ModelDef[];
      try {
        currentCatalog = readOmnirushAvailableCatalog(stateRoot);
      } catch {
        currentCatalog = [];
      }
      if (currentCatalog.length) {
        const selected = currentCatalog.find(
          (m) => m.id === request.model || `omnirush:${m.id}` === request.model,
        );
        if (!selected)
          throw new Error(
            'The selected Omnirush model is no longer in the CLI catalog. Refresh models and select another model.',
          );
        const prompt = [
          request.systemPrompt ? `system: ${request.systemPrompt}` : '',
          ...request.messages.map((message) => {
            if (typeof message.content !== 'string')
              throw new Error('Omnirush 2.x print mode does not support structured media content.');
            return `${message.role}: ${message.content}`;
          }),
        ]
          .filter(Boolean)
          .join('\n\n');
        if (selected.id.startsWith('claude-')) {
          let claudeAccess: ReturnType<typeof readOmnirushClaudeAccess>;
          try {
            claudeAccess = readOmnirushClaudeAccess(stateRoot);
          } catch {
            claudeAccess = { offered: true, allowedModels: [selected.id], reason: null };
          }
          if (!claudeAccess.allowedModels.includes(selected.id)) {
            throw new Error(
              `${selected.name} is listed by Omnirush but is not enabled for this account (server access: ${claudeAccess.reason ?? 'not_allowed'}). Ask Omnirush to enable Claude Code for this account, then refresh models.`,
            );
          }
          for await (const event of runOmnirushClaudeInteractive(
            binary,
            stateRoot,
            request,
            selected,
            signal,
          )) {
            yield event;
          }
          return;
        }
        let replayed = false;
        let currentBinary = binary;
        while (true) {
          const attempt: OmnirushPrintAttempt = { sideEffect: false };
          try {
            for await (const event of runOmnirushPrint(
              currentBinary,
              stateRoot,
              !!this.runtime,
              request,
              selected,
              prompt,
              signal,
              attempt,
            )) {
              yield event;
            }
            break;
          } catch (error) {
            // A replay is safe only for the provider-owned pre-dispatch update
            // gate. Once text or a tool event has escaped, the request may
            // have side effects and must never be submitted again.
            if (
              replayed ||
              attempt.sideEffect ||
              signal.aborted ||
              !isOmnirushUpdateRequired(error)
            )
              throw error;
            replayed = true;
            const updated = this.runtime
              ? false
              : await updateOmnirushCli(currentBinary, stateRoot, signal);
            if (!updated || signal.aborted) throw error;
            // Re-read the executable path after self-update. Package managers
            // can replace the shim while the update is in progress.
            currentBinary = resolveOmnirushLauncher() ?? currentBinary;
          }
        }
        yield { type: 'complete', finishReason: 'end_turn' };
        return;
      }
      let model: ModelDef;
      let nativeReasoningLevel: string | undefined;
      let updated = false;
      while (true) {
        try {
          rpc = new OmnirushRpc(binary, { ...request, signal }, stateRoot, !!this.runtime);
          await rpc.ready;
          const models = parseOmnirushRpcCatalog((await rpc.call('get_available_models')).models);
          this.models = models;
          this.authoritative = true;
          this.lastCatalogAttempt = Date.now();
          this.discoveryError = undefined;
          const selected = models.find(
            (m) => m.id === request.model || `omnirush:${m.id}` === request.model,
          );
          if (!selected)
            throw new Error(
              'The selected Omnirush model is no longer in the CLI catalog. Refresh models and select another model.',
            );
          model = selected;
          nativeReasoningLevel = request.reasoningLevel
            ? resolveOmnirushReasoningLevel(model, request.reasoningLevel)
            : undefined;
          if (request.reasoningLevel && nativeReasoningLevel === undefined)
            throw new Error(
              'The selected Omnirush model does not advertise that reasoning level. Refresh the catalog and select a reported level.',
            );
          await rpc.call('set_model', { provider: 'omnirush', modelId: model.apiModelId });
          if (nativeReasoningLevel)
            await rpc.call('set_thinking_level', { level: nativeReasoningLevel });
          await rpc.call('set_auto_compaction', { enabled: false });
          const state = await rpc.call('get_state');
          if (
            state.model?.id !== model.apiModelId ||
            (nativeReasoningLevel && state.thinkingLevel !== nativeReasoningLevel)
          )
            throw new Error(
              'Omnirush did not accept the selected model or reasoning level. Update the CLI and retry.',
            );
          break;
        } catch (error) {
          await rpc?.close();
          rpc = undefined;
          if (
            !updated &&
            isOmnirushStartupFailure(error) &&
            !this.runtime &&
            (updated = await updateOmnirushCli(binary, stateRoot, signal))
          ) {
            continue;
          }
          throw error;
        }
      }
      const images: Row[] = [];
      const prompt = request.messages
        .map((message) => {
          const content =
            typeof message.content === 'string'
              ? message.content
              : message.content
                  .map((block) => {
                    if (block.type === 'image' && block.imageData && block.imageMimeType) {
                      images.push({
                        type: 'image',
                        data: block.imageData,
                        mimeType: block.imageMimeType,
                      });
                      return '[Attached image]';
                    }
                    if (block.type === 'text') return block.text ?? '';
                    if (block.type === 'tool_result') return block.toolOutput ?? '';
                    if (block.type === 'tool_use')
                      return JSON.stringify({ tool: block.toolName, input: block.toolInput });
                    throw new Error('Omnirush received unsupported media content.');
                  })
                  .join('\n');
          return `${message.role}: ${content}`;
        })
        .join('\n\n');
      if (!prompt.trim()) throw new Error('Omnirush received an empty prompt.');
      if (images.length && !model.vision && !request.imageInputOverride)
        throw new Error('The Omnirush CLI model does not advertise image support.');
      await rpc.call('prompt', { message: prompt, ...(images.length ? { images } : {}) });
      const events = new OmnirushEvents(model.apiModelId!);
      while (!events.complete && !events.failed) {
        for (const event of events.accept(await rpc.next())) yield event;
      }
      if (events.complete) yield { type: 'complete', finishReason: 'end_turn' };
    } catch (error) {
      if (!request.signal?.aborted)
        yield {
          type: 'error',
          errorTransient:
            isTransientStreamErrorText(error) ||
            isOmnirushSeatWait(error instanceof Error ? error.message : String(error)),
          error: timeout.signal.aborted
            ? 'Omnirush turn timed out.'
            : error instanceof Error
              ? error.message
              : 'Omnirush request failed.',
        };
    } finally {
      clearTimeout(timer);
      await rpc?.close();
    }
  }
}
