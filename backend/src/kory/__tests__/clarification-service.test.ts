// Clarification Service Tests
// Domain: Unit tests for intent clarification and user input validation

import { describe, it, expect, beforeEach } from "bun:test";
import {
  clarificationService,
  parseClarificationDecision,
  resolveClarificationDecision,
  CLARIFICATION_SYSTEM_PROMPT,
} from "../clarification-service";

describe("ClarificationService", () => {
  describe("parseClarificationDecision", () => {
    it("should parse valid proceed decision", () => {
      const raw = JSON.stringify({ action: "proceed" });
      const result = clarificationService.parseClarificationDecision(raw, 3);
      expect(result).toEqual({ action: "proceed" });
    });

    it("should parse valid clarify decision within question limit", () => {
      const raw = JSON.stringify({
        action: "clarify",
        questions: ["What is your name?", "How old are you?"],
        reason: "Need user info",
        assumptions: ["User is new"]
      });
      const result = clarificationService.parseClarificationDecision(raw, 3);
      expect(result).toEqual({
        action: "clarify",
        questions: ["What is your name?", "How old are you?"],
        reason: "Need user info",
        assumptions: ["User is new"]
      });
    });

    it("should reject clarify decision with too many questions", () => {
      const raw = JSON.stringify({
        action: "clarify",
        questions: ["Q1?", "Q2?", "Q3?", "Q4?"],
        reason: "Too many",
        assumptions: []
      });
      const result = clarificationService.parseClarificationDecision(raw, 3);
      expect(result).toBeNull();
    });

    it("should reject clarify decision with disallowed yes/no-only question", () => {
      const raw = JSON.stringify({
        action: "clarify",
        questions: ["Are you sure?"], // Disallowed: yes/no-only without "or"
        reason: "Confirmation needed",
        assumptions: []
      });
      const result = clarificationService.parseClarificationDecision(raw, 3);
      expect(result).toBeNull();
    });

    it("should allow major branch yes/no questions", () => {
      const raw = JSON.stringify({
        action: "clarify",
        questions: ["New or existing project?"], // Major branch pattern
        reason: "Project type unclear",
        assumptions: []
      });
      const result = clarificationService.parseClarificationDecision(raw, 3);
      expect(result).toEqual({
        action: "clarify",
        questions: ["New or existing project?"],
        reason: "Project type unclear",
        assumptions: []
      });
    });

    it("should reject questions exceeding 140 characters", () => {
      const raw = JSON.stringify({
        action: "clarify",
        questions: [Array(150).fill("a").join("")], // Too long
        reason: "Too long",
        assumptions: []
      });
      const result = clarificationService.parseClarificationDecision(raw, 3);
      expect(result).toBeNull();
    });

    it("should handle fenced code blocks with JSON", () => {
      const raw = `Some text
\`\`\`json
{ "action": "proceed" }
\`\`\`
More text`;
      const result = clarificationService.parseClarificationDecision(raw, 3);
      expect(result).toEqual({ action: "proceed" });
    });

    it("should handle malformed JSON gracefully", () => {
      const result = clarificationService.parseClarificationDecision("not json", 3);
      expect(result).toBeNull();
    });

    it("should handle empty string", () => {
      const result = clarificationService.parseClarificationDecision("", 3);
      expect(result).toBeNull();
    });

    it("should handle mixed content with JSON object", () => {
      const raw = `Here's my thinking: {"action": "proceed"} that's it`;
      const result = clarificationService.parseClarificationDecision(raw, 3);
      expect(result).toEqual({ action: "proceed" });
    });

    it("should reject multiple JSON objects", () => {
      const raw = `{"action":"proceed"} {"action":"proceed"}`;
      const result = clarificationService.parseClarificationDecision(raw, 3);
      expect(result).toBeNull(); // Ambiguous: multiple objects
    });
  });

  describe("resolveClarificationDecision", () => {
    it("should return parsed decision on success", () => {
      const raw = JSON.stringify({ action: "proceed" });
      const result = clarificationService.resolveClarificationDecision(raw, 3);
      expect(result).toEqual({ action: "proceed" });
    });

    it("should fallback to proceed on parse error", () => {
      const result = clarificationService.resolveClarificationDecision("invalid json", 3);
      expect(result).toEqual({ action: "proceed" });
    });

    it("should fallback to proceed on null result", () => {
      const raw = JSON.stringify({
        action: "clarify",
        questions: ["Q1?", "Q2?", "Q3?", "Q4?"], // Too many
        reason: "Test",
        assumptions: []
      });
      const result = clarificationService.resolveClarificationDecision(raw, 3);
      expect(result).toEqual({ action: "proceed" }); // Fallback
    });
  });

  describe("validateQuestions", () => {
    it("should validate questions within limit", () => {
      const questions = ["Valid question 1?", "Valid question 2?"];
      const result = clarificationService.validateQuestions(questions, 3);
      expect(result).toBe(true);
    });

    it("should reject empty questions array", () => {
      const result = clarificationService.validateQuestions([], 3);
      expect(result).toBe(false);
    });

    it("should reject questions exceeding limit", () => {
      const questions = ["Q1?", "Q2?", "Q3?", "Q4?"];
      const result = clarificationService.validateQuestions(questions, 3);
      expect(result).toBe(false);
    });

    it("should reject disallowed yes/no-only questions", () => {
      const questions = ["Is this correct?"]; // Disallowed
      const result = clarificationService.validateQuestions(questions, 3);
      expect(result).toBe(false);
    });
  });

  describe("getSystemPrompt", () => {
    it("should return the clarification system prompt", () => {
      const prompt = clarificationService.getSystemPrompt();
      expect(prompt).toBe(CLARIFICATION_SYSTEM_PROMPT);
      expect(prompt).toContain("Return JSON only");
      expect(prompt).toContain("Maximum questions");
    });
  });

  describe("Backward Compatibility", () => {
    describe("parseClarificationDecision function", () => {
      it("should work as standalone function", () => {
        const raw = JSON.stringify({ action: "proceed" });
        const result = parseClarificationDecision(raw, 3);
        expect(result).toEqual({ action: "proceed" });
      });

      it("should return null for invalid input", () => {
        const result = parseClarificationDecision("invalid", 3);
        expect(result).toBeNull();
      });
    });

    describe("resolveClarificationDecision function", () => {
      it("should resolve successfully", () => {
        const raw = JSON.stringify({ action: "proceed" });
        const result = resolveClarificationDecision(raw, 3);
        expect(result).toEqual({ action: "proceed" });
      });

      it("should fallback to proceed on error", () => {
        const result = resolveClarificationDecision("invalid", 3);
        expect(result).toEqual({ action: "proceed" });
      });
    });
  });
});

describe("Clarification Edge Cases", () => {
  it("should handle questions with 'or' correctly", () => {
    const raw = JSON.stringify({
      action: "clarify",
      questions: ["Use frontend or backend?"], // Has "or"
      reason: "Stack unclear",
      assumptions: []
    });
    const result = clarificationService.parseClarificationDecision(raw, 3);
    expect(result).toEqual({
      action: "clarify",
      questions: ["Use frontend or backend?"],
      reason: "Stack unclear",
      assumptions: []
    });
  });

  it("should allow questions ending without question mark (non-yes/no)", () => {
    const raw = JSON.stringify({
      action: "clarify",
      questions: ["What is your name"], // No question mark, but not yes/no-only
      reason: "Info needed",
      assumptions: []
    });
    const result = clarificationService.parseClarificationDecision(raw, 3);
    // Questions without ? are not rejected unless they're yes/no-only questions
    expect(result).toEqual({
      action: "clarify",
      questions: ["What is your name"],
      reason: "Info needed",
      assumptions: []
    });
  });

  it("should handle very long questions", () => {
    const longQuestion = "A".repeat(139) + "?"; // 139 chars + question mark = 140 total
    const raw = JSON.stringify({
      action: "clarify",
      questions: [longQuestion],
      reason: "Test",
      assumptions: []
    });
    const result = clarificationService.parseClarificationDecision(raw, 3);
    expect(result).toEqual({
      action: "clarify",
      questions: [longQuestion],
      reason: "Test",
      assumptions: []
    });
  });

  it("should handle questions with special characters", () => {
    const raw = JSON.stringify({
      action: "clarify",
      questions: ["Use API key: <key> or token?"],
      reason: "Auth method",
      assumptions: []
    });
    const result = clarificationService.parseClarificationDecision(raw, 3);
    expect(result).toEqual({
      action: "clarify",
      questions: ["Use API key: <key> or token?"],
      reason: "Auth method",
      assumptions: []
    });
  });
});
