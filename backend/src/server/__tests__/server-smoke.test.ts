// Server Smoke Tests
// Domain: Basic smoke tests for original server.ts
// Note: Full integration tests require proper HTTP/WebSocket setup.
// The refactored modules (config.ts, websocket-handler.ts, shutdown-handler.ts) have comprehensive tests.

import { describe, it, expect } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

describe("Server (Original) - Smoke Tests", () => {
  it("should have server entry file", () => {
    expect(existsSync(resolve(import.meta.dir, "../../server.ts"))).toBe(true);
  });

  it("should have refactored modules available", () => {
    expect(existsSync(resolve(import.meta.dir, "../config.ts"))).toBe(true);
    expect(existsSync(resolve(import.meta.dir, "../websocket-handler.ts"))).toBe(true);
    expect(existsSync(resolve(import.meta.dir, "../shutdown-handler.ts"))).toBe(true);
  });

  it("should keep test-targeted server module files present", () => {
    const expectedFiles = ["../config.ts", "../websocket-handler.ts", "../shutdown-handler.ts"];
    for (const relPath of expectedFiles) {
      expect(existsSync(resolve(import.meta.dir, relPath))).toBe(true);
    }
  });
});

// Note: The refactored server modules have comprehensive test coverage.
// This file provides basic smoke tests for the original server.ts while it's still in production use.
// Full HTTP/WebSocket integration tests require proper test server setup with mocking of all dependencies.
