
import { spawnSync } from "bun";

console.log("🔍 Koryphaios CLI Tool Diagnostic");
console.log("=================================");

function checkTool(name: string, command: string[]) {
  process.stdout.write(`Checking ${name}... `);
  const proc = spawnSync(command);
  if (proc.exitCode === 0) {
    console.log("✅ Installed");
    const output = new TextDecoder().decode(proc.stdout).trim().split('
')[0];
    console.log(`   Version: ${output}`);
  } else {
    console.log("❌ Not Found / Error");
    if (proc.stderr.length > 0) {
      console.log(`   Error: ${new TextDecoder().decode(proc.stderr).trim()}`);
    }
  }
}

checkTool("Gemini CLI (via gcloud)", ["gcloud", "--version"]);
checkTool("Claude Code", ["claude", "--version"]);
checkTool("OpenAI CLI", ["openai", "--version"]); // Assuming openai package
checkTool("Codex CLI", ["codex", "--version"]);   // As requested

console.log("
Diagnostic Complete.");
