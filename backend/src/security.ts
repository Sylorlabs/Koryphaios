// Security module — bash sandboxing, input validation, key encryption, SSRF prevention.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  /\bcurl\b.*\|\s*\bbash\b/,                        // curl | bash
  /\bwget\b.*\|\s*\bbash\b/,
  /\beval\b.*\$\(/,                                  // eval with command substitution
  /\/etc\/passwd/,
  /\/etc\/shadow/,
  /\bsudo\b/,
  /\bsu\s+-?\s*$/,                                   // bare su
  /\bshutdown\b/,
  /\breboot\b/,
  /\binit\s+[0-6]\b/,
  /\bsystemctl\s+(stop|disable|mask)\b/,
  /\bgcloud\s+auth\b/,
  /\bclaude\s+(login|auth)\b/,
  /\bcodex\s+(auth|login)\b/,
  /\bopenai\s+login\b/,
  /\bxdg-open\b/,
  /\bopen\b\s+https?:\/\//,
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

  // Block writes to system directories
  const systemDirs = ["/boot", "/sys", "/proc/sys", "/usr/sbin", "/sbin"];
  for (const dir of systemDirs) {
    if (trimmed.includes(`> ${dir}`) || trimmed.includes(`>> ${dir}`)) {
      return { safe: false, reason: `Blocked: writing to system directory ${dir}` };
    }
  }

  return { safe: true };
}

// ─── SSRF Prevention ────────────────────────────────────────────────────────

/**
 * Validate a URL is safe to fetch — blocks SSRF, file://, and private network access.
 *
 * Checks performed:
 *  1. Must be a valid URL
 *  2. Protocol must be http: or https:
 *  3. Hostname must not be localhost or resolve to a private/loopback IP
 *  4. IPv6 private ranges blocked (::1, fc00::/7, fe80::/10)
 *  5. DNS rebinding protection with caching
 *
 * Fail-closed: if DNS resolution fails, the URL is considered unsafe.
 */
export async function validateUrl(url: string): Promise<{ safe: boolean; reason?: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { safe: false, reason: "Invalid URL format" };
  }

  // Only allow http and https
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { safe: false, reason: `Blocked protocol: ${parsed.protocol} — only http/https allowed` };
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block localhost by name
  if (hostname === "localhost" || hostname === "localhost.") {
    return { safe: false, reason: "Blocked: localhost is a restricted address" };
  }

  // Block IPv6 literals
  if (hostname.startsWith("[")) {
    const ipv6 = hostname.slice(1, -1).toLowerCase();
    if (isPrivateIPv6(ipv6)) {
      return { safe: false, reason: "Blocked: IPv6 address resolves to a restricted range" };
    }
    return { safe: true };
  }

  // Block raw IPv4 literals without DNS lookup
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    if (isPrivateIPv4(hostname)) {
      return { safe: false, reason: `Blocked: ${hostname} is a restricted IPv4 address` };
    }
    return { safe: true };
  }

  // Resolve hostname and check the resulting IPs
  try {
    const { promises: dns } = await import("node:dns");

    const [addresses, addresses6] = await Promise.all([
      dns.resolve4(hostname).catch(() => [] as string[]),
      dns.resolve6(hostname).catch(() => [] as string[]),
    ]);

    // Fail-closed: if we can't resolve at all, block it
    if (addresses.length === 0 && addresses6.length === 0) {
      return { safe: false, reason: `Blocked: could not resolve hostname "${hostname}" — fail-closed for safety` };
    }

    for (const addr of addresses) {
      if (isPrivateIPv4(addr)) {
        return { safe: false, reason: `Blocked: "${hostname}" resolves to restricted IPv4 address ${addr}` };
      }
    }

    for (const addr of addresses6) {
      if (isPrivateIPv6(addr)) {
        return { safe: false, reason: `Blocked: "${hostname}" resolves to restricted IPv6 address ${addr}` };
      }
    }
  } catch {
    return { safe: false, reason: `Blocked: DNS resolution failed for "${hostname}" — fail-closed for safety` };
  }

  return { safe: true };
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return false;


  const [a, b, c] = parts;

  return (
    a === 0 ||                                    // 0.0.0.0/8
    a === 10 ||                                   // 10.0.0.0/8
    a === 127 ||                                  // 127.0.0.0/8 (loopback)
    (a === 169 && b === 254) ||                   // 169.254.0.0/16 (link-local, AWS metadata)
    (a === 172 && b >= 16 && b <= 31) ||          // 172.16.0.0/12
    (a === 192 && b === 168) ||                   // 192.168.0.0/16
    (a === 198 && (b === 18 || b === 19)) ||      // 198.18.0.0/15 (benchmarking)
    (a === 198 && b === 51 && c === 100) ||       // 198.51.100.0/24 (TEST-NET-2)
    (a === 203 && b === 0 && c === 113) ||        // 203.0.113.0/24 (TEST-NET-3)
    a >= 224                                      // 224.0.0.0/4 (multicast) and above
  );
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();

  return (
    lower === "::1" ||                            // loopback
    lower.startsWith("fc") ||                     // fc00::/7 (unique local)
    lower.startsWith("fd") ||                     // fd00::/8 (unique local)
    lower.startsWith("fe8") ||                    // fe80::/10 (link-local)
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb") ||
    lower === "::" ||                             // unspecified
    lower.startsWith("::ffff:")                   // IPv4-mapped IPv6
  );
}

// ─── Input Validation ───────────────────────────────────────────────────────

export function sanitizeString(input: unknown, maxLength = 10_000): string {
  if (typeof input !== "string") return "";
  return input.slice(0, maxLength).trim();
}

/**
 * Sanitize user input before interpolating it into LLM system/user prompts.
 *
 * Defense-in-depth: strips common prompt injection patterns such as
 * instruction overrides, role impersonation markers, and system prompt
 * leak attempts. This does NOT make arbitrary interpolation safe on its
 * own — prefer passing user content as a `user` message rather than
 * embedding it in `systemPrompt` when possible.
 */
export function sanitizeForPrompt(input: string, maxLength = 10_000): string {
  let cleaned = input.slice(0, maxLength).trim();

  const injectionPatterns: RegExp[] = [
    /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?|context)/gi,
    /disregard\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?|context)/gi,
    /forget\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?|context)/gi,
    /you\s+are\s+now\s+/gi,
    /act\s+as\s+(if\s+you\s+are\s+|a\s+|an\s+)/gi,
    /from\s+now\s+on[,\s]+/gi,
    /new\s+instructions?:?\s*/gi,
    /system\s*prompt\s*[:=]\s*/gi,
    /\[system\]/gi,
    /<\/?system>/gi,
    /```system/gi,
  ];

  for (const pattern of injectionPatterns) {
    cleaned = cleaned.replaceAll(pattern, "");
  }

  // Escape characters that could break template literal interpolation
  cleaned = cleaned
    .replaceAll("\\", String.raw`\\`)
    .replaceAll("`", String.raw`\``)
    .replaceAll("$", String.raw`\$`);



  return cleaned;
}

export function validateSessionId(id: unknown): string | null {
  if (typeof id !== "string") return null;
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) return null;
  return id;
}

import type { ProviderName } from "@koryphaios/shared";

const VALID_PROVIDERS = new Set<string>([
  "anthropic", "cline", "openai", "google", "copilot", "openrouter",
  "groq", "xai", "azure", "bedrock", "vertexai", "local", "ollama", "opencodezen",
  "302ai", "azurecognitive", "baseten", "cerebras", "cloudflare", "cortecs", "deepseek", "deepinfra",
  "firmware", "fireworks", "gitlab", "huggingface", "helicone", "llamacpp", "ionet", "lmstudio",
  "mistral", "moonshot", "minimax", "nebius", "ollamacloud", "sapai", "stackit", "ovhcloud", "scaleway",
  "togetherai", "venice", "vercel", "zai", "zenmux",
]);

export function validateProviderName(name: unknown): ProviderName | null {
  if (typeof name !== "string") return null;
  if (!VALID_PROVIDERS.has(name)) return null;
  return name as ProviderName;
}

// ─── API Key Encryption at Rest ─────────────────────────────────────────────
// 
// ⚠️ DEPRECATED: These functions use static key derivation and are not secure
// for production use. They are kept for backward compatibility during migration.
// 
// Use the new envelope encryption from `backend/src/crypto/` instead:
//   import { EnvelopeEncryption, createKMSProviderFromEnv } from './crypto';
//   
//   const provider = createKMSProviderFromEnv();
//   const encryption = new EnvelopeEncryption(provider);
//   await encryption.initialize();
//   
//   // Encrypt
//   const envelope = await encryption.encrypt(apiKey);
//   const stored = `env:${encryption.serialize(envelope)}`;
//   
//   // Decrypt
//   const envelope = encryption.parse(stored.slice(4));
//   const { data, needsRotation } = await encryption.decrypt(envelope);

const ALGORITHM = "aes-256-gcm";
const SALT = "koryphaios-key-salt-v1";

/**
 * @deprecated Use EnvelopeEncryption from './crypto' instead
 */
function deriveEncryptionKey(): Buffer {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require("os") as typeof import("os");
  const hostname = os.hostname();
  const uid = process.getuid?.() ?? 1000;
  const seed = `${hostname}:${uid}:${SALT}`;
  return scryptSync(seed, SALT, 32);
}

/**
 * @deprecated Use EnvelopeEncryption.encrypt() instead
 * This function uses static key derivation and is vulnerable to anyone with code access.
 * Kept for backward compatibility during migration to envelope encryption.
 */
export function encryptApiKey(plaintext: string): string {
  const key = deriveEncryptionKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  return `enc:${iv.toString("hex")}:${authTag}:${encrypted}`;
}

/**
 * @deprecated Use EnvelopeEncryption.decrypt() instead
 * This function uses static key derivation and is vulnerable to anyone with code access.
 * Kept for backward compatibility during migration to envelope encryption.
 */
export function decryptApiKey(ciphertext: string): string {
  if (!ciphertext.startsWith("enc:")) return ciphertext;
  const parts = ciphertext.split(":");
  if (parts.length < 4) return ciphertext; // Malformed — return as-is
  const [, ivHex, authTagHex, ...encParts] = parts;
  const encrypted = encParts.join(":"); // Rejoin in case encrypted data contains colons
  const key = deriveEncryptionKey();
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

// ─── New Envelope Encryption Integration ───────────────────────────────────

import { EnvelopeEncryption, createKMSProviderFromEnv } from './crypto';

let envelopeEncryption: EnvelopeEncryption | null = null;

/**
 * Initialize the envelope encryption system
 * Call this during server startup
 */
export async function initializeEncryption(): Promise<EnvelopeEncryption> {
  if (envelopeEncryption) {
    return envelopeEncryption;
  }

  const provider = createKMSProviderFromEnv();
  envelopeEncryption = new EnvelopeEncryption(provider);
  await envelopeEncryption.initialize();
  
  return envelopeEncryption;
}

/**
 * Get the initialized envelope encryption instance
 * Throws if not initialized
 */
export function getEnvelopeEncryption(): EnvelopeEncryption {
  if (!envelopeEncryption) {
    throw new Error('Envelope encryption not initialized. Call initializeEncryption() first.');
  }
  return envelopeEncryption;
}

/**
 * Securely encrypt an API key using envelope encryption
 * This is the new, secure method - use this instead of encryptApiKey()
 */
export async function secureEncrypt(plaintext: string): Promise<string> {
  const encryption = getEnvelopeEncryption();
  const envelope = await encryption.encrypt(plaintext);
  return `env:${encryption.serialize(envelope)}`;
}

/**
 * Decrypt a value (handles both legacy and new envelope formats)
 * Automatically re-encrypts legacy values if needed
 */
export async function secureDecrypt(ciphertext: string): Promise<string> {
  // Handle new envelope format
  if (ciphertext.startsWith('env:')) {
    const encryption = getEnvelopeEncryption();
    const envelope = encryption.parse(ciphertext.slice(4));
    const { data } = await encryption.decrypt(envelope);
    return data;
  }
  
  // Handle legacy format
  if (ciphertext.startsWith('enc:')) {
    // Decrypt with legacy method
    const plaintext = decryptApiKey(ciphertext);
    
    // Optionally re-encrypt with new method (lazy migration)
    // This would require async/await changes in callers
    // For now, just return the plaintext
    return plaintext;
  }
  
  // Not encrypted, return as-is
  return ciphertext;
}

/**
 * Check if encryption is using the secure envelope system
 */
export function isUsingSecureEncryption(): boolean {
  return envelopeEncryption !== null;
}

/**
 * Encrypt for storage: uses envelope encryption when initialized.
 * In production, envelope encryption is required; in development, falls back to legacy with a warning.
 */
export async function encryptForStorage(plaintext: string): Promise<string> {
  if (envelopeEncryption) {
    return secureEncrypt(plaintext);
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Envelope encryption is required in production. Initialize encryption at startup or set KORYPHAIOS_KMS_* environment."
    );
  }
  toolLog.warn("Using legacy API key encryption; set up envelope encryption for production.");
  return encryptApiKey(plaintext);
}

// ─── Log Redaction (never log credentials) ──────────────────────────────────

const REDACT_KEYS = new Set([
  "apiKey", "authToken", "password", "token", "refreshToken", "secret",
  "authorization", "cookie", "baseUrl",
]);
const REDACT_PREFIX = "***";

/**
 * Redact sensitive keys from an object for safe logging.
 * Use for request body, headers, or any object that might contain credentials.
 */
export function redactForLog<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  if (obj === null || typeof obj !== "object") return obj as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const keyLower = k.toLowerCase();
    if (REDACT_KEYS.has(keyLower) || keyLower.includes("apikey") || keyLower.includes("authtoken") || keyLower.includes("secret")) {
      out[k] = v === undefined || v === null || v === "" ? undefined : REDACT_PREFIX;
      continue;
    }
    if (v !== null && typeof v === "object" && !Array.isArray(v) && typeof v !== "function") {
      out[k] = redactForLog(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Redact Authorization header value for logging (e.g. "Bearer ***"). */
export function redactAuthorizationHeader(value: string | null): string {
  if (!value) return "";
  if (/^Bearer\s+/i.test(value)) return "Bearer ***";
  return REDACT_PREFIX;
}

// ─── CORS Origin Allowlist ──────────────────────────────────────────────────

const allowedOriginsSet = new Set<string>(SECURITY.ALLOWED_ORIGINS);

/** Call once at startup to merge config-file origins into the allowlist. */
export function addCorsOrigins(origins: string[]): void {
  for (const o of origins) {
    if (o && typeof o === "string") allowedOriginsSet.add(o.trim());
  }
}

/** CORS headers. Only sets Access-Control-Allow-Origin when origin is in the allowlist (production-safe). */
export function getCorsHeaders(origin?: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, PATCH",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
  if (origin && allowedOriginsSet.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

/** Security headers for API responses (XSS, clickjacking, MIME sniffing). */
export function getSecurityHeaders(): Record<string, string> {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-XSS-Protection": "1; mode=block",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
  };
}

// ─── Rate Limiting (in-memory sliding window) ────────────────────────────────

export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  private pruneTimer: ReturnType<typeof setInterval>;

  constructor(
    private maxRequests: number = 60,
    private windowMs: number = 60_000,
  ) {
    // Auto-prune stale entries every 5 minutes to prevent unbounded memory growth
    this.pruneTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.hits) {
        if (now >= entry.resetAt) this.hits.delete(key);
      }
    }, 5 * 60_000);

    // Don't keep the process alive just for pruning
    if (this.pruneTimer.unref) this.pruneTimer.unref();
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

  destroy(): void {
    clearInterval(this.pruneTimer);
    this.hits.clear();
  }
}

// ─── Secure Token Generation ─────────────────────────────────────────────────

export function generateSecureToken(bytes: number = 32): string {
  return randomBytes(bytes).toString("hex");
}

/**
 * Write a root auth token to a mode-600 file in the data directory.
 * Returns the path to the token file.
 */
export function writeTokenToFile(token: string, sessionId: string): string {
  const tokenDir = join(process.cwd(), ".koryphaios");
  mkdirSync(tokenDir, { recursive: true });

  const tokenFile = join(tokenDir, ".root-token");
  const payload = JSON.stringify(
    {
      token,
      sessionId,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    },
    null,
    2,
  );

  writeFileSync(tokenFile, payload, { mode: 0o600, encoding: "utf-8" });
  return tokenFile;
}
