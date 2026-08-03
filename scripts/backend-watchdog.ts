#!/usr/bin/env bun
/**
 * Koryphaios Backend Watchdog
 *
 * Spawns the backend as a child process and monitors its health endpoint.
 * When the backend becomes unresponsive (the event loop is blocked by a
 * synchronous operation), the watchdog:
 *
 *   1. Attaches gdb to capture native backtraces of all threads.
 *   2. Dumps /proc/PID/status and /proc/PID/smaps_rollup for memory diagnostics.
 *   3. Saves the backend's direct file log tail for correlation.
 *   4. Kills and restarts the backend.
 *
 * The backend calls prctl(PR_SET_PTRACER, -1) at startup (via the event-loop
 * monitor), so gdb can attach even when kernel.yama.ptrace_scope=1.
 *
 * Usage:
 *   bun scripts/backend-watchdog.ts [--inspect-port=9230]
 *
 * Output:
 *   data/logs/watchdog-<timestamp>-gdb.txt   — native backtrace
 *   data/logs/watchdog-<timestamp>-proc.txt  — /proc diagnostics
 *   data/logs/watchdog-<timestamp>-log.txt   — tail of backend-direct.log
 */

const { spawn, execSync } = await import('node:child_process');
const { existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream } = await import('node:fs');
const { resolve, join } = await import('node:path');
const net = await import('node:net');

const PROJECT_ROOT = resolve(import.meta.dir, '..');
const BACKEND_DIR = resolve(PROJECT_ROOT, 'backend');
const LOG_DIR = resolve(PROJECT_ROOT, 'data', 'logs');
const ACTIVE_PORT_PATH = resolve(PROJECT_ROOT, '.koryphaios', '.active-port.json');
const BACKEND_PID_PATH = resolve(PROJECT_ROOT, '.koryphaios', '.backend-pid');

const HEALTH_POLL_MS = 2_000;
const FAIL_THRESHOLD = 3; // 3 consecutive failures = ~6s of unresponsiveness
const GDB_TIMEOUT_S = 15;
const BACKEND_READY_TIMEOUT_MS = 120_000;

// Parse --inspect-port from args
const inspectPortArg = process.argv.find((a) => a.startsWith('--inspect-port='));
const INSPECT_PORT = inspectPortArg ? Number(inspectPortArg.split('=')[1]) : 9230;

const sharedEnv = {
  ...process.env,
  KORYPHAIOS_HOST: process.env.KORYPHAIOS_HOST ?? '127.0.0.1',
  KORYPHAIOS_PORT: process.env.KORYPHAIOS_PORT ?? '3001',
  KORYPHAIOS_FRONTEND_HOST: process.env.KORYPHAIOS_FRONTEND_HOST ?? '127.0.0.1',
  KORYPHAIOS_FRONTEND_PORT: process.env.KORYPHAIOS_FRONTEND_PORT ?? '3003',
  KORYPHAIOS_DESKTOP_DEV: '1',
};

const backendHost = sharedEnv.KORYPHAIOS_HOST;
const backendPort = Number(sharedEnv.KORYPHAIOS_PORT);
const healthUrl = `http://${backendHost}:${backendPort}/api/health`;

let backendProc: ReturnType<typeof spawn> | null = null;
let consecutiveFailures = 0;
let shuttingDown = false;

function log(msg: string) {
  const ts = new Date().toISOString().split('T')[1]?.split('.')[0] ?? '';
  console.log(`[watchdog ${ts}] ${msg}`);
}

function ensureLogDir() {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
}

async function fetchHealth(timeoutMs = 3_000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(healthUrl, { signal: controller.signal });
    return resp.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function getBackendPid(): number | null {
  // Try .backend-pid first (written by the event-loop monitor)
  try {
    if (existsSync(BACKEND_PID_PATH)) {
      return Number(readFileSync(BACKEND_PID_PATH, 'utf-8').trim());
    }
  } catch { /* ignore */ }
  // Fall back to .active-port.json
  try {
    if (existsSync(ACTIVE_PORT_PATH)) {
      const data = JSON.parse(readFileSync(ACTIVE_PORT_PATH, 'utf-8'));
      if (typeof data.pid === 'number') return data.pid;
    }
  } catch { /* ignore */ }
  // Fall back to the spawned process PID
  return backendProc?.pid ?? null;
}

function captureDiagnostics(pid: number, reason: string) {
  ensureLogDir();
  const ts = Date.now();
  const tag = `${ts}-${reason.replace(/\s+/g, '_')}`;

  // 1. gdb backtrace
  const gdbFile = resolve(LOG_DIR, `watchdog-${tag}-gdb.txt`);
  try {
    log(`Capturing gdb backtrace for PID ${pid}...`);
    const gdbOutput = execSync(
      `timeout ${GDB_TIMEOUT_S} gdb -batch -p ${pid} -ex 'thread apply all bt' -ex 'info registers' 2>&1`,
      { encoding: 'utf-8', timeout: (GDB_TIMEOUT_S + 5) * 1000, maxBuffer: 10 * 1024 * 1024 },
    );
    writeFileSync(gdbFile, gdbOutput);
    log(`gdb backtrace saved to ${gdbFile} (${gdbOutput.length} bytes)`);
  } catch (e: any) {
    log(`gdb capture failed: ${e.message}`);
    writeFileSync(gdbFile, `gdb capture failed: ${e.message}\n`);
  }

  // 2. /proc diagnostics
  const procFile = resolve(LOG_DIR, `watchdog-${tag}-proc.txt`);
  try {
    const lines: string[] = [];
    lines.push(`=== Watchdog diagnostic dump ===`);
    lines.push(`PID: ${pid}`);
    lines.push(`Reason: ${reason}`);
    lines.push(`Timestamp: ${new Date().toISOString()}`);
    lines.push('');
    lines.push('--- /proc/' + pid + '/status ---');
    try { lines.push(readFileSync(`/proc/${pid}/status`, 'utf-8')); } catch (e: any) { lines.push(`(error: ${e.message})`); }
    lines.push('');
    lines.push('--- /proc/' + pid + '/smaps_rollup ---');
    try { lines.push(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf-8')); } catch (e: any) { lines.push(`(error: ${e.message})`); }
    lines.push('');
    lines.push('--- /proc/' + pid + '/stat ---');
    try { lines.push(readFileSync(`/proc/${pid}/stat`, 'utf-8')); } catch (e: any) { lines.push(`(error: ${e.message})`); }
    lines.push('');
    lines.push('--- per-thread CPU (top 5) ---');
    try {
      const threadOut = execSync(`ps -L -p ${pid} -o tid,pcpu,stat,wchan:25,comm --sort=-pcpu 2>&1 | head -10`, { encoding: 'utf-8' });
      lines.push(threadOut);
    } catch (e: any) { lines.push(`(error: ${e.message})`); }
    writeFileSync(procFile, lines.join('\n'));
    log(`proc diagnostics saved to ${procFile}`);
  } catch (e: any) {
    log(`proc dump failed: ${e.message}`);
  }

  // 3. Tail of backend-direct.log
  const logTailFile = resolve(LOG_DIR, `watchdog-${tag}-log.txt`);
  try {
    const directLog = resolve(LOG_DIR, 'backend-direct.log');
    if (existsSync(directLog)) {
      const content = readFileSync(directLog, 'utf-8');
      const lines = content.split('\n');
      const tail = lines.slice(-200).join('\n');
      writeFileSync(logTailFile, tail);
      log(`backend log tail saved to ${logTailFile}`);
    }
  } catch (e: any) {
    log(`log tail failed: ${e.message}`);
  }
}

function startBackend(): ReturnType<typeof spawn> {
  log(`Starting backend on ${backendHost}:${backendPort} (inspect port ${INSPECT_PORT})...`);
  const args = [`--inspect=127.0.0.1:${INSPECT_PORT}`, 'run', 'src/server.ts'];
  const proc = spawn('bun', args, {
    cwd: BACKEND_DIR,
    env: sharedEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Pipe backend output to console and to file
  const fileOut = createWriteStream(resolve(LOG_DIR, 'backend-dev.log'), { flags: 'a' });
  const fileErr = createWriteStream(resolve(LOG_DIR, 'backend-dev.err.log'), { flags: 'a' });

  const pipeStream = (stream: any, fileStream: any, label: string) => {
    if (!stream) return;
    let buf = '';
    stream.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      try { fileStream.write(chunk); } catch { /* ignore */ }
      buf += text;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) console.log(`[backend] ${line}`);
      }
    });
  };
  pipeStream(proc.stdout, fileOut, 'stdout');
  pipeStream(proc.stderr, fileErr, 'stderr');

  proc.on('exit', (code, signal) => {
    log(`Backend exited (code=${code}, signal=${signal})`);
    if (!shuttingDown) {
      log('Backend exited unexpectedly — will restart in 2s...');
      setTimeout(() => { if (!shuttingDown) startBackend(); }, 2_000);
    }
  });

  proc.on('error', (err) => {
    log(`Backend spawn error: ${err.message}`);
  });

  backendProc = proc;
  consecutiveFailures = 0;
  return proc;
}

async function waitForBackend(): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < BACKEND_READY_TIMEOUT_MS) {
    if (await fetchHealth()) {
      log(`Backend healthy after ${Math.round((Date.now() - start) / 1000)}s`);
      return true;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function watchdogLoop() {
  while (!shuttingDown) {
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
    if (shuttingDown) return;

    const healthy = await fetchHealth();
    if (healthy) {
      if (consecutiveFailures > 0) {
        log(`Backend recovered after ${consecutiveFailures} failures`);
      }
      consecutiveFailures = 0;
      continue;
    }

    consecutiveFailures++;
    log(`Health check failed (${consecutiveFailures}/${FAIL_THRESHOLD})`);

    if (consecutiveFailures >= FAIL_THRESHOLD) {
      const pid = getBackendPid();
      if (pid) {
        log(`Backend unresponsive for ${consecutiveFailures * HEALTH_POLL_MS}ms — capturing diagnostics...`);
        captureDiagnostics(pid, `health_fail_${consecutiveFailures}`);

        // Kill and restart
        log(`Killing backend PID ${pid}...`);
        try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
        await new Promise((r) => setTimeout(r, 2_000));
        try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
      } else {
        log('Backend unresponsive but PID unknown — cannot capture diagnostics');
      }

      consecutiveFailures = 0;
      // The exit handler will restart the backend
    }
  }
}

async function main() {
  ensureLogDir();
  log(`Koryphaios Backend Watchdog`);
  log(`Health URL: ${healthUrl}`);
  log(`Log dir: ${LOG_DIR}`);
  log(`Fail threshold: ${FAIL_THRESHOLD} consecutive failures (${FAIL_THRESHOLD * HEALTH_POLL_MS}ms)`);

  // Check if backend is already running
  const portListening = await new Promise<boolean>((r) => {
    const sock = net.createConnection({ host: backendHost, port: backendPort });
    sock.setTimeout(1000);
    sock.once('connect', () => { sock.destroy(); r(true); });
    sock.once('timeout', () => { sock.destroy(); r(false); });
    sock.once('error', () => r(false));
  });

  if (!portListening) {
    startBackend();
    const ready = await waitForBackend();
    if (!ready) {
      log('Backend failed to become healthy within timeout — exiting');
      process.exit(1);
    }
  } else {
    log('Backend already running — attaching watchdog only');
  }

  // Start the health monitoring loop
  log('Watchdog monitoring started');
  watchdogLoop();
}

process.on('SIGINT', () => {
  shuttingDown = true;
  log('Shutting down...');
  if (backendProc && !backendProc.killed) {
    backendProc.kill('SIGTERM');
  }
  setTimeout(() => process.exit(0), 1_000);
});

process.on('SIGTERM', () => {
  shuttingDown = true;
  if (backendProc && !backendProc.killed) {
    backendProc.kill('SIGTERM');
  }
  setTimeout(() => process.exit(0), 1_000);
});

main().catch((err) => {
  log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
