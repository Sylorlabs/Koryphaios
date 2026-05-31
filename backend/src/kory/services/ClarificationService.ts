/**
 * ClarificationService
 * Handles user clarification requests when task requirements are ambiguous
 * Extracted from manager.ts - Domain: Intent clarification and user input validation
 */

import { z } from 'zod';
import { routingLog } from '../../logger';

// ─── Constants ────────────────────────────────────────────────────────────────

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

const MAJOR_BRANCH_QUESTION_PATTERNS = [
  /existing\s+project\s+or\s+new/i,
  /new\s+or\s+existing/i,
  /from\s+scratch\s+or\s+existing/i,
  /web\s+or\s+mobile/i,
  /frontend\s+or\s+backend/i,
  /local\s+or\s+production/i,
] as const;

const YES_NO_ONLY_START =
  /^(is|are|do|does|did|can|could|should|would|will|have|has|had|was|were|may)\b/i;

// ─── Schema Types ───────────────────────────────────────────────────────────────

const ClarifyProceedSchema = z.object({ action: z.literal('proceed') }).strict();
const ClarifyQuestionSchema = z.string().trim().min(1).max(140);
const ClarifySchema = z
  .object({
    action: z.literal('clarify'),
    questions: z.array(ClarifyQuestionSchema).min(1),
    reason: z.string().trim().min(1),
    assumptions: z.array(z.string().trim().min(1)).default([]),
  })
  .strict();

export type ClarificationDecision =
  | z.infer<typeof ClarifyProceedSchema>
  | z.infer<typeof ClarifySchema>;

// ─── Request/Response Types ────────────────────────────────────────────────────

export interface ClarificationRequest {
  taskId: string;
  question: string;
  context?: string;
  priority?: 'low' | 'medium' | 'high';
}

export interface ClarificationResponse {
  answer: string;
  followUpQuestions?: string[];
}

// ─── Utility Functions ───────────────────────────────────────────────────────────

/**
 * Extract a JSON object from a raw LLM response.
 * Expects the model to return valid JSON (as per prompt).
 */
function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('```json')) {
    const closed = trimmed.replace(/^```json\s*/, '').replace(/```$/, '').trim();
    return closed;
  }
  if (trimmed.startsWith('```')) {
    const closed = trimmed.replace(/^```\s*/, '').replace(/```$/, '').trim();
    return closed;
  }
  return trimmed;
}

/**
 * Check if a question is a "major branch" question that warrants a yes/no format.
 * These are questions that unlock fundamentally different execution paths.
 */
function isMajorBranchYesNoQuestion(question: string): boolean {
  return MAJOR_BRANCH_QUESTION_PATTERNS.some((pattern) => pattern.test(question));
}

/**
 * Check if a question is a disallowed yes/no-only question.
 * Disallows trivial yes/no questions unless they're major branch decisions.
 */
function isDisallowedYesNoOnlyQuestion(question: string): boolean {
  const normalized = question.trim();
  if (!normalized.endsWith('?')) return false;
  if (!YES_NO_ONLY_START.test(normalized)) return false;
  if (/\bor\b/i.test(normalized)) return false; // Allow "or" questions
  return !isMajorBranchYesNoQuestion(normalized);
}

// ─── ClarificationService Class ─────────────────────────────────────────────────

export class ClarificationService {
  private pendingClarifications = new Map<string, ClarificationRequest>();

  /**
   * Parse and validate a raw LLM response as a clarification decision.
   * Returns null if the response is invalid, ambiguous, or violates question rules.
   *
   * @param raw - Raw LLM response text
   * @param maxQuestions - Maximum allowed questions (from user configuration)
   * @returns Valid ClarificationDecision or null if invalid
   */
  parseClarificationDecision(raw: string, maxQuestions: number): ClarificationDecision | null {
    try {
      const parsed = JSON.parse(extractJsonObject(raw));

      // Try to parse as "proceed" decision
      const proceed = ClarifyProceedSchema.safeParse(parsed);
      if (proceed.success) return proceed.data;

      // Try to parse as "clarify" decision
      const clarify = ClarifySchema.safeParse(parsed);
      if (!clarify.success) return null;

      // Validate question count
      if (clarify.data.questions.length > maxQuestions) return null;

      // Validate no disallowed yes/no-only questions
      if (clarify.data.questions.some((question) => isDisallowedYesNoOnlyQuestion(question))) {
        return null;
      }

      return clarify.data;
    } catch {
      return null;
    }
  }

  /**
   * Resolve a clarification decision, falling back to "proceed" on any parse failure.
   * This is the safe default - if clarification fails, proceed with the task.
   *
   * @param raw - Raw LLM response text
   * @param maxQuestions - Maximum allowed questions
   * @returns Valid ClarificationDecision (defaults to "proceed")
   */
  resolveClarificationDecision(raw: string, maxQuestions: number): ClarificationDecision {
    return this.parseClarificationDecision(raw, maxQuestions) ?? { action: 'proceed' };
  }

  /**
   * Generate the system prompt for the clarification gate.
   * @returns The clarification system prompt string
   */
  getSystemPrompt(): string {
    return CLARIFICATION_SYSTEM_PROMPT;
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
    return !questions.some((question) => isDisallowedYesNoOnlyQuestion(question));
  }

  /**
   * Request clarification from the user
   */
  async requestClarification(request: ClarificationRequest): Promise<void> {
    routingLog.info({ taskId: request.taskId }, `Clarification needed: ${request.question}`);
    this.pendingClarifications.set(request.taskId, request);
  }

  /**
   * Submit a response to a clarification request
   */
  async submitResponse(taskId: string, response: ClarificationResponse): Promise<void> {
    const request = this.pendingClarifications.get(taskId);
    if (!request) {
      throw new Error(`No pending clarification for task ${taskId}`);
    }
    routingLog.info({ taskId }, 'Clarification response received');
    this.pendingClarifications.delete(taskId);
  }

  /**
   * Get pending clarification for a task
   */
  getPendingClarification(taskId: string): ClarificationRequest | undefined {
    return this.pendingClarifications.get(taskId);
  }

  /**
   * Check if a task has pending clarification
   */
  hasPendingClarification(taskId: string): boolean {
    return this.pendingClarifications.has(taskId);
  }
}

// ─── Singleton Instance ───────────────────────────────────────────────────────

export const clarificationService = new ClarificationService();

// ─── Standalone Functions (Backward Compatibility) ─────────────────────────────

/**
 * Parse and validate a raw LLM response as a clarification decision.
 * @deprecated Use clarificationService.parseClarificationDecision() instead
 */
export function parseClarificationDecision(
  raw: string,
  maxQuestions: number,
): ClarificationDecision | null {
  return clarificationService.parseClarificationDecision(raw, maxQuestions);
}

/**
 * Resolve a clarification decision, falling back to "proceed" on any parse failure.
 * @deprecated Use clarificationService.resolveClarificationDecision() instead
 */
export function resolveClarificationDecision(
  raw: string,
  maxQuestions: number,
): ClarificationDecision {
  return clarificationService.resolveClarificationDecision(raw, maxQuestions);
}
