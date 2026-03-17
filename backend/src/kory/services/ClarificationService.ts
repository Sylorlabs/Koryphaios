// ClarificationService - Handles intent clarification gate functionality
// Extracted from KoryManager to separate concerns
// Merged from clarification-service.ts (root) and services/ClarificationService.ts

import { z } from "zod";
import { koryLog } from "../../logger";

export const CLARIFICATION_SYSTEM_PROMPT = `You are a deterministic intent-clarification gate.
Return JSON only. No markdown. No prose outside JSON.

Output must be EXACTLY one schema:
1) {"action":"proceed"}
2) {"action":"clarify","questions":["..."],"reason":"...","assumptions":["..."]}

Rules:
- Ask clarification only if request is underspecified/ambiguous for safe execution.
- Questions must be short, specific, and answerable in one message.
- Avoid yes/no-only questions unless they unlock a major branch (example: existing project or new?).
- Maximum questions is provided by user prompt; never exceed it.`;

const ClarifyProceedSchema = z.object({ action: z.literal("proceed") }).strict();
const ClarifyQuestionSchema = z.string().trim().min(1).max(140);
const ClarifySchema = z.object({
  action: z.literal("clarify"),
  questions: z.array(ClarifyQuestionSchema).min(1),
  reason: z.string().trim().min(1),
  assumptions: z.array(z.string().trim().min(1)).default([]),
}).strict();

export type ClarificationDecision = z.infer<typeof ClarifyProceedSchema> | z.infer<typeof ClarifySchema>;

const MAJOR_BRANCH_QUESTION_PATTERNS = [
  /existing\s+project\s+or\s+new/i,
  /new\s+or\s+existing/i,
  /from\s+scratch\s+or\s+existing/i,
  /web\s+or\s+mobile/i,
  /frontend\s+or\s+backend/i,
  /local\s+or\s+production/i,
];

const YES_NO_ONLY_START = /^(is|are|do|does|did|can|could|should|would|will|have|has|had|was|were|may)\b/i;

export type ClarificationResult =
  | { action: "proceed" }
  | { action: "clarify"; questions: string[]; reason: string; assumptions: string[] };

export class ClarificationService {
  /**
   * Get the system prompt for the clarification gate.
   * @returns The clarification system prompt string
   */
  get systemPrompt(): string {
    return CLARIFICATION_SYSTEM_PROMPT;
  }

  /**
   * Generate the system prompt for the clarification gate.
   * Alias for systemPrompt getter for backward compatibility.
   * @returns The clarification system prompt string
   */
  getSystemPrompt(): string {
    return CLARIFICATION_SYSTEM_PROMPT;
  }

  /**
   * Extract JSON object from raw LLM response
   * Handles fenced code blocks and extracts the first complete object.
   */
  extractJsonObject(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) return trimmed;

    const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fencedMatch?.[1]) {
      const fenced = fencedMatch[1].trim();
      // Check for multiple objects in fenced block
      const objectStarts = (fenced.match(/\{/g) ?? []).length;
      const objectEnds = (fenced.match(/\}/g) ?? []).length;
      if (objectStarts > 1 && objectEnds > 1) return "";
      if (fenced.startsWith("{") && fenced.endsWith("}")) return fenced;
    }

    // Check for multiple JSON objects first
    const objectStarts = (trimmed.match(/\{/g) ?? []).length;
    const objectEnds = (trimmed.match(/\}/g) ?? []).length;
    if (objectStarts > 1 && objectEnds > 1) return "";

    if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;

    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first >= 0 && last > first) return trimmed.slice(first, last + 1);

    return trimmed;
  }

  private isMajorBranchYesNoQuestion(question: string): boolean {
    return MAJOR_BRANCH_QUESTION_PATTERNS.some((pattern) => pattern.test(question));
  }

  private isDisallowedYesNoOnlyQuestion(question: string): boolean {
    const normalized = question.trim();
    if (!normalized.endsWith("?")) return false;
    if (!YES_NO_ONLY_START.test(normalized)) return false;
    if (/\bor\b/i.test(normalized)) return false;
    return !this.isMajorBranchYesNoQuestion(normalized);
  }

  /**
   * Parse and validate clarification decision from LLM response
   * @param raw - Raw LLM response text
   * @param maxQuestions - Maximum allowed questions
   * @returns Valid ClarificationResult or null if invalid
   */
  parseDecision(raw: string, maxQuestions: number): ClarificationResult | null {
    try {
      const parsed = JSON.parse(this.extractJsonObject(raw));

      const proceed = ClarifyProceedSchema.safeParse(parsed);
      if (proceed.success) return proceed.data;

      const clarify = ClarifySchema.safeParse(parsed);
      if (!clarify.success) return null;

      if (clarify.data.questions.length > maxQuestions) return null;
      if (clarify.data.questions.some((q) => this.isDisallowedYesNoOnlyQuestion(q))) return null;

      return clarify.data;
    } catch (err) {
      koryLog.debug({ error: err instanceof Error ? err.message : String(err) }, "Failed to parse clarification decision");
      return null;
    }
  }

  /**
   * Parse and validate a raw LLM response as a clarification decision.
   * Alias for parseDecision for backward compatibility.
   * @param raw - Raw LLM response text
   * @param maxQuestions - Maximum allowed questions
   * @returns Valid ClarificationDecision or null if invalid
   */
  parseClarificationDecision(raw: string, maxQuestions: number): ClarificationDecision | null {
    return this.parseDecision(raw, maxQuestions);
  }

  /**
   * Resolve clarification with fallback to "proceed"
   * @param raw - Raw LLM response text
   * @param maxQuestions - Maximum allowed questions
   * @returns Valid ClarificationResult (defaults to "proceed")
   */
  resolveDecision(raw: string, maxQuestions: number): ClarificationResult {
    return this.parseDecision(raw, maxQuestions) ?? { action: "proceed" };
  }

  /**
   * Resolve a clarification decision, falling back to "proceed" on any parse failure.
   * Alias for resolveDecision for backward compatibility.
   * @param raw - Raw LLM response text
   * @param maxQuestions - Maximum allowed questions
   * @returns Valid ClarificationDecision (defaults to "proceed")
   */
  resolveClarificationDecision(raw: string, maxQuestions: number): ClarificationDecision {
    return this.resolveDecision(raw, maxQuestions);
  }

  /**
   * Build clarification prompt for LLM
   * @param userMessage - The user's message to analyze
   * @param maxQuestions - Maximum allowed questions
   * @returns Formatted prompt string
   */
  buildPrompt(userMessage: string, maxQuestions: number): string {
    return `Analyze this request and determine if clarification is needed:\n\n"""\n${userMessage}\n"""\n\nMaximum questions allowed: ${maxQuestions}`;
  }

  /**
   * Validate if a set of questions meets the clarification requirements.
   * @param questions - Array of questions to validate
   * @param maxQuestions - Maximum allowed questions
   * @returns true if questions are valid
   */
  validateQuestions(questions: string[], maxQuestions: number): boolean {
    if (questions.length === 0) return false;
    if (questions.length > maxQuestions) return false;
    return !questions.some((question) => this.isDisallowedYesNoOnlyQuestion(question));
  }
}

export const clarificationService = new ClarificationService();

// ─── Backward Compatibility Exports ────────────────────────────────────────────

/**
 * @deprecated Use clarificationService.parseClarificationDecision() instead
 */
export function parseClarificationDecision(raw: string, maxQuestions: number): ClarificationDecision | null {
  return clarificationService.parseClarificationDecision(raw, maxQuestions);
}

/**
 * @deprecated Use clarificationService.resolveClarificationDecision() instead
 */
export function resolveClarificationDecision(raw: string, maxQuestions: number): ClarificationDecision {
  return clarificationService.resolveClarificationDecision(raw, maxQuestions);
}
