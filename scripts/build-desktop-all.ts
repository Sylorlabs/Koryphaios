#!/usr/bin/env bun
/**
 * Cross-platform desktop build orchestrator
 * Usage: bun run build:desktop:all
 * 
 * This script detects the current platform and runs the appropriate build script.
 * For CI/CD environments, use the GitHub Actions workflow instead.
 */

import { spawn } from "child_process";
import { resolve } from "path";
import { platform } from "os";

const PROJECT_ROOT = resolve(import.meta.dir, "..");
const CURRENT_PLATFORM = platform();

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

function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; shell?: boolean } = {}
): Promise<number> {
  return new Promise((resolve, reject) => {
    const isWindows = CURRENT_PLATFORM === "win32";
    const shell = options.shell ?? isWindows;
    
    const child = spawn(command, args, {
      cwd: options.cwd || PROJECT_ROOT,
      stdio: "inherit",
      shell,
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve(code);
      } else {
        reject(new Error(`Command exited with code ${code}`));
      }
    });

    child.on("error", (err) => {
      reject(err);
    });
  });
}

async function main() {
  log("═══════════════════════════════════════════════", "bright");
  log("  KORYPHAIOS CROSS-PLATFORM DESKTOP BUILD", "bright");
  log(`  Platform: ${CURRENT_PLATFORM}`, "bright");
  log("═══════════════════════════════════════════════\n", "bright");

  let buildScript: string;
  let args: string[] = [];

  switch (CURRENT_PLATFORM) {
    case "win32":
      buildScript = "scripts/build-desktop-windows.bat";
      args = ["release"];
      break;
    case "darwin":
      buildScript = "scripts/build-desktop-macos.sh";
      args = ["release", "universal"];
      break;
    case "linux":
      buildScript = "scripts/build-desktop-linux.sh";
      args = ["release", "x86_64"];
      break;
    default:
      log(`Unsupported platform: ${CURRENT_PLATFORM}`, "red");
      process.exit(1);
  }

  log(`Running platform-specific build script: ${buildScript}`, "cyan");
  
  try {
    // On Windows, use cmd /c for batch files
    if (CURRENT_PLATFORM === "win32") {
      await runCommand("cmd", ["/c", buildScript, ...args]);
    } else {
      // On Unix, make sure the script is executable and run with bash
      await runCommand("bash", [buildScript, ...args]);
    }
    
    log("\n═══════════════════════════════════════════════", "green");
    log("  BUILD SUCCESSFUL!", "green");
    log("═══════════════════════════════════════════════", "green");
  } catch (err) {
    log(`\nBuild failed: ${err}`, "red");
    process.exit(1);
  }
}

main().catch((err) => {
  log(`\nUnexpected error: ${err}`, "red");
  process.exit(1);
});
