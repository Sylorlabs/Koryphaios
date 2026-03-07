#!/usr/bin/env bun
/**
 * Desktop build script - builds frontend and Tauri app for production
 * Usage: bun run build:desktop
 * 
 * Cross-platform: Works on Windows, macOS, and Linux
 */

import { spawn } from "child_process";
import { resolve } from "path";
import { platform } from "os";
import { existsSync, copyFileSync, mkdirSync } from "fs";

const PROJECT_ROOT = resolve(import.meta.dir, "..");
const IS_WINDOWS = platform() === "win32";

// Colors for terminal output
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

function log(message: string, color: keyof typeof colors = "reset") {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

// Cross-platform spawn helper that returns a promise
function runCommand(
  name: string,
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<number> {
  return new Promise((resolve, reject) => {
    log(`[${name}] Running: ${command} ${args.join(" ")}`, "cyan");
    
    let child;
    if (IS_WINDOWS) {
      child = spawn("cmd", ["/c", command, ...args], {
        cwd: options.cwd,
        stdio: "inherit",
        env: options.env || process.env,
        windowsHide: false,
      });
    } else {
      child = spawn(command, args, {
        cwd: options.cwd,
        stdio: "inherit",
        env: options.env || process.env,
      });
    }

    child.on("close", (code) => {
      if (code === 0) {
        resolve(code);
      } else {
        reject(new Error(`${name} exited with code ${code}`));
      }
    });

    child.on("error", (err) => {
      reject(err);
    });
  });
}

async function main() {
  log("═══════════════════════════════════════════════", "bright");
  log("  KORYPHAIOS DESKTOP BUILD", "bright");
  log("  Platform: " + platform(), "bright");
  log("═══════════════════════════════════════════════\n", "bright");

  // Step 0: Copy config to frontend build directory
  log("[0/3] Copying configuration...", "yellow");
  const configSource = resolve(PROJECT_ROOT, "config", "app.config.json");
  const configDestDir = resolve(PROJECT_ROOT, "frontend", "static");
  const configDest = resolve(configDestDir, "app.config.json");
  
  if (existsSync(configSource)) {
    try {
      mkdirSync(configDestDir, { recursive: true });
      copyFileSync(configSource, configDest);
      log("[0/3] Configuration copied to frontend/static\n", "green");
    } catch (err) {
      log(`[0/3] Warning: Failed to copy config: ${err}`, "yellow");
    }
  } else {
    log("[0/3] Warning: Config file not found at " + configSource, "yellow");
  }

  // Step 1: Build frontend
  log("[1/3] Building frontend (static)...", "yellow");
  
  const frontendEnv = {
    ...process.env,
    BUILD_MODE: "static",
    NODE_ENV: "production",
  };

  try {
    await runCommand(
      "frontend",
      "bun",
      ["run", "build"],
      { cwd: resolve(PROJECT_ROOT, "frontend"), env: frontendEnv }
    );
    log("[1/3] Frontend build complete!\n", "green");
  } catch (err) {
    log(`[1/3] Frontend build failed: ${err}`, "red");
    process.exit(1);
  }

  // Verify frontend build output exists
  const buildOutput = resolve(PROJECT_ROOT, "frontend", "build");
  if (!existsSync(buildOutput)) {
    log(`[1/3] Error: Build output not found at ${buildOutput}`, "red");
    process.exit(1);
  }

  // Step 2: Copy config to build output
  log("[2/3] Copying configuration to build output...", "yellow");
  const buildConfigDest = resolve(buildOutput, "app.config.json");
  if (existsSync(configSource)) {
    try {
      copyFileSync(configSource, buildConfigDest);
      log("[2/3] Configuration copied to build output\n", "green");
    } catch (err) {
      log(`[2/3] Warning: Failed to copy config to build: ${err}`, "yellow");
    }
  }

  // Step 3: Build Tauri
  log("[3/3] Building Tauri app...", "yellow");
  
  try {
    await runCommand(
      "tauri",
      "bun",
      ["run", "tauri", "build"],
      { cwd: resolve(PROJECT_ROOT, "desktop") }
    );
    log("[3/3] Tauri build complete!\n", "green");
  } catch (err) {
    log(`[3/3] Tauri build failed: ${err}`, "red");
    process.exit(1);
  }

  // Success
  log("═══════════════════════════════════════════════", "green");
  log("  BUILD SUCCESSFUL!", "green");
  log("═══════════════════════════════════════════════", "green");
  
  const platformExt = IS_WINDOWS ? "exe" : platform() === "darwin" ? "app" : "AppImage";
  log(`\nOutput location: desktop/src-tauri/target/release/`, "cyan");
  log(`Look for: *.${platformExt} or bundle/ directory`, "cyan");
}

main().catch((err) => {
  log(`\nBuild failed: ${err}`, "red");
  process.exit(1);
});
