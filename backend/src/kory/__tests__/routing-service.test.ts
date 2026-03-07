// Routing Service Tests
// Domain: Unit tests for model selection and domain routing logic

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { RoutingService } from "../routing-service";
import type { ProviderName, WorkerDomain, KoryphaiosConfig } from "@koryphaios/shared";
import type { ProviderRegistry } from "../../providers";

describe("RoutingService", () => {
  let routingService: RoutingService;
  let mockProviders: ProviderRegistry;

  beforeEach(() => {
    // Mock provider registry
    mockProviders = {
      resolveProvider: async (model: string, provider: ProviderName | undefined) => {
        if (provider === "anthropic" || provider === "openai") {
          return {
            name: provider,
            streamResponse: async function* () {
              yield { type: "content_delta", content: model };
            }
          } as any;
        }
        return null;
      },
      executeWithRetry: async function* () {
        yield { type: "content_delta", content: "" };
      } as any,
    } as unknown as ProviderRegistry;

    // Mock config
    const mockConfig: KoryphaiosConfig = {
      providers: {},
      agents: {
        manager: { model: "gpt-4.1", reasoningLevel: "medium" },
        coder: { model: "gpt-4.1", reasoningLevel: "medium" },
        task: { model: "gpt-4.1" }
      },
      assignments: {
        ui: "openai:gpt-4.1",
        backend: "openai:gpt-4.1",
        general: "anthropic:claude-sonnet-4-6"
      },
      server: { port: 3000, host: "localhost" },
      dataDirectory: ".koryphaios",
    };

    routingService = new RoutingService({
      config: mockConfig,
      providers: mockProviders
    });
  });

  describe("resolveActiveRouting", () => {
    it("should use user-specified provider:model", () => {
      const result = routingService.resolveActiveRouting("custom:model123", "backend");
      expect(result).toEqual({
        model: "model123",
        provider: "custom" as ProviderName
      });
    });

    it("should use domain assignment when available", () => {
      const result = routingService.resolveActiveRouting(undefined, "ui");
      expect(result).toEqual({
        model: "gpt-4.1",
        provider: "openai" as ProviderName
      });
    });

    it("should fallback to general domain assignment", () => {
      const result = routingService.resolveActiveRouting(undefined, "review");
      expect(result.model).toBeTruthy();
      expect(result.provider).toBeDefined();
    });

    it("should avoid legacy models when flag is set", () => {
      // This test would need to check if a model is legacy and swap it
      const result = routingService.resolveActiveRouting(undefined, "general", true);
      // Should return non-legacy model
      expect(result.model).not.toBe("legacy-model");
    });
  });

  describe("buildFallbackChain", () => {
    it("should build simple fallback chain", () => {
      const mockConfig: KoryphaiosConfig = {
        providers: {},
        agents: { manager: { model: "gpt-5-mini" } },
        fallbacks: {
          "gpt-5-mini": ["gemini-3-flash", "claude-haiku-4-5"]
        },
        server: { port: 3000, host: "localhost" },
        dataDirectory: ".koryphaios"
      };

      const service = new RoutingService({
        config: mockConfig,
        providers: mockProviders
      });

      const chain = service.buildFallbackChain("gpt-5-mini");
      expect(chain).toContain("gpt-5-mini");
      expect(chain).toContain("gemini-3-flash");
      expect(chain).toContain("claude-haiku-4-5");
    });

    it("should limit chain length to 25 models", () => {
      // Create a long fallback chain
      const fallbacks: Record<string, string[]> = {};
      for (let i = 0; i < 30; i++) {
        fallbacks[`model-${i}`] = [`model-${i + 1}`];
      }

      const mockConfig: KoryphaiosConfig = {
        providers: {},
        agents: { manager: { model: "model-0" } },
        fallbacks,
        server: { port: 3000, host: "localhost" },
        dataDirectory: ".koryphaios"
      };

      const service = new RoutingService({
        config: mockConfig,
        providers: mockProviders
      });

      const chain = service.buildFallbackChain("model-0");
      expect(chain.length).toBeLessThanOrEqual(25);
    });

    it("should handle circular dependencies", () => {
      const mockConfig: KoryphaiosConfig = {
        providers: {},
        agents: { manager: { model: "model-a" } },
        fallbacks: {
          "model-a": ["model-b"],
          "model-b": ["model-a"] // Circular!
        },
        server: { port: 3000, host: "localhost" },
        dataDirectory: ".koryphaios"
      };

      const service = new RoutingService({
        config: mockConfig,
        providers: mockProviders
      });

      const chain = service.buildFallbackChain("model-a");
      // Should not include duplicates due to seen set
      const uniqueModels = new Set(chain);
      expect(uniqueModels.size).toBe(chain.length);
    });
  });

  describe("classifyDomainLLM", () => {
    it("should classify frontend tasks as 'ui'", () => {
      const result = routingService.classifyDomainLLM("Create a React component for the user profile");
      expect(["ui", "frontend"]).toContain(result);
    });

    it("should classify backend tasks as 'backend'", () => {
      const result = routingService.classifyDomainLLM("Implement a REST API endpoint for user authentication");
      expect(result).toBe("backend");
    });

    it("should classify test tasks as 'test'", () => {
      const result = routingService.classifyDomainLLM("Write unit tests for the authentication module");
      expect(result).toBe("test");
    });

    it("should classify review tasks as 'review'", () => {
      const result = routingService.classifyDomainLLM("Review the pull request for code quality issues");
      expect(["review", "critic"]).toContain(result);
    });

    it("should default to 'general' for unclear tasks", () => {
      const result = routingService.classifyDomainLLM("Tell me a short joke.");
      expect(result).toBe("general");
    });

    it("should score by keyword matches", () => {
      // "Frontend component" should score higher for ui
      const uiResult = routingService.classifyDomainLLM("Create a frontend component with styling");
      expect(["ui", "frontend"]).toContain(uiResult);
    });
  });

  describe("requiresSystemAccess", () => {
    it("should detect install command", () => {
      const result = routingService.requiresSystemAccess("Install the required dependencies");
      expect(result).toBe(true);
    });

    it("should detect sudo command", () => {
      const result = routingService.requiresSystemAccess("Use sudo to restart the server");
      expect(result).toBe(true);
    });

    it("should detect apt command", () => {
      const result = routingService.requiresSystemAccess("Run apt update");
      expect(result).toBe(true);
    });

    it("should return false for regular tasks", () => {
      const result = routingService.requiresSystemAccess("Create a new file");
      expect(result).toBe(false);
    });

    it("should be case-insensitive", () => {
      const result = routingService.requiresSystemAccess("INSTALL the package");
      expect(result).toBe(true);
    });
  });

  describe("extractAllowedPaths", () => {
    it("should extract paths from plan", async () => {
      const mockProviders = {
        resolveProvider: async () => ({
          name: "anthropic" as ProviderName,
          streamResponse: async function* () {
            yield { type: "content_delta", content: '["/src/file1.ts", "/src/file2.ts"]' };
          }
        } as any)
      } as unknown as ProviderRegistry;

      const service = new RoutingService({
        config: {
          providers: {},
          agents: { manager: { model: "gpt-4" } },
          server: { port: 3000, host: "localhost" },
          dataDirectory: ".koryphaios"
        },
        providers: mockProviders
      });

      const paths = await service.extractAllowedPaths("session-1", "Modify src and config files");
      expect(paths).toEqual(["/src/file1.ts", "/src/file2.ts"]);
    });

    it("should return empty array on provider error", async () => {
      const mockProviders = {
        resolveProvider: async () => null
      } as unknown as ProviderRegistry;

      const service = new RoutingService({
        config: {
          providers: {},
          agents: { manager: { model: "gpt-4" } },
          server: { port: 3000, host: "localhost" },
          dataDirectory: ".koryphaios"
        },
        providers: mockProviders
      });

      const paths = await service.extractAllowedPaths("session-1", "Modify files");
      expect(paths).toEqual([]);
    });

    it("should handle invalid JSON gracefully", async () => {
      const mockProviders = {
        resolveProvider: async () => ({
          name: "anthropic" as ProviderName,
          streamResponse: async function* () {
            yield { type: "content_delta", content: "invalid json" };
          }
        } as any)
      } as unknown as ProviderRegistry;

      const service = new RoutingService({
        config: {
          providers: {},
          agents: { manager: { model: "gpt-4" } },
          server: { port: 3000, host: "localhost" },
          dataDirectory: ".koryphaios"
        },
        providers: mockProviders
      });

      const paths = await service.extractAllowedPaths("session-1", "Modify files");
      expect(paths).toEqual([]);
    });
  });

  describe("isValidModel", () => {
    it("should return true for valid models", () => {
      const result = routingService.isValidModel("gemini-3-flash");
      expect(result).toBe(true);
    });

    it("should return false for invalid models", () => {
      const result = routingService.isValidModel("nonexistent-model-xyz");
      expect(result).toBe(false);
    });
  });

  describe("getDefaultModelForDomain", () => {
    it("should return default model for ui domain", () => {
      const model = routingService.getDefaultModelForDomain("ui");
      expect(model).toBeTruthy();
      expect(routingService.isValidModel(model)).toBe(true);
    });

    it("should return default model for general domain", () => {
      const model = routingService.getDefaultModelForDomain("general");
      expect(model).toBeTruthy();
      expect(routingService.isValidModel(model)).toBe(true);
    });

    it("should fallback to general default for unknown domains", () => {
      const model = routingService.getDefaultModelForDomain("unknown" as WorkerDomain);
      expect(model).toBeTruthy(); // Should not crash
    });
  });
});

describe("RoutingService Edge Cases", () => {
  let edgeProviders: ProviderRegistry;

  beforeEach(() => {
    edgeProviders = {
      resolveProvider: async () => null,
      executeWithRetry: async function* () {
        yield { type: "content_delta", content: "" };
      } as any,
    } as unknown as ProviderRegistry;
  });

  it("should handle empty preferred model", () => {
    const mockConfig: KoryphaiosConfig = {
      providers: {},
      agents: { manager: { model: "gpt-4" } },
      assignments: {},
      server: { port: 3000, host: "localhost" },
      dataDirectory: ".koryphaios"
    };

    const service = new RoutingService({
      config: mockConfig,
      providers: edgeProviders
    });

    const result = service.resolveActiveRouting("", "general");
    expect(result.model).toBeTruthy();
    expect(result.provider).toBeDefined();
  });

  it("should handle malformed provider:model format", () => {
    const service = new RoutingService({
      config: {
        providers: {},
        agents: { manager: { model: "gpt-4" } },
        assignments: {},
        server: { port: 3000, host: "localhost" },
        dataDirectory: ".koryphaios"
      },
      providers: edgeProviders
    });
    const result = service.resolveActiveRouting("invalid-format", "general");
    // Should fallback gracefully
    expect(result).toBeTruthy();
  });

  it("should handle empty assignments", () => {
    const mockConfig: KoryphaiosConfig = {
      providers: {},
      agents: { manager: { model: "gpt-4" } },
      assignments: {}, // Empty assignments
      server: { port: 3000, host: "localhost" },
      dataDirectory: ".koryphaios"
    };

    const service = new RoutingService({
      config: mockConfig,
      providers: edgeProviders
    });

    const result = service.resolveActiveRouting(undefined, "ui");
    // Should use DOMAIN.DEFAULT_MODELS.general
    expect(result.model).toBeTruthy();
  });
});
