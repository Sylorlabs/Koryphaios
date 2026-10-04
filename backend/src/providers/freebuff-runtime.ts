/** Real Freebuff TUI runtime. Docker is transport, never a replacement for bubblewrap. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import seccompProfile from '../../../docker/freebuff-runtime/seccomp.json';

const execFileAsync = promisify(execFile);
export const FREEBUFF_RUNTIME_VERSION = '0.2.12';
export const FREEBUFF_RUNTIME_IMAGE = 'koryphaios/freebuff-runtime:0.2.12-bun1.3.14';
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
let status: FreebuffRuntimeStatus = {
  available: false,
  kind: 'unavailable',
  reason: 'Freebuff isolation runtime has not been checked. Reconnect to probe it.',
};
let checkedAt = 0;
let checking: Promise<FreebuffRuntimeStatus> | undefined;
export function getFreebuffRuntimeStatus(): FreebuffRuntimeStatus {
  return { ...status };
}

/** Docker client may need its own config/context, but it must not receive provider secrets. */
function controlEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: homedir(),
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
  timeout = 30_000,
  env = controlEnv(),
): Promise<string> {
  const result = await execFileAsync(file, args, { env, timeout, maxBuffer: 2 * 1024 * 1024 });
  return result.stdout;
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
    if (
      !isAbsolute(path) ||
      resolve(path) !== path ||
      (path !== root &&
        (!relative(root, path) ||
          relative(root, path).startsWith('..') ||
          isAbsolute(relative(root, path))))
    ) {
      throw new Error('Freebuff runtime paths must stay inside runRoot');
    }
    // macOS /var -> /private/var is a system alias; require callers to canonicalize it.
    if (!existsSync(path) || !lstatSync(path).isDirectory() || realpathSync(path) !== path) {
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
export function freebuffDockerRunArgs(root: string, name: string, allowNetwork = true): string[] {
  return [
    'run',
    '-d',
    '--rm',
    '--name',
    name,
    '--platform',
    'linux/amd64',
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
    '--mount',
    `type=bind,src=${root},dst=${root}`,
    ...(!allowNetwork ? ['--network', 'none'] : []),
    FREEBUFF_RUNTIME_IMAGE,
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
      : mkdtempSync(join(realpathSync(tmpdir()), 'kory-freebuff-control-'));
  const socket = join(controlDir, 'tmux.sock');
  let started = false;
  let closed = false;
  const raw = (file: string, args: string[], timeout?: number, env?: NodeJS.ProcessEnv) =>
    kind === 'docker'
      ? command('docker', ['exec', container, file, ...args], timeout)
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
  for (let parent = dirname(runRoot); parent !== '/'; parent = dirname(parent))
    ancestors.unshift(parent);
  for (const parent of ancestors) bwrap.push('--perms', '0755', '--dir', parent);
  bwrap.push(
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--bind',
    runRoot,
    runRoot,
    '--bind',
    privateTmp,
    '/tmp',
    '--chdir',
    workspace,
    '--clearenv',
  );
  for (const [key, value] of Object.entries(env)) bwrap.push('--setenv', key, value);
  const tmux = (args: string[]) =>
    raw('tmux', ['-S', socket, '-f', '/dev/null', ...args], 30_000, env);
  const cleanup = async () => {
    if (closed) return;
    closed = true;
    if (kind === 'docker') {
      if (started) await command('docker', ['rm', '-f', container]).catch(() => {});
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
          freebuffDockerRunArgs(runRoot, container, options.allowNetwork !== false),
          60_000,
        );
      } finally {
        rmSync(profilePath, { force: true });
      }
      started = true;
      await raw('mkdir', ['-m', '700', controlDir]);
    } else {
      const bin = join(runRoot, 'bin');
      mkdirSync(bin, { recursive: true, mode: 0o700 });
      const source = options.sourceBinary || join(homedir(), '.config/manicode/freebuff');
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
            (path) =>
              path.startsWith(`${runRoot}/`) && existsSync(path) && lstatSync(path).isFile(),
          );
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
        return raw('bwrap', [...bwrap, '--', ...dropIdentity, file, ...args], opts?.timeout);
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
            ...directories,
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
          ['bwrap', ...bwrap, '--', ...dropIdentity, freebuffBinary, ...cliArgs]
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
  if (process.platform !== 'linux' && process.platform !== 'darwin')
    throw new Error('Freebuff requires Linux, or Docker Linux on macOS');
  const kind = process.platform === 'linux' ? 'native' : 'docker';
  // Colima shares HOME, not Darwin's /private/var/folders temporary directory.
  // Only the fresh run subdirectory is mounted, never this parent or HOME.
  const probeParent =
    kind === 'docker' ? join(homedir(), '.koryphaios', 'freebuff-runs') : realpathSync(tmpdir());
  mkdirSync(probeParent, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(realpathSync(probeParent), 'kory-freebuff-probe-'));
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
    const version = (
      await runtime.exec(runtime.freebuffBinary, ['--version'], { timeout: 60_000 })
    ).trim();
    if (!new RegExp(`\\b${FREEBUFF_RUNTIME_VERSION.replace(/\./g, '\\.')}\\b`).test(version))
      throw new Error(`Freebuff runtime must be native CLI ${FREEBUFF_RUNTIME_VERSION}`);
    await runtime.tmux(['new-session', '-d', '-s', runtime.session, 'sleep 15']);
    await runtime.tmux(['has-session', '-t', runtime.session]);
    await runtime.tmux(['kill-server']);
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
      // Readiness must be actionable, but never echo commands/env/credential-bearing stderr.
      const failed = error as { code?: string | number; stderr?: string; message?: string };
      const detail =
        failed.stderr
          ?.trim()
          .split('\n')
          .find((line) => /^(bwrap:|docker:|Error|error)/.test(line)) ||
        (failed.code ? `runtime command exit ${failed.code}` : failed.message?.split('\n')[0]) ||
        'probe failed';
      status = {
        available: false,
        kind: 'unavailable',
        reason: `Freebuff mandatory bwrap/private-tmux runtime probe failed (${detail.slice(0, 240)}). On macOS start Docker/Colima and run bun scripts/setup-freebuff-runtime.ts.`,
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
