/**
 * dev-desktop.ts
 * Starts backend + frontend dev server + Tauri desktop window.
 * Usage: bun run dev:desktop
 */

import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const processes: Bun.Subprocess[] = [];

function start(name: string, cmd: string[], cwd?: string): Bun.Subprocess {
  const proc = Bun.spawn(cmd, {
    cwd: cwd ?? ROOT,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
    env: process.env,
  });
  processes.push(proc);
  console.log(`[dev:desktop] started ${name} (pid ${proc.pid})`);
  return proc;
}

async function waitForBackend(
  url: string,
  timeoutMs = 30_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok || res.status < 500) return true;
    } catch {
      // not ready yet
    }
    await Bun.sleep(500);
  }
  return false;
}

async function shutdown(signal: string): Promise<void> {
  console.log(`[dev:desktop] shutting down (${signal})`);
  for (const proc of processes) {
    try { proc.kill(); } catch { /* already exited */ }
  }
  await Promise.allSettled(processes.map((p) => p.exited));
}

// ── Start services ────────────────────────────────────────────────────────────

const backend = start("backend", ["bun", "run", "dev:backend"]);

// Give the backend a moment to bind, then start frontend + Tauri
console.log("[dev:desktop] waiting for backend to be ready...");
const backendReady = await waitForBackend("http://127.0.0.1:3001");
if (!backendReady) {
  console.warn("[dev:desktop] backend did not respond in time — continuing anyway");
}

const frontend = start("frontend", ["bun", "run", "dev:frontend"]);

// Give Vite a few seconds to start, then launch Tauri
await Bun.sleep(3000);
const desktopDir = resolve(ROOT, "desktop");
const tauri = start(
  "tauri",
  ["bunx", "tauri", "dev"],
  desktopDir
);

for (const event of ["SIGINT", "SIGTERM"] as const) {
  process.on(event, async () => {
    await shutdown(event);
    process.exit(0);
  });
}

const [backendCode, frontendCode, tauriCode] = await Promise.all([
  backend.exited,
  frontend.exited,
  tauri.exited,
]);

await shutdown("child-exit");
process.exit(tauriCode !== 0 ? tauriCode : backendCode !== 0 ? backendCode : frontendCode);
