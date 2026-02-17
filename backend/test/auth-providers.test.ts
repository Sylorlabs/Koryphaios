import { describe, test, expect, beforeEach } from "bun:test";
import { GoogleAuthManager } from "../src/providers/google-auth";
import { CLIAuthManager } from "../src/providers/cli-auth";

describe("GoogleAuthManager", () => {
  let googleAuthManager: GoogleAuthManager;

  beforeEach(() => {
    googleAuthManager = new GoogleAuthManager();
  });

  describe("startAntigravityAuth", () => {
    test("returns valid OAuth URL with correct parameters", async () => {
      const result = await googleAuthManager.startAntigravityAuth();

      expect(result.success).toBe(true);
      expect(result.url).toBeDefined();
      expect(result.url).toContain("accounts.google.com");
      expect(result.url).toContain("client_id");
      expect(result.url).toContain("response_type=code");
      expect(result.url).toContain("redirect_uri");
      expect(result.url).toContain("access_type=offline");
      expect(result.url).toContain("prompt=consent");
    });

    test("includes required scopes in URL", async () => {
      const result = await googleAuthManager.startAntigravityAuth();

      expect(result.url).toContain("scope=");
    });
  });

  describe("refreshAntigravityToken", () => {
    test("throws error for invalid refresh token", async () => {
      await expect(
        googleAuthManager.refreshAntigravityToken("invalid-token")
      ).rejects.toThrow();
    });
  });
});

describe("CLIAuthManager", () => {
  let cliAuthManager: CLIAuthManager;

  beforeEach(() => {
    cliAuthManager = new CLIAuthManager();
  });

  describe("runAuthCommand", () => {
    test("returns success when command succeeds", async () => {
      const result = await cliAuthManager.runAuthCommand(
        ["echo", "hello"],
        null,
        "Test success"
      );

      expect(result.success).toBe(true);
      expect(result.message).toBe("Test success");
    });

    test("extracts URL from output when urlRegex provided", async () => {
      const result = await cliAuthManager.runAuthCommand(
        ["echo", "Visit https://example.com/auth to login"],
        /https:\/\/[^\s]+/,
        "Auth URL"
      );

      expect(result.success).toBe(true);
      expect(result.url).toBe("https://example.com/auth");
    });

    test("returns failure when command fails", async () => {
      const result = await cliAuthManager.runAuthCommand(
        ["false"],
        null,
        "Test failure"
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain("exited with code");
    });
  });
});

describe("Auth Token Detection", () => {
  test("getConfigDir respects XDG_CONFIG_HOME", () => {
    const original = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = "/custom/config";

    const { getConfigDir } = require("../src/providers/auth-utils");
    expect(getConfigDir()).toBe("/custom/config");

    if (original) {
      process.env.XDG_CONFIG_HOME = original;
    } else {
      delete process.env.XDG_CONFIG_HOME;
    }
  });

  test("detectClaudeCodeToken returns string or null", () => {
    const { detectClaudeCodeToken } = require("../src/providers/auth-utils");
    const result = detectClaudeCodeToken();

    expect(result === null || typeof result === "string").toBe(true);
  });

  test("detectCodexToken returns string or null", () => {
    const { detectCodexToken } = require("../src/providers/auth-utils");
    const result = detectCodexToken();

    expect(result === null || typeof result === "string").toBe(true);
  });

  test("detectGeminiCLIToken returns string or null", () => {
    const { detectGeminiCLIToken } = require("../src/providers/auth-utils");
    const result = detectGeminiCLIToken();

    expect(result === null || typeof result === "string").toBe(true);
  });

  test("detectCopilotToken returns string or null", () => {
    const { detectCopilotToken } = require("../src/providers/auth-utils");
    const result = detectCopilotToken();

    expect(result === null || typeof result === "string").toBe(true);
  });

  test("detectAntigravityToken returns string or null", () => {
    const { detectAntigravityToken } = require("../src/providers/auth-utils");
    const result = detectAntigravityToken();

    expect(result === null || typeof result === "string").toBe(true);
  });
});
