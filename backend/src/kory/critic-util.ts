/**
 * Critic gate utilities — parsing verdict and formatting transcripts.
 * Extracted for testability and single responsibility.
 */

import { z } from 'zod';

export const CriticReportSchema = z.object({
  verdict: z.enum(['PASS', 'FAIL']),
  findings: z.array(
    z.object({
      severity: z.enum(['critical', 'major', 'minor']),
      evidence: z.string().min(1),
      criterion: z.string().min(1),
      finding: z.string().min(1),
    }),
  ),
  checksReviewed: z.array(z.string()),
  criterionCoverage: z.array(
    z.object({
      criterion: z.string().min(1),
      evidence: z.string().min(1),
      status: z.enum(['verified', 'unmet']),
    }),
  ),
  unmetCriteria: z.array(z.string()),
});

export type CriticReport = z.infer<typeof CriticReportSchema>;

export function parseCriticReport(content: string, expectedCriteria: string[] = []): CriticReport | null {
  const candidate = content
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/```$/, '')
    .trim();
  try {
    const result = CriticReportSchema.safeParse(JSON.parse(candidate));
    if (!result.success) return null;
    if (result.data.verdict === 'PASS') {
      if (result.data.findings.some((f) => f.severity !== 'minor')) return null;
      if (result.data.checksReviewed.length === 0 || result.data.unmetCriteria.length > 0) return null;
      if (result.data.criterionCoverage.some((item) => item.status !== 'verified')) return null;
      const covered = new Set(result.data.criterionCoverage.map((item) => item.criterion));
      if (expectedCriteria.some((criterion) => !covered.has(criterion))) return null;
    }
    return result.data;
  } catch {
    return null;
  }
}

/** Only a complete structured report can pass. Legacy prose verdicts fail closed. */
export function parseCriticVerdict(content: string, expectedCriteria: string[] = []): boolean {
  return parseCriticReport(content, expectedCriteria)?.verdict === 'PASS';
}

export function deriveCriticBudget(input: {
  risk: 'low' | 'medium' | 'high';
  changedFiles?: number;
  changedLines?: number;
}): { maxTurns: number; maxTokens: number; transcriptChars: number; objectiveChars: number } {
  const sizeScore = Math.ceil((input.changedFiles ?? 0) / 5) + Math.ceil((input.changedLines ?? 0) / 250);
  const riskScore = input.risk === 'high' ? 2 : input.risk === 'medium' ? 1 : 0;
  const level = Math.min(3, riskScore + sizeScore);
  return {
    maxTurns: [5, 8, 12, 16][level]!,
    maxTokens: [2048, 4096, 6144, 8192][level]!,
    transcriptChars: [12_000, 24_000, 40_000, 64_000][level]!,
    objectiveChars: [2_000, 4_000, 8_000, 12_000][level]!,
  };
}

export function deriveSkillEvidenceCriteria(
  skills: Array<{ name: string; evidence: string[] }>,
): string[] {
  return [
    ...new Set(
      skills.flatMap((skill) =>
        skill.evidence.map((evidence) => `Skill evidence [${skill.name}]: ${evidence}`),
      ),
    ),
  ];
}

/** Format message list for critic prompt; truncate to maxLength to avoid token overflow. */
export function formatMessagesForCritic(
  messages: Array<{ role: string; content: string | any[] }>,
  maxLength: number = 12_000,
): string {
  const raw = messages
    .map((m) => {
      let text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      if (m.role === 'user') return `[MANAGER INSTRUCTION]\n${text}`;
      if (m.role === 'assistant') return `[WORKER OUTPUT]\n${text}`;
      if (m.role === 'tool') return `[WORKER TOOL RESULT]\n${text}`;
      return '';
    })
    .filter(Boolean)
    .join('\n\n---\n\n');
  if (raw.length <= maxLength) return raw;
  return raw.slice(0, maxLength) + '\n\n...[truncated]';
}
