// Security module — bash sandboxing, input validation, key encryption.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";
import { toolLog } from "./logger";
import { SECURITY } from "./constants";

// ─── Bash Command Sandboxing ────────────────────────────────────────────────

const BLOCKED_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/\s*$/,   // rm -rf /
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/\w/,       // rm -rf /anything at root
  /\bmkfs\b/,
  /\bdd\b.*\bof=\/dev\//,
  /\b:(){ :|:& };:/,                               // fork bomb
  /\bchmod\s+(-R\s+)?777\s+\//,                    // chmod 777 /
  /\bchown\s+(-R\s+)?.*\s+\//,                     // chown at root
  />\s*\/dev\/sd[a-z]/,                             // write to raw disk
  /\bcurl\b.*\|\s*\bbash\b/,                        // curl | bash (pipe to shell)
  /\bwget\b.*\|\s*\bbash\b/,
  /\beval\b.*\$\(/,                                  // eval with command sub
  /\/etc\/passwd/,
  /\/etc\/shadow/,
  /\bsudo\b/,
  /\bsu\s+-?\s*$/,                                   // bare su
  /\bshutdown\b/,
  /\breboot\b/,
  /\binit\s+[0-6]\b/,
  /\bsystemctl\s+(stop|disable|mask)\b/,
  /\bgcloud\s+auth\b/,                             // Block gcloud auth (spawns browser)
  /\bclaude\s+login\b/,                            // Block claude login (spawns browser)
  /\bclaude\s+auth\b/,                             // Block claude auth
  /\bcodex\s+auth\b/,                              // Block codex auth
  /\bcodex\s+login\b/,                             // Block codex login
  /\bopenai\s+login\b/,                            // Block openai login
  /\bxdg-open\b/,                                  // Block xdg-open (opens browser/apps)
  /\bopen\b\s+https?:\/\//,                        // Block 'open http...'
];

const BLOCKED_EXACT = new Set([
  "rm -rf /",
  "rm -rf /*",
  "rm -rf ~",
  "rm -rf ~/",
  ":(){ :|:& };:",
  "yes | rm -r /",
]);

export function validateBashCommand(command: string): { safe: boolean; reason?: string } {
  const trimmed = command.trim();

  if (BLOCKED_EXACT.has(trimmed)) {
    return { safe: false, reason: `Blocked: destructive command "${trimmed}"` };
  }

  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { safe: false, reason: `Blocked: command matches dangerous pattern ${pattern.source}` };
    }
  }

  // Block commands that try to escape working directory via absolute paths to system dirs
  const systemDirs = ["/boot", "/sys", "/proc/sys", "/usr/sbin", "/sbin"];
  for (const dir of systemDirs) {
    if (trimmed.includes(`> ${dir}`) || trimmed.includes(`>> ${dir}`)) {
      return { safe: false, reason: `Blocked: writing to system directory ${dir}` };
    }
  }

  return { safe: true };
}

// ─── Input Validation ───────────────────────────────────────────────────────

export function sanitizeString(input: unknown, maxLength = 10_000): string {
  if (typeof input !== "string") return "";
  return input.slice(0, maxLength).trim();
}

export function validateSessionId(id: unknown): string | null {
  if (typeof id !== "string") return null;
  // Session IDs: alphanumeric + hyphens, 1-64 chars
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) return null;
  return id;
}

import type { ProviderName } from "@koryphaios/shared";

export function validateProviderName(name: unknown): ProviderName | null {
  const VALID_PROVIDERS = new Set([
    "anthropic", "openai", "google", "gemini", "copilot", "codex", "openrouter",
    "groq", "xai", "azure", "bedrock", "vertexai", "local", "cline",
  ]);
  if (typeof name !== "string") return null;
  if (!VALID_PROVIDERS.has(name)) return null;
  if (name === "gemini") return "google" as ProviderName;
  return name as ProviderName;
}

// ─── API Key Encryption at Rest ─────────────────────────────────────────────

const ALGORITHM = "aes-256-gcm";
const SALT = "koryphaios-key-salt-v1"; // App-level salt (not a secret)

function deriveEncryptionKey(): Buffer {
  // Derive from machine-specific data to avoid plaintext keys
  const hostname = require("os").hostname();
  const uid = process.getuid?.() ?? 1000;
  const seed = `${hostname}:${uid}:${SALT}`;
  return scryptSync(seed, SALT, 32);
}

export function encryptApiKey(plaintext: string): string {
  const key = deriveEncryptionKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  return `enc:${iv.toString("hex")}:${authTag}:${encrypted}`;
}

export function decryptApiKey(ciphertext: string): string {
  if (!ciphertext.startsWith("enc:")) return ciphertext; // Not encrypted, return as-is
  const [, ivHex, authTagHex, encrypted] = ciphertext.split(":");
  const key = deriveEncryptionKey();
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

// ─── CORS Origin Allowlist ──────────────────────────────────────────────────

const ALLOWED_ORIGINS = new Set<string>(SECURITY.ALLOWED_ORIGINS);

export function getCorsHeaders(origin?: string | null): Record<string, string> {
  const allowedOrigin = origin && ALLOWED_ORIGINS.has(origin) ? origin : SECURITY.ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Credentials": "true",
    "Vary": "Origin",
  };
}

// ─── Rate Limiting (simple in-memory) ───────────────────────────────────────

export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  private pruneTimer: ReturnType<typeof setInterval>;

  constructor(
    private maxRequests: number = 60,
    private windowMs: number = 60_000,
  ) {
    // Auto-prune stale entries every 5 minutes
    this.pruneTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.hits) {
        if (now >= entry.resetAt) this.hits.delete(key);
      }
    }, 5 * 60_000);
  }

  check(key: string): { allowed: boolean; remaining: number; resetIn: number } {
    const now = Date.now();
    let entry = this.hits.get(key);

    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, entry);
    }

    entry.count++;
    const allowed = entry.count <= this.maxRequests;
    return {
      allowed,
      remaining: Math.max(0, this.maxRequests - entry.count),
      resetIn: entry.resetAt - now,
    };
  }

  destroy() {
    clearInterval(this.pruneTimer);
    this.hits.clear();
  }
}

// ─── Token Generation (Secure) ───────────────────────────────────────────────

/**
 * Generate a secure random token
 */
export function generateSecureToken(bytes: number = 32): string {
  return randomBytes(bytes).toString("hex");
}

/**
 * Write token to a secure file instead of console
 */
export function writeTokenToFile(token: string, sessionId: string): string {
  const { join } = require("path");
  const { mkdirSync, writeFileSync, existsSync } = require("fs");

  const tokenDir = join(process.cwd(), ".koryphaios");
  mkdirSync(tokenDir, { recursive: true });

  const tokenFile = join(tokenDir, ".root-token");

  writeFileSync(tokenFile, JSON.stringify({
    token,
    sessionId,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24h
  }, null, 2), { mode: 0o600 });

  return tokenFile;
}
