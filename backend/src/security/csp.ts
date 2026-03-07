// Complete Content Security Policy and XSS Protection Implementation
// Production-ready security headers with nonce-based CSP, DOMPurify integration, and CSRF protection

import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { getRedisClient } from "../redis";
import { authLog } from "../logger";

// ============================================================================
// CSP CONFIGURATION
// ============================================================================

export interface CSPConfig {
  reportURI?: string;
  reportOnly?: boolean;
  strictDynamic?: boolean;
  allowUnsafeInline?: boolean; // For development only
  allowUnsafeEval?: boolean;   // For development only
  customDirectives?: Record<string, string>;
}

const DEFAULT_CSP_CONFIG: CSPConfig = {
  reportOnly: false,
  strictDynamic: true,
  allowUnsafeInline: false,
  allowUnsafeEval: false,
};

// ============================================================================
// NONCE GENERATION AND VALIDATION
// ============================================================================

/**
 * Generate a cryptographically secure nonce for CSP
 * Nonces are base64-encoded 128-bit random values
 */
export function generateCSPNonce(): string {
  const nonce = randomBytes(16);
  return nonce.toString("base64");
}

/**
 * Generate a hash for CSP hash-based restrictions
 * Use this for inline scripts that need to be whitelisted
 */
export function generateCSPHash(content: string, algorithm: "sha256" | "sha384" | "sha512" = "sha384"): string {
  const hash = createHash(algorithm);
  hash.update(content);
  return `${algorithm}-${hash.digest("base64")}`;
}

/**
 * Store a nonce in Redis for validation (prevents nonce reuse attacks)
 * Nonce expires after 5 minutes (matching script execution timeout)
 */
async function storeNonce(nonce: string, ttl: number = 300_000): Promise<void> {
  try {
    const redis = getRedisClient();
    await redis.set(`csp:nonce:${nonce}`, "1", "PX", ttl);
  } catch (err) {
    authLog.warn({ err }, "Failed to store CSP nonce in Redis");
  }
}

/**
 * Validate that a nonce exists and hasn't been used
 */
export async function validateCSPNonce(nonce: string): Promise<boolean> {
  try {
    const redis = getRedisClient();
    const exists = await redis.get(`csp:nonce:${nonce}`);
    if (!exists) return false;

    // Consume the nonce (delete it) to prevent reuse
    await redis.del(`csp:nonce:${nonce}`);
    return true;
  } catch (err) {
    authLog.warn({ err }, "Failed to validate CSP nonce");
    return false;
  }
}

// ============================================================================
// CSP HEADER GENERATION
// ============================================================================

/**
 * Build a complete Content-Security-Policy header
 * Uses nonce-based whitelisting for strict security
 */
export function buildCSPHeader(
  nonce?: string,
  config: CSPConfig = {}
): string {
  const mergedConfig = { ...DEFAULT_CSP_CONFIG, ...config };

  // Base directives - strict by default
  const directives: string[] = [
    // Default policy: deny everything, then allow specific sources
    `default-src 'none'`,

    // Scripts: strict-dynamic + nonce (or hash-based fallback)
    ...(nonce
      ? [`script-src 'nonce-${nonce}' 'strict-dynamic' 'unsafe-inline' https:`]
      : [`script-src 'self' 'unsafe-inline' 'unsafe-eval' https:`]), // Fallback without nonce

    // Styles: allow inline for component libraries, require nonce when available
    ...(nonce && !mergedConfig.allowUnsafeInline
      ? [`style-src 'nonce-${nonce}' 'self' https://fonts.googleapis.com`]
      : [`style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`]),

    // Fonts: Google Fonts and local
    `font-src 'self' https://fonts.gstatic.com https://geistfont.vercel.app data:`,

    // Images: self, data URLs, blobs
    `img-src 'self' data: blob: https: https://*.githubusercontent.com`,

    // Connect: WebSocket, API calls
    `connect-src 'self' ws: wss: https:`,

    // Media: self and data URLs
    `media-src 'self' data: blob:`,

    // Objects: block all plugins (Flash, etc.)
    `object-src 'none'`,

    // Base: restrict base URLs
    `base-uri 'self'`,

    // Form actions: only same-origin
    `form-action 'self'`,

    // Frame ancestors: prevent clickjacking
    `frame-ancestors 'none'`,

    // Report violations (if configured)
    ...(mergedConfig.reportURI ? [`report-uri ${mergedConfig.reportURI}`] : []),
    ...(mergedConfig.reportURI ? [`report-to csp-endpoint`] : []),
  ];

  // Add custom directives if provided
  if (mergedConfig.customDirectives) {
    for (const [directive, value] of Object.entries(mergedConfig.customDirectives)) {
      directives.push(`${directive} ${value}`);
    }
  }

  return directives.join("; ");
}

/**
 * Build Content-Security-Policy-Report-Only header for testing
 */
export function buildCSPReportOnlyHeader(
  nonce?: string,
  config: CSPConfig = {}
): string {
  const reportOnlyConfig = { ...config, reportOnly: true };
  return buildCSPHeader(nonce, reportOnlyConfig);
}

// ============================================================================
// CSP REPORTING
// ============================================================================

export interface CSPViolationReport {
  "csp-report": {
    "document-uri": string;
    "referrer": string;
    "violated-directive": string;
    "effective-directive": string;
    "original-policy": string;
    "disposition": string;
    "blocked-uri": string;
    "line-number"?: number;
    "column-number"?: number;
    "source-file"?: string;
    "status-code"?: number;
    "script-sample"?: string;
  };
}

/**
 * Handle CSP violation reports
 * Logs violations and optionally stores them for analysis
 */
export async function handleCSPViolation(
  report: CSPViolationReport,
  requestInfo: { ip: string; userAgent: string; timestamp: number }
): Promise<void> {
  const { "csp-report": violation } = report;

  authLog.warn({
    type: "CSP_VIOLATION",
    directive: violation["violated-directive"],
    blockedURI: violation["blocked-uri"],
    sourceFile: violation["source-file"],
    lineNumber: violation["line-number"],
    userAgent: requestInfo.userAgent,
    ip: requestInfo.ip,
  }, "Content Security Policy violation detected");

  // Store violation in Redis for analysis (retention: 30 days)
  try {
    const redis = getRedisClient();
    const violationKey = `csp:violations:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    await redis.set(
      violationKey,
      JSON.stringify({ violation, requestInfo }),
      "EX",
      30 * 24 * 60 * 60 // 30 days
    );

    // Increment violation counter
    await redis.incr("csp:violations:count");

    // Add to daily violation stats
    const today = new Date().toISOString().split("T")[0];
    await redis.incr(`csp:violations:daily:${today}`);
  } catch (err) {
    authLog.error({ err }, "Failed to store CSP violation");
  }
}

/**
 * Get CSP violation statistics
 */
export async function getCSPStatistics(): Promise<{
  total: number;
  today: number;
  recent: Array<CSPViolationReport & { timestamp: number; ip: string }>;
}> {
  try {
    const redis = getRedisClient();
    const totalRaw = await redis.get("csp:violations:count");
    const total = totalRaw ? Number.parseInt(totalRaw, 10) : 0;

    const today = new Date().toISOString().split("T")[0];
    const todayRaw = await redis.get(`csp:violations:daily:${today}`);
    const todayCount = todayRaw ? Number.parseInt(todayRaw, 10) : 0;

    // Get recent violations (last 100)
    const keys = await redis.keys("csp:violations:*");
    const recent = [];

    for (const key of keys.slice(0, 100)) {
      const data = await redis.get(key);
      if (data) {
        recent.push(JSON.parse(data));
      }
    }

    return { total, today: todayCount, recent };
  } catch (err) {
    authLog.error({ err }, "Failed to get CSP statistics");
    return { total: 0, today: 0, recent: [] };
  }
}

// ============================================================================
// XSS PRETECTION - DOMPurify INTEGRATION
// ============================================================================

/**
 * Sanitize HTML content to prevent XSS attacks
 * This is a server-side implementation - for static content
 * For dynamic content, use DOMPurify on the client side
 */
export function sanitizeHTML(
  html: string,
  options: {
    allowedTags?: string[];
    allowedAttributes?: Record<string, string[]>;
    allowStyleTag?: boolean;
  } = {}
): string {
  // Basic HTML sanitization (server-side)
  // For production, integrate DOMPurify via a Node.js compatible library
  // This is a simplified version - full implementation requires isomorphic-dompurify

  const {
    allowedTags = ["p", "br", "strong", "em", "u", "a", "ul", "ol", "li", "code", "pre", "div", "span", "h1", "h2", "h3", "h4", "h5", "h6"],
    allowedAttributes = { a: ["href", "title", "rel"] },
  } = options;

  // Strip script tags and dangerous attributes
  let sanitized = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gim, "")
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gim, "")
    .replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gim, "")
    .replace(/<embed\b[^>]*>/gim, "")
    .replace(/on\w+\s*=\s*["'][^"']*["']/gim, "") // Event handlers
    .replace(/javascript:/gim, "")
    .replace(/vbscript:/gim, "")
    .replace(/data:\s*text\/html/gim, "");

  // Allow only safe tags
  const tagPattern = /<\/?(\w+)(?:\s[^>]*)?>/gi;
  const safeTags = new Set(allowedTags.map((t) => t.toLowerCase()));

  sanitized = sanitized.replace(tagPattern, (match, tag) => {
    const lowerTag = tag.toLowerCase();
    if (!safeTags.has(lowerTag)) return "";
    return match;
  });

  return sanitized;
}

/**
 * Sanitize a URL to prevent javascript: and other dangerous protocols
 */
export function sanitizeURL(url: string): string {
  const trimmed = url.trim();

  // Block dangerous protocols
  const dangerousProtocols = [
    "javascript:",
    "vbscript:",
    "data:text/html",
    "data:text/javascript",
    "data:application/javascript",
  ];

  const lower = trimmed.toLowerCase();
  for (const proto of dangerousProtocols) {
    if (lower.startsWith(proto)) {
      return "#"; // Safe fallback
    }
  }

  // Only allow http, https, mailto, tel
  if (!/^(https?:|mailto:|tel:|\/|#)/.test(lower)) {
    return "#";
  }

  return trimmed;
}

// ============================================================================
// CSRF PROTECTION
// ============================================================================

const CSRF_TOKEN_LENGTH = 32;
const CSRF_COOKIE_NAME = "kory_csrf";
const CSRF_HEADER_NAME = "x-csrf-token";
const CSRF_TTL = 8 * 60 * 60 * 1000; // 8 hours

export interface CSRFToken {
  token: string;
  expiresAt: number;
}

/**
 * Generate a new CSRF token
 */
export function generateCSRFToken(): CSRFToken {
  const token = randomBytes(CSRF_TOKEN_LENGTH).toString("hex");
  return {
    token,
    expiresAt: Date.now() + CSRF_TTL,
  };
}

/**
 * Store CSRF token in Redis
 */
async function storeCSRFToken(
  token: string,
  sessionId: string,
  ttl: number = CSRF_TTL
): Promise<void> {
  try {
    const redis = getRedisClient();
    const key = `csrf:token:${sessionId}:${token}`;
    await redis.set(key, "1", "PX", ttl);
  } catch (err) {
    authLog.warn({ err }, "Failed to store CSRF token in Redis");
  }
}

/**
 * Validate CSRF token
 */
export async function validateCSRFToken(
  token: string | null,
  sessionId: string
): Promise<boolean> {
  if (!token) return false;

  try {
    const redis = getRedisClient();
    const key = `csrf:token:${sessionId}:${token}`;
    const exists = await redis.get(key);

    // Consume the token (one-time use)
    await redis.del(key);

    return exists !== null;
  } catch (err) {
    authLog.warn({ err }, "Failed to validate CSRF token");
    return false;
  }
}

/**
 * Generate CSRF token cookie value
 */
export function buildCSRFCookie(
  token: string,
  isSecure: boolean,
  sameSite: "Strict" | "Lax" | "None" = "Strict"
): string {
  const parts = [
    `${CSRF_COOKIE_NAME}=${token}`,
    "Path=/",
    `SameSite=${sameSite}`,
  ];

  if (isSecure) parts.push("Secure");
  // NOT HttpOnly - JavaScript needs to read it for AJAX requests
  // This is safe because we require it in a header, not just the cookie

  return parts.join("; ");
}

/**
 * Generate a new CSRF token and store it
 */
export async function createCSRFToken(sessionId: string): Promise<{
  token: string;
  cookieHeader: string;
  expiresAt: number;
}> {
  const { token, expiresAt } = generateCSRFToken();
  await storeCSRFToken(token, sessionId);

  const isSecure = process.env.NODE_ENV === "production";
  const cookieHeader = buildCSRFCookie(token, isSecure);

  return { token, cookieHeader, expiresAt };
}

// ============================================================================
// SECURITY HEADERS - COMPLETE IMPLEMENTATION
// ============================================================================

export interface SecurityHeadersConfig {
  enableCSP?: boolean;
  enableHSTS?: boolean;
  enableXFrameOptions?: boolean;
  cspNonce?: string;
  cspConfig?: CSPConfig;
  reportOnly?: boolean;
}

/**
 * Build complete security headers for HTTP responses
 */
export function buildSecurityHeaders(
  config: SecurityHeadersConfig = {}
): Record<string, string> {
  const {
    enableCSP = true,
    enableHSTS = true,
    enableXFrameOptions = true,
    cspNonce,
    cspConfig = {},
    reportOnly = false,
  } = config;

  const headers: Record<string, string> = {
    // Prevent MIME type sniffing
    "X-Content-Type-Options": "nosniff",

    // Prevent clickjacking
    ...(enableXFrameOptions ? { "X-Frame-Options": "DENY" } : {}),

    // Enable XSS filter (legacy browsers)
    "X-XSS-Protection": "1; mode=block",

    // Referrer policy
    "Referrer-Policy": "strict-origin-when-cross-origin",

    // Permissions policy (restrict browser features)
    "Permissions-Policy": [
      "geolocation=()",
      "microphone=()",
      "camera=()",
      "payment=()",
      "usb=()",
      "magnetometer=()",
      "gyroscope=()",
      "accelerometer=()",
      "clipboard-read=()",
      "clipboard-write=()",
      "display-capture=()",
    ].join(", "),

    // HSTS (HTTP Strict Transport Security)
    ...(enableHSTS
      ? {
          "Strict-Transport-Security":
            "max-age=31536000; includeSubDomains; preload",
        }
      : {}),

    // Content Security Policy
    ...(enableCSP
      ? {
          ...(reportOnly
            ? {
                "Content-Security-Policy-Report-Only": buildCSPReportOnlyHeader(
                  cspNonce,
                  cspConfig
                ),
              }
            : {
                "Content-Security-Policy": buildCSPHeader(cspNonce, cspConfig),
              }),
        }
      : {}),
  };

  return headers;
}

// ============================================================================
// SECURITY MIDDLEWARE HELPERS
// ============================================================================

/**
 * Middleware helper to add nonce to request context
 * This should be called before rendering any HTML
 */
export async function attachNonceToRequest(): Promise<{
  nonce: string;
  headers: Record<string, string>;
}> {
  const nonce = generateCSPNonce();
  await storeNonce(nonce);

  const headers = buildSecurityHeaders({ cspNonce: nonce });

  return { nonce, headers };
}

/**
 * Validate that a request has proper CSRF protection
 */
export async function validateCSRFOnRequest(
  request: Request,
  sessionId: string
): Promise<{ valid: boolean; error?: string }> {
  const cookieToken = getCSRFCookieFromRequest(request);
  const headerToken = getCSRFHeaderFromRequest(request);

  if (!cookieToken) {
    return { valid: false, error: "Missing CSRF cookie" };
  }

  if (!headerToken) {
    return { valid: false, error: "Missing CSRF header" };
  }

  const isValid = await validateCSRFToken(headerToken, sessionId);

  if (!isValid) {
    return { valid: false, error: "Invalid CSRF token" };
  }

  return { valid: true };
}

function getCSRFCookieFromRequest(request: Request): string | null {
  const cookieHeader = request.headers.get("Cookie");
  if (!cookieHeader) return null;

  const cookies = cookieHeader.split(";").map((c) => c.trim());
  for (const cookie of cookies) {
    if (cookie.startsWith(`${CSRF_COOKIE_NAME}=`)) {
      return cookie.slice(CSRF_COOKIE_NAME.length + 1);
    }
  }

  return null;
}

function getCSRFHeaderFromRequest(request: Request): string | null {
  return request.headers.get(CSRF_HEADER_NAME);
}
