import { describe, expect, test } from 'bun:test';
import { validatePlanReadiness } from './plan-mode';
import { ensurePlanNote, syncPlanNote } from './plan-mode';
import { deleteNote, getNote } from '../notes/notes-service';
import { nanoid } from 'nanoid';

describe('Plan mode readiness', () => {
  test('fails closed on a bare marker', () => {
    expect(validatePlanReadiness('<!-- KORY_PLAN_READY -->').ready).toBe(false);
  });

  test('requires actionable steps inside the detailed plan section', () => {
    const headings = [
      'Decision summary',
      'Current-state evidence',
      'Detailed implementation plan',
      'User journey and failure states',
      'Risks and alternatives',
      'Acceptance criteria',
      'Verification plan',
      'Remaining assumptions',
    ]
      .map((heading) => `## ${heading}\nText`)
      .join('\n');
    expect(validatePlanReadiness(`${headings}\n<!-- KORY_PLAN_READY -->`).missing).toContain(
      'actionable implementation steps',
    );
  });

  test('creates and updates one stable plan note for a session', async () => {
    const sessionId = `restart-${nanoid(8)}`;
    const note = await ensurePlanNote(sessionId, 'Build restart-safe planning');
    try {
      expect((await ensurePlanNote(sessionId, 'ignored')).id).toBe(note.id);
      await syncPlanNote(sessionId, 'Build restart-safe planning', 'Draft plan');
      expect((await getNote(note.id))?.content).toContain('Draft plan');
    } finally {
      await deleteNote(note.id);
    }
  });
});
