/**
 * Auth & Key Validation Tests
 *
 * - Mocks 401 Unauthorized and 200 OK for Anthropic, OpenAI, Google.
 * - Tests KeyValidator minimal-ping behavior and timeout.
 * - Optional live connectivity test for keys present in .env (no mock).
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import {
  validateProviderKey,
  type KeyStatus,
} from "../src/core/auth/KeyValidator";

const PROVIDERS = ["anthropic", "openai", "google"] as const;

describe("KeyValidator", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("NO_KEY", () => {
    it("returns NO_KEY when no apiKey or authToken", async () => {
      const r = await validateProviderKey("anthropic", {});
      expect(r.status).toBe("NO_KEY");

      const r2 = await validateProviderKey("openai", {
        apiKey: "",
        authToken: "",
      });
      expect(r2.status).toBe("NO_KEY");
    });
  });

  describe("mocked 401 Unauthorized", () => {
    for (const provider of PROVIDERS) {
      it(`${provider}: returns INVALID on 401`, async () => {
        globalThis.fetch = mock(() =>
          Promise.resolve(
            new Response(JSON.stringify({ error: "Unauthorized" }), {
              status: 401,
            })
          )
        ) as typeof fetch;

        const result = await validateProviderKey(provider, {
          apiKey: "test-key-not-real",
        });

        expect(result.status).toBe("INVALID");
        expect(result.error).toContain("Unauthorized");
      });
    }
  });

  describe("mocked 200 OK", () => {
    for (const provider of PROVIDERS) {
      it(`${provider}: returns VALID on 200`, async () => {
        globalThis.fetch = mock(() =>
          Promise.resolve(
            new Response(JSON.stringify({ data: [] }), { status: 200 })
          )
        ) as typeof fetch;

        const result = await validateProviderKey(provider, {
          apiKey: "sk-test-ok",
        });

        expect(result.status).toBe("VALID");
      });
    }
  });

  describe("timeout", () => {
    it("returns INVALID on timeout (5s)", async () => {
      globalThis.fetch = mock(
        () =>
          new Promise<Response>((_, reject) =>
            setTimeout(
              () => reject(new Error("The operation was aborted")),
              10
            )
          )
      ) as typeof fetch;

      const result = await validateProviderKey("anthropic", {
        apiKey: "sk-test",
      });

      expect(result.status).toBe("INVALID");
      expect(result.error).toBeDefined();
    });
  });

  describe("unsupported provider", () => {
    it("returns INVALID for unknown provider", async () => {
      const result = await validateProviderKey("unknown_provider", {
        apiKey: "key",
      });
      expect(result.status).toBe("INVALID");
      expect(result.error).toContain("Unsupported provider");
    });
  });
});

/**
 * Live connectivity test: run only when .env has keys set.
 * Does not mock; uses real network with 5s timeout.
 */
describe("Live connectivity (.env keys)", () => {
  const envKeys: Record<string, string> = {
    anthropic: process.env.ANTHROPIC_API_KEY ?? "",
    openai: process.env.OPENAI_API_KEY ?? "",
    google: process.env.GEMINI_API_KEY ?? "",
  };

  const hasAnyKey = Object.values(envKeys).some((v) => v && v.length > 0);

  it.skipIf(!hasAnyKey)(
    "reports status for each provider with key in .env",
    async () => {
      const results: Record<string, KeyStatus> = {};
      for (const [provider, key] of Object.entries(envKeys)) {
        if (!key) {
          results[provider] = "NO_KEY";
          continue;
        }
        const r = await validateProviderKey(provider, { apiKey: key });
        results[provider] = r.status;
      }

      // Log for report (keys are never logged)
      console.log("\nLive connectivity report:");
      for (const [provider, status] of Object.entries(results)) {
        console.log(`  ${provider}: ${status}`);
      }

      expect(Object.keys(results).length).toBeGreaterThan(0);
    },
    10_000
  );
});
