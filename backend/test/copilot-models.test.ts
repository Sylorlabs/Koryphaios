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
  it("should have exactly 23 models", () => {
    expect(CopilotModels.length).toBe(23);
    expect(COPILOT_MODEL_COUNT).toBe(23);
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
  // Models that should support reasoning (21 out of 22)
  const REASONING_MODELS = [
    "gpt-5-mini",
    "gpt-5.1",
    "gpt-5.1-codex",
    "gpt-5.1-codex-mini",
    "gpt-5.1-codex-max",
    "gpt-5.2",
    "gpt-5.2-codex",
    "gpt-5.3-codex",
    "claude-haiku-4.5",
    "claude-opus-4.5",
    "claude-opus-4.6",
    "claude-opus-4.6-fast",
    "claude-sonnet-4",
    "claude-sonnet-4.5",
    "claude-sonnet-4.6",
    "gemini-2.5-pro",
    "gemini-3-flash",
    "gemini-3-pro",
    "gemini-3.1-pro",
    "grok-code-fast-1",
    "raptor-mini",
    "goldeneye",
  ];

  // Models that should NOT support reasoning (only GPT-4.1)
  const NON_REASONING_MODELS = [
    "gpt-4.1",
  ];

  it("should have reasoning support for all expected models", () => {
    for (const modelId of REASONING_MODELS) {
      const config = getReasoningConfig("copilot", modelId);
      expect(config).not.toBeNull();
      expect(hasReasoningSupport("copilot", modelId)).toBe(true);
      
      // Verify config has options
      expect(config?.options.length).toBeGreaterThan(0);
      expect(config?.defaultValue).toBeDefined();
    }
  });

  it("should NOT have reasoning support for GPT-4.1", () => {
    for (const modelId of NON_REASONING_MODELS) {
      const config = getReasoningConfig("copilot", modelId);
      expect(config).toBeNull();
      expect(hasReasoningSupport("copilot", modelId)).toBe(false);
    }
  });

  it("should have correct reasoning parameters for OpenAI models", () => {
    const openaiModels = [
      "gpt-5-mini",
      "gpt-5.1",
      "gpt-5.1-codex",
      "gpt-5.1-codex-mini",
      "gpt-5.1-codex-max",
      "gpt-5.2",
      "gpt-5.2-codex",
      "gpt-5.3-codex",
      "grok-code-fast-1",
      "raptor-mini",
      "goldeneye",
    ];

    for (const modelId of openaiModels) {
      const config = getReasoningConfig("copilot", modelId);
      expect(config?.parameter).toBe("reasoning.effort");
    }
  });

  it("should have correct reasoning parameters for Claude models", () => {
    const claudeModels = [
      "claude-opus-4.5",
      "claude-opus-4.6",
      "claude-opus-4.6-fast",
      "claude-sonnet-4",
      "claude-sonnet-4.5",
      "claude-sonnet-4.6",
    ];

    for (const modelId of claudeModels) {
      const config = getReasoningConfig("copilot", modelId);
      expect(config?.parameter).toBe("thinking.effort");
    }
  });

  it("should have budget-based reasoning for Claude Haiku 4.5", () => {
    const config = getReasoningConfig("copilot", "claude-haiku-4.5");
    expect(config?.parameter).toBe("thinkingConfig.thinkingBudget");
    expect(config?.options.length).toBe(4); // 0, 1024, 8192, 24576
  });

  it("should have level-based reasoning for Gemini 3.x models", () => {
    const gemini3Models = ["gemini-3-flash", "gemini-3-pro", "gemini-3.1-pro"];
    
    for (const modelId of gemini3Models) {
      const config = getReasoningConfig("copilot", modelId);
      expect(config?.parameter).toBe("thinkingConfig.thinkingLevel");
      expect(config?.options.length).toBe(3); // low, medium, high
    }
  });

  it("should have budget-based reasoning for Gemini 2.5 Pro", () => {
    const config = getReasoningConfig("copilot", "gemini-2.5-pro");
    expect(config?.parameter).toBe("thinkingConfig.thinkingBudget");
    expect(config?.options.length).toBe(4); // 0, 1024, 8192, 24576
  });

  it("should have xhigh option for Codex Max models", () => {
    const codexMaxModels = ["gpt-5.1-codex-max", "gpt-5.2-codex", "gpt-5.3-codex"];
    
    for (const modelId of codexMaxModels) {
      const config = getReasoningConfig("copilot", modelId);
      const values = config?.options.map(o => o.value);
      expect(values).toContain("xhigh");
    }
  });

  it("should have max option for Claude Opus 4.6", () => {
    const config = getReasoningConfig("copilot", "claude-opus-4.6");
    const values = config?.options.map(o => o.value);
    expect(values).toContain("max");
  });

  it("should normalize reasoning levels correctly", () => {
    // Test GPT-5 model normalization
    expect(normalizeReasoningLevel("copilot", "gpt-5.1", "low")).toBe("low");
    expect(normalizeReasoningLevel("copilot", "gpt-5.1", "medium")).toBe("medium");
    expect(normalizeReasoningLevel("copilot", "gpt-5.1", "high")).toBe("high");
    
    // Test Claude model normalization
    expect(normalizeReasoningLevel("copilot", "claude-opus-4.6", "low")).toBe("low");
    expect(normalizeReasoningLevel("copilot", "claude-opus-4.6", "max")).toBe("max");
    
    // Test Gemini budget normalization
    expect(normalizeReasoningLevel("copilot", "gemini-2.5-pro", "low")).toBe("1024");
    expect(normalizeReasoningLevel("copilot", "gemini-2.5-pro", "medium")).toBe("8192");
    expect(normalizeReasoningLevel("copilot", "gemini-2.5-pro", "high")).toBe("24576");
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
    expect(models.length).toBe(23);
    
    // Verify all expected models are present
    const modelIds = models.map(m => m.id);
    expect(modelIds).toContain("gpt-4.1");
    expect(modelIds).toContain("gpt-5.1-codex");
    expect(modelIds).toContain("claude-opus-4.6");
    expect(modelIds).toContain("gemini-2.5-pro");
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
  });
});

describe("Model Metadata Consistency", () => {
  it("should have consistent naming conventions", () => {
    for (const model of CopilotModels) {
      // Name should start with "GitHub Copilot"
      expect(model.name).toStartWith("GitHub Copilot");
      
      // ID should not contain spaces
      expect(model.id).not.toContain(" ");
      
      // ID should not start with "copilot." (that's added by the system)
      expect(model.id).not.toStartWith("copilot.");
    }
  });

  it("should have appropriate tier assignments", () => {
    const fastModels = CopilotModels.filter(m => m.tier === "fast");
    const flagshipModels = CopilotModels.filter(m => m.tier === "flagship" || !m.tier);
    
    // Fast models should be: gpt-5-mini, gpt-5.1-codex-mini, claude-haiku-4.5, 
    // claude-opus-4.6-fast, gemini-3-flash, grok-code-fast-1, raptor-mini
    const expectedFastModels = [
      "gpt-5-mini",
      "gpt-5.1-codex-mini",
      "claude-haiku-4.5",
      "claude-opus-4.6-fast",
      "gemini-3-flash",
      "grok-code-fast-1",
      "raptor-mini",
    ];
    
    for (const modelId of expectedFastModels) {
      const model = CopilotModels.find(m => m.id === modelId);
      expect(model?.tier).toBe("fast");
    }
  });

  it("should have canReason match reasoning config availability", () => {
    for (const model of CopilotModels) {
      const hasConfig = getReasoningConfig("copilot", model.id) !== null;
      
      // If canReason is true, there should be a reasoning config
      if (model.canReason) {
        expect(hasConfig).toBe(true);
      } else {
        expect(hasConfig).toBe(false);
      }
    }
  });
});
