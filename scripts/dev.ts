#!/usr/bin/env bun
/**
 * Main dev launcher - runs Tauri desktop mode by default
 * 
 * This is the RECOMMENDED way to develop because:
 * - Tests actual desktop performance (not browser)
 * - Catches platform-specific quirks (Windows, macOS, Linux)
 * - Uses real Tauri APIs (not mocks)
 * - Tests CSP and security policies correctly
 * 
 * Usage: bun run dev
 * 
 * For browser-only development (faster but less accurate):
 *   bun run dev:web
 */

const processes: Bun.Subprocess[] = [];

function start(name: string, script: string): Bun.Subprocess {
  const proc = Bun.spawn(["bun", "run", script], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
    env: process.env,
  });

  processes.push(proc);
  console.log(`[dev] started ${name} (pid ${proc.pid})`);
  return proc;
}

async function shutdown(signal: string): Promise<void> {
  console.log(`[dev] shutting down (${signal})`);
  for (const proc of processes) {
    try {
      proc.kill();
    } catch {
      // Process already exited.
    }
  }
  await Promise.allSettled(processes.map((proc) => proc.exited));
}

console.log("═══════════════════════════════════════════════════════════");
console.log("  KORYPHAIOS DESKTOP DEV MODE");
console.log("═══════════════════════════════════════════════════════════");
console.log("");
console.log("  Running Tauri desktop app (recommended for testing)");
console.log("");
console.log("  Why Tauri mode?");
console.log("  ✓ Tests actual desktop performance");
console.log("  ✓ Catches Windows/macOS/Linux quirks");
console.log("  ✓ Uses real native APIs");
console.log("  ✓ Tests CSP and security correctly");
console.log("");
console.log("  For browser-only mode (faster, less accurate):");
console.log("    bun run dev:web");
console.log("");
console.log("═══════════════════════════════════════════════════════════");
console.log("");

// Run Tauri desktop dev mode
const desktop = start("desktop", "dev:desktop");

for (const event of ["SIGINT", "SIGTERM"] as const) {
  process.on(event, async () => {
    await shutdown(event);
    process.exit(0);
  });
}

const code = await desktop.exited;
await shutdown("child-exit");
process.exit(code);
