import { describe, expect, test, mock, beforeEach } from "bun:test";
import { KoryManager } from "../src/kory/manager";
import { ProviderRegistry } from "../src/providers";
import { ToolRegistry } from "../src/tools";
import { AskUserTool, AskManagerTool, DelegateToWorkerTool } from "../src/tools/interaction";
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
    // Default: domain "general" uses DEFAULT_MODELS.general
    const generalRouting = manager["resolveActiveRouting"](undefined, "general");
    expect(generalRouting.model).toBe(DOMAIN.DEFAULT_MODELS.general);

    // Override via config
    manager["config"].assignments = { general: "openai:gpt-4o" };
    const overridden = manager["resolveActiveRouting"](undefined, "general");
    expect(overridden.model).toBe("gpt-4o");
    expect(overridden.provider).toBe("openai");
  });

  test("manager role includes delegate_to_worker as sole way to spawn workers", () => {
    const registry = new ToolRegistry();
    registry.register(new AskUserTool());
    registry.register(new AskManagerTool());
    registry.register(new DelegateToWorkerTool());
    const managerDefs = registry.getToolDefsForRole("manager");
    const names = managerDefs.map((d) => d.name);
    expect(names).toContain("delegate_to_worker");
    expect(names).toContain("ask_user");
    expect(managerDefs.some((d) => d.name === "delegate_to_worker")).toBe(true);
  });
});
