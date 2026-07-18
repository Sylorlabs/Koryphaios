#!/usr/bin/env bun
/**
 * Koryphaios Desktop Launcher
 * Starts backend + frontend dev server + Tauri native shell.
 */

const { spawn } = await import('node:child_process');
const { readFileSync, existsSync } = await import('node:fs');
const { resolve } = await import('node:path');
const net = await import('node:net');

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

const BACKEND_READY_TIMEOUT_MS = Number(process.env.KORYPHAIOS_BACKEND_READY_TIMEOUT_MS ?? 120_000);
const FRONTEND_READY_TIMEOUT_MS = Number(
  process.env.KORYPHAIOS_FRONTEND_READY_TIMEOUT_MS ?? 60_000,
);
const POLL_INTERVAL_MS = 500;
const PROGRESS_INTERVAL_MS = 5_000;
// Post-start watchdog: how often to poll /api/health after everything is up.
const BACKEND_WATCHDOG_INTERVAL_MS = Number(
  process.env.KORYPHAIOS_BACKEND_WATCHDOG_INTERVAL_MS ?? 3_000,
);
// Consecutive failed health checks before tearing the whole workflow down.
// At 3s cadence, 5 failures ~= 15s of sustained regression.
const BACKEND_WATCHDOG_FAIL_THRESHOLD = Number(
  process.env.KORYPHAIOS_BACKEND_WATCHDOG_FAIL_THRESHOLD ?? 5,
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

function track(name: string, proc: Child, owned = true) {
  children.push({ name, proc, owned });
  proc.on('exit', (code, signal) => {
    if (shuttingDown) return;
    log(`\n${name} exited unexpectedly (code=${code}, signal=${signal})`, colors.red);
    void cleanup(code ?? 1);
  });
  proc.on('error', (err: Error) => {
    if (shuttingDown) return;
    log(`\n${name} failed: ${err.message}`, colors.red);
    void cleanup(1);
  });
}

async function cleanup(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
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

async function main() {
  if (!existsSync(BACKEND_DIR) || !existsSync(FRONTEND_DIR) || !existsSync(DESKTOP_DIR)) {
    throw new Error('Expected backend, frontend, and desktop workspaces to exist.');
  }

  log('Koryphaios Native Desktop Dev', colors.bright);
  log('Starting backend, frontend dev server, and Tauri shell...', colors.blue);
  log(`Backend:  ${backendUrl}`, colors.dim);
  log(`Frontend: ${frontendUrl} (internal dev server for Tauri)`, colors.dim);
  log(`Socket:   ${websocketUrl}`, colors.dim);
  log('Open the native Koryphaios window — no browser required.', colors.dim);
  log('', colors.reset);

  const backendState = await resolvePortState(
    'Backend',
    backendClientHost,
    backendPort,
    isBackendHealthy,
  );

  if (backendState === 'free') {
    const backend = spawn('bun', ['run', 'src/server.ts'], {
      cwd: BACKEND_DIR,
      env: sharedEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    track('backend', backend);
    pipeLogs('backend', backend.stdout, colors.dim);
    pipeLogs('backend', backend.stderr, colors.yellow);

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
  });
  track('tauri', tauri);

  log('', colors.reset);
  log('Native desktop app is running.', colors.green);
  log('Press Ctrl+C to stop all processes.', colors.dim);

  // Post-start watchdog: the launcher already exits on raw process death,
  // but a backend can hang or stop responding while still alive. Poll health
  // continuously and tear down EVERYTHING (frontend + Tauri) when the backend
  // is sustained-unhealthy — a working UI without a working backend is the
  // exact failure mode we're preventing.
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
        log(
          `Backend stayed unhealthy for ~${consecutiveFailures * Math.round(BACKEND_WATCHDOG_INTERVAL_MS / 1000)}s — shutting down frontend + Tauri. A stale UI without a working backend is not allowed.`,
          colors.red,
        );
        void cleanup(1);
        return;
      }
    }
  })();
}

main().catch((err) => {
  log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`, colors.red);
  void cleanup(1);
});
