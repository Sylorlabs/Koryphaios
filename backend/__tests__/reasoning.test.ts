/**
 * Reasoning config and normalization (shared): Opus 4.6, Sonnet 4.6, Haiku 4.5.
 * Ensures correct toggles and that "max" is preserved for Anthropic Opus 4.6.
 */
import { describe, test, expect } from "bun:test";
import {
  getReasoningConfig,
  hasReasoningSupport,
  normalizeReasoningLevel,
  getDefaultReasoning,
} from "@koryphaios/shared";

describe("Reasoning config (shared)", () => {
  test("Opus 4.6 has effort options including max", () => {
    const config = getReasoningConfig("anthropic", "claude-opus-4-6");
    expect(config).not.toBeNull();
    expect(config!.parameter).toBe("thinking.effort");
    const values = config!.options.map((o) => o.value);
    expect(values).toContain("low");
    expect(values).toContain("medium");
    expect(values).toContain("high");
    expect(values).toContain("max");
    expect(config!.defaultValue).toBe("medium");
  });

  test("Sonnet 4.6 has effort options without max", () => {
    const config = getReasoningConfig("anthropic", "claude-sonnet-4-6");
    expect(config).not.toBeNull();
    expect(config!.parameter).toBe("thinking.effort");
    const values = config!.options.map((o) => o.value);
    expect(values).toContain("low");
    expect(values).toContain("medium");
    expect(values).toContain("high");
    expect(values).not.toContain("max");
    expect(config!.defaultValue).toBe("medium");
  });

  test("Haiku 4.5 has thinking budget options", () => {
    const config = getReasoningConfig("anthropic", "claude-haiku-4-5");
    expect(config).not.toBeNull();
    expect(config!.parameter).toBe("thinkingConfig.thinkingBudget");
    const values = config!.options.map((o) => o.value);
    expect(values).toContain("0");
    expect(values).toContain("1024");
    expect(values).toContain("8192");
    expect(values).toContain("24576");
    expect(config!.defaultValue).toBe("8192");
  });

  test("normalizeReasoningLevel preserves max for anthropic Opus 4.6", () => {
    expect(normalizeReasoningLevel("anthropic", "claude-opus-4-6", "max")).toBe("max");
    expect(normalizeReasoningLevel("anthropic", "claude-opus-4-6", "high")).toBe("high");
    expect(normalizeReasoningLevel("anthropic", "claude-opus-4-6", "low")).toBe("low");
  });

  test("normalizeReasoningLevel maps Haiku 4.5 budget values through for numeric", () => {
    // Frontend sends option value directly (0, 1024, 8192, 24576)
    expect(normalizeReasoningLevel("anthropic", "claude-haiku-4-5", "8192")).toBe("8192");
    expect(normalizeReasoningLevel("anthropic", "claude-haiku-4-5", "0")).toBe("0");
  });

  test("hasReasoningSupport is true for Opus 4.6, Sonnet 4.6, Haiku 4.5", () => {
    expect(hasReasoningSupport("anthropic", "claude-opus-4-6")).toBe(true);
    expect(hasReasoningSupport("anthropic", "claude-sonnet-4-6")).toBe(true);
    expect(hasReasoningSupport("anthropic", "claude-haiku-4-5")).toBe(true);
  });

  test("getDefaultReasoning returns correct defaults", () => {
    expect(getDefaultReasoning("anthropic", "claude-opus-4-6")).toBe("medium");
    expect(getDefaultReasoning("anthropic", "claude-sonnet-4-6")).toBe("medium");
    expect(getDefaultReasoning("anthropic", "claude-haiku-4-5")).toBe("8192");
  });
});
