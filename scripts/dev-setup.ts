#!/usr/bin/env bun
/**
 * Koryphaios Dev Setup Script
 * 
 * One-command setup for new developers. This script:
 * 1. Checks for required dependencies (bun)
 * 2. Generates secure secrets for .env
 * 3. Installs dependencies
 * 4. Validates the setup
 * 
 * Usage: bun run scripts/dev-setup.ts
 */

import { existsSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import { join } from "node:fs";
import { spawn, execSync } from "node:child_process";

const PROJECT_ROOT = process.cwd();
const ENV_FILE = join(PROJECT_ROOT, ".env");
const ENV_EXAMPLE = join(PROJECT_ROOT, ".env.example");

// Colors for output
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

function log(message: string, level: "info" | "warn" | "error" | "success" = "info") {
  const prefix = {
    info: `${colors.cyan}ℹ${colors.reset}`,
    warn: `${colors.yellow}⚠${colors.reset}`,
    error: `${colors.red}✖${colors.reset}`,
    success: `${colors.green}✔${colors.reset}`,
  }[level];
  console.log(`${prefix} ${message}`);
}

function header(title: string) {
  console.log(`\n${colors.bright}${colors.cyan}${title}${colors.reset}`);
  console.log("=".repeat(title.length));
}

async function checkBun(): Promise<boolean> {
  try {
    execSync("bun --version", { stdio: "pipe" });
    const version = execSync("bun --version", { encoding: "utf-8" }).trim();
    log(`Bun ${version} found`, "success");
    return true;
  } catch {
    log("Bun is not installed", "error");
    console.log(`\n  Install Bun: https://bun.sh/docs/installation`);
    console.log(`  curl -fsSL https://bun.sh/install | bash\n`);
    return false;
  }
}

function generateSecret(): string {
  // Generate a 64-character hex string (32 bytes)
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function setupEnv(): Promise<void> {
  header("Setting up environment");

  if (existsSync(ENV_FILE)) {
    log(".env file already exists", "warn");
    const secretsExist = readFileSync(ENV_FILE, "utf-8")
      .split("\n")
      .some((line) => line.includes("JWT_SECRET=") && line.length > "JWT_SECRET=".length + 10);
    
    if (secretsExist) {
      log("Secrets already configured, skipping", "success");
      return;
    }
    log("Generating missing secrets...", "info");
  }

  // Read template
  let envContent = existsSync(ENV_EXAMPLE)
    ? readFileSync(ENV_EXAMPLE, "utf-8")
    : "# Environment Variables for Koryphaios\n\n";

  // Generate secrets
  const secrets = {
    JWT_SECRET: generateSecret(),
    KORYPHAIOS_MASTER_KEY: generateSecret(),
    SESSION_TOKEN_SECRET: generateSecret(),
    KORY_APP_SECRET: generateSecret(),
  };

  // Replace or add secrets
  for (const [key, value] of Object.entries(secrets)) {
    const regex = new RegExp(`^${key}=.*$`, "m");
    if (regex.test(envContent)) {
      envContent = envContent.replace(regex, `${key}=${value}`);
    } else {
      envContent += `\n${key}=${value}`;
    }
  }

  // Ensure KORYPHAIOS_HOST is set to 127.0.0.1
  if (!envContent.includes("KORYPHAIOS_HOST=")) {
    envContent += "\nKORYPHAIOS_HOST=127.0.0.1";
  }

  writeFileSync(ENV_FILE, envContent);
  log("Generated .env with secure secrets", "success");
  
  console.log("\n  Generated secrets:");
  for (const key of Object.keys(secrets)) {
    console.log(`    ${key}: ****${secrets[key].slice(-8)}`);
  }
}

async function installDependencies(): Promise<boolean> {
  header("Installing dependencies");

  return new Promise((resolve) => {
    log("Running 'bun install'...", "info");
    
    const child = spawn("bun", ["install"], {
      cwd: PROJECT_ROOT,
      stdio: "inherit",
    });

    child.on("close", (code) => {
      if (code === 0) {
        log("Dependencies installed", "success");
        resolve(true);
      } else {
        log(`Installation failed with code ${code}`, "error");
        resolve(false);
      }
    });
  });
}

async function checkPortAvailability(): Promise<void> {
  header("Checking port availability");
  
  const net = await import("node:net");
  
  function checkPort(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.once("listening", () => {
        server.close();
        resolve(true);
      });
      server.listen(port, "127.0.0.1");
    });
  }

  const preferredPort = 29473;
  const isAvailable = await checkPort(preferredPort);
  
  if (isAvailable) {
    log(`Port ${preferredPort} is available ✓`, "success");
  } else {
    log(`Port ${preferredPort} is in use`, "warn");
    log("The backend will auto-find an available port in range 29450-29500", "info");
  }
}

async function printNextSteps(): Promise<void> {
  header("Setup complete!");
  
  console.log(`
${colors.bright}Quick Start:${colors.reset}

  ${colors.cyan}1. Start the desktop app:${colors.reset}
     bun run dev

  ${colors.cyan}2. Or start backend only:${colors.reset}
     bun run dev:backend

  ${colors.cyan}3. Add your API keys to .env:${colors.reset}
     - ANTHROPIC_API_KEY
     - OPENAI_API_KEY
     - etc.

${colors.bright}Zero-Config Features:${colors.reset}
  • Backend auto-finds available port if 29473 is taken
  • Frontend auto-discovers backend port
  • No manual port configuration needed

${colors.bright}Need help?${colors.reset}
  • See AGENTS.md for development guidelines
  • See README.md for full documentation
`);
}

async function main(): Promise<void> {
  console.log(`
${colors.bright}${colors.cyan}
╔══════════════════════════════════════════════════════════╗
║           Koryphaios Dev Setup                           ║
║     Zero-config development environment setup            ║
╚══════════════════════════════════════════════════════════╝
${colors.reset}`);

  // Check bun
  if (!(await checkBun())) {
    process.exit(1);
  }

  // Setup environment
  await setupEnv();

  // Check port
  await checkPortAvailability();

  // Install dependencies if node_modules doesn't exist
  if (!existsSync(join(PROJECT_ROOT, "node_modules"))) {
    const installed = await installDependencies();
    if (!installed) {
      process.exit(1);
    }
  } else {
    log("node_modules exists, skipping install", "info");
  }

  // Print next steps
  await printNextSteps();
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
