import { describe, expect, test } from 'vitest';
import type { NoteDraft } from '@koryphaios/shared';
import {
  DurableNoteDraftBackup,
  type DurableDraftScope,
  type DurableDraftSnapshot,
  type DurableDraftTransport,
} from './durable-note-draft';

const scope: DurableDraftScope = {
  projectPath: '/project-a',
  noteId: 'note-a',
  baseRevision: 4,
  baseTitle: 'Draft safety',
};
const snapshot: DurableDraftSnapshot = {
  title: 'Draft safety',
  content: 'first',
  folderPath: '/',
  tags: [],
  pinned: false,
  includeInContext: false,
  format: 'markdown',
};

function stored(id: string, revision: number, value: DurableDraftSnapshot): NoteDraft {
  return {
    id,
    noteId: scope.noteId,
    baseRevision: scope.baseRevision,
    draftRevision: revision,
    baseTitle: scope.baseTitle,
    title: value.title,
    content: value.content,
    contentBytes: value.content.length,
    folderPath: value.folderPath,
    tags: value.tags,
    pinned: value.pinned,
    includeInContext: value.includeInContext,
    format: value.format,
    state: 'recoverable',
    currentRevision: scope.baseRevision,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

describe('DurableNoteDraftBackup', () => {
  test('serializes edits and acknowledges the newest snapshot', async () => {
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const transport: DurableDraftTransport = {
      async create(_scope, value) {
        calls.push(`create:${value.content}`);
        await gate;
        return stored('draft-a', 1, value);
      },
      async update(_scope, _id, revision, value) {
        calls.push(`update:${revision}:${value.content}`);
        return stored('draft-a', revision + 1, value);
      },
      async discard() {},
    };
    const backup = new DurableNoteDraftBackup(transport);
    backup.start(scope);
    backup.markEdited(snapshot, 60_000, 60_000);
    const first = backup.flush();
    backup.markEdited({ ...snapshot, content: 'second' }, 60_000, 60_000);
    release();
    expect(await first).toBe(true);
    expect(backup.status.acknowledgedEditVersion).toBe(2);
    expect(backup.status.state).toBe('backed-up');
    expect(calls).toEqual(['create:first', 'update:1:second']);
  });

  test('keeps an unacknowledged conflict visible', async () => {
    const conflict = Object.assign(new Error('Draft changed elsewhere'), { status: 409 });
    const transport: DurableDraftTransport = {
      async create() {
        throw conflict;
      },
      async update() {
        throw conflict;
      },
      async discard() {},
    };
    const backup = new DurableNoteDraftBackup(transport);
    backup.start(scope);
    backup.markEdited(snapshot, 60_000, 60_000);
    expect(await backup.flush()).toBe(false);
    expect(backup.hasUnbackedChanges).toBe(true);
    expect(backup.status.state).toBe('conflict');
  });

  test('creates a new acknowledged branch before discarding an old saved base', async () => {
    const calls: string[] = [];
    let revision = 0;
    const transport: DurableDraftTransport = {
      async create(nextScope, value) {
        calls.push(`create@${nextScope.baseRevision}:${value.content}`);
        revision = 1;
        return { ...stored(`draft-${nextScope.baseRevision}`, revision, value), baseRevision: nextScope.baseRevision };
      },
      async update(nextScope, id, expected, value) {
        calls.push(`update@${nextScope.baseRevision}:${id}:${value.content}`);
        revision = expected + 1;
        return { ...stored(id, revision, value), baseRevision: nextScope.baseRevision };
      },
      async discard(nextScope, id) {
        calls.push(`discard@${nextScope.baseRevision}:${id}`);
      },
    };
    const backup = new DurableNoteDraftBackup(transport);
    backup.start(scope);
    backup.markEdited(snapshot, 60_000, 60_000);
    await backup.flush();
    const savedVersion = backup.status.editVersion;
    backup.markEdited({ ...snapshot, content: 'newer' }, 60_000, 60_000);
    expect(
      await backup.afterAuthoritativeSave(savedVersion, 5, { ...snapshot, content: 'newer' }),
    ).toBe(true);
    expect(calls).toEqual([
      'create@4:first',
      'update@4:draft-4:newer',
      'create@5:newer',
      'discard@4:draft-4',
    ]);
    expect(backup.status.state).toBe('backed-up');
  });
});
