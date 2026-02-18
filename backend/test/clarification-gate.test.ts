import { describe, expect, test } from "bun:test";
import { parseClarificationDecision, resolveClarificationDecision } from "../src/kory/manager";

describe("clarification gate decision parsing", () => {
  test("parses a valid proceed payload", () => {
    const decision = parseClarificationDecision('{"action":"proceed"}', 4);
    expect(decision).toEqual({ action: "proceed" });
  });

  test("enforces maxClarifyQuestions", () => {
    const raw = JSON.stringify({
      action: "clarify",
      questions: ["Q1?", "Q2?", "Q3?"],
      reason: "Need constraints",
      assumptions: [],
    });

    const decision = parseClarificationDecision(raw, 2);
    expect(decision).toBeNull();
  });

  test("falls back to proceed on invalid JSON", () => {
    const decision = resolveClarificationDecision("not-json-response", 4);
    expect(decision).toEqual({ action: "proceed" });
  });

  test("rejects disallowed yes/no-only clarification questions", () => {
    const raw = JSON.stringify({
      action: "clarify",
      questions: ["Is this okay?"],
      reason: "Need user direction",
      assumptions: [],
    });

    const decision = parseClarificationDecision(raw, 4);
    expect(decision).toBeNull();
  });

  test("rejects responses with extra keys (strict schema)", () => {
    const raw = JSON.stringify({ action: "proceed", foo: "bar" });
    const decision = parseClarificationDecision(raw, 4);
    expect(decision).toBeNull();
  });

  test("rejects ambiguous output containing multiple JSON objects", () => {
    const raw = '{"action":"proceed"}\n{"action":"proceed"}';
    const decision = parseClarificationDecision(raw, 4);
    expect(decision).toBeNull();
  });
});
