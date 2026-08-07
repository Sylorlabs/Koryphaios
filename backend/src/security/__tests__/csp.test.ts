// Tests for CSP and XSS Protection
import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test';
import { Elysia } from 'elysia';
import { getRedisManager, getRedisClient } from '../../redis';
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
  buildCSRFCookie,
  buildSecurityHeaders,
  validateCSRFOnRequest,
} from '../csp';

// Mock Redis
class MockRedis {
  private data = new Map<string, { value: string; expireAt?: number }>();

  async set(key: string, value: string, mode?: string, ttl?: number): Promise<'OK'> {
    const expireAt = ttl ? Date.now() + ttl : undefined;
    this.data.set(key, { value, expireAt });
    return 'OK';
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
    const current = parseInt((await this.get(key)) || '0', 10);
    const newValue = current + 1;
    await this.set(key, String(newValue));
    return newValue;
  }

  async decr(key: string): Promise<number> {
    const current = parseInt((await this.get(key)) || '0', 10);
    const newValue = Math.max(0, current - 1);
    await this.set(key, String(newValue));
    return newValue;
  }

  async keys(pattern: string): Promise<string[]> {
    const regex = new RegExp(pattern.replace('*', '.*'));
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

describe('CSP Nonce Generation', () => {
  test('should generate unique nonces', () => {
    const nonce1 = generateCSPNonce();
    const nonce2 = generateCSPNonce();

    expect(nonce1).toBeTruthy();
    expect(nonce2).toBeTruthy();
    expect(nonce1).not.toEqual(nonce2);
    expect(nonce1.length).toBeGreaterThan(10);
  });

  test('should generate base64-encoded nonces', () => {
    const nonce = generateCSPNonce();
    // Base64 pattern
    expect(/^[A-Za-z0-9+/=]+$/.test(nonce)).toBe(true);
  });
});

describe('CSP Hash Generation', () => {
  test('should generate sha256 hash', () => {
    const content = "alert('hello')";
    const hash = generateCSPHash(content, 'sha256');

    expect(hash).toMatch(/^sha256-[A-Za-z0-9+/=]+$/);
  });

  test('should generate sha384 hash', () => {
    const content = "console.log('world')";
    const hash = generateCSPHash(content, 'sha384');

    expect(hash).toMatch(/^sha384-[A-Za-z0-9+/=]+$/);
  });

  test('should generate sha512 hash', () => {
    const content = "document.write('test')";
    const hash = generateCSPHash(content, 'sha512');

    expect(hash).toMatch(/^sha512-[A-Za-z0-9+/=]+$/);
  });

  test('should generate consistent hashes for same content', () => {
    const content = 'const x = 42;';
    const hash1 = generateCSPHash(content);
    const hash2 = generateCSPHash(content);

    expect(hash1).toEqual(hash2);
  });

  test('should generate different hashes for different content', () => {
    const hash1 = generateCSPHash('const x = 42;');
    const hash2 = generateCSPHash('const x = 43;');

    expect(hash1).not.toEqual(hash2);
  });
});

describe('CSP Header Building', () => {
  test('should build basic CSP header without nonce', () => {
    const csp = buildCSPHeader();

    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('script-src');
    expect(csp).toContain('style-src');
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  test('should build CSP header with nonce', () => {
    const nonce = 'test-nonce-123';
    const csp = buildCSPHeader(nonce);

    expect(csp).toContain(`'nonce-${nonce}'`);
    expect(csp).toContain("'strict-dynamic'");
  });

  test('should allow custom directives', () => {
    const customDirectives = {
      'img-src': "'self' data: https://example.com",
      'media-src': 'https://cdn.example.com',
    };
    const csp = buildCSPHeader(undefined, { customDirectives });

    expect(csp).toContain("img-src 'self' data: https://example.com");
    expect(csp).toContain('media-src https://cdn.example.com');
  });

  test('should include report-uri when configured', () => {
    const csp = buildCSPHeader(undefined, {
      reportURI: '/api/security/csp-report',
    });

    expect(csp).toContain('report-uri /api/security/csp-report');
    expect(csp).toContain('report-to csp-endpoint');
  });
});

describe('XSS Protection - HTML Sanitization', () => {
  test('should strip script tags', () => {
    const input = '<p>Hello</p><script>alert("xss")</script>';
    const sanitized = sanitizeHTML(input);

    expect(sanitized).not.toContain('<script>');
    expect(sanitized).toContain('<p>Hello</p>');
  });

  test('should strip iframe tags', () => {
    const input = '<p>Content</p><iframe src="evil.com"></iframe>';
    const sanitized = sanitizeHTML(input);

    expect(sanitized).not.toContain('<iframe>');
    expect(sanitized).toContain('<p>Content</p>');
  });

  test('should strip object tags', () => {
    const input = '<object data="malicious.swf"></object>';
    const sanitized = sanitizeHTML(input);

    expect(sanitized).not.toContain('<object>');
  });

  test('should strip event handlers', () => {
    const input = '<div onclick="evil()">Click me</div>';
    const sanitized = sanitizeHTML(input);

    expect(sanitized).not.toContain('onclick');
  });

  test('should strip javascript: protocol', () => {
    const input = '<a href="javascript:alert(\'xss\')">Click</a>';
    const sanitized = sanitizeHTML(input);

    expect(sanitized).not.toContain('javascript:');
  });

  test('should allow safe HTML tags', () => {
    const input = '<p>Hello <strong>world</strong>!</p>';
    const sanitized = sanitizeHTML(input);

    expect(sanitized).toContain('<p>');
    expect(sanitized).toContain('<strong>');
    expect(sanitized).toContain('</strong>');
    expect(sanitized).toContain('</p>');
  });

  test('should allow safe tags from config', () => {
    const input = '<ul><li>Item 1</li><li>Item 2</li></ul>';
    const sanitized = sanitizeHTML(input);

    expect(sanitized).toContain('<ul>');
    expect(sanitized).toContain('<li>');
  });

  test('should strip unsafe tags while preserving safe tags', () => {
    const input = '<div class="safe"><script>xss</script></div>';
    const sanitized = sanitizeHTML(input);

    expect(sanitized).not.toContain('<script>');
    expect(sanitized).toContain('</div>'); // Check for closing div tag
    expect(sanitized).toMatch(/<div[^>]*>/); // Check for opening div tag (with or without attributes)
  });
});

describe('XSS Protection - URL Sanitization', () => {
  test('should allow https URLs', () => {
    expect(sanitizeURL('https://example.com')).toBe('https://example.com');
  });

  test('should allow http URLs', () => {
    expect(sanitizeURL('http://example.com')).toBe('http://example.com');
  });

  test('should allow mailto URLs', () => {
    expect(sanitizeURL('mailto:user@example.com')).toBe('mailto:user@example.com');
  });

  test('should allow tel URLs', () => {
    expect(sanitizeURL('tel:+1234567890')).toBe('tel:+1234567890');
  });

  test('should allow relative URLs', () => {
    expect(sanitizeURL('/path/to/page')).toBe('/path/to/page');
  });

  test('should allow fragment URLs', () => {
    expect(sanitizeURL('#section')).toBe('#section');
  });

  test('should block javascript: URLs', () => {
    expect(sanitizeURL("javascript:alert('xss')")).toBe('#');
  });

  test('should block vbscript: URLs', () => {
    expect(sanitizeURL("vbscript:msgbox('xss')")).toBe('#');
  });

  test('should block data:text/html URLs', () => {
    expect(sanitizeURL("data:text/html,<script>alert('xss')</script>")).toBe('#');
  });

  test('should trim whitespace', () => {
    expect(sanitizeURL('  https://example.com  ')).toBe('https://example.com');
  });
});

describe('CSRF Token Generation', () => {
  test('should generate unique tokens', () => {
    const token1 = generateCSRFToken();
    const token2 = generateCSRFToken();

    expect(token1.token).not.toEqual(token2.token);
    expect(token1.expiresAt).toBeGreaterThan(Date.now());
    expect(token2.expiresAt).toBeGreaterThan(Date.now());
  });

  test('should generate tokens with correct length', () => {
    const token = generateCSRFToken();

    expect(token.token.length).toBe(64); // 32 bytes * 2 (hex)
    expect(token.token).toMatch(/^[a-f0-9]{64}$/);
  });

  test('should set expiration 8 hours in the future', () => {
    const token = generateCSRFToken();
    const expectedExpiry = Date.now() + 8 * 60 * 60 * 1000;

    expect(token.expiresAt).toBeCloseTo(expectedExpiry, -3); // Within 1 second
  });
});

describe('CSRF Cookie Building', () => {
  test('should build cookie with secure flag in production', () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    const { buildCSRFCookie } = require('../csp');
    const cookie = buildCSRFCookie('test-token', true);

    expect(cookie).toContain('kory_csrf=test-token');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Secure');

    process.env.NODE_ENV = originalEnv;
  });

  test('should build cookie without secure flag in development', () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';

    const { buildCSRFCookie } = require('../csp');
    const cookie = buildCSRFCookie('test-token', false);

    expect(cookie).toContain('kory_csrf=test-token');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).not.toContain('Secure');

    process.env.NODE_ENV = originalEnv;
  });

  test('should support different SameSite policies', () => {
    const { buildCSRFCookie } = require('../csp');

    const strict = buildCSRFCookie('token', false, 'Strict');
    const lax = buildCSRFCookie('token', false, 'Lax');
    const none = buildCSRFCookie('token', true, 'None');

    expect(strict).toContain('SameSite=Strict');
    expect(lax).toContain('SameSite=Lax');
    expect(none).toContain('SameSite=None');
  });
});

describe('Security Headers', () => {
  test('should build all security headers', () => {
    const headers = buildSecurityHeaders();

    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['X-XSS-Protection']).toBe('1; mode=block');
    expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['Permissions-Policy']).toBeTruthy();
    expect(headers['Strict-Transport-Security']).toContain('max-age=31536000');
    expect(headers['Content-Security-Policy']).toBeTruthy();
  });

  test('should disable HSTS when configured', () => {
    const headers = buildSecurityHeaders({ enableHSTS: false });

    expect(headers['Strict-Transport-Security']).toBeUndefined();
  });

  test('should disable CSP when configured', () => {
    const headers = buildSecurityHeaders({ enableCSP: false });

    expect(headers['Content-Security-Policy']).toBeUndefined();
  });

  test('should include nonce in CSP when provided', () => {
    const nonce = 'test-nonce';
    const headers = buildSecurityHeaders({ cspNonce: nonce });

    const csp = headers['Content-Security-Policy'];
    expect(csp).toContain(`'nonce-${nonce}'`);
  });

  test('should use report-only mode when configured', () => {
    const headers = buildSecurityHeaders({ reportOnly: true });

    expect(headers['Content-Security-Policy']).toBeUndefined();
    expect(headers['Content-Security-Policy-Report-Only']).toBeTruthy();
  });
});

// ============================================================================
// CSP HEADER INJECTION IN REAL HTTP RESPONSES
// ============================================================================
// These tests exercise the CSP middleware against a real Elysia HTTP server
// (via app.handle) and a real Bun.serve WebSocket endpoint. They verify the
// actual bytes that arrive on the wire, not just the header-generation
// functions, so they catch wiring bugs (headers never applied, applied only
// on happy paths, applied after the body is sent, etc.).
//
// The minimal test server below mirrors how the production security-headers
// middleware is meant to be used: generate a per-request nonce, build the
// full security-header set, and stamp them onto every response — including
// errors and WebSocket upgrades.

/**
 * Build a minimal Elysia app that applies the CSP/security headers to every
 * response via onAfterHandle and onError. This is the smallest faithful
 * reproduction of the production middleware wiring.
 */
function buildSecureApp(sessionId = 'csp-test-session'): Elysia {
  return new Elysia()
    .onAfterHandle(({ set }) => {
      const nonce = generateCSPNonce();
      const headers = buildSecurityHeaders({ cspNonce: nonce });
      for (const [name, value] of Object.entries(headers)) {
        if (value) set.headers[name] = value;
      }
    })
    .onError(({ set }) => {
      // Errors must still carry security headers — a response without CSP
      // on an error page is a classic bypass.
      const nonce = generateCSPNonce();
      const headers = buildSecurityHeaders({ cspNonce: nonce });
      for (const [name, value] of Object.entries(headers)) {
        if (value) set.headers[name] = value;
      }
      set.status = 500;
      return { ok: false, error: 'Internal Server Error' };
    })
    .get('/', () => ({ ok: true }))
    .get('/echo-path', ({ path }) => ({ path }))
    .get('/boom', () => {
      throw new Error('deliberate failure');
    })
    .get('/csrf-token', async ({ set }) => {
      const { token, cookieHeader } = await createCSRFToken(sessionId);
      set.headers['Set-Cookie'] = cookieHeader;
      return { ok: true, token };
    })
    .post('/protected', async ({ request }) => {
      const result = await validateCSRFOnRequest(request, sessionId);
      if (!result.valid) {
        return new Response(JSON.stringify({ ok: false, error: result.error }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return { ok: true };
    })
    .ws('/ws', { open: () => {}, message: () => {} })
    // Explicit catch-all 404 placed LAST so specific routes win, but
    // unmatched paths still flow through onAfterHandle and receive
    // security headers (mirrors the production server's
    // `.all('/api/*', ...)` catch-all).
    .all('*', ({ set }) => {
      set.status = 404;
      return { ok: false, error: 'Not Found' };
    });
}

describe('CSP header injection in real HTTP responses', () => {
  beforeAll(async () => {
    // The CSRF round-trip test stores/validates tokens in Redis, so we need
    // a working client. The in-memory fallback is fine for tests.
    await getRedisManager().initialize({ fallbackToMemory: true });
  });

  afterAll(async () => {
    try {
      const redis = getRedisClient() as any;
      if (typeof redis.flushall === 'function') await redis.flushall();
    } catch {
      /* ignore */
    }
  });

  let app = buildSecureApp();

  test('CSP header is present on a 200 response', async () => {
    const res = await app.handle(new Request('http://localhost/'));
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy');
    expect(csp).toBeTruthy();
  });

  test('CSP header contains the expected directives', async () => {
    const res = await app.handle(new Request('http://localhost/'));
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('script-src');
    expect(csp).toContain('style-src');
    expect(csp).toContain('font-src');
    expect(csp).toContain('img-src');
    expect(csp).toContain('connect-src');
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  test('CSP nonce is present in script-src and style-src', async () => {
    const res = await app.handle(new Request('http://localhost/'));
    const csp = res.headers.get('content-security-policy') ?? '';
    // script-src uses 'nonce-<value>' 'strict-dynamic'
    expect(csp).toMatch(/script-src 'nonce-[^']+' 'strict-dynamic'/);
    // style-src also carries the nonce when not allowing unsafe-inline
    expect(csp).toMatch(/style-src 'nonce-[^']+' 'self'/);
  });

  test('CSP header is not injectable via request query parameters', async () => {
    // An attacker-controlled query string must not bleed into the CSP header.
    const res = await app.handle(
      new Request('http://localhost/?evil=script-src%20%27unsafe-inline%27'),
    );
    const csp = res.headers.get('content-security-policy') ?? '';
    // The header is generated server-side from a fixed policy + random nonce,
    // so it must not contain the attacker's literal payload, and must not gain
    // a second script-src directive.
    expect(csp).not.toContain("'unsafe-inline' script-src");
    expect(csp.match(/script-src/g)?.length).toBe(1);
    // The injected string should not appear verbatim anywhere in the header.
    expect(csp).not.toContain("evil=script-src");
  });

  test('CSP header is not injectable via request headers', async () => {
    // Request headers are never reflected into the CSP header value.
    const res = await app.handle(
      new Request('http://localhost/', {
        headers: { 'X-Attacker-Controlled': "default-src 'self'" },
      }),
    );
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    // Only one default-src directive should exist.
    expect(csp.match(/default-src/g)?.length).toBe(1);
  });

  test('security headers (X-Frame-Options, X-Content-Type-Options, etc.) are present', async () => {
    const res = await app.handle(new Request('http://localhost/'));
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-xss-protection')).toBe('1; mode=block');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('permissions-policy')).toBeTruthy();
    expect(res.headers.get('strict-transport-security')).toContain('max-age=31536000');
  });

  test('CSRF cookie is set in response headers on the token endpoint', async () => {
    const res = await app.handle(new Request('http://localhost/csrf-token'));
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toBeTruthy();
    expect(setCookie).toContain('kory_csrf=');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('SameSite=Strict');
  });

  test('CSP header is present on a 500 error response', async () => {
    const res = await app.handle(new Request('http://localhost/boom'));
    expect(res.status).toBe(500);
    const csp = res.headers.get('content-security-policy');
    expect(csp).toBeTruthy();
    expect(csp).toContain("default-src 'none'");
    // Security headers must also survive onto error responses.
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  test('CSP header is present on a 404 response', async () => {
    // The app has an explicit catch-all 404 route, so not-found responses
    // go through onAfterHandle and receive security headers.
    const res = await app.handle(new Request('http://localhost/does-not-exist'));
    expect(res.status).toBe(404);
    const csp = res.headers.get('content-security-policy');
    expect(csp).toBeTruthy();
    expect(csp).toContain("default-src 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  // VULNERABILITY: When Elysia's internal not-found handling fires (i.e. no
  // route matches AND there is no catch-all), the response does NOT pass
  // through onAfterHandle, so security headers are silently dropped. In the
  // probe above, an unmatched path returned status 500 with no CSP header.
  // A 404/500 page served without CSP is an injection surface. This is
  // skipped (not fixed) per instructions; the fix would be to ensure the
  // security-headers middleware runs in an onResponse hook that covers
  // Elysia's built-in error responses, not only onAfterHandle.
  test.skip('CSP header is present on Elysia built-in unmatched-route responses', async () => {
    const bareApp = new Elysia()
      .onAfterHandle(({ set }) => {
        const nonce = generateCSPNonce();
        const headers = buildSecurityHeaders({ cspNonce: nonce });
        for (const [name, value] of Object.entries(headers)) {
          if (value) set.headers[name] = value;
        }
      })
      .get('/', () => ({ ok: true }));
    const res = await bareApp.handle(new Request('http://localhost/does-not-exist'));
    // Desired behavior: security headers present even on the built-in 404.
    expect(res.headers.get('content-security-policy')).toBeTruthy();
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  test('CSP header is present on WebSocket upgrade responses', async () => {
    // Elysia's app.handle cannot perform a real 101 upgrade (it has no
    // underlying Bun server to hand the socket to), so we spin up a real
    // Bun.serve that mirrors the production upgrade path: generate a nonce,
    // build security headers, and stamp them onto the 101 (or 400 fallback)
    // response. We then open a real WebSocket client to confirm the upgrade
    // succeeds and the headers travel with the handshake.
    const wsApp = buildSecureApp();
    const server = Bun.serve({
      port: 0,
      websocket: { open() {}, message() {} },
      async fetch(req, srv) {
        const url = new URL(req.url);
        if (url.pathname === '/ws') {
          const nonce = generateCSPNonce();
          const headers = buildSecurityHeaders({ cspNonce: nonce });
          const upgraded = (srv as any).upgrade(req, {});
          if (upgraded) {
            return new Response(null, { status: 101, headers });
          }
          return new Response('upgrade failed', { status: 400, headers });
        }
        return wsApp.handle(req);
      },
    });

    try {
      const port = server.port;
      // Real WebSocket client — confirms the upgrade handshake completes.
      const opened = await new Promise<boolean>((resolve) => {
        const ws = new WebSocket(`ws://localhost:${port}/ws`);
        ws.onopen = () => {
          ws.close();
          resolve(true);
        };
        ws.onerror = () => resolve(false);
        setTimeout(() => resolve(false), 3000);
      });
      expect(opened).toBe(true);

      // A plain fetch with upgrade headers hits the same code path and lets
      // us inspect the response headers (the WS client API does not expose
      // the 101 response headers). Bun returns 400 to a non-WS fetch, but
      // the security headers are still attached to that response.
      const res = await fetch(`http://localhost:${port}/ws`, {
        headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
      });
      const csp = res.headers.get('content-security-policy');
      expect(csp).toBeTruthy();
      expect(csp).toContain("default-src 'none'");
      expect(res.headers.get('x-frame-options')).toBe('DENY');
    } finally {
      server.stop(true);
    }
  });

  test('CSP header is not injectable via crafted request paths with CRLF characters', async () => {
    // %0D%0A decodes to CRLF. A naive header-joiner that interpolates the
    // request path into a header value would let an attacker inject a second
    // header line. The CSP header here is generated independently of the
    // path, so it must remain clean (no CR/LF, no extra directives).
    const res = await app.handle(new Request('http://localhost/echo-path/a%0D%0ABogus-Header:%20evil'));
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).not.toContain('\r');
    expect(csp).not.toContain('\n');
    // No attacker-injected header should appear on the response.
    expect(res.headers.get('bogus-header')).toBeNull();
    // The CSP policy is unchanged.
    expect(csp).toContain("default-src 'none'");
    expect(csp.match(/default-src/g)?.length).toBe(1);
  });

  test('CSP nonce is unique across multiple requests', async () => {
    const nonces = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const res = await app.handle(new Request('http://localhost/'));
      const csp = res.headers.get('content-security-policy') ?? '';
      const match = csp.match(/'nonce-([^']+)'/);
      expect(match).not.toBeNull();
      nonces.add(match![1]);
    }
    // 50 requests must yield 50 distinct nonces.
    expect(nonces.size).toBe(50);
  });

  test('CSP nonce is not predictable / not sequential', async () => {
    // Collect a batch of nonces and confirm they are not a simple ascending
    // or otherwise trivially predictable sequence (e.g. 1,2,3... or
    // base64(0), base64(1)...). We assert the nonces don't share a common
    // monotonic prefix and aren't tiny integers.
    const nonces: string[] = [];
    for (let i = 0; i < 20; i++) {
      const res = await app.handle(new Request('http://localhost/'));
      const csp = res.headers.get('content-security-policy') ?? '';
      const match = csp.match(/'nonce-([^']+)'/);
      expect(match).not.toBeNull();
      nonces.push(match![1]);
    }

    // Each nonce is 16 random bytes base64-encoded (~24 chars), never a
    // bare small integer like "1".
    for (const n of nonces) {
      expect(n.length).toBeGreaterThanOrEqual(20);
      expect(Number.isInteger(Number(n))).toBe(false);
    }

    // Sort lexicographically; if they were sequential they'd sort to a
    // strictly increasing run. Confirm they are not in sorted order as
    // generated (the generation order is random).
    const sorted = [...nonces].sort();
    expect(sorted).not.toEqual(nonces);

    // And no two consecutive generated nonces should differ by a tiny
    // constant — sanity check via entropy: the set of first 4 chars should
    // have more than one distinct value across 20 nonces.
    const prefixes = new Set(nonces.map((n) => n.slice(0, 4)));
    expect(prefixes.size).toBeGreaterThan(1);
  });

  test('CSRF token validation in a real request cycle (set cookie, send back, verify)', async () => {
    // 1. Obtain a token: the server sets the kory_csrf cookie and returns
    //    the token in the JSON body.
    const tokenRes = await app.handle(new Request('http://localhost/csrf-token'));
    expect(tokenRes.status).toBe(200);
    const setCookie = tokenRes.headers.get('set-cookie') ?? '';
    const cookieMatch = setCookie.match(/kory_csrf=([^;]+)/);
    expect(cookieMatch).not.toBeNull();
    const cookieToken = cookieMatch![1];
    const body = (await tokenRes.json()) as { token: string };
    expect(body.token).toBe(cookieToken);

    // 2. Send the token back as both the cookie and the x-csrf-token header
    //    (double-submit pattern). The protected endpoint should accept it.
    const okRes = await app.handle(
      new Request('http://localhost/protected', {
        method: 'POST',
        headers: {
          Cookie: `kory_csrf=${cookieToken}`,
          'x-csrf-token': cookieToken,
        },
      }),
    );
    expect(okRes.status).toBe(200);
    const okBody = (await okRes.json()) as { ok: boolean };
    expect(okBody.ok).toBe(true);

    // 3. Replay the same token — it is one-time-use, so a second request
    //    with the same token must be rejected.
    const replayRes = await app.handle(
      new Request('http://localhost/protected', {
        method: 'POST',
        headers: {
          Cookie: `kory_csrf=${cookieToken}`,
          'x-csrf-token': cookieToken,
        },
      }),
    );
    expect(replayRes.status).toBe(403);
    const replayBody = (await replayRes.json()) as { ok: boolean; error?: string };
    expect(replayBody.ok).toBe(false);

    // 4. A request with no CSRF header at all must be rejected.
    const noHeaderRes = await app.handle(
      new Request('http://localhost/protected', {
        method: 'POST',
        headers: { Cookie: `kory_csrf=${cookieToken}` },
      }),
    );
    expect(noHeaderRes.status).toBe(403);

    // 5. A request with a mismatched header (correct cookie, wrong header)
    //    must be rejected.
    const mismatchRes = await app.handle(
      new Request('http://localhost/protected', {
        method: 'POST',
        headers: {
          Cookie: `kory_csrf=${cookieToken}`,
          'x-csrf-token': 'deadbeef'.repeat(8),
        },
      }),
    );
    expect(mismatchRes.status).toBe(403);
  });
});
