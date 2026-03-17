// UserInteractionService Tests
import { describe, it, expect, beforeEach } from "bun:test";
import { UserInteractionService } from "../UserInteractionService";

describe("UserInteractionService", () => {
  let service: UserInteractionService;

  beforeEach(() => {
    service = new UserInteractionService();
  });

  describe("requestInput", () => {
    it("should create pending input request", async () => {
      const promise = service.requestInput("session-1", "Continue?", ["Yes", "No"]);
      
      expect(service.hasPendingInput("session-1")).toBe(true);
      
      // Simulate user response
      service.handleInput("session-1", "Yes");
      
      const result = await promise;
      expect(result).toBe("Yes");
      expect(service.hasPendingInput("session-1")).toBe(false);
    });

    it("should handle text response", async () => {
      const promise = service.requestInput("session-1", "Details?", ["Option 1"]);
      
      service.handleInput("session-1", "Option 1", "Custom text response");
      
      const result = await promise;
      expect(result).toBe("Custom text response");
    });
  });

  describe("handleInput", () => {
    it("should ignore unknown session", () => {
      // Should not throw
      service.handleInput("unknown-session", "Yes");
    });

    it("should only resolve once", async () => {
      const promise = service.requestInput("session-1", "Continue?", ["Yes", "No"]);
      
      service.handleInput("session-1", "Yes");
      service.handleInput("session-1", "No"); // Should be ignored
      
      const result = await promise;
      expect(result).toBe("Yes");
    });
  });

  describe("cleanupSession", () => {
    it("should remove pending input", async () => {
      service.requestInput("session-1", "Continue?", ["Yes", "No"]);
      expect(service.hasPendingInput("session-1")).toBe(true);
      
      service.cleanupSession("session-1");
      expect(service.hasPendingInput("session-1")).toBe(false);
    });
  });

  describe("emit methods", () => {
    it("should emit thought without throwing", () => {
      expect(() => {
        service.emitThought("session-1", "analyzing", "Thinking...");
      }).not.toThrow();
    });

    it("should emit error without throwing", () => {
      expect(() => {
        service.emitError("session-1", "Something went wrong");
      }).not.toThrow();
    });

    it("should emit agent status without throwing", () => {
      expect(() => {
        service.emitAgentStatus("session-1", "agent-1", "thinking");
      }).not.toThrow();
    });

    it("should emit stream delta without throwing", () => {
      expect(() => {
        service.emitStreamDelta("session-1", "agent-1", "Hello", "gpt-4");
      }).not.toThrow();
    });

    it("should emit usage without throwing", () => {
      expect(() => {
        service.emitUsage("session-1", "agent-1", "gpt-4", "openai", 100, 50, true);
      }).not.toThrow();
    });
  });
});
