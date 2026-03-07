#!/usr/bin/env bun
/**
 * Web-only dev launcher - runs backend + frontend in browser
 * 
 * WARNING: This mode is faster but LESS ACCURATE for desktop testing:
 * - Browser performance ≠ Desktop performance
 * - No native API testing (menus, tray, file drop)
 * - CSP behaves differently
 * - Platform quirks not caught
 * 
 * Only use this for quick UI iteration.
 * Always test in Tauri mode before committing.
 * 
 * Usage: bun run dev:web
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
console.log("  KORYPHAIOS WEB DEV MODE (BROWSER ONLY)");
console.log("═══════════════════════════════════════════════════════════");
console.log("");
console.log("  ⚠ WARNING: This mode is LESS ACCURATE for desktop testing");
console.log("");
console.log("  Browser mode limitations:");
console.log("  ✗ Performance ≠ Desktop performance");
console.log("  ✗ No native API testing (menus, tray, file drop)");
console.log("  ✗ CSP behaves differently");
console.log("  ✗ Platform quirks (Windows/macOS/Linux) not caught");
console.log("");
console.log("  For accurate desktop testing (recommended):");
console.log("    bun run dev");
console.log("");
console.log("═══════════════════════════════════════════════════════════");
console.log("");

const backend = start("backend", "dev:backend");
const frontend = start("frontend", "dev:frontend");

for (const event of ["SIGINT", "SIGTERM"] as const) {
  process.on(event, async () => {
    await shutdown(event);
    process.exit(0);
  });
}

const [backendExit, frontendExit] = await Promise.all([backend.exited, frontend.exited]);
const code = backendExit !== 0 ? backendExit : frontendExit;
await shutdown("child-exit");
process.exit(code);
