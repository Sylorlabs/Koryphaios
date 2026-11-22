/** Real Freebuff TUI runtime. Docker is transport, never a replacement for bubblewrap. */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import seccompProfile from '../../../docker/freebuff-runtime/seccomp.json';
import dockerfile from '../../../docker/freebuff-runtime/Dockerfile' with { type: 'text' };
import {
  canonicalizePath,
  executableSuffixes,
  findOnPath,
  isContainedBy,
  isLinux,
  isMac,
  isWindows,
} from '../runtime/platform';
import { FREEBUFF_DYNAMIC_CATALOG_PROBE, parseFreebuffBundledCatalog, type FreebuffBundledCatalog } from './freebuff-bundled-catalog';
import { discoverFreebuffAccounts, freebuffConfigDir } from './auth-utils';
import {
  FREEBUFF_MIN_RUNTIME_VERSION,
  KNOWN_FREEBUFF_ARCHIVE_SHA256,
  compareFreebuffVersions,
  isValidFreebuffVersion,
  resolveLatestFreebuffVersion,
} from './freebuff-runtime-version';

const FREEBUFF_RUNTIME_REPOSITORY = 'koryphaios/freebuff-runtime';
const FREEBUFF_BUN_VERSION = '1.3.14';
/** Recipe rev: any Dockerfile change produces fresh image tags, never an
 * optimistic reuse of a stale image under a moved version tag. */
const FREEBUFF_RECIPE_REV = createHash('sha256').update(dockerfile).digest('hex').slice(0, 12);

export type FreebuffDockerArchitecture = 'amd64' | 'arm64';

export interface FreebuffRuntimeImageRef {
  version: string;
  image: string;
}

/** Versioned runtime image tag: pinned version, bun pin, recipe rev, arch. */
export function freebuffRuntimeImageTag(
  version: string,
  architecture: FreebuffDockerArchitecture,
): string {
  return `${FREEBUFF_RUNTIME_REPOSITORY}:${version}-bun${FREEBUFF_BUN_VERSION}-r${FREEBUFF_RECIPE_REV}${architecture === 'arm64' ? '-arm64' : ''}`;
}

/** Parse a local tag only when it belongs to this exact recipe and arch. */
function freebuffRuntimeTagVersion(
  tag: string,
  architecture: FreebuffDockerArchitecture,
): string | null {
  const suffix = architecture === 'arm64' ? '-arm64' : '';
  const match = new RegExp(
    `^(\\d{1,4}\\.\\d{1,4}\\.\\d{1,6})-bun${FREEBUFF_BUN_VERSION.replace(/\./g, '\\.')}-r${FREEBUFF_RECIPE_REV}${suffix}$`,
  ).exec(tag);
  const version = match?.[1];
  return version &&
    isValidFreebuffVersion(version) &&
    compareFreebuffVersions(version, FREEBUFF_MIN_RUNTIME_VERSION) >= 0
    ? version
    : null;
}

export interface FreebuffRuntimeStatus {
  available: boolean;
  kind: 'native' | 'docker' | 'unavailable';
  reason?: string;
  version?: string;
  /** Internal: the exact image turns must launch; never a guessed latest tag. */
  image?: string;
}
export interface FreebuffRuntimeOptions {
  runRoot: string;
  runHome: string;
  workspace: string;
  privateTmp: string;
  sourceBinary?: string;
  /** Deliberately not inherited: provider keys and host process variables are forbidden. */
  env?: NodeJS.ProcessEnv;
  allowNetwork?: boolean;
}
export interface FreebuffTurnRuntime {
  kind: 'native' | 'docker';
  freebuffBinary: string;
  bunBinary: string;
  hostGateway?: string;
  session: string;
  tmux(args: string[]): Promise<string>;
  exec(command: string, args: string[], options?: { timeout?: number }): Promise<string>;
  start(cliArgs: string[]): Promise<void>;
  cleanup(): Promise<void>;
}
function dockerArchitecture(env: NodeJS.ProcessEnv): FreebuffDockerArchitecture {
  return env.KORY_FREEBUFF_DOCKER_ARCH === 'arm64' ? 'arm64' : 'amd64';
}

/** Local versioned images for this recipe+arch, newest valid version first. */
async function listFreebuffRuntimeImages(
  probe: typeof command,
  env: NodeJS.ProcessEnv,
  architecture: FreebuffDockerArchitecture,
): Promise<FreebuffRuntimeImageRef[]> {
  const output = await probe(
    'docker',
    ['image', 'ls', FREEBUFF_RUNTIME_REPOSITORY, '--format', '{{.Tag}}'],
    30_000,
    env,
  );
  return output
    .split('\n')
    .map((tag) => tag.trim())
    .filter(Boolean)
    .map((tag) => {
      const version = freebuffRuntimeTagVersion(tag, architecture);
      return version ? { version, image: `${FREEBUFF_RUNTIME_REPOSITORY}:${tag}` } : null;
    })
    .filter((entry): entry is FreebuffRuntimeImageRef => entry !== null)
    .sort((a, b) => compareFreebuffVersions(b.version, a.version));
}

function runtimePath(value: string, hostRoot: string, sandboxRoot: string): string {
  if (sandboxRoot === hostRoot || !isContainedBy(hostRoot, value)) return value;
  const child = relative(hostRoot, value);
  return child ? join(sandboxRoot, child) : sandboxRoot;
}
let status: FreebuffRuntimeStatus = {
  available: false,
  kind: 'unavailable',
  reason: 'Freebuff isolation runtime has not been checked. Reconnect to probe it.',
};
let checkedAt = 0;
let checking: Promise<FreebuffRuntimeStatus> | undefined;
let executionCatalog: FreebuffBundledCatalog | null = null;
/** Catalog protocol measured from the actual qualified execution binary. */
export function getFreebuffRuntimeCatalog(): FreebuffBundledCatalog | null {
  return status.available ? executionCatalog : null;
}
export function getFreebuffRuntimeStatus(): FreebuffRuntimeStatus {
  return { ...status };
}

/** Test seam: drain a pending update, then restore the pre-probe module
 * state so sibling files in one process never inherit a probed runtime. */
export async function resetFreebuffRuntimeStateForTests(): Promise<void> {
  await imageSetup?.catch(() => {});
  await imageUpdate?.catch(() => {});
  await forcedUpdate?.catch(() => {});
  await checking?.catch(() => {});
  status = {
    available: false,
    kind: 'unavailable',
    reason: 'Freebuff isolation runtime has not been checked. Reconnect to probe it.',
  };
  checkedAt = 0;
  checking = undefined;
  executionCatalog = null;
  selectedRuntimeImage = undefined;
  imageSetup = undefined;
  imageUpdate = undefined;
  forcedUpdate = undefined;
  lastScheduleAt = 0;
}

/**
 * Native Linux probes must use the same executable discovery as the provider.
 * Freebuff supports sibling profiles (manicode2, manicode-work, ...), and a
 * detected account may keep its launcher in that profile instead of the
 * default ~/.config/manicode directory. Probing only the default path made
 * those accounts appear detected while the connection check failed before the
 * real CLI could start.
 */
export function findNativeFreebuffProbeBinary(): string | undefined {
  const profileCandidates = discoverFreebuffAccounts().flatMap((account) =>
    executableSuffixes().map((suffix) => join(account.profileDir, `freebuff${suffix}`)),
  );
  const candidates = [
    ...profileCandidates,
    ...executableSuffixes().map((suffix) => join(freebuffConfigDir(), `freebuff${suffix}`)),
    findOnPath('freebuff'),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => existsSync(candidate));
}

/** Docker client may need its own config/context, but it must not receive provider secrets. */
function controlEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: homedir(),
    USERPROFILE: homedir(),
    LANG: 'C.UTF-8',
  };
  for (const key of [
    'DOCKER_HOST',
    'DOCKER_CONTEXT',
    'DOCKER_CONFIG',
    'DOCKER_TLS_VERIFY',
    'DOCKER_CERT_PATH',
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}
async function command(
  file: string,
  args: string[],
  timeout = 60_000,
  env = controlEnv(),
): Promise<string> {
  // Drain both pipes before accepting exit. Bun's Node execFile compatibility
  // callback can precede the last Docker output chunk under heavy host load.
  const child = Bun.spawn([file, ...args], { env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
  const read = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2 * 1024 * 1024) {
          child.kill('SIGKILL');
          throw new Error('Freebuff runtime output exceeded its transport limit');
        }
        chunks.push(value);
      }
      return Buffer.concat(chunks).toString('utf8');
    } finally { reader.releaseLock(); }
  };
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, read(child.stdout), read(child.stderr)]);
    if (code !== 0 || timedOut) {
      const action = ['info', 'image', 'exec', 'run', 'rm', 'list', 'start'].includes(args[0] ?? '')
        ? args[0] : 'isolated command';
      const message = timedOut
        ? `Freebuff runtime ${file === 'docker' ? 'Docker' : 'controller'} ${action} timed out`
        : 'Freebuff runtime command failed';
      throw Object.assign(new Error(message), { code: timedOut ? 'TIMEOUT' : code, stderr });
    }
    return stdout;
  } finally { clearTimeout(timer); }
}

export interface FreebuffDockerSetupDependencies {
  environment: typeof freebuffDockerEnvironment;
  command: typeof command;
  build: (
    env: NodeJS.ProcessEnv,
    version: string,
    sha256: string,
  ) => Promise<FreebuffRuntimeImageRef>;
  resolveLatest: typeof resolveLatestFreebuffVersion;
  /** Injectable only for tests; production always proves the real runtime. */
  probeRuntime?: typeof probeFreebuffRuntime;
}

async function buildFreebuffRuntimeImage(
  env: NodeJS.ProcessEnv,
  version: string,
  sha256: string,
): Promise<FreebuffRuntimeImageRef> {
  // Embedded recipe works in the compiled desktop backend too. stdin
  // is the entire build context: no project, HOME, login or device keys enter it.
  // Only the validated version and a hex archive hash ever enter the build.
  if (!isValidFreebuffVersion(version))
    throw new Error(`Refusing to build a Freebuff runtime for invalid version '${version}'`);
  const architecture = dockerArchitecture(env);
  const image = freebuffRuntimeImageTag(version, architecture);
  const child = Bun.spawn(
    [
      'docker',
      'build',
      '--platform',
      `linux/${architecture}`,
      '--build-arg',
      `FREEBUFF_VERSION=${version}`,
      '--build-arg',
      `FREEBUFF_SHA256=${/^[0-9a-f]{64}$/i.test(sha256) ? sha256 : ''}`,
      '--tag',
      image,
      '-',
    ],
    { env, stdin: new Blob([dockerfile]), stdout: 'ignore', stderr: 'ignore' },
  );
  const timer = setTimeout(() => child.kill(), 10 * 60_000);
  try {
    if ((await child.exited) !== 0)
      throw new Error('Freebuff runtime installation failed. Reconnect to retry.');
  } finally {
    clearTimeout(timer);
  }
  return { version, image };
}

const setupDependencies: FreebuffDockerSetupDependencies = {
  environment: freebuffDockerEnvironment,
  command,
  build: buildFreebuffRuntimeImage,
  resolveLatest: resolveLatestFreebuffVersion,
};

/** The image turns currently launch. Set only by a successful probe or swap —
 * never by image discovery alone. */
let selectedRuntimeImage: FreebuffRuntimeImageRef | undefined;
let imageSetup: Promise<FreebuffRuntimeImageRef> | undefined;
let imageUpdate: Promise<void> | undefined;
let forcedUpdate: Promise<FreebuffRuntimeStatus> | undefined;
let lastScheduleAt = 0;

async function freebuffDockerEnvironmentWithResume(
  dependencies: Pick<FreebuffDockerSetupDependencies, 'environment' | 'command'>,
): Promise<NodeJS.ProcessEnv> {
  try {
    return await dependencies.environment();
  } catch (error) {
    // Resume an existing, correctly sized architecture profile without
    // creating a VM or switching Docker's global context.
    if (process.env.KORY_FREEBUFF_DOCKER_CONTEXT || process.env.DOCKER_CONTEXT || process.env.DOCKER_HOST)
      throw error;
    const profiles = (await dependencies.command('colima', ['list', '--json'], 10_000, controlEnv()))
      .split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    const existing = profiles.find((profile) =>
      profile.name === 'default' &&
      ['x86_64', 'aarch64', 'arm64'].includes(String(profile.arch)) &&
      profile.runtime === 'docker' &&
      profile.status === 'Stopped');
    if (!existing) throw error;
    await dependencies.command('colima', ['start', 'default', '--activate=false'], 120_000, controlEnv());
    return dependencies.environment();
  }
}

/**
 * Remove only this repository's same-arch tags beyond the current and the
 * immediately previous version. Removal errors (e.g. an image in use) are
 * ignored; no other repository is ever touched.
 */
async function gcFreebuffRuntimeImages(
  probe: typeof command,
  env: NodeJS.ProcessEnv,
  architecture: FreebuffDockerArchitecture,
  currentVersion: string,
): Promise<void> {
  let local: FreebuffRuntimeImageRef[];
  try {
    local = await listFreebuffRuntimeImages(probe, env, architecture);
  } catch {
    return;
  }
  const keep = new Set([currentVersion]);
  const previous = local.find(
    (entry) => compareFreebuffVersions(entry.version, currentVersion) < 0,
  );
  if (previous) keep.add(previous.version);
  for (const entry of local) {
    if (keep.has(entry.version)) continue;
    await probe('docker', ['image', 'rm', entry.image], 30_000, env).catch(() => {});
  }
}

/**
 * Coalesced background update: build the resolved target image, prove real
 * bubblewrap isolation with it, then swap the runtime status atomically.
 * Turns already running keep their container.
 */
function scheduleFreebuffImageUpdate(
  env: NodeJS.ProcessEnv,
  architecture: FreebuffDockerArchitecture,
  target: string,
  dependencies: FreebuffDockerSetupDependencies,
  prebuilt?: FreebuffRuntimeImageRef,
): void {
  if (imageUpdate) return;
  imageUpdate = (async () => {
    try {
      const built =
        prebuilt ??
        (await dependencies.build(
          env,
          target,
          KNOWN_FREEBUFF_ARCHIVE_SHA256[target]?.[architecture] ?? '',
        ));
      const next = await (dependencies.probeRuntime ?? probeFreebuffRuntime)(built);
      if (!next.available) return;
      status = next;
      selectedRuntimeImage = built;
      checkedAt = Date.now();
      await gcFreebuffRuntimeImages(
        dependencies.command,
        env,
        architecture,
        built.version,
      );
    } catch {
      /* Keep the proven current runtime; a failed update never downgrades it. */
    }
  })().finally(() => {
    imageUpdate = undefined;
  });
}

/**
 * App-owned, coalesced image candidate selection. Target = npm `latest` when
 * resolvable, else the newest local image. The returned ref is only a
 * CANDIDATE: selectedRuntimeImage changes solely through a successful probe
 * or a swap path, so an unprobed local image can never serve turns. A newer
 * local image while a proven image serves swaps in the background; a missing
 * target builds in the background while the proven image keeps serving; with
 * no local image the build is blocking.
 */
export function ensureFreebuffRuntimeImage(
  dependencies: FreebuffDockerSetupDependencies = setupDependencies,
): Promise<FreebuffRuntimeImageRef> {
  if (imageSetup) return imageSetup;
  imageSetup = (async () => {
    const env = await freebuffDockerEnvironmentWithResume(dependencies);
    const architecture = dockerArchitecture(env);
    const local = await listFreebuffRuntimeImages(dependencies.command, env, architecture);
    const latest = await dependencies.resolveLatest().catch(() => null);
    const target = latest ?? local[0]?.version;
    const proven = selectedRuntimeImage;
    if (target) {
      const existing = local.find((entry) => entry.version === target);
      if (existing) {
        if (proven && existing.image !== proven.image) {
          // Built by another process or an earlier run: probe it in the
          // background and swap on success — never hand turns an unprobed tag.
          scheduleFreebuffImageUpdate(env, architecture, target, dependencies, existing);
          return proven;
        }
        return existing;
      }
      if (local.length > 0) {
        scheduleFreebuffImageUpdate(env, architecture, target, dependencies);
        return proven ?? local[0]!;
      }
      return dependencies.build(
        env,
        target,
        KNOWN_FREEBUFF_ARCHIVE_SHA256[target]?.[architecture] ?? '',
      );
    }
    throw new Error(
      'Freebuff isolated runtime image is not installed and the latest release could not be resolved. Check network access to the npm registry and reconnect.',
    );
  })().finally(() => {
    imageSetup = undefined;
  });
  return imageSetup;
}

/**
 * Non-blocking latest check. Throttled to once per ten minutes and skipped
 * while any image flow is in flight: this runs on status-render paths, which
 * must never spawn docker work back to back.
 */
export function scheduleFreebuffRuntimeUpdate(
  dependencies: FreebuffDockerSetupDependencies = setupDependencies,
): void {
  if (!isMac() && !isWindows()) return;
  if (imageSetup || imageUpdate || forcedUpdate) return;
  if (Date.now() - lastScheduleAt < 10 * 60_000) return;
  lastScheduleAt = Date.now();
  void ensureFreebuffRuntimeImage(dependencies).catch(() => {});
}

/**
 * Forced update used by the 410 self-heal for a runtime that was rejected at
 * `failedVersion`. Already-advanced status returns immediately, in-flight
 * updates are awaited first, and all concurrent callers share one build.
 * Throws an actionable error when Codebuff already requires more than the
 * latest published release.
 */
export function forceFreebuffRuntimeUpdate(
  failedVersion?: string,
  signal?: AbortSignal,
  dependencies: FreebuffDockerSetupDependencies = setupDependencies,
): Promise<FreebuffRuntimeStatus> {
  const alreadyAdvanced = () =>
    status.available &&
    status.version !== undefined &&
    (!failedVersion ||
      compareFreebuffVersions(status.version, failedVersion) > 0);
  const begin = async (): Promise<FreebuffRuntimeStatus> => {
    // Shared across concurrent callers — it must never observe one caller's
    // signal, or cancelling that turn would fail the update for the others.
    // Per-caller cancellation is a pre-check in run() plus the caller-side race.
    if (imageUpdate) await imageUpdate.catch(() => {});
    if (alreadyAdvanced()) return getFreebuffRuntimeStatus();
    if (!isMac() && !isWindows()) {
      throw new Error(
        'the installed Freebuff CLI is retired; update it and reconnect',
      );
    }
    const env = await dependencies.environment();
    const architecture = dockerArchitecture(env);
    const latest = await dependencies.resolveLatest({ force: true });
    if (!latest)
      throw new Error(
        'the latest Freebuff release could not be resolved; check network access to the npm registry and retry',
      );
    if (failedVersion && compareFreebuffVersions(latest, failedVersion) <= 0)
      throw new Error(
        `Codebuff requires a newer Freebuff than the latest published release v${latest}`,
      );
    const local = await listFreebuffRuntimeImages(dependencies.command, env, architecture);
    const built =
      local.find((entry) => entry.version === latest) ??
      (await dependencies.build(
        env,
        latest,
        KNOWN_FREEBUFF_ARCHIVE_SHA256[latest]?.[architecture] ?? '',
      ));
    const next = await (dependencies.probeRuntime ?? probeFreebuffRuntime)(built);
    if (!next.available)
      throw new Error('the updated Freebuff runtime failed its isolation probe');
    status = next;
    selectedRuntimeImage = built;
    checkedAt = Date.now();
    await gcFreebuffRuntimeImages(dependencies.command, env, architecture, built.version);
    return getFreebuffRuntimeStatus();
  };
  const run = async (): Promise<FreebuffRuntimeStatus> => {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (alreadyAdvanced()) return getFreebuffRuntimeStatus();
    forcedUpdate ??= begin().finally(() => {
      forcedUpdate = undefined;
    });
    return forcedUpdate;
  };
  return run();
}

export async function ensureFreebuffRuntimeReady(): Promise<FreebuffRuntimeStatus> {
  if (isMac() || isWindows()) {
    let candidate: FreebuffRuntimeImageRef;
    try {
      candidate = await ensureFreebuffRuntimeImage();
    } catch {
      return {
        available: false, kind: 'unavailable',
        reason: 'Freebuff could not prepare its isolated Linux runtime. Make sure Docker is running, then reconnect. Koryphaios installs the runtime automatically.',
      };
    }
    return refreshFreebuffRuntimeStatus(true, candidate);
  }
  return refreshFreebuffRuntimeStatus(true);
}

/** Namespace setup must run on a native Linux kernel, not under user-mode
 * emulation. Prefer the selected daemon; a running Colima profile is a local fallback.
 * This never changes Docker's global context or starts/stops a user's VM.
 */
export async function freebuffDockerEnvironment(
  probe: typeof command = command,
): Promise<NodeJS.ProcessEnv> {
  const env = controlEnv();
  if (process.env.KORY_FREEBUFF_DOCKER_CONTEXT) {
    env.DOCKER_CONTEXT = process.env.KORY_FREEBUFF_DOCKER_CONTEXT;
    delete env.DOCKER_HOST;
  }
  const architecture = await probe('docker', ['info', '--format', '{{.Architecture}}'], 30_000, env)
    .then((value) => value.trim()).catch(() => 'unavailable');
  if (['x86_64', 'amd64'].includes(architecture)) {
    env.KORY_FREEBUFF_DOCKER_ARCH = 'amd64';
    return env;
  }
  if (['aarch64', 'arm64'].includes(architecture)) {
    env.KORY_FREEBUFF_DOCKER_ARCH = 'arm64';
    return env;
  }
  if (
    !process.env.KORY_FREEBUFF_DOCKER_CONTEXT &&
    !process.env.DOCKER_CONTEXT &&
    !process.env.DOCKER_HOST
  ) {
    const colimaEnv: NodeJS.ProcessEnv = { ...env, DOCKER_CONTEXT: 'colima' };
    try {
      const colimaArchitecture = (
        await probe('docker', ['info', '--format', '{{.Architecture}}'], 30_000, colimaEnv)
      ).trim();
      if (['x86_64', 'amd64'].includes(colimaArchitecture)) {
        colimaEnv.KORY_FREEBUFF_DOCKER_ARCH = 'amd64';
        return colimaEnv;
      }
      if (['aarch64', 'arm64'].includes(colimaArchitecture)) {
        colimaEnv.KORY_FREEBUFF_DOCKER_ARCH = 'arm64';
        return colimaEnv;
      }
    } catch {
      /* Report the architecture requirement below. */
    }
  }
  throw new Error(
    'Freebuff requires a Linux Docker daemon with a native amd64 or arm64 kernel; select a running context with KORY_FREEBUFF_DOCKER_CONTEXT',
  );
}
function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Fail closed on lexical escape and symlinks before mounting anything. */
export function validateFreebuffRuntimePaths(options: FreebuffRuntimeOptions): void {
  const root = options.runRoot;
  if (
    !isAbsolute(root) ||
    resolve(root) !== root ||
    root === sep ||
    root === homedir() ||
    root === process.cwd() ||
    /[,\n\r]/.test(root)
  ) {
    throw new Error('Freebuff runRoot must be a dedicated absolute private directory');
  }
  for (const path of [root, options.runHome, options.workspace, options.privateTmp]) {
    if (!isAbsolute(path) || resolve(path) !== path || !isContainedBy(root, path)) {
      throw new Error('Freebuff runtime paths must stay inside runRoot');
    }
    // macOS /var -> /private/var is a system alias; require callers to canonicalize it.
    if (!existsSync(path) || !lstatSync(path).isDirectory() || canonicalizePath(path) !== path) {
      throw new Error(
        'Freebuff runtime paths must be existing canonical directories without symlinks',
      );
    }
  }
  if (new Set([root, options.runHome, options.workspace, options.privateTmp]).size !== 4) {
    throw new Error('Freebuff home, workspace and tmp must be distinct private directories');
  }
}

/** Only the disposable root is host-mounted; no devices, host home or daemon socket.
 * The trusted tmux/bwrap controller needs four capabilities on Ubuntu/Colima,
 * whose AppArmor kernel policy blocks unprivileged userns even in unconfined containers.
 * The actual CLI is UID/GID-dropped with ZERO effective/permitted/inheritable/ambient
 * capabilities and no-new-privileges, inside mandatory bwrap mount/PID/IPC/UTS isolation.
 */
export function freebuffDockerRunArgs(
  root: string,
  name: string,
  image: string,
  allowNetwork = true,
  architecture: FreebuffDockerArchitecture = 'amd64',
  mountTarget = root,
): string[] {
  return [
    'run',
    '-d',
    '--rm',
    '--name',
    name,
    '--platform',
    `linux/${architecture}`,
    '--pull=never',
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt',
    'no-new-privileges',
    '--cap-add=SYS_ADMIN',
    '--cap-add=SETUID',
    '--cap-add=SETGID',
    '--cap-add=DAC_OVERRIDE',
    '--security-opt',
    'apparmor=unconfined',
    // Moby default allowlist with ONLY pivot_root added; mount/namespace operations
    // already require SYS_ADMIN in the profile. All other syscall restrictions remain.
    '--security-opt',
    `seccomp=${join(root, '.runtime-seccomp.json')}`,
    '--pids-limit',
    '256',
    '--memory',
    '3g',
    '--cpus',
    '2',
    '--user',
    '0:0',
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,mode=1777,size=256m',
    // Docker Desktop provides this alias automatically; Colima does not.
    // host-gateway resolves to the selected Linux VM's host bridge on both.
    '--add-host',
    'host.docker.internal:host-gateway',
    '--mount',
    `type=bind,src=${root},dst=${mountTarget}`,
    ...(!allowNetwork ? ['--network', 'none'] : []),
    image,
  ];
}

async function makeRuntime(
  options: FreebuffRuntimeOptions,
  kind: 'native' | 'docker',
  image?: string,
): Promise<FreebuffTurnRuntime> {
  validateFreebuffRuntimePaths(options);
  const { runRoot, runHome, workspace, privateTmp } = options;
  const id = randomBytes(10).toString('hex');
  const container = `kory-freebuff-${id}`;
  const session = `kory-freebuff-${id}`;
  // Control socket is NOT visible inside bwrap: /tmp there is privateTmp.
  const controlDir =
    kind === 'docker'
      ? `/tmp/kory-control-${id}`
      : mkdtempSync(join(canonicalizePath(tmpdir()), 'kory-freebuff-control-'));
  const socket = join(controlDir, 'tmux.sock');
  const dockerEnv = kind === 'docker' ? await freebuffDockerEnvironment() : undefined;
  const dockerArch = dockerEnv ? dockerArchitecture(dockerEnv) : undefined;
  const runImage = kind === 'docker' ? image ?? selectedRuntimeImage?.image : undefined;
  if (kind === 'docker' && !runImage)
    throw new Error('Freebuff runtime image is not selected; reconnect to prepare it.');
  // Windows paths cannot be used as paths inside the Linux container. Docker
  // mounts the host run root at this stable POSIX location, while native Linux
  // and macOS keep the existing same-path mount contract.
  const sandboxRoot = kind === 'docker' && isWindows() ? '/kory/run' : runRoot;
  let started = false;
  let closed = false;
  const raw = (file: string, args: string[], timeout?: number, env?: NodeJS.ProcessEnv) =>
    kind === 'docker'
      ? command('docker', ['exec', container, file, ...args], timeout, dockerEnv)
      : command(file, args, timeout, env);
  let freebuffBinary = '/opt/kory/freebuff/freebuff';
  let bunBinary = '/opt/kory/bun';
  const env: Record<string, string> = {
    HOME: runHome,
    USERPROFILE: runHome,
    XDG_CONFIG_HOME: join(runHome, '.config'),
    XDG_CACHE_HOME: join(runHome, '.cache'),
    XDG_DATA_HOME: join(runHome, '.local/share'),
    XDG_STATE_HOME: join(runHome, '.local/state'),
    TMPDIR: privateTmp,
    TERM: 'xterm-256color',
    LANG: 'C.UTF-8',
    PATH: `${join(runRoot, 'bin')}:/opt/kory:/usr/local/bin:/usr/bin:/bin`,
  };
  if (sandboxRoot !== runRoot) {
    for (const key of [
      'HOME',
      'USERPROFILE',
      'XDG_CONFIG_HOME',
      'XDG_CACHE_HOME',
      'XDG_DATA_HOME',
      'XDG_STATE_HOME',
      'TMPDIR',
    ]) {
      env[key] = runtimePath(env[key]!, runRoot, sandboxRoot);
    }
    env.PATH = `${runtimePath(join(runRoot, 'bin'), runRoot, sandboxRoot)}:/opt/kory:/usr/local/bin:/usr/bin:/bin`;
  }
  const bwrap = [
    '--die-with-parent',
    '--new-session',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--cap-drop',
    'ALL',
  ];
  if (kind === 'native') bwrap.push('--unshare-user');
  else bwrap.push('--cap-add', 'CAP_SETUID', '--cap-add', 'CAP_SETGID');
  // The controller is root only outside bwrap. Drop UID and all ambient/inheritable
  // capabilities before any CLI/bridge code executes; NNP prevents reacquisition.
  const dropIdentity =
    kind === 'docker'
      ? [
          '/usr/bin/setpriv',
          `--reuid=${process.getuid?.() || 65534}`,
          `--regid=${process.getgid?.() || 65534}`,
          '--clear-groups',
          '--inh-caps=-all',
          '--ambient-caps=-all',
        ]
      : [];
  if (options.allowNetwork === false && kind === 'native') bwrap.push('--unshare-net');
  bwrap.push('--perms', '0755', '--dir', '/etc', '--perms', '0755', '--dir', '/opt');
  for (const path of ['/usr', '/bin', '/sbin', '/lib', '/lib64'])
    bwrap.push('--ro-bind-try', path, path);
  for (const path of [
    '/etc/ssl',
    '/etc/ca-certificates',
    '/etc/resolv.conf',
    '/etc/hosts',
    '/etc/nsswitch.conf',
    '/etc/passwd',
    '/etc/group',
  ])
    bwrap.push('--ro-bind-try', path, path);
  if (kind === 'docker') bwrap.push('--ro-bind', '/opt/kory', '/opt/kory');
  // bwrap creates missing parents mode0700; root-controlled Docker setup must
  // make only the empty synthetic ancestor chain traversable after UID drop.
  const ancestors: string[] = [];
  for (let parent = dirname(sandboxRoot); parent !== '/'; parent = dirname(parent))
    ancestors.unshift(parent);
  for (const parent of ancestors) bwrap.push('--perms', '0755', '--dir', parent);
  bwrap.push(
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--bind',
    runRoot,
    sandboxRoot,
    '--bind',
    runtimePath(privateTmp, runRoot, sandboxRoot),
    '/tmp',
    '--chdir',
    runtimePath(workspace, runRoot, sandboxRoot),
    '--clearenv',
  );
  for (const [key, value] of Object.entries(env)) bwrap.push('--setenv', key, value);
  const tmux = (args: string[]) =>
    raw('tmux', ['-S', socket, '-f', '/dev/null', ...args], 30_000, env);
  const cleanup = async () => {
    if (closed) return;
    closed = true;
    if (kind === 'docker') {
      if (started)
        await command('docker', ['rm', '-f', container], 30_000, dockerEnv).catch(() => {});
    } else {
      await tmux(['kill-server']).catch(() => {});
      rmSync(controlDir, { recursive: true, force: true });
    }
  };
  try {
    if (kind === 'docker') {
      const profilePath = join(runRoot, '.runtime-seccomp.json');
      // Docker CLI consumes this before starting the container, not a runtime trust input.
      writeFileSync(profilePath, JSON.stringify(seccompProfile), { mode: 0o600, flag: 'wx' });
      try {
        await command(
          'docker',
           freebuffDockerRunArgs(
             runRoot,
             container,
             runImage!,
             options.allowNetwork !== false,
             dockerArch ?? 'amd64',
             sandboxRoot,
           ),
          60_000,
          dockerEnv,
        );
      } finally {
        rmSync(profilePath, { force: true });
      }
      started = true;
      await raw('mkdir', ['-m', '700', controlDir]);
    } else {
      const bin = join(runRoot, 'bin');
      mkdirSync(bin, { recursive: true, mode: 0o700 });
      const source = options.sourceBinary || join(freebuffConfigDir(), 'freebuff');
      freebuffBinary = join(bin, 'freebuff');
      if (resolve(source) !== freebuffBinary) copyFileSync(source, freebuffBinary);
      const wasm = join(dirname(source), 'tree-sitter.wasm');
      if (existsSync(wasm) && resolve(wasm) !== join(bin, 'tree-sitter.wasm'))
        copyFileSync(wasm, join(bin, 'tree-sitter.wasm'));
      bunBinary = join(bin, 'bun');
      const bun = Bun.which('bun');
      if (!bun) throw new Error('Freebuff bridge runtime requires Bun');
      copyFileSync(bun, bunBinary);
      chmodSync(freebuffBinary, 0o700);
      chmodSync(bunBinary, 0o700);
    }
    const runtime: FreebuffTurnRuntime = {
      kind,
      freebuffBinary,
      bunBinary,
      hostGateway: kind === 'docker' ? 'host.docker.internal' : undefined,
      session,
      tmux,
      async exec(file, args, opts) {
        if (closed) throw new Error('Freebuff runtime is closed');
        if (kind === 'docker') {
          // Colima sshfs caches readdir after host staging writes (even when stat
          // sees the new file). A disposable create/unlink inside the same private
          // directory invalidates that cache. Never retry command/tool execution
          // and never read input contents or touch anything outside runRoot.
          const staged = [file, ...args].filter(
            (path) => isContainedBy(runRoot, path) && existsSync(path) && lstatSync(path).isFile(),
          ).map((path) => runtimePath(path, runRoot, sandboxRoot));
          if (staged.length)
            await raw(
              'bwrap',
              [
                ...bwrap,
                '--',
                ...dropIdentity,
                '/bin/sh',
                '-ec',
                'for file do marker=$(mktemp "$(dirname "$file")/.kory-stage-XXXXXXXX"); rm -- "$marker"; test -r "$file"; done',
                'staged-inputs',
                ...staged,
              ],
              10_000,
            );
        }
        return raw(
          'bwrap',
          [
            ...bwrap,
            '--',
            ...dropIdentity,
            runtimePath(file, runRoot, sandboxRoot),
            ...args.map((arg) => runtimePath(arg, runRoot, sandboxRoot)),
          ],
          opts?.timeout,
        );
      },
      async start(cliArgs) {
        if (closed) throw new Error('Freebuff runtime is closed');
        if (kind === 'docker') {
          // The TUI scans .agents and workspace directories itself. Invalidate
          // all staged directory listings before it starts, not just Bun entry files.
          const directories = [runRoot];
          for (let index = 0; index < directories.length; index++) {
            for (const entry of readdirSync(directories[index]!, { withFileTypes: true })) {
              if (entry.isDirectory()) directories.push(join(directories[index]!, entry.name));
            }
          }
          await runtime.exec('/bin/sh', [
            '-ec',
            'for dir do marker=$(mktemp "$dir/.kory-stage-XXXXXXXX"); rm -- "$marker"; done',
            'staged-directories',
            ...directories.map((directory) => runtimePath(directory, runRoot, sandboxRoot)),
          ]);
        }
        await tmux([
          'new-session',
          '-d',
          '-s',
          session,
          '-x',
          '180',
          '-y',
          '50',
           ['bwrap', ...bwrap, '--', ...dropIdentity, freebuffBinary, ...cliArgs.map((arg) => runtimePath(arg, runRoot, sandboxRoot))]
            .map(quote)
            .join(' '),
        ]);
      },
      cleanup,
    };
    // Every turn verifies isolation, even when availability is cached.
    await runtime.exec('/bin/sh', [
      '-ec',
      'test "$(id -u)" != 0; test ! -e /var/run/docker.sock; test ! -e "$1"; grep -Eq "^CapEff:[[:space:]]+0+$" /proc/self/status; grep -Eq "^CapPrm:[[:space:]]+0+$" /proc/self/status; grep -Eq "^NoNewPrivs:[[:space:]]+1$" /proc/self/status; printf bwrap-ok',
      'probe',
      socket,
    ]);
    return runtime;
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** Credential-free real kernel/filesystem + private tmux probe, used by readiness and setup. */
export async function probeFreebuffRuntime(
  target?: FreebuffRuntimeImageRef,
): Promise<FreebuffRuntimeStatus> {
  if (!isLinux() && !isMac() && !isWindows())
    throw new Error('Freebuff requires Linux or a Docker Linux runtime');
  const kind = isLinux() ? 'native' : 'docker';
  // The probe must know exactly which image it is proving: an explicit target
  // (update swap), the selected image, or the newest local versioned image.
  let probeImage = target;
  if (kind === 'docker' && !probeImage) {
    if (selectedRuntimeImage) probeImage = selectedRuntimeImage;
    else {
      const env = await freebuffDockerEnvironment();
      const local = await listFreebuffRuntimeImages(
        command,
        env,
        dockerArchitecture(env),
      );
      probeImage = local[0];
    }
    if (!probeImage)
      throw new Error('no Freebuff runtime image is installed');
  }
  // Colima shares HOME, not Darwin's /private/var/folders temporary directory.
  // Only the fresh run subdirectory is mounted, never this parent or HOME.
  const probeParent =
    kind === 'docker'
      ? join(homedir(), '.koryphaios', 'freebuff-runs')
      : canonicalizePath(tmpdir());
  mkdirSync(probeParent, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(canonicalizePath(probeParent), 'kory-freebuff-probe-'));
  const runRoot = join(root, 'run');
  for (const dir of [
    runRoot,
    join(runRoot, 'home'),
    join(runRoot, 'workspace'),
    join(runRoot, 'tmp'),
  ])
    mkdirSync(dir, { mode: 0o700 });
  const sentinel = join(root, 'host-sentinel');
  writeFileSync(sentinel, 'not a credential; must remain outside isolation', { mode: 0o600 });
  let runtime: FreebuffTurnRuntime | undefined;
  try {
    runtime = await makeRuntime(
      {
        runRoot,
        runHome: join(runRoot, 'home'),
        workspace: join(runRoot, 'workspace'),
        privateTmp: join(runRoot, 'tmp'),
        ...(kind === 'native' && { sourceBinary: findNativeFreebuffProbeBinary() }),
        allowNetwork: false,
      },
      kind,
      probeImage?.image,
    );
    const script =
      'test ! -e "$1"; ! cat "$1" 2>/dev/null; ! (echo denied > "$1") 2>/dev/null; ! (echo denied > /usr/kory-denied) 2>/dev/null; echo allowed > "$2"; printf isolation-ok';
    const evidence = await runtime.exec('/bin/sh', [
      '-ec',
      script,
      'probe',
      sentinel,
      join(runRoot, 'workspace/allowed'),
    ]);
    if (evidence !== 'isolation-ok') throw new Error('Freebuff filesystem isolation probe failed');
    // Native --version exits before its console output reliably drains through
    // Docker exec. Inspect the embedded version and protocol of the actual
    // sandbox binary instead; an empty pipe is never mistaken for a bad version.
    const catalog = parseFreebuffBundledCatalog(Buffer.from(
      await runtime.exec(runtime.bunBinary, ['-e', FREEBUFF_DYNAMIC_CATALOG_PROBE, runtime.freebuffBinary]),
    ));
    if (kind === 'docker') {
      // The probed image's own version tag is the contract; never an optimistic pass.
      if (catalog.cliVersion !== probeImage!.version)
        throw new Error('Freebuff execution catalog version does not match its runtime image');
    } else if (
      !isValidFreebuffVersion(catalog.cliVersion) ||
      compareFreebuffVersions(catalog.cliVersion, FREEBUFF_MIN_RUNTIME_VERSION) < 0
    ) {
      throw new Error(
        `Freebuff ${catalog.cliVersion} is retired; version ${FREEBUFF_MIN_RUNTIME_VERSION} or newer is required`,
      );
    }
    await runtime.tmux(['new-session', '-d', '-s', runtime.session, 'sleep 15']);
    await runtime.tmux(['has-session', '-t', runtime.session]);
    await runtime.tmux(['kill-server']);
    executionCatalog = catalog;
    return {
      available: true,
      kind,
      version: kind === 'docker' ? probeImage!.version : catalog.cliVersion,
      ...(probeImage ? { image: probeImage.image } : {}),
    };
  } finally {
    await runtime?.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
}
export async function refreshFreebuffRuntimeStatus(
  force = false,
  target?: FreebuffRuntimeImageRef,
): Promise<FreebuffRuntimeStatus> {
  if (checking) return checking;
  if (!force && checkedAt && Date.now() - checkedAt < 60_000) return getFreebuffRuntimeStatus();
  checking = (async () => {
    try {
      status = await probeFreebuffRuntime(target);
      if (status.available && status.image)
        selectedRuntimeImage = { version: status.version ?? '', image: status.image };
    } catch (error) {
      executionCatalog = null;
      // Readiness must be actionable, but never echo commands/env/credential-bearing stderr.
      const failed = error as { code?: string | number; stderr?: string; message?: string };
      const detail =
        failed.stderr
          ?.trim()
          .split('\n')
          .find((line) => /^(bwrap:|docker:|Error|error)/.test(line)) ||
        (failed.code === 'TIMEOUT' ? failed.message :
          failed.code ? `runtime command exit ${failed.code}` : failed.message?.split('\n')[0]) ||
        'probe failed';
      status = {
        available: false,
        kind: 'unavailable',
        reason: `Freebuff isolated runtime check failed (${detail.slice(0, 240)}). Reconnect to let Koryphaios prepare and check the runtime again.`,
      };
    }
    checkedAt = Date.now();
    return getFreebuffRuntimeStatus();
  })();
  try {
    return await checking;
  } finally {
    checking = undefined;
  }
}
export async function createFreebuffTurnRuntime(
  options: FreebuffRuntimeOptions,
): Promise<FreebuffTurnRuntime> {
  const ready = await refreshFreebuffRuntimeStatus();
  if (!ready.available || ready.kind === 'unavailable')
    throw new Error(ready.reason || 'Freebuff runtime unavailable');
  // Turns always launch the PROVEN image from status, never a candidate ref.
  return makeRuntime(options, ready.kind, ready.image);
}
