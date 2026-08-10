import * as notes from '../notes/notes-service';
import { listQuestionDecisions } from '../stores/pending-question-store';

export const PLAN_READY_MARKER = '<!-- KORY_PLAN_READY -->';
const REQUIRED_PLAN_HEADINGS = [
  'Decision summary',
  'Current-state evidence',
  'Detailed implementation plan',
  'User journey and failure states',
  'Risks and alternatives',
  'Acceptance criteria',
  'Verification plan',
  'Remaining assumptions',
] as const;

export function validatePlanReadiness(content: string): { ready: boolean; missing: string[] } {
  const missing: string[] = REQUIRED_PLAN_HEADINGS.filter(
    (heading) =>
      !new RegExp(
        `(?:^|\\n)#{1,6}\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(?:\\n|$)`,
        'i',
      ).test(content),
  );
  if (!content.includes(PLAN_READY_MARKER)) missing.push('readiness marker');
  const detailed =
    /(?:^|\n)#{1,6}\s+Detailed implementation plan\s*\n([\s\S]*?)(?=\n#{1,6}\s+|$)/i.exec(
      content,
    )?.[1] ?? '';
  if (!/^\s*(?:\d+[.)]|[-*]\s+\[[ xX]\])\s+\S/m.test(detailed)) {
    missing.push('actionable implementation steps');
  }
  return { ready: missing.length === 0, missing };
}

function titleForSession(sessionId: string): string {
  return `Plan ${sessionId}`;
}

export async function ensurePlanNote(
  sessionId: string,
  objective: string,
  projectRoot?: string,
): Promise<{ id: string; title: string }> {
  const title = titleForSession(sessionId);
  const existing = await notes.getNoteByTitle(title, projectRoot);
  if (existing) return { id: existing.id, title: existing.title };
  const note = await notes.createNote(
    {
      title,
      folderPath: '/Plans',
      tags: ['kory-plan', `session:${sessionId}`],
      includeInContext: true,
      content: `# ${title}\n\nSession: ${sessionId}\n\n## Objective\n\n${objective.trim() || 'To be established.'}\n\n## Confirmed decisions\n\nNone yet.\n\n## Current plan\n\nPlanning is in progress.`,
    },
    projectRoot,
  );
  return { id: note.id, title: note.title };
}

export async function syncPlanNote(
  sessionId: string,
  objective: string,
  plan: string,
  projectRoot?: string,
): Promise<string> {
  const note = await ensurePlanNote(sessionId, objective, projectRoot);
  const decisions = await listQuestionDecisions(sessionId);
  const readiness = validatePlanReadiness(plan);
  await notes.updateNote(
    note.id,
    {
      includeInContext: true,
      content: `# ${note.title}\n\nSession: ${sessionId}\n\n## Objective\n\n${objective.trim() || 'To be established.'}\n\n## Confirmed decisions\n\n${decisions.length ? decisions.map((item) => `- ${item.replace(/\n/g, ' — ')}`).join('\n') : 'None recorded.'}\n\n## Readiness\n\n${readiness.ready ? 'Ready for explicit handoff.' : `Not ready. Missing: ${readiness.missing.join(', ')}.`}\n\n## Current plan\n\n${plan.trim() || 'Planning is in progress.'}`,
    },
    projectRoot,
  );
  return note.id;
}
