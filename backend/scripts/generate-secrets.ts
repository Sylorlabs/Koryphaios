#!/usr/bin/env bun
/**
 * Generate secure secrets for Koryphaios authentication
 *
 * Usage:
 *   bun run scripts/generate-secrets.ts
 *
 * Output:
 *   Secure random secrets ready for .env or environment variables
 */

import { randomBytes } from "node:crypto";

function generateSecret(bytes: number, name: string): string {
  const secret = randomBytes(bytes).toString("hex");
  const comment = `# ${bytes} bytes = ${bytes * 8} bits`;

  console.log(`\n# ${name}`);
  console.log(`# ${comment}`);
  console.log(`${name}=${secret}`);
  console.log(`# Length: ${secret.length} characters`);

  return secret;
}

console.log("=".repeat(60));
console.log("Koryphaios: Authentication Secrets Generator");
console.log("=".repeat(60));
console.log("\nGenerating secure random secrets for your environment...\n");

console.log("─".repeat(60));
console.log("Copy these to your .env file or set as environment variables:");
console.log("─".repeat(60));

// JWT_SECRET (64 characters minimum)
generateSecret(32, "JWT_SECRET");

console.log("");

// SESSION_TOKEN_SECRET (32 characters minimum)
generateSecret(16, "SESSION_TOKEN_SECRET");

console.log("");

// Optional: Additional secrets for future use
console.log("\n" + "─".repeat(60));
console.log("Optional: For future features");
console.log("─".repeat(60));

// API key signing secret (future)
generateSecret(32, "API_SIGNING_SECRET");

console.log("");

// Encryption key for sensitive data (future)
generateSecret(32, "ENCRYPTION_KEY");

console.log("\n" + "=".repeat(60));
console.log("✓ Secrets generated successfully!");
console.log("=".repeat(60));
console.log("\n📝 Next steps:");
console.log("   1. Copy the above to your .env file");
console.log("   2. Store your .env file securely (git ignored)");
console.log("   3. Back up these secrets in a secure location");
console.log("   4. Restart your application");
console.log("\n⚠️  IMPORTANT: Never commit secrets to git!");
console.log("=" .repeat(60));

console.log("\n💡 Tip: To generate these again in the future, run:");
console.log("   bun run scripts/generate-secrets.ts\n");
