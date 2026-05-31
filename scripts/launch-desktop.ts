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

const PROJECT_ROOT = resolve(import.meta.dir, '..');
const BACKEND_DIR = resolve(PROJECT_ROOT, 'backend');
const FRONTEND_DIR = resolve(PROJECT_ROOT, 'frontend');
const DESKTOP_DIR = resolve(PROJECT_ROOT, 'desktop');
const APP_CONFIG_PATH = resolve(PROJECT_ROOT, 'config', 'app.config.json');

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

const sharedEnv = {
  ...process.env,
  KORYPHAIOS_HOST: backendHost,
  KORYPHAIOS_PORT: String(backendPort),
  KORYPHAIOS_FRONTEND_HOST: frontendHost,
  KORYPHAIOS_FRONTEND_PORT: String(frontendPort),
};

const children: Array<{ name: string; proc: Child }> = [];
let shuttingDown = false;

function track(name: string, proc: Child) {
  children.push({ name, proc });
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
  for (const { name, proc } of children.reverse()) {
    if (proc.killed) continue;
    log(`  stopping ${name}`, colors.dim);
    try {
      proc.kill('SIGTERM');
    } catch {
      // ignore
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 750));
  process.exit(exitCode);
}

process.on('SIGINT', () => void cleanup(0));
process.on('SIGTERM', () => void cleanup(0));

function pipeLogs(name: string, stream: NodeJS.ReadableStream | null | undefined, color = colors.dim) {
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
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(500);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

async function assertPortAvailable(label: string, host: string, port: number) {
  if (await isPortListening(host, port)) {
    throw new Error(`${label} port ${host}:${port} is already in use. Stop the existing process and rerun bun run dev.`);
  }
}

async function waitForHttpOk(label: string, url: string, timeoutMs: number, validate?: (body: string) => boolean) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        const body = await response.text();
        if (!validate || validate(body)) return;
      }
    } catch {
      // keep waiting
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label} did not become ready at ${url} within ${timeoutMs}ms`);
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
  log('', colors.reset);

  await assertPortAvailable('Backend', backendClientHost, backendPort);
  await assertPortAvailable('Frontend', frontendHost, frontendPort);

  const backend = spawn('bun', ['run', 'src/server.ts'], {
    cwd: BACKEND_DIR,
    env: sharedEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  track('backend', backend);
  pipeLogs('backend', backend.stdout, colors.dim);
  pipeLogs('backend', backend.stderr, colors.yellow);

  log('Waiting for backend health...', colors.blue);
  await waitForHttpOk('Backend', `${backendUrl}/api/health`, 30000, (body) => body.includes('"ok":true'));
  log('Backend ready', colors.green);

  const frontend = spawn('bun', ['x', 'vite', 'dev', '--host', frontendHost, '--port', String(frontendPort), '--strictPort'], {
    cwd: FRONTEND_DIR,
    env: {
      ...sharedEnv,
      VITE_BACKEND_URL: backendUrl,
      VITE_BACKEND_WS_URL: websocketUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  track('frontend', frontend);
  pipeLogs('frontend', frontend.stdout, colors.dim);
  pipeLogs('frontend', frontend.stderr, colors.yellow);

  log('Waiting for frontend dev server...', colors.blue);
  await waitForHttpOk('Frontend', frontendUrl, 30000, (body) => body.includes('<!doctype html') || body.includes('<!DOCTYPE html'));
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
}

main().catch((err) => {
  log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`, colors.red);
  void cleanup(1);
});
