// Tests for CSP and XSS Protection
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  generateCSPNonce,
  generateCSPHash,
  buildCSPHeader,
  handleCSPViolation,
  getCSPStatistics,
  sanitizeHTML,
  sanitizeURL,
  generateCSRFToken,
  validateCSRFToken,
  createCSRFToken,
  buildSecurityHeaders,
  validateCSRFOnRequest,
} from "../src/security/csp";

// Mock Redis
class MockRedis {
  private data = new Map<string, { value: string; expireAt?: number }>();

  async set(key: string, value: string, mode?: string, ttl?: number): Promise<"OK"> {
    const expireAt = ttl ? Date.now() + ttl : undefined;
    this.data.set(key, { value, expireAt });
    return "OK";
  }

  async get(key: string): Promise<string | null> {
    const entry = this.data.get(key);
    if (!entry) return null;

    // Check expiration
    if (entry.expireAt && entry.expireAt < Date.now()) {
      this.data.delete(key);
      return null;
    }

    return entry.value;
  }

  async del(...keys: string[]): Promise<number> {
    let count = 0;
    for (const key of keys) {
      if (this.data.delete(key)) count++;
    }
    return count;
  }

  async incr(key: string): Promise<number> {
    const current = parseInt((await this.get(key)) || "0", 10);
    const newValue = current + 1;
    await this.set(key, String(newValue));
    return newValue;
  }

  async decr(key: string): Promise<number> {
    const current = parseInt((await this.get(key)) || "0", 10);
    const newValue = Math.max(0, current - 1);
    await this.set(key, String(newValue));
    return newValue;
  }

  async keys(pattern: string): Promise<string[]> {
    const regex = new RegExp(pattern.replace("*", ".*"));
    return Array.from(this.data.keys()).filter((k) => regex.test(k));
  }

  clear() {
    this.data.clear();
  }
}

const mockRedis = new MockRedis();

// Mock getRedisClient
// Note: This would need proper mocking in the actual implementation
// For now, we test the functions that don't require Redis

describe("CSP Nonce Generation", () => {
  test("should generate unique nonces", () => {
    const nonce1 = generateCSPNonce();
    const nonce2 = generateCSPNonce();

    expect(nonce1).toBeTruthy();
    expect(nonce2).toBeTruthy();
    expect(nonce1).not.toEqual(nonce2);
    expect(nonce1.length).toBeGreaterThan(10);
  });

  test("should generate base64-encoded nonces", () => {
    const nonce = generateCSPNonce();
    // Base64 pattern
    expect(/^[A-Za-z0-9+/=]+$/.test(nonce)).toBe(true);
  });
});

describe("CSP Hash Generation", () => {
  test("should generate sha256 hash", () => {
    const content = "alert('hello')";
    const hash = generateCSPHash(content, "sha256");

    expect(hash).toMatch(/^sha256-[A-Za-z0-9+/=]+$/);
  });

  test("should generate sha384 hash", () => {
    const content = "console.log('world')";
    const hash = generateCSPHash(content, "sha384");

    expect(hash).toMatch(/^sha384-[A-Za-z0-9+/=]+$/);
  });

  test("should generate sha512 hash", () => {
    const content = "document.write('test')";
    const hash = generateCSPHash(content, "sha512");

    expect(hash).toMatch(/^sha512-[A-Za-z0-9+/=]+$/);
  });

  test("should generate consistent hashes for same content", () => {
    const content = "const x = 42;";
    const hash1 = generateCSPHash(content);
    const hash2 = generateCSPHash(content);

    expect(hash1).toEqual(hash2);
  });

  test("should generate different hashes for different content", () => {
    const hash1 = generateCSPHash("const x = 42;");
    const hash2 = generateCSPHash("const x = 43;");

    expect(hash1).not.toEqual(hash2);
  });
});

describe("CSP Header Building", () => {
  test("should build basic CSP header without nonce", () => {
    const csp = buildCSPHeader();

    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src");
    expect(csp).toContain("style-src");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  test("should build CSP header with nonce", () => {
    const nonce = "test-nonce-123";
    const csp = buildCSPHeader(nonce);

    expect(csp).toContain(`'nonce-${nonce}'`);
    expect(csp).toContain("'strict-dynamic'");
  });

  test("should allow custom directives", () => {
    const customDirectives = {
      "img-src": "'self' data: https://example.com",
      "media-src": "https://cdn.example.com",
    };
    const csp = buildCSPHeader(undefined, { customDirectives });

    expect(csp).toContain("img-src 'self' data: https://example.com");
    expect(csp).toContain("media-src https://cdn.example.com");
  });

  test("should include report-uri when configured", () => {
    const csp = buildCSPHeader(undefined, {
      reportURI: "/api/security/csp-report",
    });

    expect(csp).toContain("report-uri /api/security/csp-report");
    expect(csp).toContain("report-to csp-endpoint");
  });
});

describe("XSS Protection - HTML Sanitization", () => {
  test("should strip script tags", () => {
    const input = '<p>Hello</p><script>alert("xss")</script>';
    const sanitized = sanitizeHTML(input);

    expect(sanitized).not.toContain("<script>");
    expect(sanitized).toContain("<p>Hello</p>");
  });

  test("should strip iframe tags", () => {
    const input = '<p>Content</p><iframe src="evil.com"></iframe>';
    const sanitized = sanitizeHTML(input);

    expect(sanitized).not.toContain("<iframe>");
    expect(sanitized).toContain("<p>Content</p>");
  });

  test("should strip object tags", () => {
    const input = '<object data="malicious.swf"></object>';
    const sanitized = sanitizeHTML(input);

    expect(sanitized).not.toContain("<object>");
  });

  test("should strip event handlers", () => {
    const input = '<div onclick="evil()">Click me</div>';
    const sanitized = sanitizeHTML(input);

    expect(sanitized).not.toContain("onclick");
  });

  test("should strip javascript: protocol", () => {
    const input = '<a href="javascript:alert(\'xss\')">Click</a>';
    const sanitized = sanitizeHTML(input);

    expect(sanitized).not.toContain("javascript:");
  });

  test("should allow safe HTML tags", () => {
    const input = '<p>Hello <strong>world</strong>!</p>';
    const sanitized = sanitizeHTML(input);

    expect(sanitized).toContain("<p>");
    expect(sanitized).toContain("<strong>");
    expect(sanitized).toContain("</strong>");
    expect(sanitized).toContain("</p>");
  });

  test("should allow safe tags from config", () => {
    const input = '<ul><li>Item 1</li><li>Item 2</li></ul>';
    const sanitized = sanitizeHTML(input);

    expect(sanitized).toContain("<ul>");
    expect(sanitized).toContain("<li>");
  });

  test("should strip unsafe tags while preserving safe tags", () => {
    const input = '<div class="safe"><script>xss</script></div>';
    const sanitized = sanitizeHTML(input);

    expect(sanitized).not.toContain("<script>");
    expect(sanitized).toContain("</div>"); // Check for closing div tag
    expect(sanitized).toMatch(/<div[^>]*>/); // Check for opening div tag (with or without attributes)
  });
});

describe("XSS Protection - URL Sanitization", () => {
  test("should allow https URLs", () => {
    expect(sanitizeURL("https://example.com")).toBe("https://example.com");
  });

  test("should allow http URLs", () => {
    expect(sanitizeURL("http://example.com")).toBe("http://example.com");
  });

  test("should allow mailto URLs", () => {
    expect(sanitizeURL("mailto:user@example.com")).toBe("mailto:user@example.com");
  });

  test("should allow tel URLs", () => {
    expect(sanitizeURL("tel:+1234567890")).toBe("tel:+1234567890");
  });

  test("should allow relative URLs", () => {
    expect(sanitizeURL("/path/to/page")).toBe("/path/to/page");
  });

  test("should allow fragment URLs", () => {
    expect(sanitizeURL("#section")).toBe("#section");
  });

  test("should block javascript: URLs", () => {
    expect(sanitizeURL("javascript:alert('xss')")).toBe("#");
  });

  test("should block vbscript: URLs", () => {
    expect(sanitizeURL("vbscript:msgbox('xss')")).toBe("#");
  });

  test("should block data:text/html URLs", () => {
    expect(sanitizeURL("data:text/html,<script>alert('xss')</script>")).toBe("#");
  });

  test("should trim whitespace", () => {
    expect(sanitizeURL("  https://example.com  ")).toBe("https://example.com");
  });
});

describe("CSRF Token Generation", () => {
  test("should generate unique tokens", () => {
    const token1 = generateCSRFToken();
    const token2 = generateCSRFToken();

    expect(token1.token).not.toEqual(token2.token);
    expect(token1.expiresAt).toBeGreaterThan(Date.now());
    expect(token2.expiresAt).toBeGreaterThan(Date.now());
  });

  test("should generate tokens with correct length", () => {
    const token = generateCSRFToken();

    expect(token.token.length).toBe(64); // 32 bytes * 2 (hex)
    expect(token.token).toMatch(/^[a-f0-9]{64}$/);
  });

  test("should set expiration 8 hours in the future", () => {
    const token = generateCSRFToken();
    const expectedExpiry = Date.now() + 8 * 60 * 60 * 1000;

    expect(token.expiresAt).toBeCloseTo(expectedExpiry, -3); // Within 1 second
  });
});

describe("CSRF Cookie Building", () => {
  test("should build cookie with secure flag in production", () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    const { buildCSRFCookie } = require("../src/security/csp");
    const cookie = buildCSRFCookie("test-token", true);

    expect(cookie).toContain("kory_csrf=test-token");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Secure");

    process.env.NODE_ENV = originalEnv;
  });

  test("should build cookie without secure flag in development", () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";

    const { buildCSRFCookie } = require("../src/security/csp");
    const cookie = buildCSRFCookie("test-token", false);

    expect(cookie).toContain("kory_csrf=test-token");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).not.toContain("Secure");

    process.env.NODE_ENV = originalEnv;
  });

  test("should support different SameSite policies", () => {
    const { buildCSRFCookie } = require("../src/security/csp");

    const strict = buildCSRFCookie("token", false, "Strict");
    const lax = buildCSRFCookie("token", false, "Lax");
    const none = buildCSRFCookie("token", true, "None");

    expect(strict).toContain("SameSite=Strict");
    expect(lax).toContain("SameSite=Lax");
    expect(none).toContain("SameSite=None");
  });
});

describe("Security Headers", () => {
  test("should build all security headers", () => {
    const headers = buildSecurityHeaders();

    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["X-XSS-Protection"]).toBe("1; mode=block");
    expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["Permissions-Policy"]).toBeTruthy();
    expect(headers["Strict-Transport-Security"]).toContain("max-age=31536000");
    expect(headers["Content-Security-Policy"]).toBeTruthy();
  });

  test("should disable HSTS when configured", () => {
    const headers = buildSecurityHeaders({ enableHSTS: false });

    expect(headers["Strict-Transport-Security"]).toBeUndefined();
  });

  test("should disable CSP when configured", () => {
    const headers = buildSecurityHeaders({ enableCSP: false });

    expect(headers["Content-Security-Policy"]).toBeUndefined();
  });

  test("should include nonce in CSP when provided", () => {
    const nonce = "test-nonce";
    const headers = buildSecurityHeaders({ cspNonce: nonce });

    const csp = headers["Content-Security-Policy"];
    expect(csp).toContain(`'nonce-${nonce}'`);
  });

  test("should use report-only mode when configured", () => {
    const headers = buildSecurityHeaders({ reportOnly: true });

    expect(headers["Content-Security-Policy"]).toBeUndefined();
    expect(headers["Content-Security-Policy-Report-Only"]).toBeTruthy();
  });
});
