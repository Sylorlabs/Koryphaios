// RoutingService Tests
import { describe, it, expect, beforeEach } from "bun:test";
import { RoutingService } from "../RoutingService";
import type { ProviderRegistry } from "../../../providers";
import type { KoryphaiosConfig } from "@koryphaios/shared";

describe("RoutingService", () => {
  let service: RoutingService;
  let mockProviders: ProviderRegistry;
  let mockConfig: KoryphaiosConfig;

  beforeEach(() => {
    mockProviders = {
      resolveProvider: async () => undefined,
      getFirstAvailableRouting: () => undefined,
    } as unknown as ProviderRegistry;

    mockConfig = {
      assignments: {},
      fallbacks: {
        "gpt-4o": ["claude-3-7-sonnet", "gpt-4o-mini"],
      },
    } as KoryphaiosConfig;

    service = new RoutingService(mockProviders, mockConfig);
  });

  describe("buildFallbackChain", () => {
    it("should build chain from config", () => {
      const chain = service.buildFallbackChain("gpt-4o");
      expect(chain).toContain("gpt-4o");
      expect(chain).toContain("claude-3-7-sonnet");
      expect(chain).toContain("gpt-4o-mini");
    });

    it("should limit chain to 25 models", () => {
      const longChain = service.buildFallbackChain("model-1");
      expect(longChain.length).toBeLessThanOrEqual(25);
    });
  });

  describe("resolveRouting", () => {
    it("should parse provider:model format", () => {
      const result = service.resolveRouting("anthropic:claude-3", "general", false);
      expect(result.provider).toBe("anthropic");
      expect(result.model).toBe("claude-3");
    });

    it("should use domain assignment from config", () => {
      mockConfig.assignments = { ui: "openai:gpt-4o" };
      const result = service.resolveRouting(undefined, "ui", false);
      expect(result.provider).toBe("openai");
      expect(result.model).toBe("gpt-4o");
    });

    it("should use default when no preference", () => {
      const result = service.resolveRouting(undefined, "general", false);
      expect(result.model).toBeDefined();
      expect(result.provider).toBeDefined();
    });
  });

  describe("classifyDomain", () => {
    it("should classify frontend keywords", () => {
      const domain = service.classifyDomain("Build a React component with CSS");
      expect(["ui", "frontend"]).toContain(domain);
    });

    it("should classify backend keywords", () => {
      const domain = service.classifyDomain("Create an API endpoint with database");
      expect(domain).toBe("backend");
    });

    it("should default to general", () => {
      const domain = service.classifyDomain("Some random request");
      expect(domain).toBe("general");
    });

    it("should classify test keywords", () => {
      const domain = service.classifyDomain("Write unit tests for this function");
      expect(domain).toBe("test");
    });
  });

  describe("requiresSystemAccess", () => {
    it("should detect install commands", () => {
      expect(service.requiresSystemAccess("Install dependencies")).toBe(true);
    });

    it("should detect sudo", () => {
      expect(service.requiresSystemAccess("Run sudo apt update")).toBe(true);
    });

    it("should return false for safe commands", () => {
      expect(service.requiresSystemAccess("Read a file")).toBe(false);
    });
  });
});
