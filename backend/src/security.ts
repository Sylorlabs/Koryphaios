// Security module — strict path validation, encryption, and input sanitization.

import { createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync } from "crypto";
import { resolve, relative, isAbsolute, normalize } from "path";
import { serverLog } from "./logger";
import { SECURITY } from "./constants";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { PROJECT_ROOT } from "./runtime/paths";

// ─── Secure Key Management ──────────────────────────────────────────────────

const KEY_FILE = ".koryphaios/.keys";
let MASTER_KEY: Buffer | null = null;
let keyInitialized = false;

/**
 * Initialize encryption key securely.
 * Priority:
 * 1. KORY_APP_SECRET environment variable
 * 2. Generated key file (persistent across restarts)
 *
 * IMPORTANT: The salt is stored WITH the key, not hardcoded.
 */
function initializeMasterKey(): Buffer {
  if (MASTER_KEY) return MASTER_KEY;

  const appSecret = process.env.KORY_APP_SECRET;

  if (appSecret) {
    // Derive key from environment secret with a unique salt per installation
    const salt = process.env.KORY_KEY_SALT || `koryphaios-${Date.now()}`;
    MASTER_KEY = pbkdf2Sync(appSecret, salt, 100000, 32, "sha512");
    keyInitialized = true;
    serverLog.info("Encryption key derived from KORY_APP_SECRET");
    return MASTER_KEY;
  }

  // Try to load existing key file
  const keyPath = join(PROJECT_ROOT, KEY_FILE);
  const keyDir = join(PROJECT_ROOT, ".koryphaios");

  try {
    if (existsSync(keyPath)) {
      const keyData = JSON.parse(readFileSync(keyPath, "utf-8"));
      MASTER_KEY = Buffer.from(keyData.key, "hex");
      keyInitialized = true;
      serverLog.info("Encryption key loaded from key file");
      return MASTER_KEY;
    }
  } catch (err) {
    serverLog.warn({ err }, "Failed to load existing key file, generating new one");
  }

  // Generate new key and persist it
  mkdirSync(keyDir, { recursive: true });
  MASTER_KEY = randomBytes(32);

  try {
    writeFileSync(keyPath, JSON.stringify({
      key: MASTER_KEY.toString("hex"),
      createdAt: new Date().toISOString(),
      version: 1,
    }, null, 2), { mode: 0o600 }); // Owner read/write only

    serverLog.info({ path: keyPath }, "Generated and saved new encryption key");
  } catch (err) {
    serverLog.error({ err }, "Failed to save encryption key file - keys will not persist!");
  }

  keyInitialized = true;
  return MASTER_KEY;
}

// Initialize on module load
initializeMasterKey();

function getMasterKey(): Buffer {
  if (!MASTER_KEY) {
    initializeMasterKey();
  }
  if (!MASTER_KEY) {
    throw new Error("Failed to initialize encryption key");
  }
  return MASTER_KEY;
}

// ─── Filesystem Scope / Sandboxing ──────────────────────────────────────────

/**
 * Validates if a path is safe to access.
 *
 * Rules:
 * 1. If allowedRoots contains '/', access is granted globally (Privileged mode).
 * 2. Otherwise, path must be within one of the `allowedRoots`.
 */
export function validatePathAccess(targetPath: string, allowedRoots: string[] = [process.cwd()]): { allowed: boolean; reason?: string } {
  try {
    const safeTarget = resolve(normalize(targetPath));

    // PRIVILEGED MODE: If root is allowed, everything is allowed.
    if (allowedRoots.includes("/") || allowedRoots.includes("/*")) {
      return { allowed: true };
    }

    for (const root of allowedRoots) {
      const safeRoot = resolve(normalize(root));
      const rel = relative(safeRoot, safeTarget);

      if (!rel.startsWith("..") && !isAbsolute(rel)) {
        return { allowed: true };
      }

      if (safeTarget === safeRoot) {
        return { allowed: true };
      }
    }

    return { allowed: false, reason: `Path '${targetPath}' is outside the allowed workspace scope. Use the Manager for system-level tasks.` };
  } catch (err) {
    return { allowed: false, reason: "Invalid path structure" };
  }
}

// ─── Bash Command Validation ────────────────────────────────────────────────

/**
 * Dangerous command patterns - using regex for more comprehensive matching
 */
const DESTRUCTIVE_PATTERNS = [
  /\brm\s+(-[rf]+\s+|)-rf\s+\/\s*$/i,           // rm -rf /
  /\brm\s+(-[rf]+\s+|)-rf\s+\/\*/i,              // rm -rf /*
  /\brm\s+(-[rf]+\s+|)-rf\s+~\s*$/i,             // rm -rf ~
  /\brm\s+(-[rf]+\s+|)-rf\s+\.\s*$/i,            // rm -rf .
  /\bmkfs\b/i,                                    // mkfs
  /:\(\)\s*\{\s*:\|\:&\s*\}\s*;:/i,              // Fork bomb
  />\s*\/dev\/(sd[a-z]|hd[a-z]|nvme)/i,          // Overwrite disk
  /\bdd\s+.*of=\/dev\//i,                        // dd to device
  /\bchmod\s+(-R\s+)?(000|777)\s+\//i,           // Dangerous chmod
  /\bchown\s+.*\s+\//i,                          // Chown root
  />\s*\/(etc|boot|proc|sys)\//i,                // Overwrite system files
  /\bfind\s+\/\s+.*-delete\b/i,                  // find / -delete
  /\bfind\s+\/\s+.*-exec\s+rm\b/i,              // find / -exec rm
  /\bperl\s+-e\s+.*system\s*\(/i,               // Perl shell escape
  /\bpython[3]?\s+-c\s+.*os\.(system|popen|exec)/i, // Python shell escape
];

/**
 * Commands that require elevated privileges - blocked in sandbox
 */
const PRIVILEGED_COMMANDS = [
  /\bsudo\b/i,
  /\bsu\b(\s+|$)/i,
  /\bdoas\b/i,
  /\bpkexec\b/i,
];

/**
 * Network command patterns - blocked in sandbox
 */
const NETWORK_PATTERNS = [
  /\b(curl|wget)\s+/i,
  /\b(nc|netcat|ncat)\s+/i,
  /\b(ssh|scp|rsync|sftp)\s+/i,
  /\b(telnet|ftp)\s+/i,
  /\b(nmap|masscan)\s+/i,
  /\b(tcpdump|tshark)\s+/i,
  /\b(dig|nslookup|host)\s+/i,
];

/**
 * Validates a bash command using pattern matching.
 * @param command The command to check.
 * @param isSandboxed If true, enforce strict rules. If false, allow Manager-level usage.
 */
export function validateBashCommand(command: string, isSandboxed: boolean = true): { safe: boolean; reason?: string } {
  const trimmed = command.trim();

  // Always block destructive patterns
  for (const pattern of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { safe: false, reason: "Blocked: Destructive system-level command detected." };
    }
  }

  // Block privileged commands in sandbox mode
  if (isSandboxed) {
    for (const pattern of PRIVILEGED_COMMANDS) {
      if (pattern.test(trimmed)) {
        return { safe: false, reason: "Blocked: Privileged commands not allowed in sandbox mode." };
      }
    }

    for (const pattern of NETWORK_PATTERNS) {
      if (pattern.test(trimmed)) {
        return { safe: false, reason: "Blocked: Network commands not allowed in sandbox mode. Request Manager authorization." };
      }
    }

    // Block access to sensitive files
    if (/(\/etc\/(passwd|shadow|sudoers|ssh)|\/\.ssh\/|\/\.gnupg\/)/i.test(trimmed)) {
      return { safe: false, reason: "Blocked: Access to sensitive system files is restricted." };
    }
  }

  return { safe: true };
}

// ─── Input Validation ───────────────────────────────────────────────────────

export function sanitizeString(input: unknown, maxLength = 10_000): string {
  if (typeof input !== "string") return "";
  // Basic control char stripping, keep newlines/tabs
  return input.slice(0, maxLength).replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").trim();
}

export function validateSessionId(id: unknown): string | null {
  if (typeof id !== "string") return null;
  // Strict: alphanumeric, hyphens, underscores. No path chars.
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) return null;
  return id;
}

import type { ProviderName } from "@koryphaios/shared";

export function validateProviderName(name: unknown): ProviderName | null {
  const VALID_PROVIDERS = new Set([
    "anthropic", "openai", "google", "gemini", "copilot", "codex", "openrouter", "cline",
    "groq", "xai", "azure", "bedrock", "vertexai", "local",
    "deepseek", "togetherai", "cerebras", "fireworks", "huggingface", "deepinfra",
    "minimax", "moonshot", "ollama", "ollamacloud", "lmstudio", "llamacpp",
    "cloudflare", "vercel", "baseten", "helicone", "portkey",
    "hyperbolic", "ionet", "nebius", "zai", "cortecs", "stepfun",
    "qwen", "alibaba", "zhipuai", "modelscope",
    "replicate", "modal", "scaleway", "venice", "zenmux", "firmware",
    "mistralai", "cohere", "perplexity", "luma", "fal",
    "elevenlabs", "deepgram", "gladia", "assemblyai", "lmnt",
    "nvidia", "nim", "friendliai", "friendli", "voyageai", "mixedbread",
    "mem0", "letta", "blackforestlabs", "klingai", "prodia",
    "302ai", "opencodezen", "novita-ai", "upstage", "v0",
    "siliconflow", "abacus", "llama", "vultr", "wandb", "poe",
    "github-models", "requesty", "inference", "submodel", "synthetic", "moark", "nova",
  ]);
  if (typeof name !== "string") return null;
  if (!VALID_PROVIDERS.has(name)) return null;
  if (name === "gemini") return "google" as ProviderName;
  return name as ProviderName;
}

// ─── API Key Encryption (AES-256-GCM) ───────────────────────────────────────

const ALGORITHM = "aes-256-gcm";

export function encryptApiKey(plaintext: string): string {
  if (!plaintext) return "";

  const key = getMasterKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");

  return `v2:${iv.toString("hex")}:${authTag}:${encrypted}`;
}

export function decryptApiKey(ciphertext: string): string {
  if (!ciphertext) return "";

  // Handle legacy v1 format (backwards compatibility)
  if (ciphertext.startsWith("v1:")) {
    return decryptV1(ciphertext);
  }

  // Handle current v2 format
  if (!ciphertext.startsWith("v2:")) {
    return ciphertext; // Legacy/Plaintext fallback
  }

  try {
    const parts = ciphertext.split(":");
    if (parts.length !== 4) throw new Error("Invalid format");

    const [, ivHex, authTagHex, encrypted] = parts;
    const key = getMasterKey();

    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(authTagHex, "hex"));

    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");

    return decrypted;
  } catch (err) {
    serverLog.error({ err }, "Decryption failed - key may have changed");
    return "[DECRYPTION_FAILED]";
  }
}

/**
 * Legacy v1 decryption for backwards compatibility
 */
function decryptV1(ciphertext: string): string {
  try {
    const parts = ciphertext.split(":");
    if (parts.length !== 4) throw new Error("Invalid v1 format");

    const [, ivHex, authTagHex, encrypted] = parts;

    // v1 used a hardcoded salt - derive the old key
    const appSecret = process.env.KORY_APP_SECRET;
    if (!appSecret) {
      serverLog.warn("Cannot decrypt v1 data without KORY_APP_SECRET");
      return "[DECRYPTION_FAILED]";
    }

    const legacyKey = pbkdf2Sync(appSecret, "koryphaios-v1-salt", 100000, 32, "sha512");

    const decipher = createDecipheriv(ALGORITHM, legacyKey, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(authTagHex, "hex"));

    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");

    return decrypted;
  } catch (err) {
    serverLog.error({ err }, "v1 Decryption failed");
    return "[DECRYPTION_FAILED]";
  }
}

// ─── CORS ───────────────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = new Set<string>(SECURITY.ALLOWED_ORIGINS);

export function getCorsHeaders(origin?: string | null): Record<string, string> {
  // Strict: only allow explicitly listed origins
  const allowedOrigin = origin && ALLOWED_ORIGINS.has(origin)
    ? origin
    : ""; // Empty string if not allowed (browser will reject)

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Session-Token",
    "Access-Control-Allow-Credentials": "true",
    "Vary": "Origin",
  };
}

// ─── Rate Limiting ──────────────────────────────────────────────────────────

export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  private pruneTimer: ReturnType<typeof setInterval>;

  constructor(
    private maxRequests: number = 60,
    private windowMs: number = 60_000,
  ) {
    // Auto-prune expired entries every 5 minutes
    this.pruneTimer = setInterval(() => this.cleanup(), 5 * 60_000);
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

    // Penalty box: extend reset time if they keep hammering past 2x limit
    if (entry.count > this.maxRequests * 2) {
      entry.resetAt = now + this.windowMs;
    }

    return {
      allowed,
      remaining: Math.max(0, this.maxRequests - entry.count),
      resetIn: Math.max(0, entry.resetAt - now),
    };
  }

  /**
   * Clean up expired entries to prevent memory leak
   */
  cleanup(): number {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, entry] of this.hits.entries()) {
      if (now >= entry.resetAt) {
        this.hits.delete(key);
        cleaned++;
      }
    }
    return cleaned;
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
  const tokenDir = join(PROJECT_ROOT, ".koryphaios");
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
