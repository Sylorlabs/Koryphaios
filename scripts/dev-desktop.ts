#!/usr/bin/env bun
/**
 * Desktop dev launcher - starts backend, frontend, and Tauri app
 * Usage: bun run dev:desktop
 * 
 * Cross-platform: Works on Windows, macOS, and Linux
 */

import { spawn, type ChildProcess } from "child_process";
import { resolve } from "path";
import { setTimeout } from "timers/promises";
import { existsSync, readFileSync } from "fs";
import { platform } from "os";

const PROJECT_ROOT = resolve(import.meta.dir, "..");
const FRONTEND_PORT = 5173;
const MAX_WAIT_MS = 30000;
const IS_WINDOWS = platform() === "win32";

// Read port from .env file or use default
function getBackendPort(): number {
  const envPath = resolve(PROJECT_ROOT, ".env");
  if (existsSync(envPath)) {
    const envContent = readFileSync(envPath, "utf-8");
    const portMatch = envContent.match(/KORYPHAIOS_PORT=(\d+)/);
    if (portMatch) {
      return parseInt(portMatch[1], 10);
    }
  }
  // Try to read from koryphaios.json
  const configPath = resolve(PROJECT_ROOT, "koryphaios.json");
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      if (config.server?.port) {
        return config.server.port;
      }
    } catch {
      // Ignore config parse errors
    }
  }
  return 3000;
}

const BACKEND_PORT = getBackendPort();

async function waitForPort(port: number, name: string): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < MAX_WAIT_MS) {
    try {
      const res = await fetch(`http://localhost:${port}/api/health`).catch(() => null);
      if (res?.ok) return true;
    } catch { 
      // Port not ready yet
    }
    await setTimeout(500);
  }
  return false;
}

async function waitForFrontend(port: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < MAX_WAIT_MS) {
    try {
      const res = await fetch(`http://localhost:${port}`).catch(() => null);
      if (res?.ok) return true;
    } catch { 
      // Port not ready yet
    }
    await setTimeout(500);
  }
  return false;
}

// Cross-platform spawn helper
function spawnCrossPlatform(
  command: string,
  args: string[],
  options: { cwd?: string; stdio?: any; env?: NodeJS.ProcessEnv } = {}
): ChildProcess {
  const { cwd, stdio, env } = options;
  
  if (IS_WINDOWS) {
    // On Windows, use cmd.exe /c for shell commands
    return spawn("cmd", ["/c", command, ...args], {
      cwd,
      stdio: stdio || "inherit",
      env: env || process.env,
      windowsHide: false,
    });
  }
  
  // On Unix, spawn directly
  return spawn(command, args, {
    cwd,
    stdio: stdio || "inherit",
    env: env || process.env,
  });
}

// Cross-platform Tauri spawn with cargo environment
function spawnTauriDev(cwd: string): ChildProcess {
  const cargoHome = process.env.CARGO_HOME || resolve(process.env.HOME || "~", ".cargo");
  
  if (IS_WINDOWS) {
    // Windows: Use cmd.exe and set PATH
    const cargoBin = resolve(cargoHome, "bin");
    const newPath = `${cargoBin};${process.env.PATH}`;
    
    return spawn("cmd", ["/c", "bun", "run", "tauri", "dev"], {
      cwd,
      stdio: "inherit",
      env: {
        ...process.env,
        PATH: newPath,
      },
      windowsHide: false,
    });
  }
  
  // Unix: Source cargo env and run
  return spawn("bash", ["-c", `source "${resolve(cargoHome, "env")}" && bun run tauri dev`], {
    cwd,
    stdio: "inherit",
  });
}

console.log(`[Koryphaios Desktop] Starting development servers...`);
console.log(`[Koryphaios Desktop] Platform: ${platform()}`);
console.log(`[Koryphaios Desktop] Backend port: ${BACKEND_PORT}\n`);

// Start backend directly
console.log(`[1/3] Starting backend server on port ${BACKEND_PORT}...`);
const backend = spawnCrossPlatform("bun", ["run", "src/server.ts"], {
  cwd: resolve(PROJECT_ROOT, "backend"),
});

// Wait for backend to be ready
const backendReady = await waitForPort(BACKEND_PORT, "backend");
if (!backendReady) {
  console.error("[Koryphaios Desktop] Backend failed to start");
  backend.kill();
  process.exit(1);
}
console.log("[1/3] Backend ready!\n");

// Start frontend directly
console.log("[2/3] Starting frontend dev server on port 5173...");
const frontend = spawnCrossPlatform("bun", ["run", "vite", "dev"], {
  cwd: resolve(PROJECT_ROOT, "frontend"),
});

// Wait for frontend to be ready
const frontendReady = await waitForFrontend(FRONTEND_PORT);
if (!frontendReady) {
  console.error("[Koryphaios Desktop] Frontend failed to start");
  frontend.kill();
  backend.kill();
  process.exit(1);
}
console.log("[2/3] Frontend ready!\n");

// Launch Tauri
console.log("[3/3] Launching Tauri app...\n");

const tauri = spawnTauriDev(resolve(PROJECT_ROOT, "desktop"));

// Handle cleanup
const cleanup = () => {
  console.log("\n[Koryphaios Desktop] Shutting down servers...");
  backend.kill();
  frontend.kill();
  tauri.kill();
  process.exit(0);
};

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

// Windows doesn't support SIGINT properly, handle exit events
if (IS_WINDOWS) {
  process.on("exit", cleanup);
}

// If Tauri exits, kill the servers
tauri.on("exit", cleanup);
