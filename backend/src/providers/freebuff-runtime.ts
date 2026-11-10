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
import { randomBytes } from 'node:crypto';
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

export const FREEBUFF_RUNTIME_VERSION = '0.2.16';
export const FREEBUFF_RUNTIME_IMAGE = 'koryphaios/freebuff-runtime:0.2.16-bun1.3.14';
export const FREEBUFF_RUNTIME_IMAGE_ARM64 = 'koryphaios/freebuff-runtime:0.2.16-bun1.3.14-arm64';
export interface FreebuffRuntimeStatus {
  available: boolean;
  kind: 'native' | 'docker' | 'unavailable';
  reason?: string;
  version?: string;
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
type FreebuffDockerArchitecture = 'amd64' | 'arm64';

function dockerArchitecture(env: NodeJS.ProcessEnv): FreebuffDockerArchitecture {
  return env.KORY_FREEBUFF_DOCKER_ARCH === 'arm64' ? 'arm64' : 'amd64';
}

function runtimeImage(architecture: FreebuffDockerArchitecture): string {
  return architecture === 'arm64' ? FREEBUFF_RUNTIME_IMAGE_ARM64 : FREEBUFF_RUNTIME_IMAGE;
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
  build: (env: NodeJS.ProcessEnv) => Promise<void>;
}
const setupDependencies: FreebuffDockerSetupDependencies = {
  environment: freebuffDockerEnvironment,
  command,
  async build(env) {
    // Embedded pinned recipe works in the compiled desktop backend too. stdin
    // is the entire build context: no project, HOME, login or device keys enter it.
    const architecture = dockerArchitecture(env);
    const child = Bun.spawn([
      'docker', 'build', '--platform', `linux/${architecture}`, '--tag', runtimeImage(architecture), '-',
    ], { env, stdin: new Blob([dockerfile]), stdout: 'ignore', stderr: 'ignore' });
    const timer = setTimeout(() => child.kill(), 10 * 60_000);
    try {
      if (await child.exited !== 0) throw new Error('Freebuff runtime installation failed. Reconnect to retry.');
    } finally { clearTimeout(timer); }
  },
};
let imageSetup: Promise<void> | undefined;
/** App-owned, coalesced installation. Existing images are reused; the caller
 * still has to prove real bubblewrap isolation afterward. Never an optimistic pass. */
export function ensureFreebuffDockerImage(
  dependencies: FreebuffDockerSetupDependencies = setupDependencies,
): Promise<void> {
  if (imageSetup) return imageSetup;
  imageSetup = (async () => {
    let env: NodeJS.ProcessEnv;
    try { env = await dependencies.environment(); } catch (error) {
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
      env = await dependencies.environment();
    }
    try {
      const image = runtimeImage(dockerArchitecture(env));
      await dependencies.command('docker', ['image', 'inspect', '--format', '{{.Id}}', image], 30_000, env);
    } catch (error) {
      // A busy/offline daemon is not a missing image. Never queue a rebuild on
      // every transient transport failure.
      if (!/no such (?:image|object)/i.test(String((error as { stderr?: string }).stderr ?? '')))
        throw error;
      await dependencies.build(env);
    }
  })().finally(() => { imageSetup = undefined; });
  return imageSetup;
}
export async function ensureFreebuffRuntimeReady(): Promise<FreebuffRuntimeStatus> {
  if (isMac() || isWindows()) {
    try { await ensureFreebuffDockerImage(); } catch {
      return {
        available: false, kind: 'unavailable',
        reason: 'Freebuff could not prepare its isolated Linux runtime. Make sure Docker is running, then reconnect. Koryphaios installs the runtime automatically.',
      };
    }
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
    runtimeImage(architecture),
  ];
}

async function makeRuntime(
  options: FreebuffRuntimeOptions,
  kind: 'native' | 'docker',
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
export async function probeFreebuffRuntime(): Promise<FreebuffRuntimeStatus> {
  if (!isLinux() && !isMac() && !isWindows())
    throw new Error('Freebuff requires Linux or a Docker Linux runtime');
  const kind = isLinux() ? 'native' : 'docker';
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
    if (catalog.cliVersion !== FREEBUFF_RUNTIME_VERSION)
      throw new Error('Freebuff execution catalog version does not match its runtime');
    await runtime.tmux(['new-session', '-d', '-s', runtime.session, 'sleep 15']);
    await runtime.tmux(['has-session', '-t', runtime.session]);
    await runtime.tmux(['kill-server']);
    executionCatalog = catalog;
    return { available: true, kind, version: FREEBUFF_RUNTIME_VERSION };
  } finally {
    await runtime?.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
}
export async function refreshFreebuffRuntimeStatus(force = false): Promise<FreebuffRuntimeStatus> {
  if (checking) return checking;
  if (!force && checkedAt && Date.now() - checkedAt < 60_000) return getFreebuffRuntimeStatus();
  checking = (async () => {
    try {
      status = await probeFreebuffRuntime();
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
  return makeRuntime(options, ready.kind);
}
