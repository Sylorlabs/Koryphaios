// Kory Manager Smoke Tests
// Domain: Basic smoke tests for original manager.ts
// Note: Full integration tests require proper database setup.
// The refactored modules have comprehensive test coverage.

import { describe, it, expect } from "bun:test";
import { KoryManager } from "../manager";
import type { ProviderRegistry, ToolRegistry } from "../../providers";
import type { KoryphaiosConfig, ProviderName } from "@koryphaios/shared";

describe("KoryManager (Original) - Smoke Tests", () => {
  it("should have KoryManager class", () => {
    expect(KoryManager).toBeDefined();
    expect(typeof KoryManager === "function").toBe(true);
  });

  it("should have expected public methods", () => {
    // Create instance to check methods
    const providers = {} as ProviderRegistry;
    const tools = {} as ToolRegistry;
    const config = {} as KoryphaiosConfig;

    // Note: Constructor will fail without proper setup
    // We're just verifying the class structure exists
    expect(KoryManager.prototype).toBeDefined();
    expect(typeof KoryManager.prototype.setYoloMode).toBe("function");
    expect(typeof KoryManager.prototype.handleUserInput).toBe("function");
    expect(typeof KoryManager.prototype.handleSessionResponse).toBe("function");
    expect(typeof KoryManager.prototype.cancelWorker).toBe("function");
    expect(typeof KoryManager.prototype.cancelSessionWorkers).toBe("function");
    expect(typeof KoryManager.prototype.isSessionRunning).toBe("function");
    expect(typeof KoryManager.prototype.getStatus).toBe("function");
    expect(typeof KoryManager.prototype.cancel).toBe("function");
  });

  it("should export KoryManager class", () => {
    // Verify it's exported from manager.ts
    const managerModule = require("../manager");
    expect(managerModule.KoryManager).toBeDefined();
  });
});

describe("KoryManager - Method Signatures", () => {
  it("should have correct constructor signature", () => {
    // Constructor takes: providers, tools, workingDirectory, config, sessions?, messages?
    expect(KoryManager.length).toBe(6); // 6 parameters including this
  });

  it("setYoloMode should accept boolean", () => {
    const descriptor = Object.getOwnPropertyDescriptor(KoryManager.prototype, "setYoloMode");
    expect(descriptor?.value?.length).toBe(1); // Takes enabled: boolean
  });

  it("handleUserInput should accept sessionId, selection, and optional text", () => {
    const descriptor = Object.getOwnPropertyDescriptor(KoryManager.prototype, "handleUserInput");
    expect(descriptor?.value?.length).toBe(3); // sessionId, selection, text?
  });

  it("processTask should accept sessionId, message, and optional parameters", () => {
    const descriptor = Object.getOwnPropertyDescriptor(KoryManager.prototype, "processTask");
    expect(descriptor?.value?.length).toBe(4); // sessionId, userMessage, preferredModel?, reasoningLevel?
  });
});

// Note: The refactored modules (clarification-service, routing-service, etc.)
// have comprehensive test coverage. This file provides basic smoke tests
// for the original manager.ts while it's still in production use.
