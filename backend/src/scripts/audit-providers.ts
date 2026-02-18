
import { ProviderRegistry } from "../providers/registry";
import { detectClaudeCodeToken, detectCopilotToken, detectGeminiCLIToken, detectCodexToken } from "../providers/auth-utils";
import { spawnSync } from "bun";
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

console.log("Starting Provider Audit...");

const registry = new ProviderRegistry();
const statusList = await registry.getStatus();

console.log("\n--- CLI Tool Availability ---");
const tools = ["gemini", "codex", "claude", "gh", "gcloud", "curl"];
for (const tool of tools) {
  const proc = spawnSync(["which", tool], { stdout: "pipe", stderr: "pipe" });
  const path = proc.stdout.toString().trim();
  console.log(`${tool}: ${proc.exitCode === 0 ? `INSTALLED at ${path}` : "MISSING"}`);
}

console.log("\n--- Token Detection ---");
console.log(`Claude Code Token: ${detectClaudeCodeToken() ? "DETECTED" : "MISSING"}`);
console.log(`GitHub Copilot Token: ${detectCopilotToken() ? "DETECTED" : "MISSING"}`);
console.log(`Gemini CLI Token: ${detectGeminiCLIToken() ? "DETECTED" : "MISSING"}`);
console.log(`Codex Token: ${detectCodexToken() ? "DETECTED" : "MISSING"}`);

console.log("\n--- Provider Status & Verification ---");

for (const status of statusList) {
  console.log(`\nProvider: ${status.name}`);
  console.log(`  Enabled: ${status.enabled}`);
  console.log(`  Authenticated: ${status.authenticated}`);
  console.log(`  Auth Mode: ${status.authMode}`);
  console.log(`  Models: ${status.models.length} available`);

  // Force verification attempt
  console.log("  Verifying connection...");
  try {
    // We try to verify even if not "authenticated" to test error handling
    const result = await registry.verifyConnection(status.name);
    if (result.success) {
      console.log("  Result: SUCCESS");
    } else {
      console.log(`  Result: FAILED - ${result.error}`);
    }
  } catch (err: any) {
    console.log(`  Result: CRASHED - ${err.message}`);
  }
}

console.log("\n--- End of Audit ---");
