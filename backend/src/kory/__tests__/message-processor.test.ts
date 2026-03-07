// Message Processor Tests
// Domain: Unit tests for LLM turn processing and streaming

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { MessageProcessor, type ProcessTurnResult, type CompletedToolCall } from "../message-processor";
import type { ProviderName } from "@koryphaios/shared";
import type { ProviderRegistry, ToolRegistry } from "../../providers";

// Mock providers and tools
const createMockStream = (content = "Hello, world!") => async function* () {
  yield { type: "content_delta", content: "Hello, " };
  yield { type: "content_delta", content: content.replace("Hello, ", "") };
  yield { type: "usage_update", tokensIn: 100, tokensOut: 50 };
};

const createMockProviders = (): ProviderRegistry => {
  let currentStream = createMockStream();

  return {
    executeWithRetry: ((...args: any[]) => currentStream()) as any,
    setStream: (stream: any) => { currentStream = stream; },
    resolveProvider: mock(async () => null),
    getFirstAvailableRouting: mock(() => null),
  } as unknown as ProviderRegistry & { setStream: (stream: any) => void };
};

const createMockTools = (): ToolRegistry => {
  return {
    getToolDefsForRole: mock(() => [
      { name: "read_file", description: "Read file", inputSchema: {} },
      { name: "write_file", description: "Write file", inputSchema: {} }
    ]),
    getTool: mock(() => null),
  } as unknown as ToolRegistry;
};

describe("MessageProcessor", () => {
  let messageProcessor: MessageProcessor;
  let mockProviders: ProviderRegistry;
  let mockTools: ToolRegistry;
  let mockEmitUsageUpdate: any;
  let mockEmitWSMessage: any;

  beforeEach(() => {
    mockProviders = createMockProviders();
    mockTools = createMockTools();

    mockEmitUsageUpdate = mock(() => {});
    mockEmitWSMessage = mock(() => {});

    messageProcessor = new MessageProcessor({
      providers: mockProviders,
      tools: mockTools,
      managerAgentId: "kory-manager",
      systemPrompt: "You are Kory, the manager agent.",
      emitUsageUpdate: mockEmitUsageUpdate,
      emitWSMessage: mockEmitWSMessage,
    });
  });

  describe("processManagerTurn", () => {
    it("should process a simple manager turn", async () => {
      const messages = [
        { role: "user", content: "Hello, Kory!" }
      ];

      const result = await messageProcessor.processManagerTurn(
        "session-1",
        "gpt-4.1",
        { name: "openai" as ProviderName },
        messages,
        { sessionId: "session-1", agentId: "kory-manager" }
      );

      expect(result.success).toBe(false); // No tool calls
      expect(result.content).toBe("Hello, world!");
      expect(result.usage).toEqual({ tokensIn: 100, tokensOut: 50 });
    });

    it("should emit usage updates during processing", async () => {
      const messages = [{ role: "user", content: "Test" }];

      await messageProcessor.processManagerTurn(
        "session-1",
        "gpt-4.1",
        { name: "openai" as ProviderName },
        messages,
        { sessionId: "session-1", agentId: "kory-manager" }
      );

      expect(mockEmitUsageUpdate).toHaveBeenCalledWith(
        "session-1",
        "kory-manager",
        "gpt-4.1",
        "openai",
        100,
        50,
        true
      );
    });

    it("should not stream content for delegation-only turns", async () => {
      // Mock stream that only delegates to worker
      const delegationStream = async function* () {
        yield { type: "tool_use_start", toolCallId: "call-1", toolName: "delegate_to_worker" };
        yield { type: "tool_use_delta", toolCallId: "call-1", toolInput: '{"task":"test"}' };
        yield { type: "tool_use_stop", toolCallId: "call-1" };
        yield { type: "usage_update", tokensIn: 100, tokensOut: 50 };
      };

      (mockProviders as any).setStream(delegationStream);

      const messages = [{ role: "user", content: "Implement feature" }];

      await messageProcessor.processManagerTurn(
        "session-1",
        "gpt-4.1",
        { name: "openai" as ProviderName },
        messages,
        { sessionId: "session-1", agentId: "kory-manager" }
      );

      // Should NOT emit stream.delta for delegation-only turns
      expect(mockEmitWSMessage).not.toHaveBeenCalledWith(
        "session-1",
        "stream.delta",
        expect.any(Object)
      );
    });

    it("should handle tool calls", async () => {
      const toolCallStream = async function* () {
        yield { type: "content_delta", content: "I'll read the file." };
        yield { type: "tool_use_start", toolCallId: "call-1", toolName: "read_file" };
        yield { type: "tool_use_delta", toolCallId: "call-1", toolInput: '{"path":"test.txt"}' };
        yield { type: "tool_use_stop", toolCallId: "call-1" };
        yield { type: "usage_update", tokensIn: 100, tokensOut: 50 };
      };

      (mockProviders as any).setStream(toolCallStream);

      const messages = [{ role: "user", content: "Read test.txt" }];

      const result = await messageProcessor.processManagerTurn(
        "session-1",
        "gpt-4.1",
        { name: "openai" as ProviderName },
        messages,
        { sessionId: "session-1", agentId: "kory-manager" }
      );

      expect(result.success).toBe(true);
      expect(result.completedToolCalls).toEqual([{
        id: "call-1",
        name: "read_file",
        input: { path: "test.txt" }
      }]);
    });

    it("should emit tool call events", async () => {
      const toolCallStream = async function* () {
        yield { type: "tool_use_start", toolCallId: "call-1", toolName: "read_file" };
        yield { type: "tool_use_delta", toolCallId: "call-1", toolInput: '{}' };
        yield { type: "tool_use_stop", toolCallId: "call-1" };
      };

      (mockProviders as any).setStream(toolCallStream);

      const messages = [{ role: "user", content: "Read file" }];

      await messageProcessor.processManagerTurn(
        "session-1",
        "gpt-4.1",
        { name: "openai" as ProviderName },
        messages,
        { sessionId: "session-1", agentId: "kory-manager" }
      );

      expect(mockEmitWSMessage).toHaveBeenCalledWith(
        "session-1",
        "stream.tool_call",
        expect.objectContaining({
          agentId: "kory-manager",
          toolCall: expect.objectContaining({
            id: "call-1",
            name: "read_file"
          })
        })
      );
    });

    it("should add assistant message to conversation", async () => {
      const messages = [{ role: "user", content: "Hello" }];
      const initialLength = messages.length;

      await messageProcessor.processManagerTurn(
        "session-1",
        "gpt-4.1",
        { name: "openai" as ProviderName },
        messages,
        { sessionId: "session-1", agentId: "kory-manager" }
      );

      expect(messages.length).toBe(initialLength + 1);
      expect(messages[messages.length - 1]).toMatchObject({
        role: "assistant",
        content: "Hello, world!"
      });
    });

    it("should abort when signal is aborted", async () => {
      const abortController = new AbortController();
      abortController.abort();

      const messages = [{ role: "user", content: "Test" }];

      await expect(messageProcessor.processManagerTurn(
        "session-1",
        "gpt-4.1",
        { name: "openai" as ProviderName },
        messages,
        { sessionId: "session-1", agentId: "kory-manager" },
        abortController.signal
      )).rejects.toThrow("Manager run aborted");
    });

    it("should handle malformed tool input JSON gracefully", async () => {
      const malformedStream = async function* () {
        yield { type: "tool_use_start", toolCallId: "call-1", toolName: "read_file" };
        yield { type: "tool_use_delta", toolCallId: "call-1", toolInput: 'invalid json{{{' };
        yield { type: "tool_use_stop", toolCallId: "call-1" };
      };

      (mockProviders as any).setStream(malformedStream);

      const messages = [{ role: "user", content: "Read file" }];

      const result = await messageProcessor.processManagerTurn(
        "session-1",
        "gpt-4.1",
        { name: "openai" as ProviderName },
        messages,
        { sessionId: "session-1", agentId: "kory-manager" }
      );

      expect(result.completedToolCalls).toEqual([{
        id: "call-1",
        name: "read_file",
        input: {} // Fallback to empty object
      }]);
    });

    it("should handle multiple tool calls", async () => {
      const multiToolStream = async function* () {
        yield { type: "tool_use_start", toolCallId: "call-1", toolName: "read_file" };
        yield { type: "tool_use_delta", toolCallId: "call-1", toolInput: '{"path":"a.txt"}' };
        yield { type: "tool_use_stop", toolCallId: "call-1" };
        yield { type: "tool_use_start", toolCallId: "call-2", toolName: "write_file" };
        yield { type: "tool_use_delta", toolCallId: "call-2", toolInput: '{"path":"b.txt"}' };
        yield { type: "tool_use_stop", toolCallId: "call-2" };
      };

      (mockProviders as any).setStream(multiToolStream);

      const messages = [{ role: "user", content: "Copy file" }];

      const result = await messageProcessor.processManagerTurn(
        "session-1",
        "gpt-4.1",
        { name: "openai" as ProviderName },
        messages,
        { sessionId: "session-1", agentId: "kory-manager" }
      );

      expect(result.completedToolCalls).toHaveLength(2);
      expect(result.completedToolCalls?.[0]?.name).toBe("read_file");
      expect(result.completedToolCalls?.[1]?.name).toBe("write_file");
    });
  });

  describe("processProviderTurn", () => {
    it("should process a worker turn with streaming", async () => {
      const messages = [{ role: "user", content: "Implement authentication" }];

      const result = await messageProcessor.processProviderTurn(
        "session-1",
        "worker-123",
        "gpt-4.1",
        { name: "openai" as ProviderName },
        messages,
        { sessionId: "session-1", agentId: "worker-123" }
      );

      expect(result.success).toBe(true); // No tool calls = success
      expect(result.content).toBe("Hello, world!");
    });

    it("should stream content deltas to client", async () => {
      const messages = [{ role: "user", content: "Test" }];

      await messageProcessor.processProviderTurn(
        "session-1",
        "worker-123",
        "gpt-4.1",
        { name: "openai" as ProviderName },
        messages,
        { sessionId: "session-1", agentId: "worker-123" }
      );

      expect(mockEmitWSMessage).toHaveBeenCalledWith(
        "session-1",
        "stream.delta",
        expect.objectContaining({
          agentId: "worker-123",
          content: "Hello, "
        })
      );
    });

    it("should use coder role tools", async () => {
      const messages = [{ role: "user", content: "Test" }];

      await messageProcessor.processProviderTurn(
        "session-1",
        "worker-123",
        "gpt-4.1",
        { name: "openai" as ProviderName },
        messages,
        { sessionId: "session-1", agentId: "worker-123" }
      );

      expect(mockTools.getToolDefsForRole).toHaveBeenCalledWith("coder");
    });

    it("should abort when signal is aborted", async () => {
      const abortController = new AbortController();
      abortController.abort();

      const messages = [{ role: "user", content: "Test" }];

      await expect(messageProcessor.processProviderTurn(
        "session-1",
        "worker-123",
        "gpt-4.1",
        { name: "openai" as ProviderName },
        messages,
        { sessionId: "session-1", agentId: "worker-123" },
        undefined,
        abortController.signal
      )).rejects.toThrow("Worker run aborted");
    });

    it("should return success=true when no tool calls", async () => {
      const messages = [{ role: "user", content: "Just chat" }];

      const result = await messageProcessor.processProviderTurn(
        "session-1",
        "worker-123",
        "gpt-4.1",
        { name: "openai" as ProviderName },
        messages,
        { sessionId: "session-1", agentId: "worker-123" }
      );

      expect(result.success).toBe(true);
    });

    it("should return success=false when tool calls exist", async () => {
      const toolStream = async function* () {
        yield { type: "tool_use_start", toolCallId: "call-1", toolName: "read_file" };
        yield { type: "tool_use_delta", toolCallId: "call-1", toolInput: '{}' };
        yield { type: "tool_use_stop", toolCallId: "call-1" };
      };

      (mockProviders as any).setStream(toolStream);

      const messages = [{ role: "user", content: "Read file" }];

      const result = await messageProcessor.processProviderTurn(
        "session-1",
        "worker-123",
        "gpt-4.1",
        { name: "openai" as ProviderName },
        messages,
        { sessionId: "session-1", agentId: "worker-123" }
      );

      expect(result.success).toBe(false);
      expect(result.completedToolCalls).toHaveLength(1);
    });
  });

  describe("toProviderMessages", () => {
    it("should convert user messages", () => {
      const messages = [
        { role: "user", content: "Hello" }
      ];

      const result = messageProcessor.toProviderMessages(messages);

      expect(result).toEqual([{ role: "user", content: "Hello" }]);
    });

    it("should convert assistant messages", () => {
      const messages = [
        { role: "assistant", content: "Hi there!" }
      ];

      const result = messageProcessor.toProviderMessages(messages);

      expect(result).toEqual([{ role: "assistant", content: "Hi there!" }]);
    });

    it("should convert tool messages with tool_call_id", () => {
      const messages = [
        { role: "tool", content: "File content", tool_call_id: "call-123" }
      ];

      const result = messageProcessor.toProviderMessages(messages);

      expect(result).toEqual([
        { role: "tool", content: "File content", tool_call_id: "call-123" }
      ]);
    });

    it("should convert assistant messages with tool_calls", () => {
      const messages = [
        {
          role: "assistant",
          content: "I'll read that file",
          tool_calls: [
            { id: "call-1", name: "read_file", input: { path: "test.txt" } }
          ]
        }
      ];

      const result = messageProcessor.toProviderMessages(messages);

      expect(result).toEqual([
        {
          role: "assistant",
          content: "I'll read that file",
          tool_calls: [
            { id: "call-1", name: "read_file", input: { path: "test.txt" } }
          ]
        }
      ]);
    });

    it("should handle mixed conversation", () => {
      const messages = [
        { role: "user", content: "Read test.txt" },
        {
          role: "assistant",
          content: "I'll read it",
          tool_calls: [{ id: "call-1", name: "read_file", input: { path: "test.txt" } }]
        },
        { role: "tool", content: "File content", tool_call_id: "call-1" },
        { role: "assistant", content: "Here's the content" }
      ];

      const result = messageProcessor.toProviderMessages(messages);

      expect(result).toHaveLength(4);
      expect(result[0]).toMatchObject({ role: "user" });
      expect(result[1]).toMatchObject({ role: "assistant", tool_calls: expect.any(Array) });
      expect(result[2]).toMatchObject({ role: "tool", tool_call_id: "call-1" });
      expect(result[3]).toMatchObject({ role: "assistant" });
    });

    it("should handle messages without tool_call_id", () => {
      const messages = [
        { role: "tool", content: "Result" }
      ];

      const result = messageProcessor.toProviderMessages(messages);

      expect(result[0]).not.toHaveProperty("tool_call_id");
    });

    it("should handle assistant messages without tool_calls", () => {
      const messages = [
        { role: "assistant", content: "No tools needed" }
      ];

      const result = messageProcessor.toProviderMessages(messages);

      expect(result[0]).not.toHaveProperty("tool_calls");
    });
  });
});

describe("MessageProcessor Edge Cases", () => {
  it("should handle empty messages array", async () => {
    const mockProviders = createMockProviders();
    const mockTools = createMockTools();
    const emitUsage = mock(() => {});
    const emitWS = mock(() => {});

    const processor = new MessageProcessor({
      providers: mockProviders,
      tools: mockTools,
      managerAgentId: "kory",
      systemPrompt: "Test",
      emitUsageUpdate: emitUsage,
      emitWSMessage: emitWS,
    });

    const result = await processor.processManagerTurn(
      "session-1",
      "gpt-4",
      { name: "openai" as const },
      [],
      { sessionId: "session-1", agentId: "kory" }
    );

    expect(result.content).toBe("Hello, world!");
  });

  it("should handle very long content", async () => {
    const longContent = "A".repeat(100000);
    const longStream = async function* () {
      yield { type: "content_delta", content: longContent };
      yield { type: "usage_update", tokensIn: 1000, tokensOut: 1000 };
    };

    const mockProviders = {
      executeWithRetry: ((...args: any[]) => longStream()),
      setStream: (stream: any) => {},
    } as unknown as ProviderRegistry & { setStream: (stream: any) => void };

    const mockTools = createMockTools();

    const processor = new MessageProcessor({
      providers: mockProviders,
      tools: mockTools,
      managerAgentId: "kory",
      systemPrompt: "Test",
      emitUsageUpdate: mock(() => {}),
      emitWSMessage: mock(() => {}),
    });

    const messages = [{ role: "user", content: "Generate long text" }];

    const result = await processor.processManagerTurn(
      "session-1",
      "gpt-4",
      { name: "openai" as const },
      messages,
      { sessionId: "session-1", agentId: "kory" }
    );

    expect(result.content?.length).toBe(100000);
  });

  it("should handle zero token usage", async () => {
    const zeroUsageStream = async function* () {
      yield { type: "content_delta", content: "Hi" };
      yield { type: "usage_update", tokensIn: 0, tokensOut: 0 };
    };

    const mockProviders = {
      executeWithRetry: ((...args: any[]) => zeroUsageStream()),
      setStream: (stream: any) => {},
    } as unknown as ProviderRegistry & { setStream: (stream: any) => void };

    const mockTools = createMockTools();
    const emitUsage = mock(() => {});

    const processor = new MessageProcessor({
      providers: mockProviders,
      tools: mockTools,
      managerAgentId: "kory",
      systemPrompt: "Test",
      emitUsageUpdate: emitUsage,
      emitWSMessage: mock(() => {}),
    });

    const messages = [{ role: "user", content: "Hi" }];

    await processor.processManagerTurn(
      "session-1",
      "gpt-4",
      { name: "openai" as const },
      messages,
      { sessionId: "session-1", agentId: "kory" }
    );

    expect(emitUsage).toHaveBeenCalledWith(
      "session-1",
      "kory",
      "gpt-4",
      "openai",
      0,
      0,
      true
    );
  });

  it("should handle special characters in tool input", async () => {
    const specialCharStream = async function* () {
      yield { type: "tool_use_start", toolCallId: "call-1", toolName: "write_file" };
      yield { type: "tool_use_delta", toolCallId: "call-1", toolInput: '{"path":"file.txt","content":"Hello\\n\\tWorld"}' };
      yield { type: "tool_use_stop", toolCallId: "call-1" };
    };

    const mockProviders = {
      executeWithRetry: ((...args: any[]) => specialCharStream()),
      setStream: (stream: any) => {},
    } as unknown as ProviderRegistry & { setStream: (stream: any) => void };

    const mockTools = createMockTools();

    const processor = new MessageProcessor({
      providers: mockProviders,
      tools: mockTools,
      managerAgentId: "kory",
      systemPrompt: "Test",
      emitUsageUpdate: mock(() => {}),
      emitWSMessage: mock(() => {}),
    });

    const messages = [{ role: "user", content: "Write file" }];

    const result = await processor.processManagerTurn(
      "session-1",
      "gpt-4",
      { name: "openai" as const },
      messages,
      { sessionId: "session-1", agentId: "kory" }
    );

    expect(result.completedToolCalls?.[0]?.input).toEqual({
      path: "file.txt",
      content: "Hello\n\tWorld"
    });
  });
});

describe("MessageProcessor Backward Compatibility", () => {
  it("should export ProcessTurnResult type", () => {
    const result: ProcessTurnResult = {
      success: true,
      content: "Test",
      usage: { tokensIn: 100, tokensOut: 50 },
      completedToolCalls: [{ id: "call-1", name: "test", input: {} }]
    };
    expect(result).toBeDefined();
  });

  it("should export CompletedToolCall type", () => {
    const toolCall: CompletedToolCall = {
      id: "call-1",
      name: "read_file",
      input: { path: "test.txt" }
    };
    expect(toolCall).toBeDefined();
  });

  it("should work with legacy message format", () => {
    const mockProviders = createMockProviders();
    const mockTools = createMockTools();

    const processor = new MessageProcessor({
      providers: mockProviders,
      tools: mockTools,
      managerAgentId: "kory",
      systemPrompt: "Test",
      emitUsageUpdate: mock(() => {}),
      emitWSMessage: mock(() => {}),
    });

    const legacyMessages = [
      { role: "user", content: "Test" },
      { role: "assistant", content: "Response" }
    ];

    const result = processor.toProviderMessages(legacyMessages);

    expect(result).toHaveLength(2);
    expect(result[0]?.role).toBe("user");
    expect(result[1]?.role).toBe("assistant");
  });
});
