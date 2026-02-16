import { describe, test, expect } from "bun:test";
import { ProviderRegistry } from "../src/providers/registry";
import { encryptApiKey } from "../src/security";
import type { KoryphaiosConfig } from "@koryphaios/shared";

function minimalConfig(): KoryphaiosConfig {
  return {
    providers: {},
    agents: {
      manager: { model: "claude-sonnet-4-5" },
      coder: { model: "claude-sonnet-4-5" },
      task: { model: "o4-mini" },
    },
    server: { port: 3000, host: "localhost" },
    dataDirectory: ".koryphaios-test",
  };
}

describe("ProviderRegistry auth modes", () => {
  test("copilot rejects apiKey input (auth-only)", () => {
    const registry = new ProviderRegistry(minimalConfig());
    const result = registry.setCredentials("copilot", { apiKey: "gho_123" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("auth only");
  });

  test("anthropic accepts authToken without apiKey", () => {
    const registry = new ProviderRegistry(minimalConfig());
    const result = registry.setCredentials("anthropic", { authToken: "test-token" });
    expect(result.success).toBe(true);
  });

  test("azure accepts authToken + endpoint without apiKey", () => {
    const registry = new ProviderRegistry(minimalConfig());
    const result = registry.setCredentials("azure", {
      authToken: "azure-token",
      baseUrl: "https://example.openai.azure.com",
    });
    expect(result.success).toBe(true);
  });

  test("bedrock requires environment auth", () => {
    const originalKey = process.env.AWS_ACCESS_KEY_ID;
    const originalSecret = process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    try {
      const registry = new ProviderRegistry(minimalConfig());
      const result = registry.setCredentials("bedrock", {});
      expect(result.success).toBe(false);
      expect(result.error).toContain("environment credentials");
    } finally {
      if (originalKey !== undefined) process.env.AWS_ACCESS_KEY_ID = originalKey;
      if (originalSecret !== undefined) process.env.AWS_SECRET_ACCESS_KEY = originalSecret;
    }
  });

  test("decrypts encrypted env API keys on startup", async () => {
    const original = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = encryptApiKey("sk-test-valid-looking");
    try {
      const registry = new ProviderRegistry(minimalConfig());
      const statuses = await registry.getStatus();
      const status = statuses.find((p) => p.name === "openai");
      expect(status?.enabled).toBe(true);
      expect(status?.authenticated).toBe(true);
    } finally {
      if (original === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = original;
      }
    }
  });
});
