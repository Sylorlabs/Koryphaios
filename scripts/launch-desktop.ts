#!/usr/bin/env bun
/**
 * Koryphaios Desktop Launcher
 * Starts backend + frontend dev server + Tauri native shell.
 */

const { spawn } = await import('node:child_process');
const { readFileSync, existsSync, createWriteStream, mkdirSync } = await import('node:fs');
const { resolve } = await import('node:path');
const net = await import('node:net');

process.env.KORYPHAIOS_DESKTOP_DEV = process.env.KORYPHAIOS_DESKTOP_DEV ?? '1';

type Child = ReturnType<typeof spawn>;

type AppConfig = {
  server?: {
    host?: string;
    port?: number;
  };
};

type ManagedChild = {
  name: string;
  proc: Child;
  owned: boolean;
};

const PROJECT_ROOT = resolve(import.meta.dir, '..');
const BACKEND_DIR = resolve(PROJECT_ROOT, 'backend');
const FRONTEND_DIR = resolve(PROJECT_ROOT, 'frontend');
const DESKTOP_DIR = resolve(PROJECT_ROOT, 'desktop');
const APP_CONFIG_PATH = resolve(PROJECT_ROOT, 'config', 'app.config.json');
const ACTIVE_PORT_PATH = resolve(PROJECT_ROOT, '.koryphaios', '.active-port.json');
const KORYPHAIOS_BACKEND_ID = 'koryphaios';
const BACKEND_LOG_DIR = resolve(PROJECT_ROOT, 'data', 'logs');
// Backend restart backoff: start fast (the user wants recovery ASAP), grow
// exponentially, cap at 10s so a crash-looping backend doesn't hammer the CPU.
const BACKEND_RESTART_INITIAL_BACKOFF_MS = 500;
const BACKEND_RESTART_MAX_BACKOFF_MS = 10_000;
// Keep the native app's backend stable while agents/editors are changing the
// worktree. Bun's --watch stops the healthy server before it knows whether the
// replacement source parses, so an atomic-looking save can strand the desktop
// UI on its backend-down overlay. Live backend reload remains available as an
// explicit opt-in for developers who accept that interruption.
const BACKEND_WATCH_ENABLED = process.env.KORYPHAIOS_BACKEND_WATCH === '1';

const BACKEND_READY_TIMEOUT_MS = Number(process.env.KORYPHAIOS_BACKEND_READY_TIMEOUT_MS ?? 120_000);
// A restarted backend doesn't need to re-initialise MCP servers from scratch
// (they're already cached), so we can use a tighter timeout than the initial
// 120s cold-start window.
const BACKEND_RESTART_READY_TIMEOUT_MS = Number(
  process.env.KORYPHAIOS_BACKEND_RESTART_READY_TIMEOUT_MS ?? 30_000,
);
const FRONTEND_READY_TIMEOUT_MS = Number(
  process.env.KORYPHAIOS_FRONTEND_READY_TIMEOUT_MS ?? 60_000,
);
const POLL_INTERVAL_MS = 500;
const PROGRESS_INTERVAL_MS = 5_000;
// Post-start watchdog: how often to poll /api/health after everything is up.
const isDesktopDev = process.env.KORYPHAIOS_DESKTOP_DEV === '1';
const BACKEND_WATCHDOG_INTERVAL_MS = Number(
  process.env.KORYPHAIOS_BACKEND_WATCHDOG_INTERVAL_MS ?? (isDesktopDev ? 1_000 : 3_000),
);
// Consecutive failed health checks before tearing the whole workflow down.
// At 3s cadence, 5 failures ~= 15s of sustained regression.
const BACKEND_WATCHDOG_FAIL_THRESHOLD = Number(
  process.env.KORYPHAIOS_BACKEND_WATCHDOG_FAIL_THRESHOLD ?? (isDesktopDev ? 3 : 5),
);

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

function loadAppConfig(): AppConfig {
  if (!existsSync(APP_CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(APP_CONFIG_PATH, 'utf-8')) as AppConfig;
  } catch {
    return {};
  }
}

const appConfig = loadAppConfig();
const backendHost = process.env.KORYPHAIOS_HOST ?? appConfig.server?.host ?? '127.0.0.1';
const backendClientHost = backendHost === '0.0.0.0' ? '127.0.0.1' : backendHost;
const backendPort = Number(process.env.KORYPHAIOS_PORT ?? appConfig.server?.port ?? 3001);
const frontendHost = process.env.KORYPHAIOS_FRONTEND_HOST ?? '127.0.0.1';
const frontendPort = Number(process.env.KORYPHAIOS_FRONTEND_PORT ?? 3003);

const backendUrl = `http://${backendClientHost}:${backendPort}`;
const frontendUrl = `http://${frontendHost}:${frontendPort}`;
const websocketUrl = `ws://${backendClientHost}:${backendPort}/ws`;
const backendHealthUrl = `${backendUrl}/api/health`;

const sharedEnv = {
  ...process.env,
  KORYPHAIOS_HOST: backendHost,
  KORYPHAIOS_PORT: String(backendPort),
  KORYPHAIOS_FRONTEND_HOST: frontendHost,
  KORYPHAIOS_FRONTEND_PORT: String(frontendPort),
  KORYPHAIOS_DESKTOP_DEV: '1',
  // Inherit any pinned compat hash so the dev backend's /api/health reports
  // the same value the dev frontend's Vite define baked in. Without this the
  // backend falls back to its own resolution (env, then compat-hash.json) —
  // keeping them aligned via the file too is fine, but env wins.
  ...(process.env.KORYPHAIOS_FRONTEND_BUNDLE_HASH
    ? { KORYPHAIOS_FRONTEND_BUNDLE_HASH: process.env.KORYPHAIOS_FRONTEND_BUNDLE_HASH }
    : {}),
};

const children: ManagedChild[] = [];
let shuttingDown = false;
let ownedBackend: Child | null = null;
let backendRecoveryInFlight = false;
let backendRestartTimer: ReturnType<typeof setTimeout> | null = null;
let backendRestartBackoffMs = BACKEND_RESTART_INITIAL_BACKOFF_MS;

/** Remove all tracked children matching `name` so cleanup() doesn't signal an
 *  already-exited process after a restartable death. */
function untrack(name: string) {
  for (let i = children.length - 1; i >= 0; i--) {
    if (children[i].name === name) children.splice(i, 1);
  }
}

function track(name: string, proc: Child, owned = true, onExit?: () => void) {
  children.push({ name, proc, owned });
  proc.on('exit', (code, signal) => {
    if (shuttingDown) return;
    if (onExit) {
      log(`\n${name} exited (code=${code}, signal=${signal}) — recovering...`, colors.yellow);
      onExit();
      return;
    }
    log(`\n${name} exited unexpectedly (code=${code}, signal=${signal})`, colors.red);
    void cleanup(code ?? 1);
  });
  proc.on('error', (err: Error) => {
    if (shuttingDown) return;
    log(`\n${name} failed: ${err.message}`, colors.red);
    if (onExit) {
      onExit();
      return;
    }
    void cleanup(1);
  });
}

async function cleanup(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  // Cancel any pending backend restart so it doesn't fire after we've begun
  // tearing down — that would spawn a fresh backend into a dying workflow.
  if (backendRestartTimer) {
    clearTimeout(backendRestartTimer);
    backendRestartTimer = null;
  }
  log('\nShutting down desktop workflow...', colors.yellow);
  for (const { name, proc, owned } of [...children].reverse()) {
    if (!owned || proc.killed) continue;
    log(`  stopping ${name}`, colors.dim);
    try {
      proc.kill('SIGTERM');
    } catch {
      // ignore
    }
  }
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 750));
  process.exit(exitCode);
}

process.on('SIGINT', () => void cleanup(0));
process.on('SIGTERM', () => void cleanup(0));

function pipeLogs(
  name: string,
  stream: NodeJS.ReadableStream | null | undefined,
  color = colors.dim,
) {
  if (!stream) return;
  let buffer = '';
  stream.on('data', (chunk: Buffer | string) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      log(`[${name}] ${line}`, color);
    }
  });
}

// ─── Backend file logging ───────────────────────────────────────────────────
// In dev mode the backend's stdout/stderr go to the terminal via pipeLogs, but
// if the terminal closes (or the user backgrounds the launcher) the crash
// trace is lost forever. Mirror backend output to data/logs/ so a crashed
// backend always leaves a postmortem — same convention as the production
// Tauri supervisor (app_data_dir/logs/backend.log).
let backendFileOut: ReturnType<typeof createWriteStream> | null = null;
let backendFileErr: ReturnType<typeof createWriteStream> | null = null;

function openBackendFileLogs() {
  try {
    mkdirSync(BACKEND_LOG_DIR, { recursive: true });
    backendFileOut = createWriteStream(resolve(BACKEND_LOG_DIR, 'backend-dev.log'), {
      flags: 'a',
    });
    backendFileErr = createWriteStream(resolve(BACKEND_LOG_DIR, 'backend-dev.err.log'), {
      flags: 'a',
    });
  } catch {
    // File logging is best-effort; don't block startup if the dir is read-only.
  }
}

function pipeBackendToFile(
  stream: NodeJS.ReadableStream | null | undefined,
  fileStream: ReturnType<typeof createWriteStream> | null,
) {
  if (!stream || !fileStream) return;
  stream.on('data', (chunk: Buffer | string) => {
    try {
      fileStream.write(chunk);
    } catch {
      // ignore — file logging is best-effort
    }
  });
}

async function isPortListening(host: string, port: number): Promise<boolean> {
  return await new Promise((resolvePromise) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(1000);
    socket.once('connect', () => {
      socket.destroy();
      resolvePromise(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolvePromise(false);
    });
    socket.once('error', () => resolvePromise(false));
  });
}

type BackendHealth = {
  ok?: boolean;
  data?: { id?: string; pid?: number; version?: string; compat?: { serverStartedAt?: number } };
};

type ActivePort = { host?: string; port?: number; pid?: number };

function readActivePort(): ActivePort | null {
  if (!existsSync(ACTIVE_PORT_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(ACTIVE_PORT_PATH, 'utf-8')) as ActivePort;
    return typeof parsed.port === 'number' && typeof parsed.pid === 'number' ? parsed : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function fetchBackendHealth(timeoutMs = 3_000): Promise<BackendHealth | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(backendHealthUrl, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return null;
    return (await response.json()) as BackendHealth;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function isBackendHealthy(): Promise<boolean> {
  const health = await fetchBackendHealth();
  return (
    health?.ok === true &&
    health.data?.id === KORYPHAIOS_BACKEND_ID &&
    typeof health.data.pid === 'number' &&
    typeof health.data.compat?.serverStartedAt === 'number'
  );
}

async function isFrontendHealthy(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  let body: string | null = null;
  try {
    const response = await fetch(frontendUrl, { signal: controller.signal });
    body = response.ok ? await response.text() : null;
  } catch {
    body = null;
  } finally {
    clearTimeout(timer);
  }
  if (!body) return false;
  const lower = body.toLowerCase();
  return lower.includes('<!doctype html') || lower.includes('<html');
}

async function resolvePortState(
  label: string,
  host: string,
  port: number,
  isHealthy: () => Promise<boolean>,
): Promise<'free' | 'reusable'> {
  if (!(await isPortListening(host, port))) return 'free';
  if (label === 'Backend' && (await isHealthy())) {
    const activePort = readActivePort();
    const health = await fetchBackendHealth();
    const markerMatches =
      activePort?.host === backendClientHost &&
      activePort.port === backendPort &&
      activePort.pid === health?.data?.pid &&
      typeof activePort.pid === 'number' &&
      isProcessAlive(activePort.pid);
    if (!markerMatches) {
      throw new Error(
        `Backend port ${host}:${port} is occupied by an unverified process. Refusing to attach the frontend. Stop that process, then rerun bun run dev.`,
      );
    }
    log(`${label} already running at ${host}:${port} — reusing`, colors.yellow);
    return 'reusable';
  }
  if (label !== 'Backend' && (await isHealthy())) {
    log(`${label} already running at ${host}:${port} — reusing`, colors.yellow);
    return 'reusable';
  }
  throw new Error(
    `${label} port ${host}:${port} is already in use by another process. Stop it and rerun bun run dev.`,
  );
}

async function waitForReady(
  label: string,
  isHealthy: () => Promise<boolean>,
  timeoutMs: number,
  hint?: string,
) {
  const started = Date.now();
  let lastProgress = started;

  while (Date.now() - started < timeoutMs) {
    if (await isHealthy()) return;

    if (Date.now() - lastProgress >= PROGRESS_INTERVAL_MS) {
      const elapsed = Math.round((Date.now() - started) / 1000);
      const suffix = hint ? ` — ${hint}` : '';
      log(`  still waiting for ${label}... (${elapsed}s${suffix})`, colors.dim);
      lastProgress = Date.now();
    }

    await new Promise((resolvePromise) => setTimeout(resolvePromise, POLL_INTERVAL_MS));
  }

  throw new Error(`${label} did not become ready within ${timeoutMs}ms`);
}

function startOwnedBackend(): Child {
  const backendArgs = BACKEND_WATCH_ENABLED
    ? ['run', '--watch', 'src/server.ts']
    : ['run', 'src/server.ts'];
  const backend = spawn('bun', backendArgs, {
    cwd: BACKEND_DIR,
    env: sharedEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  untrack('backend');
  ownedBackend = backend;
  // The backend is restartable: when it exits, schedule a restart instead of
  // tearing down Vite/Tauri. A working UI without a working backend is the
  // exact failure mode we're preventing — but killing the frontend on every
  // transient backend crash is the opposite extreme.
  track('backend', backend, true, () => scheduleBackendRestart('process exited'));
  pipeLogs('backend', backend.stdout, colors.dim);
  pipeLogs('backend', backend.stderr, colors.yellow);
  // Mirror to files so a crashed backend leaves a postmortem even if the
  // terminal that launched `bun run dev` is already closed.
  pipeBackendToFile(backend.stdout, backendFileOut);
  pipeBackendToFile(backend.stderr, backendFileErr);
  return backend;
}

/** Schedule a backend restart with exponential backoff. Debounces rapid
 *  exit/error events so a crash-looping backend doesn't spawn dozens of
 *  processes per second. Safe to call from the exit handler, the error
 *  handler, or the watchdog — only one restart is ever in-flight at a time. */
function scheduleBackendRestart(reason: string): void {
  if (shuttingDown) return;
  if (backendRecoveryInFlight) {
    // A recovery is already running (waitForReady is polling). When it fails
    // it will schedule its own follow-up restart, so don't queue a duplicate.
    return;
  }
  if (backendRestartTimer) return; // already scheduled
  const delay = backendRestartBackoffMs;
  backendRestartBackoffMs = Math.min(
    backendRestartBackoffMs * 2,
    BACKEND_RESTART_MAX_BACKOFF_MS,
  );
  log(
    `Backend restart scheduled in ${Math.round(delay / 100) / 10}s (${reason})`,
    colors.yellow,
  );
  backendRestartTimer = setTimeout(() => {
    backendRestartTimer = null;
    void performBackendRestart();
  }, delay);
}

async function performBackendRestart(): Promise<void> {
  if (shuttingDown || backendRecoveryInFlight) return;
  backendRecoveryInFlight = true;
  let success = false;
  try {
    // Kill any lingering backend process before spawning a replacement.
    if (ownedBackend && !ownedBackend.killed) {
      try { ownedBackend.kill('SIGTERM'); } catch {}
      await new Promise((r) => setTimeout(r, 200));
      // Force kill if still alive
      try {
        if (ownedBackend.exitCode === null && ownedBackend.signalCode === null) {
          ownedBackend.kill('SIGKILL');
        }
      } catch {}
    }
    untrack('backend');
    log('Spawning new backend process...', colors.blue);
    startOwnedBackend();
    await waitForReady(
      'restarted backend',
      isBackendHealthy,
      BACKEND_RESTART_READY_TIMEOUT_MS,
    );
    log('Backend recovered', colors.green);
    // Reset backoff after a successful recovery so the next crash restarts
    // immediately instead of waiting for the exponential backoff to decay.
    backendRestartBackoffMs = BACKEND_RESTART_INITIAL_BACKOFF_MS;
    success = true;
  } catch (error) {
    log(
      `Backend recovery failed: ${error instanceof Error ? error.message : String(error)}`,
      colors.red,
    );
  } finally {
    backendRecoveryInFlight = false;
  }
  // Schedule a follow-up restart AFTER clearing backendRecoveryInFlight so
  // the guard in scheduleBackendRestart doesn't reject it. The new backend's
  // exit handler will also fire if the process died, but if it's hanging
  // (alive but unhealthy) this is the only path to recovery.
  if (!success && !shuttingDown) {
    scheduleBackendRestart('health-check timeout');
  }
}

async function main() {
  if (!existsSync(BACKEND_DIR) || !existsSync(FRONTEND_DIR) || !existsSync(DESKTOP_DIR)) {
    throw new Error('Expected backend, frontend, and desktop workspaces to exist.');
  }

  log('Koryphaios Native Desktop Dev', colors.bright);
  log('Starting backend, frontend dev server, and Tauri shell...', colors.blue);
  log(`Backend:  ${backendUrl}`, colors.dim);
  log(`Frontend: ${frontendUrl} (internal dev server for Tauri)`, colors.dim);
  log(`Socket:   ${websocketUrl}`, colors.dim);
  log(
    `Reload:   ${BACKEND_WATCH_ENABLED ? 'watching backend source (interruptible)' : 'stable backend process'}`,
    colors.dim,
  );
  log('Open the native Koryphaios window — no browser required.', colors.dim);
  log('', colors.reset);

  const backendState = await resolvePortState(
    'Backend',
    backendClientHost,
    backendPort,
    isBackendHealthy,
  );

  if (backendState === 'free') {
    openBackendFileLogs();
    startOwnedBackend();

    log('Waiting for backend health...', colors.blue);
    await waitForReady(
      'Backend',
      isBackendHealthy,
      BACKEND_READY_TIMEOUT_MS,
      'MCP servers may take up to ~60s on first launch',
    );
  }

  log('Backend ready', colors.green);

  const frontendState = await resolvePortState(
    'Frontend',
    frontendHost,
    frontendPort,
    isFrontendHealthy,
  );

  if (frontendState === 'free') {
    const frontend = spawn(
      'bun',
      ['x', 'vite', 'dev', '--host', frontendHost, '--port', String(frontendPort), '--strictPort'],
      {
        cwd: FRONTEND_DIR,
        env: {
          ...sharedEnv,
          VITE_BACKEND_URL: backendUrl,
          VITE_BACKEND_WS_URL: websocketUrl,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: SPAWN_SHELL,
      },
    );
    track('frontend', frontend);
    pipeLogs('frontend', frontend.stdout, colors.dim);
    pipeLogs('frontend', frontend.stderr, colors.yellow);

    log('Waiting for frontend dev server...', colors.blue);
    await waitForReady('Frontend', isFrontendHealthy, FRONTEND_READY_TIMEOUT_MS);
  }

  log('Frontend ready', colors.green);

  log('Launching native Tauri shell...', colors.blue);
  const tauri = spawn('bun', ['run', 'tauri', 'dev'], {
    cwd: DESKTOP_DIR,
    env: sharedEnv,
    stdio: 'inherit',
    shell: SPAWN_SHELL,
  });
  track('tauri', tauri);

  log('', colors.reset);
  log('Native desktop app is running.', colors.green);
  log('Press Ctrl+C to stop all processes.', colors.dim);

  // Post-start watchdog: keep an owned backend recoverable without tearing
  // down the desktop shell. A reused external backend remains fail-closed:
  // the launcher cannot safely kill or replace a process it does not own.
  let consecutiveFailures = 0;
  (async () => {
    while (!shuttingDown) {
      await new Promise((r) => setTimeout(r, BACKEND_WATCHDOG_INTERVAL_MS));
      if (shuttingDown) return;
      const healthy = await isBackendHealthy().catch(() => false);
      if (healthy) {
        consecutiveFailures = 0;
        continue;
      }
      consecutiveFailures++;
      log(
        `Backend health regression (${consecutiveFailures}/${BACKEND_WATCHDOG_FAIL_THRESHOLD})`,
        colors.yellow,
      );
      if (consecutiveFailures >= BACKEND_WATCHDOG_FAIL_THRESHOLD) {
        if (ownedBackend) {
          // scheduleBackendRestart handles backoff and deduplication; the
          // exit handler also calls it so we don't double-restart.
          scheduleBackendRestart('health regression');
          consecutiveFailures = 0; // reset; the restart cycle owns the countdown
        } else {
          log(
            'The reused backend stayed unhealthy and is not launcher-owned — shutting down desktop workflow.',
            colors.red,
          );
          void cleanup(1);
          return;
        }
      }
    }
  })();
}

main().catch((err) => {
  log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`, colors.red);
  void cleanup(1);
});
