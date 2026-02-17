// Tests for security utilities
import { describe, test, expect } from "bun:test";
import {
  validateBashCommand,
  sanitizeString,
  validateSessionId,
  validateProviderName,
  encryptApiKey,
  decryptApiKey,
  RateLimiter,
} from "../src/security";

describe("validateBashCommand", () => {
  test("allows safe commands", () => {
    expect(validateBashCommand("ls -la")).toEqual({ safe: true });
    expect(validateBashCommand("git status")).toEqual({ safe: true });
    expect(validateBashCommand("echo hello")).toEqual({ safe: true });
  });

  test("blocks dangerous commands", () => {
    const dangerous = [
      "rm -rf /",
      "rm -rf /*",
      "dd if=/dev/zero of=/dev/sda",
      ":(){ :|:& };:",
      "sudo rm -rf /",
      "sudo dd if=/dev/zero of=/dev/sda",
    ];

    for (const cmd of dangerous) {
      const result = validateBashCommand(cmd);
      expect(result.safe).toBe(false);
      expect(result.reason).toBeDefined();
    }
  });
});

describe("sanitizeString", () => {
  test("trims and limits length", () => {
    expect(sanitizeString("  hello  ")).toBe("hello");
    expect(sanitizeString("a".repeat(100), 10)).toBe("a".repeat(10));
  });

  test("handles non-string input", () => {
    expect(sanitizeString(123)).toBe("");
    expect(sanitizeString(null)).toBe("");
    expect(sanitizeString(undefined)).toBe("");
  });
});

describe("validateSessionId", () => {
  test("accepts valid session IDs", () => {
    expect(validateSessionId("abc123")).toBe("abc123");
    expect(validateSessionId("session-id_123")).toBe("session-id_123");
  });

  test("rejects invalid session IDs", () => {
    expect(validateSessionId("")).toBeNull();
    expect(validateSessionId("has spaces")).toBeNull();
    expect(validateSessionId("has/slash")).toBeNull();
    expect(validateSessionId(123)).toBeNull();
  });
});

describe("validateProviderName", () => {
  test("accepts valid provider names", () => {
    expect(validateProviderName("anthropic")).toBe("anthropic");
    expect(validateProviderName("openai")).toBe("openai");
  });

  test("rejects invalid provider names", () => {
    expect(validateProviderName("invalid")).toBeNull();
    expect(validateProviderName("")).toBeNull();
    expect(validateProviderName(123)).toBeNull();
  });
});

describe("API key encryption", () => {
  test("encrypts and decrypts correctly", () => {
    const original = "sk-test-api-key-12345";
    const encrypted = encryptApiKey(original);
    
    expect(encrypted).toContain("v1:");
    expect(encrypted).not.toContain(original);
    
    const decrypted = decryptApiKey(encrypted);
    expect(decrypted).toBe(original);
  });

  test("handles unencrypted keys", () => {
    const plain = "sk-plain-key";
    expect(decryptApiKey(plain)).toBe(plain);
  });
});

describe("RateLimiter", () => {
  test("allows requests within limit", () => {
    const limiter = new RateLimiter(5, 1000);
    
    for (let i = 0; i < 5; i++) {
      const result = limiter.check("test-key");
      expect(result.allowed).toBe(true);
    }
  });

  test("blocks requests exceeding limit", () => {
    const limiter = new RateLimiter(3, 1000);
    
    // First 3 should pass
    for (let i = 0; i < 3; i++) {
      limiter.check("test-key");
    }
    
    // 4th should be blocked
    const result = limiter.check("test-key");
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  test("resets after window expires", async () => {
    const limiter = new RateLimiter(2, 100); // 100ms window
    
    limiter.check("test-key");
    limiter.check("test-key");
    
    // Should be blocked immediately
    expect(limiter.check("test-key").allowed).toBe(false);
    
    // Wait for window to expire
    await new Promise(resolve => setTimeout(resolve, 150));
    
    // Should be allowed again
    expect(limiter.check("test-key").allowed).toBe(true);
  });
});
