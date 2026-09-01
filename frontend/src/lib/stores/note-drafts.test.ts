import { describe, expect, it } from 'vitest';
import type { NoteDraftSummary } from '@koryphaios/shared';
import { reviveNoteDraftSummary } from './note-drafts';

describe('durable Notes draft transport', () => {
  it('revives both wire timestamps before recovery UI consumes them', () => {
    const wire = {
      id: 'draft-1',
      noteId: 'note-1',
      baseRevision: 2,
      draftRevision: 3,
      baseTitle: 'Base',
      title: 'Draft',
      contentBytes: 12,
      createdAt: '2026-08-30T12:00:00.000Z',
      updatedAt: '2026-08-30T12:01:00.000Z',
      state: 'recoverable',
    } as unknown as NoteDraftSummary;

    const revived = reviveNoteDraftSummary(wire);
    expect(revived.createdAt).toBeInstanceOf(Date);
    expect(revived.updatedAt).toBeInstanceOf(Date);
    expect(revived.createdAt.toISOString()).toBe('2026-08-30T12:00:00.000Z');
  });
});
