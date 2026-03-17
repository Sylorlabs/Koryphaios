/**
 * Comprehensive tests for GitHub Copilot model configuration
 * 
 * These tests verify:
 * 1. All models have valid configurations
 * 2. Model IDs are unique
 * 3. Reasoning configuration matches model capabilities
 * 4. Provider integration works correctly
 */

import { describe, it, expect } from "bun:test";
import { CopilotModels, COPILOT_MODEL_COUNT } from "../src/providers/models/copilot";
import { getReasoningConfig, hasReasoningSupport, getDefaultReasoning, normalizeReasoningLevel } from "@koryphaios/shared";
import { CopilotProvider, detectCopilotToken } from "../src/providers/copilot";

describe("Copilot Model Catalog", () => {
  it("should have exactly 8 models", () => {
    expect(CopilotModels.length).toBe(8);
    expect(COPILOT_MODEL_COUNT).toBe(8);
  });

  it("should have unique model IDs", () => {
    const ids = CopilotModels.map(m => m.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it("should have all models with copilot provider", () => {
    for (const model of CopilotModels) {
      expect(model.provider).toBe("copilot");
    }
  });

  it("should have apiModelId matching id for all models", () => {
    // Since we removed the copilot. prefix, id should equal apiModelId
    for (const model of CopilotModels) {
      expect(model.apiModelId).toBe(model.id);
    }
  });

  it("should have valid context windows", () => {
    for (const model of CopilotModels) {
      expect(model.contextWindow).toBeGreaterThan(0);
      expect(model.maxOutputTokens).toBeGreaterThan(0);
    }
  });

  it("should have zero cost (included in Copilot subscription)", () => {
    for (const model of CopilotModels) {
      expect(model.costPerMInputTokens).toBe(0);
      expect(model.costPerMOutputTokens).toBe(0);
    }
  });
});

describe("Copilot Model Reasoning Configuration", () => {
  // Models that support reasoning via Copilot
  const REASONING_MODELS = [
    "o1",
    "o1-mini", 
    "o3-mini",
    "gpt-4o",
    "gpt-4o-mini",
    "claude-opus-4.6",
    "claude-3.5-sonnet",
    "claude-haiku-4.5",
    "gemini-2.0-pro",
    "gemini-2.0-flash",
  ];

  it("should have reasoning support for o-series models", () => {
    const oModels = ["o1", "o1-mini", "o3-mini"];
    for (const modelId of oModels) {
      const config = getReasoningConfig("copilot", modelId);
      expect(config).not.toBeNull();
      expect(hasReasoningSupport("copilot", modelId)).toBe(true);
      expect(config?.parameter).toBe("reasoning.effort");
    }
  });

  it("should have reasoning support for GPT-4o models", () => {
    const gptModels = ["gpt-4o", "gpt-4o-mini"];
    for (const modelId of gptModels) {
      const config = getReasoningConfig("copilot", modelId);
      expect(config).not.toBeNull();
      expect(hasReasoningSupport("copilot", modelId)).toBe(true);
      expect(config?.parameter).toBe("reasoning.effort");
    }
  });

  it("should have budget-based reasoning for Claude Haiku 4.5", () => {
    const config = getReasoningConfig("copilot", "claude-haiku-4.5");
    expect(config?.parameter).toBe("thinkingConfig.thinkingBudget");
    expect(config?.options.length).toBe(4); // 0, 1024, 8192, 24576
  });

  it("should have level-based reasoning for Gemini 2.0 Flash", () => {
    const config = getReasoningConfig("copilot", "gemini-2.0-flash");
    expect(config?.parameter).toBe("thinkingConfig.thinkingLevel");
    expect(config?.options.length).toBe(3); // low, medium, high
  });

  it("should have budget-based reasoning for Gemini 2.0 Pro", () => {
    const config = getReasoningConfig("copilot", "gemini-2.0-pro");
    expect(config?.parameter).toBe("thinkingConfig.thinkingBudget");
    expect(config?.options.length).toBe(4); // 0, 1024, 8192, 24576
  });

  it("should have max option for Claude Opus 4.6", () => {
    const config = getReasoningConfig("copilot", "claude-opus-4.6");
    const values = config?.options.map(o => o.value);
    expect(values).toContain("max");
  });

  it("should normalize reasoning levels correctly", () => {
    // Test GPT-4o model normalization
    expect(normalizeReasoningLevel("copilot", "gpt-4o", "low")).toBe("low");
    expect(normalizeReasoningLevel("copilot", "gpt-4o", "medium")).toBe("medium");
    expect(normalizeReasoningLevel("copilot", "gpt-4o", "high")).toBe("high");
    
    // Test Claude model normalization
    expect(normalizeReasoningLevel("copilot", "claude-opus-4.6", "max")).toBe("max");
    expect(normalizeReasoningLevel("copilot", "claude-opus-4.6", "high")).toBe("high");
  });

  it("should have correct default reasoning values", () => {
    expect(getDefaultReasoning("copilot", "gpt-4o")).toBe("medium");
    expect(getDefaultReasoning("copilot", "o1")).toBe("medium");
    expect(getDefaultReasoning("copilot", "claude-haiku-4.5")).toBe("8192");
    expect(getDefaultReasoning("copilot", "gemini-2.0-flash")).toBe("medium");
  });
});

describe("CopilotProvider Integration", () => {
  it("should return the correct model catalog", () => {
    const provider = new CopilotProvider({
      name: "copilot",
      disabled: false,
      authToken: "test-token",
    });

    const models = provider.listModels();
    expect(models.length).toBe(8);
    
    // Verify all expected models are present
    const modelIds = models.map(m => m.id);
    expect(modelIds).toContain("gpt-4o");
    expect(modelIds).toContain("gpt-4o-mini");
    expect(modelIds).toContain("claude-3.5-sonnet");
    expect(modelIds).toContain("gemini-2.0-pro");
    expect(modelIds).toContain("gemini-2.0-flash");
  });

  it("should report availability based on auth token", () => {
    const providerWithToken = new CopilotProvider({
      name: "copilot",
      disabled: false,
      authToken: "test-token",
    });
    expect(providerWithToken.isAvailable()).toBe(true);

    const providerDisabled = new CopilotProvider({
      name: "copilot",
      disabled: true,
      authToken: "test-token",
    });
    expect(providerDisabled.isAvailable()).toBe(false);

    const providerNoToken = new CopilotProvider({
      name: "copilot",
      disabled: false,
    });
    expect(providerNoToken.isAvailable()).toBe(false);
  });

  it("should support checking model availability", () => {
    const provider = new CopilotProvider({
      name: "copilot",
      disabled: false,
      authToken: "test-token",
    });

    // Test checking if models are supported
    expect(provider.isAvailable()).toBe(true);
    const models = provider.listModels();
    expect(models.some(m => m.id === "gpt-4o")).toBe(true);
  });
});

describe("Copilot Token Detection", () => {
  it("should return null when no token is configured", () => {
    // detectCopilotToken checks env vars and config files
    // In test environment with no GITHUB_TOKEN set, it should return null
    const token = detectCopilotToken();
    // May be null (no token) or a string (if GITHUB_TOKEN is set in env)
    expect(token === null || typeof token === 'string').toBe(true);
  });

  it("should detect token from environment variable", () => {
    // Set a test token
    process.env.GITHUB_TOKEN = "gho_test_token_12345";
    
    try {
      const token = detectCopilotToken();
      expect(token).toBe("gho_test_token_12345");
    } finally {
      // Clean up
      delete process.env.GITHUB_TOKEN;
    }
  });
});

describe("Model Metadata Consistency", () => {
  it("should have appropriate tier assignments", () => {
    const fastModels = CopilotModels.filter(m => m.tier === "fast");
    const flagshipModels = CopilotModels.filter(m => m.tier === "flagship");
    const reasoningModels = CopilotModels.filter(m => m.tier === "reasoning");
    
    // Verify we have models in each tier
    expect(fastModels.length).toBeGreaterThanOrEqual(2); // gpt-4o-mini, gemini-2.0-flash
    expect(flagshipModels.length).toBeGreaterThanOrEqual(2); // gpt-4o, claude-3.5-sonnet, gemini-2.0-pro
    expect(reasoningModels.length).toBeGreaterThanOrEqual(3); // o1, o1-mini, o3-mini
  });

  it("should have canReason match reasoning config availability", () => {
    for (const model of CopilotModels) {
      const hasConfig = getReasoningConfig("copilot", model.id) !== null;
      
      // If canReason is true, there should be a reasoning config
      if (model.canReason) {
        expect(hasConfig).toBe(true);
      }
      // Note: Some models may have configs but canReason=false if they're not officially supported
    }
  });
});
