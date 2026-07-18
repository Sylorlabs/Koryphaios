import { z } from 'zod';
import type { TaskKind } from './prompts';

export const ClarificationDecisionSchema = z.object({
  action: z.enum(['proceed', 'clarify']),
  questions: z.array(z.string().trim().min(1).max(140)).optional().default([]),
  reason: z.string().trim().optional(),
  assumptions: z.array(z.string().trim().min(1)).optional().default([]),
});

export type ClarificationDecision = z.infer<typeof ClarificationDecisionSchema>;

export interface IntentQuestion {
  id: string;
  question: string;
  options: string[];
}

const STOP_OPTION = 'Stop asking and implement now';

/** Deterministic discovery is deliberately conservative; repository inspection remains preferred. */
export function buildIntentDiscoveryBatch(
  request: string,
  taskKind: TaskKind,
  depth: 'off' | 'adaptive' | 'deep',
): IntentQuestion[] {
  if (depth === 'off') return [];
  const text = request.trim().toLowerCase();
  const vague =
    text.length < 45 ||
    /\b(make it better|improve it|build something|fix it|modernize)\b/.test(text);
  if (depth === 'adaptive' && !vague) return [];

  const questions: IntentQuestion[] = [];
  if (taskKind === 'ui') {
    questions.push({
      id: 'ui_direction',
      question: 'Which design authority should lead this interface work?',
      options: [
        'Existing project toolkit and patterns (Recommended)',
        'Establish a new cross-medium toolkit',
        'Match a supplied reference closely',
        STOP_OPTION,
      ],
    });
  } else if (taskKind === 'feature' || taskKind === 'refactor') {
    questions.push({
      id: 'change_priority',
      question: 'Which tradeoff should lead this change?',
      options: [
        'Smallest compatible change (Recommended)',
        'Broader architecture improvement',
        'Fast experimental path',
        STOP_OPTION,
      ],
    });
  }
  if (depth === 'deep' && questions.length < 3) {
    questions.push({
      id: 'evidence_priority',
      question: 'Which evidence matters most for acceptance?',
      options: [
        'Repository tests and real runtime flow (Recommended)',
        'Human visual comparison',
        'Performance measurements',
        STOP_OPTION,
      ],
    });
  }
  return questions.slice(0, 3);
}

const MAJOR_BRANCH_QUESTION_PATTERNS = [
  /existing\s+project\s+or\s+new/i,
  /new\s+or\s+existing/i,
  /from\s+scratch\s+or\s+existing/i,
  /web\s+or\s+mobile/i,
  /frontend\s+or\s+backend/i,
  /local\s+or\s+production/i,
];

const YES_NO_ONLY_START =
  /^(is|are|do|does|did|can|could|should|would|will|have|has|had|was|were|may)\b/i;

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
