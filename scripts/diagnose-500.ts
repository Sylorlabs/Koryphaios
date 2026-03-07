#!/usr/bin/env bun
/**
 * Diagnostic script to help identify the source of 500 errors
 * Usage: bun run scripts/diagnose-500.ts
 */

import { resolve } from "path";
import { existsSync, readFileSync } from "fs";

const PROJECT_ROOT = resolve(import.meta.dir, "..");

console.log("═══════════════════════════════════════════════════════════");
console.log("  KORYPHAIOS 500 ERROR DIAGNOSTIC");
console.log("═══════════════════════════════════════════════════════════\n");

// Check port configuration consistency
console.log("1. PORT CONFIGURATION CHECK");
console.log("───────────────────────────────────────────────────────────");

const sources: { name: string; path: string; port?: number }[] = [
  { name: ".env", path: resolve(PROJECT_ROOT, ".env") },
  { name: "koryphaios.json", path: resolve(PROJECT_ROOT, "koryphaios.json") },
  { name: "config/app.config.json", path: resolve(PROJECT_ROOT, "config", "app.config.json") },
];

let defaultPort = 3000;

for (const source of sources) {
  if (existsSync(source.path)) {
    try {
      const content = readFileSync(source.path, "utf-8");
      
      if (source.name === ".env") {
        const match = content.match(/KORYPHAIOS_PORT=(\d+)/);
        if (match) {
          source.port = parseInt(match[1], 10);
        }
      } else {
        const json = JSON.parse(content);
        source.port = json.server?.port;
      }
      
      if (source.port) {
        console.log(`  ✓ ${source.name}: port ${source.port}`);
      } else {
        console.log(`  ⚠ ${source.name}: no port configured (will use default: ${defaultPort})`);
      }
    } catch (e) {
      console.log(`  ✗ ${source.name}: ERROR reading file - ${e}`);
    }
  } else {
    console.log(`  ✗ ${source.name}: FILE NOT FOUND`);
  }
}

// Check for port conflicts
const ports = sources.map(s => s.port).filter((p): p is number => p !== undefined);
const uniquePorts = [...new Set(ports)];

console.log("\n2. PORT CONSISTENCY CHECK");
console.log("───────────────────────────────────────────────────────────");

if (uniquePorts.length === 0) {
  console.log("  ⚠ No ports configured in any file. Will use default: 3000");
} else if (uniquePorts.length === 1) {
  console.log(`  ✓ All configurations use port ${uniquePorts[0]} (consistent)`);
} else {
  console.log("  ✗ PORT MISMATCH DETECTED!");
  console.log(`    Configured ports: ${uniquePorts.join(", ")}`);
  console.log("    This can cause 500 errors when the backend and frontend");
  console.log("    try to communicate on different ports.");
  console.log("\n    RECOMMENDATION: Set all configs to use the same port.");
}

// Check for common issues
console.log("\n3. COMMON ISSUES CHECK");
console.log("───────────────────────────────────────────────────────────");

// Check if port is in use (simple check)
console.log("  Checking if default port (3000) might be in use...");
console.log("  (Run 'lsof -i :3000' or 'netstat -tlnp | grep 3000' to verify)");

// Check environment
console.log("\n4. ENVIRONMENT CHECK");
console.log("───────────────────────────────────────────────────────────");
console.log(`  NODE_ENV: ${process.env.NODE_ENV || "not set"}`);
console.log(`  KORYPHAIOS_PORT: ${process.env.KORYPHAIOS_PORT || "not set"}`);
console.log(`  KORYPHAIOS_HOST: ${process.env.KORYPHAIOS_HOST || "not set"}`);

console.log("\n5. RECOMMENDATIONS");
console.log("───────────────────────────────────────────────────────────");

if (uniquePorts.length > 1) {
  console.log("  1. Fix port mismatch:");
  console.log("     - Edit .env: KORYPHAIOS_PORT=3000");
  console.log("     - Edit koryphaios.json: set server.port to 3000");
  console.log("     - Edit config/app.config.json: set server.port to 3000");
}

console.log("  2. Check for port conflicts:");
console.log("     - Run: lsof -i :3000");
console.log("     - Kill any process using the port, or");
console.log("     - Change to a different port in all config files");

console.log("  3. Clear any cached state:");
console.log("     - rm -rf .koryphaios/");
console.log("     - Restart the backend and frontend");

console.log("\n═══════════════════════════════════════════════════════════");
console.log("  END OF DIAGNOSTIC");
console.log("═══════════════════════════════════════════════════════════");
