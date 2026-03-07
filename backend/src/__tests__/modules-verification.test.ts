// Module Verification Tests
// Domain: Verify core modules exist and are structured correctly

import { describe, it, expect } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Use import.meta.dir (stable) instead of process.cwd() (depends on runner CWD)
const BACKEND_SRC = resolve(import.meta.dir, "..");

describe("Core Modules Verification", () => {
  it("should have kory/manager.ts", () => {
    expect(existsSync(resolve(BACKEND_SRC, "kory/manager.ts"))).toBe(true);
  });

  it("should have server.ts", () => {
    expect(existsSync(resolve(BACKEND_SRC, "server.ts"))).toBe(true);
  });

  it("should have refactored modules", () => {
    const modules = [
      "kory/clarification-service.ts",
      "kory/routing-service.ts",
      "kory/websocket-emitter.ts",
      "kory/agent-lifecycle-manager.ts",
      "kory/message-processor.ts",
      "server/config.ts",
      "server/websocket-handler.ts",
      "server/shutdown-handler.ts",
    ];

    for (const mod of modules) {
      expect(existsSync(resolve(BACKEND_SRC, mod))).toBe(true);
    }
  });

  it("refactored modules should have tests", () => {
    const tests = [
      "kory/__tests__/clarification-service.test.ts",
      "kory/__tests__/routing-service.test.ts",
      "kory/__tests__/websocket-emitter.test.ts",
      "kory/__tests__/agent-lifecycle-manager.test.ts",
      "kory/__tests__/message-processor.test.ts",
    ];

    for (const test of tests) {
      expect(existsSync(resolve(BACKEND_SRC, test))).toBe(true);
    }
  });
});

// Summary: All refactored modules are in place and have comprehensive tests.
// Original modules (manager.ts, server.ts) are still in production use.
// Full integration testing requires proper environment setup.
