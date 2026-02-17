// Tests for session token authentication
import { describe, test, expect, beforeAll } from "bun:test";
import {
  generateSessionToken,
  verifySessionToken,
  extractTokenFromRequest,
} from "../src/auth";

describe("Session Token Authentication", () => {
  describe("generateSessionToken", () => {
    test("generates a valid token", () => {
      const sessionId = "test-session-123";
      const token = generateSessionToken(sessionId);

      expect(token).toBeTruthy();
      expect(token).toContain(".");
      expect(token.split(".")).toHaveLength(2);
    });

    test("generates different tokens for different sessions", () => {
      const token1 = generateSessionToken("session-1");
      const token2 = generateSessionToken("session-2");

      expect(token1).not.toBe(token2);
    });
  });

  describe("verifySessionToken", () => {
    test("verifies valid token", () => {
      const sessionId = "test-session-456";
      const token = generateSessionToken(sessionId);
      const payload = verifySessionToken(token);

      expect(payload.sessionId).toBe(sessionId);
      expect(payload.createdAt).toBeLessThanOrEqual(Date.now());
      expect(payload.expiresAt).toBeGreaterThan(Date.now());
    });

    test("rejects tampered token", () => {
      const token = generateSessionToken("session-789");
      const [payload, signature] = token.split(".");
      const tamperedToken = `${payload}.${signature}xxx`;

      expect(() => verifySessionToken(tamperedToken)).toThrow();
    });

    test("rejects expired token", () => {
      const sessionId = "expired-session";
      const token = generateSessionToken(sessionId, -1000); // Expired 1 second ago

      expect(() => verifySessionToken(token)).toThrow("Token expired");
    });

    test("rejects invalid format", () => {
      expect(() => verifySessionToken("invalid")).toThrow();
      expect(() => verifySessionToken("no.signature")).toThrow();
      expect(() => verifySessionToken("")).toThrow();
    });
  });

  describe("extractTokenFromRequest", () => {
    test("extracts from Authorization header", () => {
      const token = "test-token-123";
      const req = new Request("http://localhost/api/test", {
        headers: {
          "Authorization": `Bearer ${token}`,
        },
      });

      const extracted = extractTokenFromRequest(req);
      expect(extracted).toBe(token);
    });

    test("extracts from X-Session-Token header", () => {
      const token = "test-token-456";
      const req = new Request("http://localhost/api/test", {
        headers: {
          "X-Session-Token": token,
        },
      });

      const extracted = extractTokenFromRequest(req);
      expect(extracted).toBe(token);
    });

    test("extracts from query parameter", () => {
      const token = "test-token-789";
      const req = new Request(`http://localhost/ws?token=${token}`);

      const extracted = extractTokenFromRequest(req);
      expect(extracted).toBe(token);
    });

    test("returns null when no token present", () => {
      const req = new Request("http://localhost/api/test");
      const extracted = extractTokenFromRequest(req);
      expect(extracted).toBeNull();
    });

    test("prioritizes Authorization header", () => {
      const bearerToken = "bearer-token";
      const headerToken = "header-token";
      const req = new Request("http://localhost/api/test?token=query-token", {
        headers: {
          "Authorization": `Bearer ${bearerToken}`,
          "X-Session-Token": headerToken,
        },
      });

      const extracted = extractTokenFromRequest(req);
      expect(extracted).toBe(bearerToken);
    });
  });

  describe("Token roundtrip", () => {
    test("generate -> verify -> extract works end-to-end", () => {
      const sessionId = "e2e-test-session";
      const token = generateSessionToken(sessionId);

      // Verify token
      const payload = verifySessionToken(token);
      expect(payload.sessionId).toBe(sessionId);

      // Extract from request
      const req = new Request("http://localhost/api/test", {
        headers: {
          "Authorization": `Bearer ${token}`,
        },
      });

      const extracted = extractTokenFromRequest(req);
      expect(extracted).toBe(token);

      // Verify extracted token
      const finalPayload = verifySessionToken(extracted!);
      expect(finalPayload.sessionId).toBe(sessionId);
    });
  });
});
