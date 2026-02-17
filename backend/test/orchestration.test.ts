import { describe, expect, test, mock, beforeEach } from "bun:test";
import { KoryManager } from "../src/kory/manager";
import { ProviderRegistry } from "../src/providers";
import { ToolRegistry } from "../src/tools";
import type { Session, AgentIdentity, WSMessage } from "@koryphaios/shared";
import { DOMAIN } from "../src/constants";

// Mock dependencies
const mockProviderRegistry = {
  resolveProvider: mock(),
  getAvailable: mock(() => []),
  isQuotaError: mock(() => false),
  get: mock(),
} as unknown as ProviderRegistry;

const mockToolRegistry = {
  getToolDefs: mock(() => []),
  execute: mock(),
} as unknown as ToolRegistry;

const mockConfig = {
  agents: {
    manager: { model: "mock-model" },
  },
  assignments: {},
  fallbacks: {},
};

// Mock WebSocket broker
mock.module("../src/pubsub", () => ({
  wsBroker: {
    publish: mock(),
  },
}));

describe("KoryManager Orchestration", () => {
  let manager: KoryManager;

  beforeEach(() => {
    manager = new KoryManager(
      mockProviderRegistry,
      mockToolRegistry,
      "/tmp",
      mockConfig as any,
      { getRecent: () => [] } as any, // Mock sessions/messages
      { add: () => {} } as any
    );
  });

  test("should resolve correct routing for domain", () => {
    // Default
    const frontendRouting = manager["resolveActiveRouting"](undefined, "frontend");
    expect(frontendRouting.model).toBe(DOMAIN.DEFAULT_MODELS.frontend);

    // Override via config
    manager["config"].assignments = { frontend: "openai:gpt-4o" };
    const overridden = manager["resolveActiveRouting"](undefined, "frontend");
    expect(overridden.model).toBe("gpt-4o");
    expect(overridden.provider).toBe("openai");
  });

  // Note: Testing full async routing loop requires extensive mocking of streams
  // which is complex in this unit test setup. Ideally, we would integration test
  // with a local mock provider.
});
