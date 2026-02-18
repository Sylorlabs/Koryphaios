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

export function sanitizeForPrompt(input: string, maxLength: number = 100_000): string {
  let sanitized = sanitizeString(input, maxLength);

  // Strip common jailbreak patterns (simple heuristic)
  const blocklist = [
    /Ignore all previous instructions/gi,
    /You are now/gi,
    /From now on/gi,
    /Forget all prior rules/gi,
    /<system>/gi,
    /<\/system>/gi,
    /\[system\]/gi,
    /system prompt:/gi,
  ];

  for (const pattern of blocklist) {
    sanitized = sanitized.replace(pattern, "");
  }

  // Escape template literal markers
  sanitized = sanitized.replace(/\${/g, "\\${");

  return sanitized;
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

let warnedAboutInsecureKey = false;

function deriveEncryptionKey(): Buffer {
  if (process.env.KORYPHAIOS_MASTER_KEY) {
    return scryptSync(process.env.KORYPHAIOS_MASTER_KEY, "koryphaios-master-salt", 32);
  }

  if (!warnedAboutInsecureKey) {
    console.warn("SECURITY WARNING: Using insecure fallback encryption key. Set KORYPHAIOS_MASTER_KEY env var to secure your API keys.");
    warnedAboutInsecureKey = true;
  }

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

// ─── URL Validation (SSRF Prevention) ───────────────────────────────────────

import { resolve4, resolve6 } from "dns/promises";
import { isIP } from "net";

/**
 * Validates a URL to prevent SSRF and arbitrary file read.
 *
 * Checks:
 * 1. Protocol must be http or https.
 * 2. Hostname must not be a private/loopback IP.
 * 3. Hostname must resolve to a public IP (DNS check).
 *
 * Fails closed: if DNS resolution fails, the URL is blocked.
 *
 * Note: Vulnerable to DNS rebinding attacks (TOCTOU) because we cannot
 * pin the resolved IP in Bun's fetch implementation easily.
 */
export async function validateUrl(urlStr: string): Promise<{ safe: boolean; reason?: string }> {
  try {
    const url = new URL(urlStr);

    if (!["http:", "https:"].includes(url.protocol)) {
      return { safe: false, reason: "Only HTTP and HTTPS protocols are allowed" };
    }

    let hostname = url.hostname;

    // Handle IPv6 literals in brackets (e.g., [::1])
    if (hostname.startsWith("[") && hostname.endsWith("]")) {
      hostname = hostname.slice(1, -1);
    }

    // Check if hostname is an IP address
    if (isIP(hostname)) {
      if (isPrivateIP(hostname)) {
        return { safe: false, reason: "Access to private IP addresses is restricted" };
      }
    } else {
      // Resolve hostname — fail closed if DNS fails. Check ALL resolved IPs (IPv4 and IPv6).
      try {
        const [ipv4, ipv6] = await Promise.all([
          resolve4(hostname).catch(() => [] as string[]),
          resolve6(hostname).catch(() => [] as string[]),
        ]);
        const addresses = [...ipv4, ...ipv6];

        if (addresses.length === 0) {
           return { safe: false, reason: "DNS resolution failed — no records found" };
        }

        for (const address of addresses) {
          if (isPrivateIP(address)) {
            return { safe: false, reason: "Host resolves to a restricted IP address: " + address };
          }
        }
      } catch {
        return { safe: false, reason: "DNS resolution failed — cannot verify host safety" };
      }
    }

    return { safe: true };
  } catch {
    return { safe: false, reason: "Invalid URL format" };
  }
}

function isPrivateIP(ip: string): boolean {
  if (ip === "localhost") return true;

  // IPv4
  const parts = ip.split(".");
  if (parts.length === 4) {
    const first = parseInt(parts[0], 10);
    const second = parseInt(parts[1], 10);

    if (first === 127) return true;           // 127.0.0.0/8 loopback
    if (first === 10) return true;            // 10.0.0.0/8 private
    if (first === 192 && second === 168) return true; // 192.168.0.0/16 private
    if (first === 172 && second >= 16 && second <= 31) return true; // 172.16.0.0/12 private
    if (first === 169 && second === 254) return true; // 169.254.0.0/16 link-local
    if (first === 0) return true;             // 0.0.0.0/8
  }

  // IPv6
  if (ip === "::1" || ip === "0:0:0:0:0:0:0:1") return true; // loopback
  const lower = ip.toLowerCase();
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7 unique local
  if (lower.startsWith("fe80:")) return true; // fe80::/10 link-local

  return false;
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
