/**
 * Claude subscription auth: token format and subscription detection.
 * Uses the same AUTH constant as server and registry so format is single source of truth.
 */
import { describe, test, expect } from "bun:test";
import { AUTH } from "../src/constants";

describe("Claude subscription auth", () => {
  test("accepts valid OAuth token format from claude setup-token", () => {
    expect(AUTH.CLAUDE_OAUTH_TOKEN_REGEX.test("sk-ant-oat01-abc123")).toBe(true);
    expect(AUTH.CLAUDE_OAUTH_TOKEN_REGEX.test("sk-ant-oat02-xyz")).toBe(true);
    expect(AUTH.CLAUDE_OAUTH_TOKEN_REGEX.test("sk-ant-oat99-")).toBe(true);
  });

  test("rejects CLI marker and API key format", () => {
    expect(AUTH.CLAUDE_OAUTH_TOKEN_REGEX.test("cli:claude")).toBe(false);
    expect(AUTH.CLAUDE_OAUTH_TOKEN_REGEX.test("sk-ant-api03-")).toBe(false);
    expect(AUTH.CLAUDE_OAUTH_TOKEN_REGEX.test("")).toBe(false);
  });
});
