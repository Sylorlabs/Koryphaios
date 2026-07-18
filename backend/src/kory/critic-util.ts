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
  unmetCriteria: z.array(z.string()),
});

export type CriticReport = z.infer<typeof CriticReportSchema>;

export function parseCriticReport(content: string): CriticReport | null {
  const candidate = content
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/```$/, '')
    .trim();
  try {
    const result = CriticReportSchema.safeParse(JSON.parse(candidate));
    if (!result.success) return null;
    if (
      result.data.verdict === 'PASS' &&
      result.data.findings.some((f) => f.severity !== 'minor')
    ) {
      return null;
    }
    return result.data;
  } catch {
    return null;
  }
}

/** Legacy plain verdict parsing remains strict; ambiguous prose can never pass. */
export function parseCriticVerdict(content: string): boolean {
  const report = parseCriticReport(content);
  if (report) return report.verdict === 'PASS';
  const lines = content
    .trim()
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const lastLine = lines[lines.length - 1] ?? '';
  const upper = lastLine.toUpperCase();
  if (upper === 'PASS') return true;
  if (upper.startsWith('FAIL')) return false;
  return false;
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
