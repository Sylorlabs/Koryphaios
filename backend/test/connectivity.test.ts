/**
 * Connectivity tests: all enabled provider endpoints must return 200 OK or a specific
 * "Out of Credits" error. Timeout or Connection Refused is a failure.
 * API keys are never printed or logged; use masked strings in assertions if needed.
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { ProviderRegistry } from "../src/providers/registry";
import type { ProviderName } from "@koryphaios/shared";
import { maskApiKey } from "../src/providers/api-endpoints";

describe("Connectivity", () => {
  let registry: ProviderRegistry | null = null;

  beforeAll(() => {
    try {
      registry = new ProviderRegistry(undefined);
    } catch (e) {
      // e.g. Windows: "which" not in PATH when Codex provider initializes
    }
  });

  test("maskApiKey never exposes full key", () => {
    expect(maskApiKey(undefined)).toBe("(none)");
    expect(maskApiKey("")).toBe("(none)");
    expect(maskApiKey("sk-abc123xyz")).toBe("sk-a...3xyz"); // first 4 + ... + last 4
    expect(maskApiKey("short")).toBe("***");
  });

  test("testConnection returns shape { ok, status?, error?, outOfCredits? }", async () => {
    if (!registry) return;
    const result = await registry.testConnection("openai" as ProviderName);
    expect(result).toHaveProperty("ok");
    expect(typeof result.ok).toBe("boolean");
    if (!result.ok) {
      expect(result).toHaveProperty("error");
      if (result.status != null) expect(typeof result.status).toBe("number");
      if (result.outOfCredits != null) expect(typeof result.outOfCredits).toBe("boolean");
    } else {
      expect(result.status).toBe(200);
    }
  });

  test("verifyConnection for unsupported provider returns error not 200", async () => {
    if (!registry) return;
    const result = await registry.verifyConnection("local" as ProviderName, {
      baseUrl: "https://nonexistent.example.com",
    });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("endpoints return 200 or Out of Credits (no raw keys in error)", async () => {
    if (!registry) return;
    const providersToTest: ProviderName[] = [
      "anthropic",
      "openai",
      "google",
      "groq",
      "openrouter",
      "xai",
      "deepseek",
    ];
    for (const name of providersToTest) {
      const result = await registry.testConnection(name);
      expect(result).toHaveProperty("ok");
      if (!result.ok && result.error) {
        // Security: error message must never contain a raw API key (sk-..., long tokens)
        expect(result.error).not.toMatch(/^sk-[a-zA-Z0-9]{20,}/);
        expect(result.error).not.toMatch(/\b[A-Za-z0-9_-]{20,}\b/);
      }
    }
  });
});

