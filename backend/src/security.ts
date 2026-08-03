// Security module — bash sandboxing, input validation, key encryption, SSRF prevention.

// Re-export new security modules
export {
  auditBashCommand,
  sanitizeCommandForLogging,
  SANDBOX_CMD_WHITELIST,
  type BashValidationResult,
} from './security/bash-sandbox';

export {
  sanitizePathComponent,
  validatePathParameter,
  validateApiPath,
  safePathJoin,
  type PathValidationResult,
} from './security/path-security';

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { toolLog } from './logger';
import { SECURITY } from './constants';

// ─── Bash Command Denylist (defense-in-depth, NOT a sandbox) ────────────────
// This is a denylist of known-dangerous patterns, NOT a sandbox. It provides
// defense-in-depth but cannot prevent all command injection. Real sandboxing
// requires OS-level isolation (see ./security/bash-sandbox for the sandbox
// validator used by the Bash tool, which enforces a command whitelist and
// blocks shell metacharacters in sandboxed mode).

const BLOCKED_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/\s*$/, // rm -rf /
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/\w/, // rm -rf /anything at root
  /\bmkfs\b/,
  /\bdd\b/,
  /\b:(){ :|:& };:/, // fork bomb
  /\bchmod\s+(-R\s+)?777\s+\//, // chmod 777 /
  /\bchown\s+(-R\s+)?.*\s+\//, // chown at root
  />\s*\/dev\/sd[a-z]/, // write to raw disk
  /\bcurl\b.*\|\s*\bbash\b/, // curl | bash
  /\bwget\b.*\|\s*\bbash\b/, // wget | bash
  /\bcurl\b.*\|\s*\bsh\b/, // curl | sh
  /\bwget\b.*\|\s*\bsh\b/, // wget | sh
  /\beval\b.*\$\(/, // eval with command substitution
  /\/etc\/passwd/,
  /\/etc\/shadow/,
  /\bsudo\b/,
  /\bsu\s+-?\s*$/, // bare su
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
  /\$\(/, // command substitution $(...)
  /`[^`]*`/, // backtick command substitution
  /\bpython[23]?\s+-c\b/, // python -c (arbitrary code execution)
  /\bpython[23]?\s*<</, // python heredoc (arbitrary code execution)
  /\bperl\s+-e\b/, // perl -e (arbitrary code execution)
  /\bruby\s+-e\b/, // ruby -e (arbitrary code execution)
  /\bnc\b.*-[elp]/, // netcat listeners
  /\bncat\b/, // ncat
  /\bsocat\b/, // socat
  /\bcrontab\b/, // crontab modification
  /\bat\b\s+/, // at command (scheduled execution)
  /\bbash\s+-c\b/, // bash -c (arbitrary code execution)
  /\bsh\s+-c\b/, // sh -c (arbitrary code execution)
  /\benv\s+-i\b/, // env -i (strips environment, used to evade restrictions)
  /\bexec\b/, // exec (replaces shell process)
  /\bsource\b/, // source (executes a file in the current shell)
  /\b\.\s+\//, // dot-sourcing ./script (executes in current shell)
];

const BLOCKED_EXACT = new Set([
  'rm -rf /',
  'rm -rf /*',
  'rm -rf ~',
  'rm -rf ~/',
  ':(){ :|:& };:',
  'yes | rm -r /',
]);

/**
 * Audit a bash command against a denylist of known-dangerous patterns.
 *
 * WARNING: This is a denylist of known-dangerous patterns, NOT a sandbox. It
 * provides defense-in-depth but cannot prevent all command injection. Real
 * sandboxing requires OS-level isolation. For the actual sandbox validator
 * (command whitelist + shell-metacharacter blocking), use `validateBashCommand`
 * from ./security/bash-sandbox.
 */
export function auditBashDenylist(command: string): { safe: boolean; reason?: string } {
  const trimmed = command.trim();

  if (BLOCKED_EXACT.has(trimmed)) {
    return { safe: false, reason: `Blocked: destructive command "${trimmed}"` };
  }

  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        safe: false,
        reason: `Blocked: command matches dangerous pattern ${pattern.source}`,
      };
    }
  }

  // Block writes to system directories
  const systemDirs = ['/boot', '/sys', '/proc/sys', '/usr/sbin', '/sbin'];
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
const MAX_CACHE_SIZE = 1000; // bound the cache to prevent unbounded memory growth

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
    return { safe: false, reason: 'Invalid URL format' };
  }

  // Only allow http and https
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      safe: false,
      reason: `Blocked protocol: ${parsed.protocol} — only http/https allowed`,
    };
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block localhost by name
  if (hostname === 'localhost' || hostname === 'localhost.') {
    return { safe: false, reason: 'Blocked: localhost is a restricted address' };
  }

  // Cloud provider metadata service hostnames expose instance credentials.
  // Deduplicated: 169.254.169.254 appeared once per provider — kept once here.
  const CLOUD_METADATA_HOSTNAMES = new Set<string>([
    // AWS / Azure / DigitalOcean / Linode / Vultr / Oracle / IBM (shared IP)
    '169.254.169.254',
    'metadata.ec2.internal',
    'instance-data.ec2.internal',
    // GCP
    'metadata.google.internal',
    'metadata.google',
    'management.azure',
    'management.core.windows.net',
    'digitalocean-metadata',
    // Packet/Equinix
    'metadata.packet.net',
    'metadata.equinix.com',
    'metadata.linode.com',
    'metadata.vultr.com',
    'compute.metadata.oracle.com',
    // Alibaba Cloud
    '100.100.100.200',
    'meta.taobao.ali.com',
    'metadata.service.softlayer.com',
    // OVHcloud
    '100.64.0.1',
    'metadata.ovh.net',
  ]);

  if (CLOUD_METADATA_HOSTNAMES.has(hostname)) {
    return {
      safe: false,
      reason: 'Blocked: cloud metadata service is restricted (SSRF protection)',
    };
  }

  // Block IPv6 literals
  if (hostname.startsWith('[')) {
    const ipv6 = hostname.slice(1, -1).toLowerCase();
    if (isPrivateIPv6(ipv6)) {
      return { safe: false, reason: 'Blocked: IPv6 address resolves to a restricted range' };
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
  if (cached && now - cached.timestamp < DNS_CACHE_TTL_MS) {
    // Return cached validated IPs to ensure consistency
    return {
      safe: true,
      validatedHostname: hostname,
      validatedIps: cached.ips,
    };
  }

  // Resolve hostname and check the resulting IPs
  try {
    const { promises: dns } = await import('node:dns');

    const [addresses, addresses6] = await Promise.all([
      dns.resolve4(hostname).catch(() => [] as string[]),
      dns.resolve6(hostname).catch(() => [] as string[]),
    ]);

    // Fail-closed: if we can't resolve at all, block it
    if (addresses.length === 0 && addresses6.length === 0) {
      return {
        safe: false,
        reason: `Blocked: could not resolve hostname "${hostname}" — fail-closed for safety`,
      };
    }

    for (const addr of addresses) {
      if (isPrivateIPv4(addr)) {
        return {
          safe: false,
          reason: `Blocked: "${hostname}" resolves to restricted IPv4 address ${addr}`,
        };
      }
    }

    for (const addr of addresses6) {
      if (isPrivateIPv6(addr)) {
        return {
          safe: false,
          reason: `Blocked: "${hostname}" resolves to restricted IPv6 address ${addr}`,
        };
      }
    }

    // Cache the validated IPs (FIFO eviction when the cache is full)
    const allIps = [...addresses, ...addresses6];
    if (validatedHostCache.size >= MAX_CACHE_SIZE) {
      // Evict the oldest entry (Map preserves insertion order)
      const oldest = validatedHostCache.keys().next().value;
      if (oldest !== undefined) validatedHostCache.delete(oldest);
    }
    validatedHostCache.set(hostname, { ips: allIps, timestamp: now });

    return {
      safe: true,
      validatedHostname: hostname,
      validatedIps: allIps,
    };
  } catch {
    return {
      safe: false,
      reason: `Blocked: DNS resolution failed for "${hostname}" — fail-closed for safety`,
    };
  }
}

/**
 * Clear the DNS validation cache. Useful for testing or when DNS changes are expected.
 */
export function clearValidateUrlCache(): void {
  validatedHostCache.clear();
}

/**
 * Fetch a URL with SSRF protection that pins the resolved IP at request time.
 *
 * This prevents DNS-rebinding TOCTOU attacks: validateUrl resolves and checks
 * the IPs, then safeFetch rewrites the URL hostname to the validated IP and
 * sets the Host header to the original hostname (preserving virtual hosting).
 *
 * Callers MUST use safeFetch instead of raw fetch for any user-controlled URL.
 */
export async function safeFetch(url: string, init?: RequestInit): Promise<Response> {
  const validation = await validateUrl(url);
  if (!validation.safe) {
    throw new Error(`SSRF protection blocked fetch: ${validation.reason}`);
  }

  const parsed = new URL(url);
  const originalHostname = validation.validatedHostname ?? parsed.hostname;
  const validatedIp = validation.validatedIps?.[0];

  // Build headers, preserving any caller-supplied headers and setting Host.
  const headers = new Headers(init?.headers);
  // Only set Host if we are rewriting the hostname to an IP (not already a literal).
  let fetchUrl = url;
  if (validatedIp && !/^\d{1,3}(\.\d{1,3}){3}$/.test(parsed.hostname) && !parsed.hostname.startsWith('[')) {
    // Rewrite hostname to the pinned IP; bracket IPv6 literals.
    const ipHost = validatedIp.includes(':') ? `[${validatedIp}]` : validatedIp;
    parsed.hostname = ipHost;
    fetchUrl = parsed.toString();
    // Preserve original hostname for virtual hosting (do not overwrite if caller set it).
    if (!headers.has('Host')) {
      headers.set('Host', originalHostname);
    }
  }

  return fetch(fetchUrl, { ...init, headers });
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return false;

  const [a, b, c] = parts;

  return (
    a === 0 || // 0.0.0.0/8
    a === 10 || // 10.0.0.0/8
    a === 127 || // 127.0.0.0/8 (loopback)
    (a === 169 && b === 254) || // 169.254.0.0/16 (link-local, AWS metadata)
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
    (a === 192 && b === 168) || // 192.168.0.0/16
    (a === 198 && (b === 18 || b === 19)) || // 198.18.0.0/15 (benchmarking)
    (a === 198 && b === 51 && c === 100) || // 198.51.100.0/24 (TEST-NET-2)
    (a === 203 && b === 0 && c === 113) || // 203.0.113.0/24 (TEST-NET-3)
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 (carrier-grade NAT, Oracle/Aliyun metadata)
    (a === 192 && b === 0 && c === 2) || // 192.0.2.0/24 (IPv4 service continuation, some cloud providers)
    (a === 192 && b === 88 && c === 99) || // 192.88.99.0/24 (NAT64 discovery)
    a >= 224 // 224.0.0.0/4 (multicast) and above
  );
}

/**
 * Parse an IPv6 address string into a 128-bit BigInt.
 * Handles :: expansion and leading-zero omission per RFC 4291.
 * Returns null for malformed addresses.
 */
function parseIPv6ToBigInt(ip: string): bigint | null {
  const lower = ip.toLowerCase();
  const doubleColonCount = (lower.match(/::/g) ?? []).length;
  if (doubleColonCount > 1) return null;

  let working = lower;
  const groups: string[] = working.split('::');
  if (groups.length === 2) {
    const [head, tail] = groups;
    const headParts = head ? head.split(':') : [];
    const tailParts = tail ? tail.split(':') : [];
    const missing = 8 - headParts.length - tailParts.length;
    if (missing < 0) return null;
    working = [...headParts, ...Array(missing).fill('0'), ...tailParts].join(':');
  }

  const parts = working.split(':');
  if (parts.length !== 8) return null;

  let value = 0n;
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    value = (value << 16n) | BigInt(parseInt(part, 16));
  }
  return value;
}

/** Check whether a BigInt falls within a CIDR range (address & mask === network). */
function ipv6InRange(addr: bigint, network: bigint, mask: bigint): boolean {
  return (addr & mask) === network;
}

const IPV6_LOOPBACK = 1n; // ::1
const IPV6_UNSPECIFIED = 0n; // ::
// fc00::/7 — Unique Local Addresses
const ULA_NETWORK = BigInt('0xfc000000000000000000000000000000');
const ULA_MASK = BigInt('0xfe000000000000000000000000000000');
// fe80::/10 — Link-Local
const LINKLOCAL_NETWORK = BigInt('0xfe800000000000000000000000000000');
const LINKLOCAL_MASK = BigInt('0xffc00000000000000000000000000000');
// ::ffff:0:0/96 — IPv4-mapped
const V4MAPPED_NETWORK = BigInt('0x00000000000000000000ffff00000000');
const V4MAPPED_MASK = BigInt('0xffffffffffffffffffffffff00000000');
// 64:ff9b::/96 — IPv4-IPv6 translation (NAT64)
const NAT64_NETWORK = BigInt('0x0064ff9b000000000000000000000000');
const NAT64_MASK = BigInt('0xffffffffffffffffffffffff00000000');
// ff00::/8 — Multicast
const MULTICAST_NETWORK = BigInt('0xff000000000000000000000000000000');
const MULTICAST_MASK = BigInt('0xff000000000000000000000000000000');

function isPrivateIPv6(ip: string): boolean {
  const addr = parseIPv6ToBigInt(ip);
  if (addr === null) return false;

  return (
    addr === IPV6_LOOPBACK || // ::1 (loopback)
    addr === IPV6_UNSPECIFIED || // :: (unspecified)
    ipv6InRange(addr, ULA_NETWORK, ULA_MASK) || // fc00::/7 (ULA)
    ipv6InRange(addr, LINKLOCAL_NETWORK, LINKLOCAL_MASK) || // fe80::/10 (link-local)
    ipv6InRange(addr, V4MAPPED_NETWORK, V4MAPPED_MASK) || // ::ffff:0:0/96 (IPv4-mapped)
    ipv6InRange(addr, NAT64_NETWORK, NAT64_MASK) || // 64:ff9b::/96 (NAT64)
    ipv6InRange(addr, MULTICAST_NETWORK, MULTICAST_MASK) // ff00::/8 (multicast)
  );
}

// ─── Input Validation ───────────────────────────────────────────────────────

export function sanitizeString(input: unknown, maxLength = 10_000): string {
  if (typeof input !== 'string') return '';
  return input.slice(0, maxLength).trim();
}

/**
 * WARNING: This function provides minimal defense-in-depth only. It CANNOT
 * prevent prompt injection. User content MUST be passed as a `user` role
 * message, never interpolated into system prompts. This function exists as a
 * legacy compatibility shim only.
 *
 * Defense-in-depth: strips a handful of common prompt-injection patterns
 * (instruction overrides, role impersonation markers, system-prompt leak
 * attempts). The trailing replaceAll for `\`, backtick, and `\$` escapes
 * characters so the result is safe to interpolate inside a JS template
 * literal; this is intentional and correct for that use case (it escapes the
 * already-cleaned string, not the raw input).
 */
export function defenseInDepthPromptSanitizer(input: string, maxLength = 10_000): string {
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
    cleaned = cleaned.replaceAll(pattern, '');
  }

  // Escape characters that could break template literal interpolation
  cleaned = cleaned
    .replaceAll('\\', String.raw`\\`)
    .replaceAll('`', String.raw`\``)
    .replaceAll('$', String.raw`\$`);

  return cleaned;
}

export function validateSessionId(id: unknown): string | null {
  if (typeof id !== 'string') return null;
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) return null;
  return id;
}

import type { ProviderName } from '@koryphaios/shared';

const VALID_PROVIDERS = new Set<string>([
  'anthropic',
  'cline',
  'openai',
  'google',
  'copilot',
  'openrouter',
  'tokenrouter',
  'groq',
  'digitalocean',
  'xai',
  'azure',
  'bedrock',
  'vertexai',
  'local',
  'ollama',
  'opencodezen',
  'opencodego',
  '302ai',
  'azurecognitive',
  'baseten',
  'cerebras',
  'cloudflare',
  'cortecs',
  'deepseek',
  'deepinfra',
  'codex-auth',
  'fireworks',
  'gitlab',
  'huggingface',
  'helicone',
  'llamacpp',
  'ionet',
  'lmstudio',
  'kimicode',
  'mistral',
  'moonshot',
  'minimax',
  'nebius',
  'ollamacloud',
  'sapai',
  'stackit',
  'ovhcloud',
  'scaleway',
  'togetherai',
  'venice',
  'vercel',
  'zai',
  'zenmux',
]);

export function validateProviderName(name: unknown): ProviderName | null {
  if (typeof name !== 'string') return null;
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
  allowedRoots: string[],
): { allowed: boolean; reason?: string } {
  if (!allowedRoots.length) return { allowed: false, reason: 'No allowed roots configured' };
  if (allowedRoots.includes('/') && !allowedRoots.some((r) => r !== '/')) return { allowed: true };

  let resolved: string;
  try {
    resolved = resolve(absolutePath);
    try {
      resolved = realpathSync(resolved);
    } catch {
      // File may not exist yet (e.g. write); use resolved path
    }
  } catch {
    return { allowed: false, reason: 'Invalid path' };
  }

  const normalized = resolve(resolved) + (resolved.endsWith('/') ? '' : '');
  for (const root of allowedRoots) {
    const rootResolved = resolve(root);
    const rootNorm = rootResolved + (rootResolved.endsWith('/') ? '' : '/');
    if (normalized === rootResolved || normalized.startsWith(rootNorm)) return { allowed: true };
  }
  return { allowed: false, reason: 'Path is outside allowed directories' };
}

// ─── Envelope Encryption Integration ────────────────────────────────────────

import { EnvelopeEncryption, createKMSProviderFromEnv } from './crypto';

let envelopeEncryption: EnvelopeEncryption | null = null;

// Set by markEncryptionFailed() when startup initialization fails in non-prod.
// encryptForStorage checks this to fail fast with a clear message instead of
// retrying the same broken configuration on the first key-write.
let encryptionInitFailed = false;

/** Mark envelope encryption as permanently failed (called by bootstrap on init error). */
export function markEncryptionFailed(): void {
  encryptionInitFailed = true;
}

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
      'Legacy enc: encryption format is no longer supported. Please re-encrypt your API keys using envelope encryption (run the migration or re-enter credentials).',
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
  if (encryptionInitFailed) {
    throw new Error(
      'Envelope encryption initialization failed at startup and is disabled. Fix the KMS configuration and restart the server before writing encrypted credentials.',
    );
  }
  if (!envelopeEncryption) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'Envelope encryption is required in production. Initialize encryption at startup or set KORYPHAIOS_KMS_* environment.',
      );
    }
    await initializeEncryption();
  }
  return secureEncrypt(plaintext);
}

// ─── Log Redaction (never log credentials) ──────────────────────────────────

const REDACT_KEYS = new Set([
  'apiKey',
  'authToken',
  'password',
  'token',
  'refreshToken',
  'secret',
  'authorization',
  'cookie',
  'baseUrl',
]);
const REDACT_PREFIX = '***';

/**
 * Redact sensitive keys from an object for safe logging.
 * Use for request body, headers, or any object that might contain credentials.
 */
export function redactForLog<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  if (obj === null || typeof obj !== 'object') return obj as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const keyLower = k.toLowerCase();
    if (
      REDACT_KEYS.has(keyLower) ||
      keyLower.includes('apikey') ||
      keyLower.includes('authtoken') ||
      keyLower.includes('secret')
    ) {
      out[k] = v === undefined || v === null || v === '' ? undefined : REDACT_PREFIX;
      continue;
    }
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && typeof v !== 'function') {
      out[k] = redactForLog(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Redact Authorization header value for logging (e.g. "Bearer ***"). */
export function redactAuthorizationHeader(value: string | null): string {
  if (!value) return '';
  if (/^Bearer\s+/i.test(value)) return 'Bearer ***';
  return REDACT_PREFIX;
}

// ─── CORS Origin Allowlist ──────────────────────────────────────────────────

const allowedOriginsSet = new Set<string>(SECURITY.ALLOWED_ORIGINS);

/** Call once at startup to merge config-file origins into the allowlist. */
export function addCorsOrigins(origins: string[]): void {
  for (const o of origins) {
    if (o && typeof o === 'string') allowedOriginsSet.add(o.trim());
  }
}

/** CORS headers. Only sets Access-Control-Allow-Origin when origin is in the allowlist (production-safe). */
export function getCorsHeaders(origin?: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, PATCH',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (origin && allowedOriginsSet.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

/** Security headers for API responses (XSS, clickjacking, MIME sniffing). */
export function getSecurityHeaders(): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com https://geistfont.vercel.app; img-src 'self' data: blob:; connect-src 'self' ws: wss:",
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
  return randomBytes(bytes).toString('hex');
}

/**
 * Write a root auth token to a mode-600 file in the data directory.
 * Returns the path to the token file.
 */
export function writeTokenToFile(token: string, sessionId: string): string {
  const tokenDir = join(process.cwd(), '.koryphaios');
  mkdirSync(tokenDir, { recursive: true });

  const tokenFile = join(tokenDir, '.root-token');
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

  writeFileSync(tokenFile, payload, { mode: 0o600, encoding: 'utf-8' });
  return tokenFile;
}

// ─── CLI Auth Token Handling ─────────────────────────────────────────────────

/**
 * CLI auth token types that need special handling
 */
export type CLIAuthProvider = 'codex';

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
  encryptFn: (plaintext: string) => Promise<string>,
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
  if (storedValue.startsWith('env:')) {
    // Could be encrypted CLI token, need to decrypt to check
    // This is intentionally opaque - verification happens at runtime
    return false;
  }

  // Legacy plaintext format (DEPRECATED - for migration only)
  if (storedValue.startsWith('cli:')) {
    toolLog.warn(
      { storedValue: storedValue.slice(0, 20) + '...' },
      'DEPRECATED: Plaintext CLI auth token detected. Re-authenticate to upgrade to encrypted storage.',
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
  decryptFn: (ciphertext: string) => Promise<string>,
): Promise<{ provider: CLIAuthProvider; timestamp: number } | null> {
  let decrypted: string;

  // Handle encrypted format
  if (storedValue.startsWith('env:')) {
    try {
      decrypted = await decryptFn(storedValue);
    } catch {
      return null;
    }
  } else if (storedValue.startsWith('cli:')) {
    // Legacy plaintext format
    decrypted = storedValue;
  } else {
    return null;
  }

  // Parse the marker: cli:provider:timestamp
  const parts = decrypted.split(':');
  if (parts.length < 2 || parts[0] !== 'cli') {
    return null;
  }

  const provider = parts[1] as CLIAuthProvider;
  if (provider !== 'codex') {
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
  persistFn: (key: string, value: string) => void,
): Promise<number> {
  let migrated = 0;

  const cliTokenPatterns = [
    { key: 'CODEX_AUTH_TOKEN', providers: ['codex'] as CLIAuthProvider[] },
  ];

  for (const { key, providers } of cliTokenPatterns) {
    const value = envVars[key];
    if (!value) continue;

    // Check if it's a legacy plaintext token
    if (
      value.startsWith('cli:') &&
      !value.startsWith('cli:codex:')
    ) {
      // This is a legacy format token, migrate it
      const provider = value.split(':')[1] as CLIAuthProvider;
      if (providers.includes(provider)) {
        const encrypted = await createSecureCLIAuthToken(provider, encryptFn);
        persistFn(key, encrypted);
        migrated++;
        toolLog.info({ key, provider }, 'Migrated CLI auth token to encrypted format');
      }
    }
  }

  return migrated;
}
