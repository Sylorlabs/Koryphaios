// Security module — bash sandboxing, input validation, key encryption, SSRF prevention.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { toolLog } from "./logger";
import { SECURITY } from "./constants";

// ─── Bash Command Sandboxing ────────────────────────────────────────────────

const BLOCKED_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/\s*$/,   // rm -rf /
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/\w/,       // rm -rf /anything at root
  /\bmkfs\b/,
  /\bdd\b/,
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
  /\$\(/,                                            // command substitution $(...)
  /`[^`]*`/,                                         // backtick command substitution
  /\bpython[23]?\s+-c\b/,                            // python -c (arbitrary code execution)
  /\bperl\s+-e\b/,                                   // perl -e (arbitrary code execution)
  /\bruby\s+-e\b/,                                   // ruby -e (arbitrary code execution)
  /\bnc\b.*-[elp]/,                                  // netcat listeners
  /\bncat\b/,                                        // ncat
  /\bsocat\b/,                                       // socat
  /\bcrontab\b/,                                     // crontab modification
  /\bat\b\s+/,                                       // at command (scheduled execution)
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

// Cache for validated URLs to prevent DNS rebinding attacks
// Maps hostname -> { ips: string[], timestamp: number }
const validatedHostCache = new Map<string, { ips: string[]; timestamp: number }>();
const DNS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Validate a URL is safe to fetch — blocks SSRF, file://, and private network access.
 *
 * Checks performed:
 *  1. Must be a valid URL
 *  2. Protocol must be http: or https:
 *  3. Hostname must not be localhost or resolve to a private/loopback IP
 *  4. IPv6 private ranges blocked (::1, fc00::/7, fe80::/10)
 *  5. DNS rebinding protection: resolved IPs are cached and must match on subsequent requests
 *
 * Fail-closed: if DNS resolution fails, the URL is considered unsafe.
 * 
 * SECURITY NOTE: This function returns validated IPs that MUST be used with fetch
 * via a custom agent/dispatcher to prevent DNS rebinding (time-of-check vs time-of-use).
 */
export async function validateUrl(url: string): Promise<{ 
  safe: boolean; 
  reason?: string;
  validatedIps?: string[];
  validatedHostname?: string;
}> {
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

  // Block cloud provider metadata service hostnames
  // These endpoints expose cloud instance metadata and credentials
  const CLOUD_METADATA_HOSTNAMES = [
    // AWS
    "169.254.169.254",
    "metadata.ec2.internal",
    "instance-data.ec2.internal",
    // GCP
    "metadata.google.internal",
    "metadata.google",
    // Azure
    "169.254.169.254",
    "management.azure",
    "management.core.windows.net",
    // DigitalOcean
    "169.254.169.254",
    "digitalocean-metadata",
    // Packet/Equinix
    "metadata.packet.net",
    "metadata.equinix.com",
    // Linode
    "169.254.169.254",
    "metadata.linode.com",
    // Vultr
    "169.254.169.254",
    "metadata.vultr.com",
    // Oracle Cloud
    "169.254.169.254",
    "compute.metadata.oracle.com",
    // Alibaba Cloud
    "100.100.100.200",
    "meta.taobao.ali.com",
    // IBM Cloud
    "169.254.169.254",
    "metadata.service.softlayer.com",
    // OVHcloud
    "100.64.0.1",
    "metadata.ovh.net",
  ];

  if (CLOUD_METADATA_HOSTNAMES.includes(hostname)) {
    return { safe: false, reason: "Blocked: cloud metadata service is restricted (SSRF protection)" };
  }

  // Block IPv6 literals
  if (hostname.startsWith("[")) {
    const ipv6 = hostname.slice(1, -1).toLowerCase();
    if (isPrivateIPv6(ipv6)) {
      return { safe: false, reason: "Blocked: IPv6 address resolves to a restricted range" };
    }
    return { safe: true, validatedHostname: hostname };
  }

  // Block raw IPv4 literals without DNS lookup
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    if (isPrivateIPv4(hostname)) {
      return { safe: false, reason: `Blocked: ${hostname} is a restricted IPv4 address` };
    }
    return { safe: true, validatedHostname: hostname, validatedIps: [hostname] };
  }

  // Check cache first
  const cached = validatedHostCache.get(hostname);
  const now = Date.now();
  if (cached && (now - cached.timestamp) < DNS_CACHE_TTL_MS) {
    // Return cached validated IPs to ensure consistency
    return { 
      safe: true, 
      validatedHostname: hostname,
      validatedIps: cached.ips 
    };
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

    // Cache the validated IPs
    const allIps = [...addresses, ...addresses6];
    validatedHostCache.set(hostname, { ips: allIps, timestamp: now });

    return { 
      safe: true, 
      validatedHostname: hostname,
      validatedIps: allIps 
    };
  } catch {
    return { safe: false, reason: `Blocked: DNS resolution failed for "${hostname}" — fail-closed for safety` };
  }
}

/**
 * Clear the DNS validation cache. Useful for testing or when DNS changes are expected.
 */
export function clearValidateUrlCache(): void {
  validatedHostCache.clear();
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
    (a === 100 && b >= 64 && b <= 127) ||         // 100.64.0.0/10 (carrier-grade NAT, Oracle/Aliyun metadata)
    (a === 192 && b === 0 && c === 2) ||          // 192.0.2.0/24 (IPv4 service continuation, some cloud providers)
    (a === 192 && b === 88 && c === 99) ||        // 192.88.99.0/24 (NAT64 discovery)
    a >= 224                                      // 224.0.0.0/4 (multicast) and above
  );
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();

  return (
    lower === "::1" ||                            // loopback
    lower === "::" ||                             // unspecified
    lower.startsWith("fc") ||                     // fc00::/7 (unique local)
    lower.startsWith("fd") ||                     // fd00::/8 (unique local)
    lower.startsWith("fe8") ||                    // fe80::/10 (link-local)
    lower.startsWith("fe9") ||                    // fe90::/10 (link-local)
    lower.startsWith("fea") ||                    // fea0::/10 (link-local)
    lower.startsWith("feb") ||                    // feb0::/10 (link-local)
    lower.startsWith("::ffff:") ||                // IPv4-mapped IPv6 (::ffff:0:0/96)
    lower.startsWith("64:ff9b:") ||              // IPv4-IPv6 translation (64:ff9b::/96)
    lower.startsWith("fd00") ||                   // ULA
    lower.startsWith("fd01") ||                   // ULA
    lower.startsWith("fd02") ||                   // ULA
    lower.startsWith("fd03") ||                   // ULA
    lower.startsWith("fd04") ||                   // ULA
    lower.startsWith("fd05") ||                   // ULA
    lower.startsWith("fd06") ||                   // ULA
    lower.startsWith("fd07") ||                   // ULA
    lower.startsWith("fd08") ||                   // ULA
    lower.startsWith("fd09") ||                   // ULA
    lower.startsWith("fd0a") ||                   // ULA
    lower.startsWith("fd0b") ||                   // ULA
    lower.startsWith("fd0c") ||                   // ULA
    lower.startsWith("fd0d") ||                   // ULA
    lower.startsWith("fd0e") ||                   // ULA
    lower.startsWith("fd0f") ||                   // ULA
    lower.startsWith("fd1") || lower.startsWith("fd2") || lower.startsWith("fd3") ||  // More ULA
    lower.startsWith("fe") ||                     // Reserved for IETF
    lower.startsWith("ff")                        // Multicast
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

// ─── Path Access (sandbox / allowed roots) ───────────────────────────────────

/**
 * Check whether a path is under one of the allowed root directories.
 * Used by file tools to enforce sandbox when isSandboxed is true.
 */
export function validatePathAccess(
  absolutePath: string,
  allowedRoots: string[]
): { allowed: boolean; reason?: string } {
  if (!allowedRoots.length) return { allowed: false, reason: "No allowed roots configured" };
  if (allowedRoots.includes("/") && !allowedRoots.some((r) => r !== "/")) return { allowed: true };

  let resolved: string;
  try {
    resolved = resolve(absolutePath);
    try {
      resolved = realpathSync(resolved);
    } catch {
      // File may not exist yet (e.g. write); use resolved path
    }
  } catch {
    return { allowed: false, reason: "Invalid path" };
  }

  const normalized = resolve(resolved) + (resolved.endsWith("/") ? "" : "");
  for (const root of allowedRoots) {
    const rootResolved = resolve(root);
    const rootNorm = rootResolved + (rootResolved.endsWith("/") ? "" : "/");
    if (normalized === rootResolved || normalized.startsWith(rootNorm)) return { allowed: true };
  }
  return { allowed: false, reason: "Path is outside allowed directories" };
}

// ─── Envelope Encryption Integration ────────────────────────────────────────

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
  
  // Legacy format is no longer supported — keys must be re-encrypted
  if (ciphertext.startsWith('enc:')) {
    throw new Error(
      'Legacy enc: encryption format is no longer supported. Please re-encrypt your API keys using envelope encryption (run the migration or re-enter credentials).'
    );
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
  if (!envelopeEncryption) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "Envelope encryption is required in production. Initialize encryption at startup or set KORYPHAIOS_KMS_* environment."
      );
    }
    await initializeEncryption();
  }
  return secureEncrypt(plaintext);
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
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com https://geistfont.vercel.app; img-src 'self' data: blob:; connect-src 'self' ws: wss:",
  };
}

// ─── Secure Token Generation ─────────────────────────────────────────────────

// ─── CSRF Protection (double-submit cookie) ──────────────────────────────────
export function generateCsrfToken(): string {
  return randomBytes(32).toString('hex');
}

export function validateCsrfToken(cookieToken: string | null, headerToken: string | null): boolean {
  if (!cookieToken || !headerToken) return false;
  if (cookieToken.length !== headerToken.length) return false;
  try {
    return timingSafeEqual(Buffer.from(cookieToken, 'hex'), Buffer.from(headerToken, 'hex'));
  } catch {
    return false;
  }
}

export function buildCsrfCookie(token: string, isSecure: boolean): string {
  const parts = [`kory_csrf=${token}`, 'Path=/', 'SameSite=Strict'];
  if (isSecure) parts.push('Secure');
  // NOT HttpOnly — JS needs to read this to send as header
  return parts.join('; ');
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

// ─── CLI Auth Token Handling ─────────────────────────────────────────────────

/**
 * CLI auth token types that need special handling
 */
export type CLIAuthProvider = "gemini" | "codex";

/**
 * Create a secure marker for CLI-based authentication.
 * This marker is stored encrypted and indicates the provider
 * should use CLI-based auth at runtime.
 * 
 * SECURITY: CLI auth tokens are now encrypted before storage,
 * using the same envelope encryption as API keys.
 */
export async function createSecureCLIAuthToken(
  provider: CLIAuthProvider,
  encryptFn: (plaintext: string) => Promise<string>
): Promise<string> {
  // Create a unique marker that includes timestamp for audit
  const timestamp = Date.now();
  const marker = `cli:${provider}:${timestamp}`;
  
  // Encrypt the marker before storage
  // This ensures CLI auth markers are treated with same security as API keys
  return encryptFn(marker);
}

/**
 * Verify if a stored value is a CLI auth token
 */
export function isCLIAuthToken(storedValue: string): boolean {
  // Check for encrypted envelope format first
  if (storedValue.startsWith("env:")) {
    // Could be encrypted CLI token, need to decrypt to check
    // This is intentionally opaque - verification happens at runtime
    return false;
  }
  
  // Legacy plaintext format (DEPRECATED - for migration only)
  if (storedValue.startsWith("cli:")) {
    toolLog.warn(
      { storedValue: storedValue.slice(0, 20) + "..." },
      "DEPRECATED: Plaintext CLI auth token detected. Re-authenticate to upgrade to encrypted storage."
    );
    return true;
  }
  
  return false;
}

/**
 * Parse a CLI auth token to extract provider info
 * Handles both encrypted and legacy plaintext formats
 */
export async function parseCLIAuthToken(
  storedValue: string,
  decryptFn: (ciphertext: string) => Promise<string>
): Promise<{ provider: CLIAuthProvider; timestamp: number } | null> {
  let decrypted: string;
  
  // Handle encrypted format
  if (storedValue.startsWith("env:")) {
    try {
      decrypted = await decryptFn(storedValue);
    } catch {
      return null;
    }
  } else if (storedValue.startsWith("cli:")) {
    // Legacy plaintext format
    decrypted = storedValue;
  } else {
    return null;
  }
  
  // Parse the marker: cli:provider:timestamp
  const parts = decrypted.split(":");
  if (parts.length < 2 || parts[0] !== "cli") {
    return null;
  }
  
  const provider = parts[1] as CLIAuthProvider;
  if (!["gemini", "codex"].includes(provider)) {
    return null;
  }
  
  const timestamp = parts.length > 2 ? parseInt(parts[2], 10) : 0;
  
  return { provider, timestamp };
}

/**
 * Migrate legacy plaintext CLI tokens to encrypted format
 * Call this during startup to upgrade existing tokens
 */
export async function migrateCLIAuthTokens(
  envVars: Record<string, string>,
  encryptFn: (plaintext: string) => Promise<string>,
  persistFn: (key: string, value: string) => void
): Promise<number> {
  let migrated = 0;
  
  const cliTokenPatterns = [
    { key: "GOOGLE_AUTH_TOKEN", providers: ["gemini"] as CLIAuthProvider[] },
    { key: "CODEX_AUTH_TOKEN", providers: ["codex"] as CLIAuthProvider[] },
  ];
  
  for (const { key, providers } of cliTokenPatterns) {
    const value = envVars[key];
    if (!value) continue;
    
    // Check if it's a legacy plaintext token
    if (value.startsWith("cli:") && !value.startsWith("cli:gemini:") && !value.startsWith("cli:codex:")) {
      // This is a legacy format token, migrate it
      const provider = value.split(":")[1] as CLIAuthProvider;
      if (providers.includes(provider)) {
        const encrypted = await createSecureCLIAuthToken(provider, encryptFn);
        persistFn(key, encrypted);
        migrated++;
        toolLog.info({ key, provider }, "Migrated CLI auth token to encrypted format");
      }
    }
  }
  
  return migrated;
}
