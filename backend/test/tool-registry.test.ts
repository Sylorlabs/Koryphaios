import { describe, test, expect, mock } from "bun:test";
import { ToolRegistry, type Tool, type ToolContext, type ToolCallInput } from "../src/tools/registry";

describe("ToolRegistry", () => {
  const defaultCtx: ToolContext = {
    sessionId: "test-session",
    workingDirectory: "/tmp",
  };

  const createMockTool = (name: string, role?: "manager" | "worker" | "critic" | "any"): Tool => ({
    name,
    description: `Description for ${name}`,
    inputSchema: { type: "object" },
    role,
    run: mock(async (ctx, call) => ({
      callId: call.id,
      name: call.name,
      output: `Result for ${call.name}`,
      isError: false,
      durationMs: 0,
    })),
  });

  test("should register and retrieve tools", () => {
    const registry = new ToolRegistry();
    const tool = createMockTool("test-tool");

    registry.register(tool);

    expect(registry.get("test-tool")).toBe(tool);
    expect(registry.get("unknown-tool")).toBeUndefined();
  });

  test("should retrieve all tools", () => {
    const registry = new ToolRegistry();
    const tool1 = createMockTool("tool1");
    const tool2 = createMockTool("tool2");

    registry.register(tool1);
    registry.register(tool2);

    const tools = registry.getAll();
    expect(tools).toHaveLength(2);
    expect(tools).toContain(tool1);
    expect(tools).toContain(tool2);
  });

  test("should get tool definitions filtered by role", () => {
    const registry = new ToolRegistry();

    const managerTool = createMockTool("manager-tool", "manager");
    const workerTool = createMockTool("worker-tool", "worker");
    const criticTool = createMockTool("critic-tool", "critic");
    const anyTool = createMockTool("any-tool", "any");
    const defaultTool = createMockTool("default-tool"); // No role = included in all

    registry.register(managerTool);
    registry.register(workerTool);
    registry.register(criticTool);
    registry.register(anyTool);
    registry.register(defaultTool);

    // Manager gets manager + worker + any (full access)
    const managerDefs = registry.getToolDefsForRole("manager");
    expect(managerDefs.map(t => t.name)).toEqual(expect.arrayContaining(["manager-tool", "worker-tool", "any-tool", "default-tool"]));
    expect(managerDefs.map(t => t.name)).not.toContain("critic-tool");

    // Worker gets worker + any
    const workerDefs = registry.getToolDefsForRole("worker");
    expect(workerDefs.map(t => t.name)).toEqual(expect.arrayContaining(["worker-tool", "any-tool", "default-tool"]));
    expect(workerDefs.map(t => t.name)).not.toContain("manager-tool");
    expect(workerDefs.map(t => t.name)).not.toContain("critic-tool");

    // Critic gets critic + any only (read-only tools)
    const criticDefs = registry.getToolDefsForRole("critic");
    expect(criticDefs.map(t => t.name)).toEqual(expect.arrayContaining(["critic-tool", "any-tool", "default-tool"]));
    expect(criticDefs.map(t => t.name)).not.toContain("manager-tool");
    expect(criticDefs.map(t => t.name)).not.toContain("worker-tool");
  });

  test("should execute a registered tool successfully", async () => {
    const registry = new ToolRegistry();
    const tool = createMockTool("test-tool");
    registry.register(tool);

    const callInput: ToolCallInput = {
      id: "call-1",
      name: "test-tool",
      input: { foo: "bar" },
    };

    const result = await registry.execute(defaultCtx, callInput);

    expect(result.isError).toBe(false);
    expect(result.output).toBe("Result for test-tool");
    expect(tool.run).toHaveBeenCalledWith(defaultCtx, callInput);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("should handle unknown tools execution", async () => {
    const registry = new ToolRegistry();
    const callInput: ToolCallInput = {
      id: "call-2",
      name: "unknown-tool",
      input: {},
    };

    const result = await registry.execute(defaultCtx, callInput);

    expect(result.isError).toBe(true);
    expect(result.output).toContain("Unknown tool: unknown-tool");
  });

  test("should handle tool execution errors", async () => {
    const registry = new ToolRegistry();
    const failingTool = createMockTool("failing-tool");
    // Override run to throw error
    (failingTool.run as any).mockImplementation(async () => {
      throw new Error("Something went wrong");
    });

    registry.register(failingTool);

    const callInput: ToolCallInput = {
      id: "call-3",
      name: "failing-tool",
      input: {},
    };

    const result = await registry.execute(defaultCtx, callInput);

    expect(result.isError).toBe(true);
    expect(result.output).toContain("Tool error: Something went wrong");
  });
});
