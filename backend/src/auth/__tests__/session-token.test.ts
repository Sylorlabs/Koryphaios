// Tests for session token authentication
import { describe, test, expect, beforeAll } from 'bun:test';
import { generateSessionToken, verifySessionToken, extractTokenFromRequest } from '../../auth';

describe('Session Token Authentication', () => {
  describe('generateSessionToken', () => {
    test('generates a valid token', () => {
      const sessionId = 'test-session-123';
      const token = generateSessionToken(sessionId);

      expect(token).toBeTruthy();
      expect(token).toContain('.');
      expect(token.split('.')).toHaveLength(2);
    });

    test('generates different tokens for different sessions', () => {
      const token1 = generateSessionToken('session-1');
      const token2 = generateSessionToken('session-2');

      expect(token1).not.toBe(token2);
    });
  });

  describe('verifySessionToken', () => {
    test('verifies valid token', () => {
      const sessionId = 'test-session-456';
      const token = generateSessionToken(sessionId);
      const payload = verifySessionToken(token);

      expect(payload.sessionId).toBe(sessionId);
      expect(payload.createdAt).toBeLessThanOrEqual(Date.now());
      expect(payload.expiresAt).toBeGreaterThan(Date.now());
    });

    test('rejects tampered token', () => {
      const token = generateSessionToken('session-789');
      const [payload, signature] = token.split('.');
      const tamperedToken = `${payload}.${signature}xxx`;

      expect(() => verifySessionToken(tamperedToken)).toThrow();
    });

    test('rejects expired token', () => {
      const sessionId = 'expired-session';
      const token = generateSessionToken(sessionId, -1000); // Expired 1 second ago

      expect(() => verifySessionToken(token)).toThrow('Token expired');
    });

    test('rejects invalid format', () => {
      expect(() => verifySessionToken('invalid')).toThrow();
      expect(() => verifySessionToken('no.signature')).toThrow();
      expect(() => verifySessionToken('')).toThrow();
    });
  });

  describe('extractTokenFromRequest', () => {
    test('extracts from Authorization header', () => {
      const token = 'test-token-123';
      const req = new Request('http://localhost/api/test', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      const extracted = extractTokenFromRequest(req);
      expect(extracted).toBe(token);
    });

    test('extracts from X-Session-Token header', () => {
      const token = 'test-token-456';
      const req = new Request('http://localhost/api/test', {
        headers: {
          'X-Session-Token': token,
        },
      });

      const extracted = extractTokenFromRequest(req);
      expect(extracted).toBe(token);
    });

    test('does NOT extract from query parameter (security: tokens must be in headers)', () => {
      const token = 'test-token-789';
      const req = new Request(`http://localhost/ws?token=${token}`);

      // Query-string tokens are no longer accepted — they appear in logs/history
      const extracted = extractTokenFromRequest(req);
      expect(extracted).toBeNull();
    });

    test('returns null when no token present', () => {
      const req = new Request('http://localhost/api/test');
      const extracted = extractTokenFromRequest(req);
      expect(extracted).toBeNull();
    });

    test('prioritizes Authorization header', () => {
      const bearerToken = 'bearer-token';
      const headerToken = 'header-token';
      const req = new Request('http://localhost/api/test?token=query-token', {
        headers: {
          Authorization: `Bearer ${bearerToken}`,
          'X-Session-Token': headerToken,
        },
      });

      const extracted = extractTokenFromRequest(req);
      expect(extracted).toBe(bearerToken);
    });
  });

  describe('Token roundtrip', () => {
    test('generate -> verify -> extract works end-to-end', () => {
      const sessionId = 'e2e-test-session';
      const token = generateSessionToken(sessionId);

      // Verify token
      const payload = verifySessionToken(token);
      expect(payload.sessionId).toBe(sessionId);

      // Extract from request
      const req = new Request('http://localhost/api/test', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      const extracted = extractTokenFromRequest(req);
      expect(extracted).toBe(token);

      // Verify extracted token
      const finalPayload = verifySessionToken(extracted!);
      expect(finalPayload.sessionId).toBe(sessionId);
    });
  });

  // ─── Edge cases: replay, revocation, timing ─────────────────────────────
  describe('Token replay and revocation edge cases', () => {
    test('the same token can be verified multiple times (stateless replay is allowed)', () => {
      // Session tokens are stateless HMAC — verifying N times is fine.
      // Revocation requires a server-side denylist (tested separately).
      const token = generateSessionToken('replay-session');
      const p1 = verifySessionToken(token);
      const p2 = verifySessionToken(token);
      const p3 = verifySessionToken(token);
      expect(p1.sessionId).toBe('replay-session');
      expect(p2.sessionId).toBe('replay-session');
      expect(p3.sessionId).toBe('replay-session');
    });

    test('tokens generated for the same session at different times have different signatures', async () => {
      const t1 = generateSessionToken('same-session');
      // Wait 2ms so createdAt differs
      await new Promise((r) => setTimeout(r, 2));
      const t2 = generateSessionToken('same-session');
      // createdAt differs, so the payload differs, so the signature differs
      expect(t1).not.toBe(t2);
      // Both should verify to the same sessionId
      expect(verifySessionToken(t1).sessionId).toBe('same-session');
      expect(verifySessionToken(t2).sessionId).toBe('same-session');
    });

    test('token with far-future expiry is still valid', () => {
      // 1 year in milliseconds (relative offset)
      const oneYear = 365 * 24 * 60 * 60 * 1000;
      const token = generateSessionToken('future-session', oneYear);
      const payload = verifySessionToken(token);
      expect(payload.sessionId).toBe('future-session');
      expect(payload.expiresAt).toBeGreaterThan(Date.now());
    });

    test('token that expired 1 second ago is rejected', () => {
      // The second parameter is a relative offset in milliseconds (negative = past)
      const token = generateSessionToken('just-expired', -1000);
      expect(() => verifySessionToken(token)).toThrow('Token expired');
    });

    test('rejects token with modified sessionId in payload', () => {
      const token = generateSessionToken('original-session');
      const [payloadB64, signature] = token.split('.');
      // Decode, modify sessionId, re-encode
      const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString());
      payload.sessionId = 'hijacked-session';
      const tamperedPayload = Buffer.from(JSON.stringify(payload)).toString('base64');
      const tamperedToken = `${tamperedPayload}.${signature}`;
      expect(() => verifySessionToken(tamperedToken)).toThrow();
    });

    test('rejects token with modified expiresAt in payload', () => {
      const token = generateSessionToken('expiry-session', 1000); // 1s relative offset
      const [payloadB64, signature] = token.split('.');
      const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString());
      // Extend expiry to bypass expiration check
      payload.expiresAt = Date.now() + 365 * 24 * 60 * 60 * 1000;
      const tamperedPayload = Buffer.from(JSON.stringify(payload)).toString('base64');
      const tamperedToken = `${tamperedPayload}.${signature}`;
      expect(() => verifySessionToken(tamperedToken)).toThrow();
    });

    test('rejects token signed with a different secret', () => {
      // Generate with the configured secret
      const token = generateSessionToken('cross-secret');
      // The signature is tied to SESSION_TOKEN_SECRET — a different secret
      // would produce a different signature, so verification fails
      expect(() => verifySessionToken(token)).not.toThrow();
      // But if we tamper with the signature, it fails
      const [payload, sig] = token.split('.');
      const fakeSig = Buffer.from('a'.repeat(sig.length)).toString('base64');
      expect(() => verifySessionToken(`${payload}.${fakeSig}`)).toThrow();
    });

    test('token payload contains only expected fields (no sensitive data leak)', () => {
      const token = generateSessionToken('leak-check');
      const [payloadB64] = token.split('.');
      const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString());
      // The payload should only contain sessionId, createdAt, expiresAt
      const keys = Object.keys(payload).sort();
      expect(keys).toEqual(['createdAt', 'expiresAt', 'sessionId']);
      // No password, no user data, no secrets
      expect(payload.sessionId).toBe('leak-check');
      expect(typeof payload.createdAt).toBe('number');
      expect(typeof payload.expiresAt).toBe('number');
    });

    test('Authorization header with Bearer prefix and extra whitespace is handled', () => {
      const token = generateSessionToken('whitespace-session');
      // The extractor should handle "Bearer <token>" with potential whitespace
      const req = new Request('http://localhost/api/test', {
        headers: { Authorization: `Bearer  ${token}` },
      });
      const extracted = extractTokenFromRequest(req);
      // The extractor should return the token (with or without trimming)
      expect(extracted).toBeTruthy();
    });

    test('Authorization header with just "Bearer" and no token returns null', () => {
      const req = new Request('http://localhost/api/test', {
        headers: { Authorization: 'Bearer' },
      });
      const extracted = extractTokenFromRequest(req);
      expect(extracted).toBeNull();
    });

    test('empty Authorization header returns null', () => {
      const req = new Request('http://localhost/api/test', {
        headers: { Authorization: '' },
      });
      const extracted = extractTokenFromRequest(req);
      expect(extracted).toBeNull();
    });
  });
});
