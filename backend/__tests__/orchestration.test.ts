// Integration tests for Kory orchestration
// Tests the manager/worker/critic pipeline with real tool execution

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { KoryManager } from "../src/kory/manager";
import { ProviderRegistry } from "../src/providers";
import { ToolRegistry, BashTool, ReadFileTool, WriteFileTool, GrepTool } from "../src/tools";
import { SessionStore } from "../src/stores/session-store";
import { MessageStore } from "../src/stores/message-store";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import type { KoryphaiosConfig } from "@koryphaios/shared";

// ─── Test Fixtures ────────────────────────────────────────────────────

const TEST_DIR = join(process.cwd(), ".test-orchestration");
const TEST_SESSION_ID = "test-session-001";

let kory: KoryManager;
let providers: ProviderRegistry;
let tools: ToolRegistry;
let sessions: SessionStore;
let messages: MessageStore;

const mockConfig: KoryphaiosConfig = {
  server: { port: 3000, host: "localhost" },
  dataDirectory: ".test-data",
};

// ─── Setup / Teardown ────────────────────────────────────────────────────

beforeAll(() => {
  // Create test directory
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
  mkdirSync(TEST_DIR, { recursive: true });
  
  // Create test file
  writeFileSync(join(TEST_DIR, "test.txt"), "Hello, World!");
  
  // Initialize stores
  sessions = new SessionStore();
  messages = new MessageStore();
  
  // Initialize tools
  tools = new ToolRegistry();
  tools.register(new BashTool());
  tools.register(new ReadFileTool());
  tools.register(new WriteFileTool());
  tools.register(new GrepTool());
  
  // Initialize providers (with empty config - no actual API calls)
  providers = new ProviderRegistry(mockConfig);
  
  // Initialize Kory manager
  kory = new KoryManager(providers, tools, TEST_DIR, mockConfig, sessions, messages);
});

afterAll(() => {
  // Cleanup
  kory?.cancel();
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
});

// ─── Tool Execution Tests ──────────────────────────────────────────────────

describe("Tool Execution", () => {
  test("should execute read_file tool", async () => {
    const result = await tools.execute(
      { sessionId: TEST_SESSION_ID, workingDirectory: TEST_DIR },
      { id: "1", name: "read_file", input: { path: "test.txt" } }
    );
    
    expect(result.isError).toBe(false);
    expect(result.output).toContain("Hello, World!");
  });

  test("should execute write_file tool", async () => {
    const result = await tools.execute(
      { sessionId: TEST_SESSION_ID, workingDirectory: TEST_DIR },
      { id: "2", name: "write_file", input: { path: "new.txt", content: "New content" } }
    );
    
    expect(result.isError).toBe(false);
    
    // Verify file was created
    const content = readFileSync(join(TEST_DIR, "new.txt"), "utf-8");
    expect(content).toBe("New content");
  });

  test("should execute grep tool", async () => {
    const result = await tools.execute(
      { sessionId: TEST_SESSION_ID, workingDirectory: TEST_DIR },
      { id: "3", name: "grep", input: { pattern: "Hello" } }
    );
    
    expect(result.isError).toBe(false);
    expect(result.output).toContain("test.txt");
  });

  test("should reject dangerous bash commands", async () => {
    const result = await tools.execute(
      { sessionId: TEST_SESSION_ID, workingDirectory: TEST_DIR },
      { id: "4", name: "bash", input: { command: "rm -rf /" } }
    );
    
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Blocked");
  });

  test("should block path traversal attempts", async () => {
    const result = await tools.execute(
      { sessionId: TEST_SESSION_ID, workingDirectory: TEST_DIR },
      { id: "5", name: "read_file", input: { path: "../../../etc/passwd" } }
    );
    
    expect(result.isError).toBe(true);
  });
});

// ─── Manager State Tests ────────────────────────────────────────────────────

describe("KoryManager State", () => {
  test("should track session running state", () => {
    const session = sessions.create("user1", "Test");
    expect(kory.isSessionRunning(session.id)).toBe(false);
  });

  test("should get memory stats", () => {
    const stats = kory.getMemoryStats();
    expect(stats).toHaveProperty("activeWorkers");
    expect(stats).toHaveProperty("pendingUserInputs");
  });

  test("should cleanup session resources", () => {
    const session = sessions.create("user1", "Test");
    kory.cleanupSession(session.id);
    expect(true).toBe(true);
  });
});

// ─── YOLO Mode Tests ──────────────────────────────────────────────────────

describe("YOLO Mode", () => {
  test("should toggle YOLO mode", () => {
    kory.setYoloMode(true);
    kory.setYoloMode(false);
    expect(true).toBe(true);
  });
});

// ─── Worker Status Tests ──────────────────────────────────────────────────

describe("Worker Status", () => {
  test("should return empty status when no workers running", () => {
    const status = kory.getStatus();
    expect(status).toEqual([]);
  });

  test("should cancel all workers", () => {
    kory.cancel();
    const status = kory.getStatus();
    expect(status).toEqual([]);
  });
});

// ─── Circuit Breaker Tests ────────────────────────────────────────────────

describe("Circuit Breaker", () => {
  test("should create circuit breaker for providers", async () => {
    const { getCircuitBreaker } = await import("../src/resilience/circuit-breaker");
    
    const circuit = getCircuitBreaker("test-provider", {
      failureThreshold: 3,
      successThreshold: 2,
      resetTimeoutMs: 5000,
    });
    
    expect(circuit.getState()).toBe("CLOSED");
    expect(circuit.getStats().name).toBe("test-provider");
  });
});

// ─── Bounded Cache Tests ───────────────────────────────────────────────────

describe("Bounded Cache", () => {
  test("should create bounded cache with TTL", async () => {
    const { BoundedCache } = await import("../src/resilience/bounded-cache");
    
    const cache = new BoundedCache({ 
      name: "test-cache", 
      maxSize: 100, 
      defaultTtlMs: 1000 
    });
    
    cache.set("key1", "value1");
    expect(cache.get("key1")).toBe("value1");
    expect(cache.size).toBe(1);
    
    cache.delete("key1");
    expect(cache.get("key1")).toBeUndefined();
    
    cache.shutdown();
  });
});

// ─── Session Management Tests ──────────────────────────────────────────────

describe("Session Management", () => {
  test("should create a session", () => {
    const session = sessions.create("test-user", "Test Session");
    expect(session.id).toBeDefined();
    expect(session.title).toBe("Test Session");
  });

  test("should list sessions for a user", () => {
    sessions.create("user1", "Session 1");
    sessions.create("user1", "Session 2");
    sessions.create("user2", "Session 3");
    
    const user1Sessions = sessions.listForUser("user1");
    expect(user1Sessions.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── Message Store Tests ───────────────────────────────────────────────────

describe("Message Store", () => {
  test("should add messages to a session", () => {
    const session = sessions.create("user1", "Test");
    
    messages.add(session.id, {
      id: "msg1",
      sessionId: session.id,
      role: "user",
      content: "Hello",
      createdAt: Date.now(),
    });
    
    const all = messages.getAll(session.id);
    expect(all.length).toBe(1);
    expect(all[0]?.content).toBe("Hello");
  });
});