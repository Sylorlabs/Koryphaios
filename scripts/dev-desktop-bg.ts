#!/usr/bin/env bun
/**
 * Desktop dev launcher - background mode with log files
 * Runs servers in background, opens Tauri app instantly
 * Logs go to files for debugging
 */

import { spawn } from "child_process";
import { resolve } from "path";
import { setTimeout } from "timers/promises";
import { mkdirSync, existsSync } from "fs";

const PROJECT_ROOT = resolve(import.meta.dir, "..");
const LOG_DIR = resolve(PROJECT_ROOT, ".koryphaios", "logs");
const BACKEND_PORT = 3002;
const FRONTEND_PORT = 5173;
const MAX_WAIT_MS = 30000;

// Ensure log directory exists
if (!existsSync(LOG_DIR)) {
  mkdirSync(LOG_DIR, { recursive: true });
}

const backendLog = resolve(LOG_DIR, "backend.log");
const frontendLog = resolve(LOG_DIR, "frontend.log");

async function waitForPort(port: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < MAX_WAIT_MS) {
    try {
      const res = await fetch(`http://localhost:${port}/api/health`).catch(() => null);
      if (res?.ok) return true;
    } catch { }
    await setTimeout(200);
  }
  return false;
}

async function waitForFrontend(port: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < MAX_WAIT_MS) {
    try {
      const res = await fetch(`http://localhost:${port}`).catch(() => null);
      if (res?.ok) return true;
    } catch { }
    await setTimeout(200);
  }
  return false;
}

// Check if servers already running
const backendRunning = await waitForPort(BACKEND_PORT).catch(() => false);
const frontendRunning = await waitForFrontend(FRONTEND_PORT).catch(() => false);

if (backendRunning && frontendRunning) {
  console.log("[Koryphaios] Servers already running, launching app...");
} else {
  console.log("[Koryphaios] Starting background servers...");
  
// Start backend in background
    console.log("[1/2] Starting backend server on port 3002...");
    const backend = spawn("bun", ["run", "src/server.ts"], {
      cwd: resolve(PROJECT_ROOT, "backend"),
      stdio: "inherit",
    });
    
    // Write logs to file
    const backendOut = Bun.file(backendLog).writer();
    backend.stdout?.pipeTo(new WritableStream({
      write(chunk) { backendOut.write(chunk); }
    }));
    backend.stderr?.pipeTo(new WritableStream({
      write(chunk) { backendOut.write(chunk); }
    }));
    
    backend.unref();
    
    // Wait for backend
    const ready = await waitForPort(BACKEND_PORT);
    if (!ready) {
      console.error("[Koryphaios] Backend failed to start");
      process.exit(1);
    }
  }
  
  // Start frontend in background
  if (!frontendRunning) {
    const frontend = spawn("bun", ["run", "vite", "dev", "--host"], {
      cwd: resolve(PROJECT_ROOT, "frontend"),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    
    // Write logs to file
    const frontendOut = Bun.file(frontendLog).writer();
    frontend.stdout?.pipeTo(new WritableStream({
      write(chunk) { frontendOut.write(chunk); }
    }));
    frontend.stderr?.pipeTo(new WritableStream({
      write(chunk) { frontendOut.write(chunk); }
    }));
    
    frontend.unref();
    
    // Wait for frontend
    const ready = await waitForFrontend(FRONTEND_PORT);
    if (!ready) {
      console.error("[Koryphaios] Frontend failed to start");
      process.exit(1);
    }
  }
  
  console.log("[Koryphaios] Servers ready!");
}

// Launch Tauri app
console.log("[Koryphaios] Launching app...");

const tauri = spawn("bash", ["-c", "source ~/.cargo/env && cargo run"], {
  cwd: resolve(PROJECT_ROOT, "desktop/src-tauri"),
  stdio: "inherit",
});

// Save PID for cleanup
await Bun.write(resolve(LOG_DIR, "tauri.pid"), tauri.pid?.toString() || "");

// Handle cleanup
tauri.on("exit", (code) => {
  process.exit(code || 0);
});
