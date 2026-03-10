#!/usr/bin/env bun
/**
 * Main dev launcher - runs Tauri desktop mode
 * 
 * This is the standard way to develop Koryphaios Desktop:
 * - Tests actual desktop performance
 * - Catches platform-specific quirks (Windows, macOS, Linux)
 * - Uses real Tauri APIs
 * - Tests CSP and security policies correctly
 * 
 * Usage: bun run dev
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
console.log("  Running Tauri desktop app");
console.log("");
console.log("  Features:");
console.log("  ✓ Native desktop performance");
console.log("  ✓ Cross-platform: Windows, macOS, Linux");
console.log("  ✓ Real native APIs (file system, notifications)");
console.log("  ✓ Local-first architecture");
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
