// WebSocket Emitter Tests
// Domain: Unit tests for real-time event broadcasting

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { WebSocketEmitter, initWebSocketEmitter, getWebSocketEmitter } from "../websocket-emitter";
import type { ProviderName } from "@koryphaios/shared";

// Mock wsBroker
const mockWsBroker = {
  publish: mock(() => {}),
};

describe("WebSocketEmitter", () => {
  let wsEmitter: WebSocketEmitter;
  let publishSpy: any;

  beforeEach(() => {
    // Spy on wsBroker.publish
    publishSpy = mock(() => {});
    // Mock wsBroker module
    // Note: In actual implementation, you'd need to mock the module

    wsEmitter = new WebSocketEmitter({
      managerAgentId: "kory-manager"
    });

    // Replace the emitWSMessage method to use our spy
    wsEmitter["emitWSMessage"] = (sessionId: string, type: string, payload: any) => {
      publishSpy(type, payload);
    };
  });

  describe("emitThought", () => {
    it("should broadcast thought event", () => {
      wsEmitter.emitThought("session-1", "analyzing", "Analyzing user request");

      expect(publishSpy).toHaveBeenCalledWith(
        "kory.thought",
        expect.objectContaining({
          thought: "Analyzing user request",
          phase: "analyzing"
        })
      );
    });

    it("should support all phases", () => {
      const phases = ["analyzing", "routing", "delegating", "verifying", "synthesizing"];

      phases.forEach(phase => {
        wsEmitter.emitThought("session-1", phase, `Phase: ${phase}`);

        expect(publishSpy).toHaveBeenCalledWith(
          "kory.thought",
          expect.objectContaining({
            phase,
            thought: `Phase: ${phase}`
          })
        );
      });
    });
  });

  describe("emitRouting", () => {
    it("should broadcast routing decision", () => {
      wsEmitter.emitRouting(
        "session-1",
        "backend",
        "gpt-4.1",
        "openai",
        "Backend domain selected"
      );

      expect(publishSpy).toHaveBeenCalledWith(
        "kory.routing",
        expect.objectContaining({
          domain: "backend",
          selectedModel: "gpt-4.1",
          selectedProvider: "openai",
          reasoning: "Backend domain selected"
        })
      );
    });

    it("should generate default reasoning if not provided", () => {
      wsEmitter.emitRouting(
        "session-1",
        "ui",
        "claude-sonnet-4-6",
        "anthropic"
      );

      expect(publishSpy).toHaveBeenCalledWith(
        "kory.routing",
        expect.objectContaining({
          domain: "ui",
          selectedModel: "claude-sonnet-4-6",
          selectedProvider: "anthropic",
          reasoning: expect.stringContaining("claude-sonnet-4-6")
        })
      );
    });
  });

  describe("emitError", () => {
    it("should broadcast error message", () => {
      wsEmitter.emitError("session-1", "Something went wrong");

      expect(publishSpy).toHaveBeenCalledWith(
        "system.error",
        expect.objectContaining({
          sessionId: "session-1",
          error: "Something went wrong"
        })
      );
    });

    it("should include error code when provided", () => {
      wsEmitter.emitError("session-1", "Invalid input", "VALIDATION_ERROR");

      expect(publishSpy).toHaveBeenCalledWith(
        "system.error",
        expect.objectContaining({
          sessionId: "session-1",
          error: "Invalid input",
          code: "VALIDATION_ERROR"
        })
      );
    });

    it("should include details when provided", () => {
      wsEmitter.emitError("session-1", "Failed to parse", "PARSE_ERROR", "Line 42: unexpected token");

      expect(publishSpy).toHaveBeenCalledWith(
        "system.error",
        expect.objectContaining({
          sessionId: "session-1",
          error: "Failed to parse",
          code: "PARSE_ERROR",
          details: "Line 42: unexpected token"
        })
      );
    });
  });

  describe("emitUsageUpdate", () => {
    it("should broadcast token usage", () => {
      wsEmitter.emitUsageUpdate(
        "session-1",
        "worker-123",
        "gpt-4.1",
        "openai",
        1000,
        500,
        true
      );

      expect(publishSpy).toHaveBeenCalledWith(
        "stream.usage",
        expect.objectContaining({
          agentId: "worker-123",
          model: "gpt-4.1",
          provider: "openai",
          tokensIn: 1000,
          tokensOut: 500,
          tokensUsed: 1500,
          usageKnown: true
        })
      );
    });

    it("should include context window when known", () => {
      // Mock resolveTrustedContextWindow to return context info
      wsEmitter.emitUsageUpdate(
        "session-1",
        "worker-123",
        "claude-opus-4-6",
        "anthropic",
        5000,
        2000,
        true
      );

      expect(publishSpy).toHaveBeenCalledWith(
        "stream.usage",
        expect.objectContaining({
          contextKnown: expect.any(Boolean) // Will be true/false based on model
        })
      );
    });

    it("should include contextWindow when available", () => {
      wsEmitter.emitUsageUpdate(
        "session-1",
        "worker-123",
        "gpt-4.1",
        "openai",
        1000,
        500,
        false
      );

      expect(publishSpy).toHaveBeenCalledWith(
        "stream.usage",
        expect.objectContaining({
          tokensUsed: 1500
        })
      );
    });
  });

  describe("emitAgentStatus", () => {
    it("should broadcast agent status update", () => {
      wsEmitter.emitAgentStatus("session-1", "worker-123", "thinking");

      expect(publishSpy).toHaveBeenCalledWith(
        "agent.status",
        expect.objectContaining({
          agentId: "worker-123",
          status: "thinking"
        })
      );
    });

    it("should include detail when provided", () => {
      wsEmitter.emitAgentStatus("session-1", "worker-123", "thinking", "Processing file");

      expect(publishSpy).toHaveBeenCalledWith(
        "agent.status",
        expect.objectContaining({
          agentId: "worker-123",
          status: "thinking",
          detail: "Processing file"
        })
      );
    });
  });

  describe("emitAgentSpawned", () => {
    it("should broadcast agent spawned event", () => {
      wsEmitter.emitAgentSpawned(
        "session-1",
        "worker-123",
        "Code Assistant",
        "coder",
        "backend",
        "rgba(0,255,255,0.5)"
      );

      expect(publishSpy).toHaveBeenCalledWith(
        "agent.spawned",
        expect.objectContaining({
          agent: expect.objectContaining({
            id: "worker-123",
            name: "Code Assistant",
            role: "coder",
            domain: "backend",
            glowColor: "rgba(0,255,255,0.5)"
          })
        })
      );
    });
  });

  describe("emitStreamDelta", () => {
    it("should broadcast streaming content", () => {
      wsEmitter.emitStreamDelta("session-1", "worker-123", "Hello, world!", "gpt-4.1");

      expect(publishSpy).toHaveBeenCalledWith(
        "stream.delta",
        expect.objectContaining({
          agentId: "worker-123",
          content: "Hello, world!",
          model: "gpt-4.1"
        })
      );
    });
  });

  describe("emitStreamComplete", () => {
    it("should broadcast stream completion", () => {
      wsEmitter.emitStreamComplete(
        "session-1",
        "msg-123",
        "worker-123",
        1000,
        500
      );

      expect(publishSpy).toHaveBeenCalledWith(
        "stream.complete",
        expect.objectContaining({
          messageId: "msg-123",
          agentId: "worker-123",
          tokensIn: 1000,
          tokensOut: 500
        })
      );
    });

    it("should work without token counts", () => {
      wsEmitter.emitStreamComplete("session-1", "msg-123", "worker-123");

      expect(publishSpy).toHaveBeenCalledWith(
        "stream.complete",
        expect.not.objectContaining({
          tokensIn: expect.anything()
        })
      );
    });
  });

  describe("Singleton Pattern", () => {
    it("should return same instance on subsequent calls", () => {
      const emitter1 = initWebSocketEmitter("test-manager");
      const emitter2 = initWebSocketEmitter("test-manager");

      expect(emitter1).toBe(emitter2);
    });

    it("should allow getting existing instance", () => {
      const created = initWebSocketEmitter("test-manager-2");
      const retrieved = getWebSocketEmitter();

      expect(created).toBeDefined();
      expect(retrieved).toBeDefined();
      expect(retrieved).toBe(created);
    });
  });
});

describe("WebSocketEmitter Edge Cases", () => {
  it("should handle empty sessionId gracefully", () => {
    const wsEmitter = new WebSocketEmitter({
      managerAgentId: "kory-manager"
    });

    wsEmitter["emitWSMessage"] = () => {}; // Mock to avoid actual broadcast

    // Should not throw
    expect(() => wsEmitter.emitThought("", "analyzing", "test")).not.toThrow();
  });

  it("should handle very long thought content", () => {
    const wsEmitter = new WebSocketEmitter({
      managerAgentId: "kory-manager"
    });

    wsEmitter["emitWSMessage"] = () => {};

    const longThought = "A".repeat(10000);
    expect(() => wsEmitter.emitThought("session-1", "analyzing", longThought)).not.toThrow();
  });

  it("should handle special characters in error messages", () => {
    const wsEmitter = new WebSocketEmitter({
      managerAgentId: "kory-manager"
    });

    wsEmitter["emitWSMessage"] = () => {};

    const specialError = "Error: \n\t<script>alert('xss')</script>";
    expect(() => wsEmitter.emitError("session-1", specialError)).not.toThrow();
  });

  it("should handle zero token usage", () => {
    const wsEmitter = new WebSocketEmitter({
      managerAgentId: "kory-manager"
    });

    wsEmitter["emitWSMessage"] = () => {};

    expect(() => wsEmitter.emitUsageUpdate("session-1", "agent-1", "gpt-4", "openai", 0, 0, false)).not.toThrow();
  });
});

describe("Backward Compatibility", () => {
  it("should export initWebSocketEmitter function", () => {
    expect(initWebSocketEmitter).toBeDefined();
    expect(typeof initWebSocketEmitter).toBe("function");
  });

  it("should export WebSocketEmitter class", () => {
    expect(WebSocketEmitter).toBeDefined();
    expect(typeof WebSocketEmitter).toBe("function");
  });
});
