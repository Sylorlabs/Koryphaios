#!/usr/bin/env bun
/**
 * Koryphaios User Mode Launcher (`bun run user`)
 *
 * Stable daily-driver install for local use, deliberately separate from the
 * development workflow (`bun run dev`):
 *
 *   - Runs the production backend bundle (backend/build/server.js) with plain
 *     `bun` — no `--watch`, no TypeScript hot path. Editing source files while
 *     user mode runs does NOT reload, restart, or crash it.
 *   - Serves the prebuilt static frontend (frontend/build/client) from the
 *     backend itself — no Vite dev server, no HMR, no Tauri dev shell, no
 *     dev-only tooling of any kind.
 *   - Keeps its own isolated data directory (sessions, SQLite DBs, credentials,
 *     logs) outside the repo, so dev experiments, migrations, test runs, and
 *     branch checkouts can never touch the daily-driver state.
 *   - Opens the app in a native Tauri window pointed at the user backend — no
 *     browser needed. The window loads the static production frontend (no Vite,
 *     no HMR), and no dev tooling runs anywhere in this mode.
 *
 * Usage:
 *   bun run user                  Start (rebuilds stale artifacts automatically)
 *   bun run user -- --rebuild     Force a full rebuild of backend + frontend
 *   bun run user -- --no-window   Skip the Tauri window (browser at the URL)
 *   KORYPHAIOS_PORT=3101 bun run user   Prefer a custom port (default 3001;
 *                                       falls forward if occupied, e.g. by dev)
 *   KORYPHAIOS_DATA_DIR=/path bun run user   Override the user data directory
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SPAWN_SHELL = process.platform === 'win32';

const PROJECT_ROOT = resolve(import.meta.dir, '..');
const BACKEND_DIR = join(PROJECT_ROOT, 'backend');
const BACKEND_BUILD = join(BACKEND_DIR, 'build', 'server.js');
const FRONTEND_DIST = join(PROJECT_ROOT, 'frontend', 'build', 'client');
const FRONTEND_ENTRY = join(FRONTEND_DIST, 'index.html');
const DESKTOP_DIR = join(PROJECT_ROOT, 'desktop');

const args = process.argv.slice(2);
const FORCE_REBUILD = args.includes('--rebuild');
const NO_WINDOW = args.includes('--no-window');

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  blue: '\x1b[34m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
};

function log(message: string, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function fail(message: string): never {
  log(`Fatal: ${message}`, colors.red);
  process.exit(1);
}

/** Platform-aware per-user data directory for the stable install. Kept
 *  distinct from both the repo checkout and any packaged Tauri app data so
 *  neither dev work nor a desktop install can contend over the same SQLite
 *  files. */
function defaultUserDataDir(): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'KoryphaiosUser');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim();
    if (appData) return join(appData, 'KoryphaiosUser');
    return join(homedir(), '.koryphaios-user');
  }
  const xdg = process.env.XDG_DATA_HOME?.trim();
  if (xdg) return join(xdg, 'koryphaios-user');
  return join(homedir(), '.local', 'share', 'koryphaios-user');
}

function runBuildStep(label: string, cmd: string, buildArgs: string[], cwd: string): boolean {
  log(`[user] ${label}...`, colors.blue);
  const result = spawnSync(cmd, buildArgs, {
    cwd,
    stdio: 'inherit',
    shell: SPAWN_SHELL,
    env: process.env,
  });
  if (result.status !== 0) {
    return false;
  }
  return true;
}

/** Newest source mtime under a directory (recursive, skips node_modules).
 *  Used to detect stale build artifacts: a bundle older than its sources is
 *  rebuilt so user mode never runs weeks-old code silently. */
function newestMtimeMs(dir: string): number {
  let newest = 0;
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
      const nested = newestMtimeMs(full);
      if (nested > newest) newest = nested;
    } else if (entry.isFile()) {
      try {
        const mtime = statSync(full).mtimeMs;
        if (mtime > newest) newest = mtime;
      } catch {
        // ignore disappearing files
      }
    }
  }
  return newest;
}

function artifactMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function ensureArtifacts() {
  // backend bundle inputs: backend/src + shared/src (workspace import).
  const backendSourcesNewest = Math.max(
    newestMtimeMs(join(BACKEND_DIR, 'src')),
    newestMtimeMs(join(PROJECT_ROOT, 'shared', 'src')),
  );
  const backendStale =
    !existsSync(BACKEND_BUILD) || artifactMtimeMs(BACKEND_BUILD) < backendSourcesNewest;
  if (FORCE_REBUILD || backendStale) {
    // backend `build` runs typecheck first, then bundles server.ts.
    const ok = runBuildStep(
      `Building backend bundle (backend/build/server.js)${FORCE_REBUILD ? '' : ' — sources changed'}`,
      'bun',
      ['run', 'build'],
      BACKEND_DIR,
    );
    if (!ok && existsSync(BACKEND_BUILD)) {
      // A dirty dev tree can fail typecheck; user mode stays usable on the
      // last good bundle instead of refusing to start.
      log('[user] Backend build failed — continuing with the previous bundle.', colors.yellow);
    } else if (!ok) {
      fail('Backend build failed and no previous bundle exists.');
    }
  } else {
    log('[user] Backend bundle is current — skipping build (use --rebuild to force)', colors.dim);
  }
  // Frontend inputs: frontend/src + shared/src, plus the files baked in via
  // Vite define (version + compat hash).
  const frontendSourcesNewest = Math.max(
    newestMtimeMs(join(PROJECT_ROOT, 'frontend', 'src')),
    newestMtimeMs(join(PROJECT_ROOT, 'shared', 'src')),
    artifactMtimeMs(join(PROJECT_ROOT, 'frontend', 'package.json')),
    artifactMtimeMs(join(PROJECT_ROOT, 'compat-hash.json')),
  );
  const frontendStale =
    !existsSync(FRONTEND_ENTRY) || artifactMtimeMs(FRONTEND_ENTRY) < frontendSourcesNewest;
  if (FORCE_REBUILD || frontendStale) {
    // Static adapter build (BUILD_MODE=static): plain HTML/CSS/JS the backend
    // can serve directly. Same entry point the Tauri package uses.
    const ok = runBuildStep(
      `Building static frontend (frontend/build/client)${FORCE_REBUILD ? '' : ' — sources changed'}`,
      'bun',
      ['run', 'desktop/scripts/build-frontend.ts'],
      PROJECT_ROOT,
    );
    if (!ok && existsSync(FRONTEND_ENTRY)) {
      log('[user] Frontend build failed — continuing with the previous build.', colors.yellow);
    } else if (!ok) {
      fail('Frontend build failed and no previous build exists.');
    }
  } else {
    log('[user] Static frontend is current — skipping build (use --rebuild to force)', colors.dim);
  }
  if (!existsSync(BACKEND_BUILD)) fail(`Backend bundle missing: ${BACKEND_BUILD}`);
  if (!existsSync(FRONTEND_ENTRY)) fail(`Static frontend missing: ${FRONTEND_ENTRY}`);
}

/** Seed a fresh user install with the existing provider/model configuration
 *  so the user does not have to re-enter everything. Secrets, credentials,
 *  databases, and sessions are NEVER copied — only the public provider
 *  definitions. Runs once; afterwards the install owns its own config. */
function seedUserConfig(dataDir: string) {
  const dest = join(dataDir, 'koryphaios.json');
  if (existsSync(dest)) return;
  const sources = [join(BACKEND_DIR, 'koryphaios.json'), join(PROJECT_ROOT, 'koryphaios.json')];
  for (const source of sources) {
    if (!existsSync(source)) continue;
    try {
      // Validate it parses before adopting it.
      JSON.parse(readFileSync(source, 'utf-8'));
      copyFileSync(source, dest);
      log(`[user] Seeded provider config from ${source}`, colors.green);
      log(
        '[user] API keys/credentials were NOT copied — enter them once in the UI.',
        colors.yellow,
      );
      return;
    } catch {
      // Corrupt source — try the next one.
    }
  }
  log('[user] No existing config found — starting with defaults.', colors.yellow);
}

async function waitForHealth(url: string, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      let ok = false;
      try {
        const res = await fetch(`${url}/api/health`, { signal: controller.signal });
        ok = res.ok;
      } finally {
        clearTimeout(timer);
      }
      if (ok) return true;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function readActivePort(dataDir: string): { port?: number; url?: string } | null {
  const marker = join(dataDir, '.koryphaios', '.active-port.json');
  if (!existsSync(marker)) return null;
  try {
    return JSON.parse(readFileSync(marker, 'utf-8')) as { port?: number; url?: string };
  } catch {
    return null;
  }
}

/** True when nothing answers on host:port (connection refused/timeout). */
async function isPortFree(host: string, port: number): Promise<boolean> {
  const net = await import('node:net');
  return await new Promise((resolvePromise) => {
    let settled = false;
    const finish = (free: boolean) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      resolvePromise(free);
    };
    const socket = net.createConnection({ host, port });
    socket.once('connect', () => finish(false));
    socket.once('error', () => finish(true));
    socket.setTimeout(1500);
    socket.once('timeout', () => finish(true));
  });
}

/** Pick the requested port, or the next free one above it. The dev backend
 *  usually holds 3001, so user mode slides to 3002+ instead of crashing with
 *  EADDRINUSE — both installs stay up side by side. */
async function findFreePort(host: string, start: number): Promise<number> {
  for (let port = start; port < start + 21; port++) {
    if (await isPortFree(host, port)) return port;
  }
  throw new Error(`No free port found in range ${start}..${start + 20}`);
}

async function main() {
  const host = process.env.KORYPHAIOS_HOST?.trim() || '127.0.0.1';
  const requestedPort = Number(process.env.KORYPHAIOS_PORT ?? 3001) || 3001;
  const dataDir = process.env.KORYPHAIOS_DATA_DIR?.trim() || defaultUserDataDir();

  log('Koryphaios User Mode (stable install)', colors.bright);
  log(`Data:     ${dataDir}`, colors.dim);
  log(`Backend:  ${BACKEND_BUILD}`, colors.dim);
  log(`Frontend: ${FRONTEND_DIST} (static, served by the backend)`, colors.dim);
  log('', colors.reset);

  ensureArtifacts();

  // Resolve the port BEFORE spawning so the backend binds it directly and the
  // health wait + reported URL always agree (no guessing from marker files).
  const probeHost = host === '0.0.0.0' ? '127.0.0.1' : host;
  const port = await findFreePort(probeHost, requestedPort).catch((err: unknown) => {
    fail(err instanceof Error ? err.message : String(err));
  });
  if (port !== requestedPort) {
    log(
      `[user] Port ${requestedPort} is occupied (dev backend?) — using ${port} instead.`,
      colors.yellow,
    );
  }

  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(dataDir, 'logs'), { recursive: true, mode: 0o700 });
  seedUserConfig(dataDir);
  const logFile = join(dataDir, 'logs', 'user-backend.log');

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'production',
    KORYPHAIOS_HOST: host,
    KORYPHAIOS_PORT: String(port),
    KORYPHAIOS_DATA_DIR: dataDir,
    KORYPHAIOS_FRONTEND_DIST: FRONTEND_DIST,
  };
  // A local single-user install has no external KMS. Unless the operator
  // explicitly configured one (passphrase or provider), acknowledge the
  // weak-protection local key explicitly instead of crashing at boot — the
  // backend refuses to start in production otherwise. Same protection level
  // as the dev workflow; the data dir is 0700 + key file is 0600.
  if (!env.KORYPHAIOS_KMS_PASSPHRASE && !env.KORYPHAIOS_KMS_PROVIDER) {
    env.KORYPHAIOS_ALLOW_INSECURE_LOCAL_KMS = '1';
    log('[user] No KMS configured — using local key storage (0700 data dir).', colors.yellow);
  }

  log(`Starting backend (PID will show below) — logs appended to ${logFile}`, colors.blue);
  const child = spawn('bun', [BACKEND_BUILD], {
    cwd: PROJECT_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: SPAWN_SHELL,
  });

  let logStream: ReturnType<typeof import('node:fs').createWriteStream> | null = null;
  try {
    const { createWriteStream } = await import('node:fs');
    logStream = createWriteStream(logFile, { flags: 'a', mode: 0o600 });
  } catch {
    // Console-only logging if the file cannot be opened.
  }

  const tee = (stream: NodeJS.ReadableStream | null, toStderr: boolean) => {
    if (!stream) return;
    stream.on('data', (chunk: Buffer) => {
      try {
        logStream?.write(chunk);
      } catch {
        // ignore
      }
      (toStderr ? process.stderr : process.stdout).write(chunk);
    });
  };
  tee(child.stdout, false);
  tee(child.stderr, true);

  let shuttingDown = false;
  let trackedWindow: ReturnType<typeof spawn> | null = null;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`\n[user] Received ${signal} — stopping...`, colors.yellow);
    for (const proc of [trackedWindow, child]) {
      try {
        proc?.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    log(
      `\n[user] Backend exited unexpectedly (code=${code}, signal=${signal}). See ${logFile}`,
      colors.red,
    );
    try {
      logStream?.end();
    } catch {
      // ignore
    }
    process.exit(code ?? 1);
  });

  const requestedUrl = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;
  log(`Waiting for backend at ${requestedUrl} ...`, colors.blue);
  const healthy = await waitForHealth(requestedUrl, 120_000);
  if (!healthy) {
    fail(`Backend did not become healthy within 120s. See ${logFile}`);
  }

  // The backend may have taken port+1 on EADDRINUSE — report the real URL.
  const marker = readActivePort(dataDir);
  const actualUrl = marker?.url ?? requestedUrl;
  writeFileSync(
    join(dataDir, 'user.json'),
    JSON.stringify(
      { url: actualUrl, pid: child.pid ?? null, startedAt: Date.now(), dataDir },
      null,
      2,
    ),
  );

  log('', colors.reset);
  log(`Koryphaios is running at ${actualUrl}`, colors.green);
  if (NO_WINDOW) {
    log('Open that URL in your browser — no terminal, IDE, or dev tools required.', colors.dim);
    log('Source edits, branch switches, and `bun run dev` do not affect this install.', colors.dim);
    log('Press Ctrl+C to stop.', colors.dim);
    return;
  }

  // Native window for the stable install. The Tauri shell loads the user
  // backend's own URL (static production frontend — no Vite, no HMR), and
  // KORYPHAIOS_PORT tells the shell the backend is already running so it
  // starts no bundled/dev backend of its own. Closing the window stops the
  // backend too: one app, one lifecycle.
  log(
    'Launching native window (first launch compiles the desktop shell — one-time wait)...',
    colors.blue,
  );
  const tauriConfigPath = join(tmpdir(), `kory-user-tauri-config-${process.pid}.json`);
  writeFileSync(tauriConfigPath, JSON.stringify({ build: { devUrl: actualUrl } }));
  const tauri = spawn('bun', ['run', 'tauri', 'dev', '--config', tauriConfigPath], {
    cwd: DESKTOP_DIR,
    env: {
      ...process.env,
      KORYPHAIOS_HOST: host,
      KORYPHAIOS_PORT: String(port),
      KORYPHAIOS_DESKTOP_DEV: '1',
    },
    stdio: 'inherit',
    shell: SPAWN_SHELL,
  });
  trackedWindow = tauri;
  tauri.on('exit', (code, signal) => {
    try {
      rmSync(tauriConfigPath, { force: true });
    } catch {
      // ignore
    }
    if (shuttingDown) return;
    log(
      `\n[user] Window closed (code=${code}, signal=${signal}) — stopping backend...`,
      colors.yellow,
    );
    shutdown('window-closed');
  });
  tauri.on('error', (err: Error) => {
    if (shuttingDown) return;
    log(`\n[user] Window failed to start: ${err.message}`, colors.red);
    log(`[user] The backend is still healthy at ${actualUrl} — use a browser, or`, colors.dim);
    log('[user] re-run with --no-window to skip the native shell.', colors.dim);
  });

  log('', colors.reset);
  log('Native window opening — no browser required.', colors.green);
  log('Source edits, branch switches, and `bun run dev` do not affect this install.', colors.dim);
  log('Closing the window or pressing Ctrl+C stops everything.', colors.dim);
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
