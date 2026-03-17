// ClarificationService Tests
import { describe, it, expect, beforeEach } from "bun:test";
import { ClarificationService } from "../ClarificationService";

describe("ClarificationService", () => {
  let service: ClarificationService;

  beforeEach(() => {
    service = new ClarificationService();
  });

  describe("extractJsonObject", () => {
    it("should extract JSON from plain text", () => {
      const result = service.extractJsonObject('{"action":"proceed"}');
      expect(result).toBe('{"action":"proceed"}');
    });

    it("should extract JSON from markdown code block", () => {
      const result = service.extractJsonObject('```json\n{"action":"proceed"}\n```');
      expect(result).toBe('{"action":"proceed"}');
    });

    it("should handle JSON embedded in prose", () => {
      const result = service.extractJsonObject('Here is my response: {"action":"proceed"} - hope that helps!');
      expect(result).toBe('{"action":"proceed"}');
    });

    it("should return empty string for multiple JSON objects", () => {
      const result = service.extractJsonObject('{"a":1}{"b":2}');
      expect(result).toBe("");
    });
  });

  describe("parseDecision", () => {
    it("should parse proceed action", () => {
      const result = service.parseDecision('{"action":"proceed"}', 3);
      expect(result).toEqual({ action: "proceed" });
    });

    it("should parse clarify action", () => {
      const raw = '{"action":"clarify","questions":["What is the scope?"],"reason":"Need clarification","assumptions":["User wants X"]}';
      const result = service.parseDecision(raw, 3);
      expect(result).toEqual({
        action: "clarify",
        questions: ["What is the scope?"],
        reason: "Need clarification",
        assumptions: ["User wants X"],
      });
    });

    it("should reject too many questions", () => {
      const raw = '{"action":"clarify","questions":["Q1","Q2","Q3","Q4"],"reason":"Test"}';
      const result = service.parseDecision(raw, 3);
      expect(result).toBeNull();
    });

    it("should reject yes/no only questions", () => {
      const raw = '{"action":"clarify","questions":["Is this correct?"],"reason":"Test"}';
      const result = service.parseDecision(raw, 3);
      expect(result).toBeNull();
    });

    it("should allow yes/no questions for major branches", () => {
      const raw = '{"action":"clarify","questions":["Is this a new or existing project?"],"reason":"Test"}';
      const result = service.parseDecision(raw, 3);
      expect(result).not.toBeNull();
    });

    it("should return null for invalid JSON", () => {
      const result = service.parseDecision("invalid json", 3);
      expect(result).toBeNull();
    });
  });

  describe("resolveDecision", () => {
    it("should return decision when valid", () => {
      const result = service.resolveDecision('{"action":"clarify","questions":["What?"],"reason":"Test"}', 3);
      expect(result.action).toBe("clarify");
    });

    it("should fallback to proceed on invalid input", () => {
      const result = service.resolveDecision("invalid", 3);
      expect(result).toEqual({ action: "proceed" });
    });
  });

  describe("buildPrompt", () => {
    it("should include user message", () => {
      const prompt = service.buildPrompt("Build a website", 3);
      expect(prompt).toContain("Build a website");
      expect(prompt).toContain("3");
    });
  });
});
