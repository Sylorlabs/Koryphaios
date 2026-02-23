import { describe, test, expect } from "bun:test";
import { parseCriticVerdict, formatMessagesForCritic } from "../src/kory/critic-util";

describe("parseCriticVerdict", () => {
  test("returns true when last non-empty line starts with PASS", () => {
    expect(parseCriticVerdict("Some feedback.\nPASS")).toBe(true);
    expect(parseCriticVerdict("PASS")).toBe(true);
    expect(parseCriticVerdict("Review done.\n\nPASS")).toBe(true);
  });

  test("returns false when last non-empty line starts with FAIL", () => {
    expect(parseCriticVerdict("Issues found.\nFAIL")).toBe(false);
    expect(parseCriticVerdict("FAIL: missing tests")).toBe(false);
    expect(parseCriticVerdict("Review.\n\nFAIL: lint errors")).toBe(false);
  });

  test("returns false when content says does not PASS (last line is FAIL)", () => {
    expect(parseCriticVerdict("The code does not PASS our bar.\nFAIL")).toBe(false);
  });

  test("fallback to includes(PASS) when last line is neither PASS nor FAIL", () => {
    expect(parseCriticVerdict("Overall assessment: PASS.")).toBe(true);
    expect(parseCriticVerdict("No issues found.")).toBe(false);
  });

  test("handles empty or whitespace", () => {
    expect(parseCriticVerdict("")).toBe(false);
    expect(parseCriticVerdict("   \n  ")).toBe(false);
  });
});

describe("formatMessagesForCritic", () => {
  test("formats user, assistant, tool messages", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
      { role: "tool", content: "result" },
    ];
    const out = formatMessagesForCritic(messages);
    expect(out).toContain("[USER]");
    expect(out).toContain("Hello");
    expect(out).toContain("[ASSISTANT]");
    expect(out).toContain("Hi");
    expect(out).toContain("[TOOL RESULT]");
    expect(out).toContain("result");
  });

  test("truncates when over maxLength", () => {
    const long = "x".repeat(20_000);
    const messages = [{ role: "user", content: long }];
    const out = formatMessagesForCritic(messages, 500);
    expect(out.length).toBeLessThanOrEqual(520);
    expect(out).toContain("...[truncated]");
  });

  test("does not truncate when under maxLength", () => {
    const messages = [{ role: "user", content: "short" }];
    const out = formatMessagesForCritic(messages, 1000);
    expect(out).toBe("[USER]\nshort");
  });
});
