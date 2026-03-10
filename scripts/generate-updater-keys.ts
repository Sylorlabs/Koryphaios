#!/usr/bin/env bun
/**
 * Generate Tauri updater signing keys
 * Uses minisign-compatible format
 */

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

// Generate Ed25519 key pair using Node's crypto
const { privateKey, publicKey } = await crypto.subtle.generateKey(
  { name: "Ed25519" },
  true,
  ["sign", "verify"]
);

// Export keys
const privateKeyRaw = await crypto.subtle.exportKey("pkcs8", privateKey);
const publicKeyRaw = await crypto.subtle.exportKey("raw", publicKey);

// Convert to base64
const privateKeyB64 = Buffer.from(privateKeyRaw).toString("base64");
const publicKeyB64 = Buffer.from(publicKeyRaw).toString("base64");

// Create minisign-compatible format
// Tauri expects base64-encoded raw public key for the pubkey field
const keysDir = join(process.cwd(), ".keys");
mkdirSync(keysDir, { recursive: true });

// Save private key (keep this secret!)
writeFileSync(
  join(keysDir, "private.key"),
  `-----BEGIN PRIVATE KEY-----\n${privateKeyB64}\n-----END PRIVATE KEY-----`,
  { mode: 0o600 }
);

// Save public key
writeFileSync(
  join(keysDir, "public.key"),
  `-----BEGIN PUBLIC KEY-----\n${publicKeyB64}\n-----END PUBLIC KEY-----`
);

// Also save the raw base64 for tauri.conf.json
writeFileSync(join(keysDir, "tauri-pubkey.txt"), publicKeyB64);

console.log("✅ Tauri updater keys generated!");
console.log("");
console.log("📁 Key files created in .keys/ directory:");
console.log("   - private.key (KEEP SECRET - used for signing releases)");
console.log("   - public.key (can be shared)");
console.log("   - tauri-pubkey.txt (copy this to tauri.conf.json)");
console.log("");
console.log("🔑 Public Key (for tauri.conf.json):");
console.log(publicKeyB64);
console.log("");
console.log("⚠️  IMPORTANT:");
console.log("   - Store private.key securely (GitHub Secret, password manager)");
console.log("   - Never commit private.key to git");
console.log("   - Add .keys/ to .gitignore");
