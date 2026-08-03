import type { FeedEntry } from '$lib/types';
import type { GoalChecklistItem } from '@koryphaios/shared';

const clean = (value: string): string => value
  .replace(/^#{1,6}\s+/, '')
  .replace(/^\*\*(.*?)\*\*:?$/, '$1')
  .replace(/[`*_]/g, '')
  .trim();

export function latestPlanText(entries: FeedEntry[]): string {
  return [...entries]
    .reverse()
    .find((entry) => entry.type === 'content' && entry.agentId !== 'user' && entry.text.trim().length > 0)
    ?.text.trim() ?? '';
}

export function originalPlanRequest(entries: FeedEntry[], fallback: string): string {
  return entries.find((entry) => entry.type === 'user_message' && entry.text.trim())?.text.trim()
    ?? fallback.trim()
    ?? 'Complete the approved plan';
}

export function checklistFromPlan(plan: string): GoalChecklistItem[] {
  const detailedSection = /(?:^|\n)#{1,6}\s+Detailed implementation plan\s*\n([\s\S]*?)(?=\n#{1,6}\s+|$)/i.exec(plan)?.[1];
  const source = detailedSection?.trim() || plan;
  const candidates = source.split('\n').flatMap((line) => {
    const numbered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    const checkbox = /^\s*[-*]\s+\[[ xX]\]\s+(.+)$/.exec(line);
    return numbered?.[1] || checkbox?.[1] ? [clean(numbered?.[1] ?? checkbox![1])] : [];
  }).filter((title) => title.length >= 4 && title.length <= 220).slice(0, 20);

  const titles = candidates.length >= 2
    ? candidates
    : ['Implement the approved plan', 'Verify every acceptance criterion'];
  const stamp = Date.now();
  return titles.map((title, order) => ({
    id: `plan-${order + 1}-${stamp}`,
    title,
    status: 'pending',
    order,
    dependsOn: order === 0 ? [] : [`plan-${order}-${stamp}`],
    evidence: [],
  }));
}

export function implementationPrompt(objective: string, plan: string): string {
  const approvedPlan = plan.replace(/\s*<!-- KORY_PLAN_READY -->\s*/g, '\n').trim();
  return `Implement this approved plan. Treat it as the authoritative starting context, inspect the current workspace before editing, and verify each acceptance criterion.\n\nObjective:\n${objective}\n\nApproved plan:\n${approvedPlan}`;
}
