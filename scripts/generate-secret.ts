#!/usr/bin/env bun
import { randomBytes } from "crypto";
import { appendFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";

const ENV_PATH = join(process.cwd(), ".env");

console.log("🔐 Koryphaios Secret Generator");
console.log("──────────────────────────────");

const secrets = [
  { key: "KORY_APP_SECRET", desc: "Encryption Key (API Keys)" },
  { key: "SESSION_TOKEN_SECRET", desc: "Signing Key (Auth Tokens)" }
];

try {
  let envContent = "";
  if (existsSync(ENV_PATH)) {
    envContent = readFileSync(ENV_PATH, "utf-8");
  }

  let added = 0;

  for (const { key, desc } of secrets) {
    if (envContent.includes(`${key}=`)) {
      console.log(`⚠️  ${key} already exists in .env (Skipping)`);
      continue;
    }

    const secret = randomBytes(64).toString("hex");
    const newEntry = `\n# ${desc}\n${key}=${secret}\n`;
    appendFileSync(ENV_PATH, newEntry);
    console.log(`✅ Generated ${key}`);
    added++;
  }

  if (added > 0) {
    console.log(`\n📂 Updated ${ENV_PATH}`);
    console.log("Restart the server for changes to take effect.");
  } else {
    console.log("\nNo changes needed. Your secrets are already set.");
  }

} catch (err) {
  console.error("❌ Failed to update .env:", err);
  process.exit(1);
}
