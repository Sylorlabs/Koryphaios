import { z } from 'zod';

export const ClarificationDecisionSchema = z.object({
  action: z.enum(['proceed', 'clarify']),
  questions: z.array(z.string().trim().min(1).max(140)).optional().default([]),
  reason: z.string().trim().optional(),
  assumptions: z.array(z.string().trim().min(1)).optional().default([]),
});

export type ClarificationDecision = z.infer<typeof ClarificationDecisionSchema>;

const MAJOR_BRANCH_QUESTION_PATTERNS = [
  /existing\s+project\s+or\s+new/i,
  /new\s+or\s+existing/i,
  /from\s+scratch\s+or\s+existing/i,
  /web\s+or\s+mobile/i,
  /frontend\s+or\s+backend/i,
  /local\s+or\s+production/i,
];

const YES_NO_ONLY_START = /^(is|are|do|does|did|can|could|should|would|will|have|has|had|was|were|may)\b/i;

function isMajorBranchYesNoQuestion(question: string): boolean {
  return MAJOR_BRANCH_QUESTION_PATTERNS.some((pattern) => pattern.test(question));
}

function isDisallowedYesNoOnlyQuestion(question: string): boolean {
  const normalized = question.trim();
  if (!normalized.endsWith('?')) return false;
  if (!YES_NO_ONLY_START.test(normalized)) return false;
  if (/\bor\b/i.test(normalized)) return false;
  return !isMajorBranchYesNoQuestion(normalized);
}

export function validateClarificationDecision(
  parsed: unknown,
  maxQuestions: number,
): ClarificationDecision | null {
  try {
    const result = ClarificationDecisionSchema.safeParse(parsed);
    if (!result.success) return null;
    
    if (result.data.action === 'clarify') {
      if ((result.data.questions?.length ?? 0) > maxQuestions) return null;
      if (result.data.questions?.some((q) => isDisallowedYesNoOnlyQuestion(q))) return null;
    }
    
    return result.data;
  } catch {
    return null;
  }
}
