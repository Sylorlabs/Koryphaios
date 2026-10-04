import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb, initDb } from '../../db';
import {
  getNote,
  listNoteRelationships,
  listNotes,
  proposeNoteRelationship,
  reviewNoteRelationship,
  syncProjectDocuments,
  unlinkNotes,
} from '../notes-service';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'kory-relationship-relocation-')));
const host = { provenance: 'agent' as const, actor: { sessionId: 'relocation-proposer' } };
beforeAll(async () => {
  await initDb();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function document(scope: string, path: string) {
  const note = (await listNotes(undefined, scope)).find((row) => row.sourcePath === path);
  expect(note).toBeDefined();
  return note!;
}

async function propose(scope: string, fromId: string, toId: string, evidence: string) {
  const from = (await getNote(fromId, scope))!;
  const to = (await getNote(toId, scope))!;
  return proposeNoteRelationship(
    {
      fromId,
      toId,
      type: 'supports',
      evidence,
      weight: 0.75,
      expectedSourceRevision: from.revision,
      expectedTargetRevision: to.revision,
    },
    scope,
    host,
  );
}

function history(scope: string) {
  return getDb()
    .query<
      {
        id: number;
        from_note_id: string;
        to_note_id: string;
        revision: number;
        action: string;
        snapshot_json: string;
      },
      [string]
    >(
      `SELECT id,from_note_id,to_note_id,revision,action,snapshot_json
    FROM note_relationship_history WHERE project_root=? ORDER BY id`,
    )
    .all(scope);
}

async function move(scope: string, from: string, to: string) {
  renameSync(join(scope, from), join(scope, to));
  expect(await syncProjectDocuments(scope)).toMatchObject({ identityRelocations: 1, removed: 0 });
  return document(scope, to);
}

describe('relationship revision safety across project-document relocation', () => {
  for (const direction of ['outgoing', 'incoming'] as const) {
    for (const reuse of [false, true]) {
      test(`${direction} relocation rejects old pair receipts${reuse ? ' with higher destination history' : ''}`, async () => {
        const scope = join(root, `${direction}-${reuse}`);
        mkdirSync(scope);
        writeFileSync(join(scope, 'c.md'), '# Original C\n');
        writeFileSync(join(scope, 'b.md'), '# Stable B\n');
        await syncProjectDocuments(scope);
        const c = await document(scope, 'c.md');
        const b = await document(scope, 'b.md');
        const pair = (id: string): [string, string] =>
          direction === 'outgoing' ? [id, b.id] : [b.id, id];
        let original = await propose(scope, ...pair(c.id), 'Original C evidence');
        if (reuse) {
          await unlinkNotes(...pair(c.id), { syncContent: false }, scope);
          original = await propose(scope, ...pair(c.id), 'Recreated C evidence');
          expect(original.revision).toBeGreaterThan(1);
        }
        const originalHistory = history(scope);
        const d = await move(scope, 'c.md', 'd.md');
        const movedOriginal = (
          await listNoteRelationships(scope, { fromId: pair(d.id)[0], toId: pair(d.id)[1] })
        )[0]!;
        expect(movedOriginal.revision).toBeGreaterThan(original.revision);

        writeFileSync(join(scope, 'a.md'), '# Unrelated A\n');
        await syncProjectDocuments(scope);
        const a = await document(scope, 'a.md');
        const replacement = await propose(scope, ...pair(a.id), 'Unrelated A evidence');
        expect(replacement.revision).toBe(1);
        const beforeRelocation = history(scope);
        const reusedC = await move(scope, 'a.md', 'c.md');
        expect(reusedC.id).toBe(c.id);
        const relationships = await listNoteRelationships(scope);
        expect(relationships).toHaveLength(2);
        expect(
          relationships.find((row) => row.fromId === pair(d.id)[0] && row.toId === pair(d.id)[1]),
        ).toEqual(movedOriginal);
        const relocated = relationships.find(
          (row) => row.fromId === pair(c.id)[0] && row.toId === pair(c.id)[1],
        )!;
        expect(relocated).toMatchObject({
          status: 'proposed',
          type: replacement.type,
          evidence: replacement.evidence,
          actor: replacement.actor,
          provenance: replacement.provenance,
          weight: replacement.weight,
          sourceRevision: replacement.sourceRevision,
          targetRevision: replacement.targetRevision,
          createdAt: replacement.createdAt,
          updatedAt: replacement.updatedAt,
          stale: true,
        });
        expect(relocated.revision).toBeGreaterThan(original.revision);
        expect(relocated.revision).toBeGreaterThan(replacement.revision);
        const afterRelocation = history(scope);
        expect(afterRelocation.slice(0, originalHistory.length)).toEqual(originalHistory);
        expect(afterRelocation.slice(0, beforeRelocation.length)).toEqual(beforeRelocation);
        expect(afterRelocation).toHaveLength(beforeRelocation.length + 1);
        expect(afterRelocation.at(-1)).toMatchObject({
          from_note_id: pair(c.id)[0],
          to_note_id: pair(c.id)[1],
          revision: relocated.revision,
          action: 'update',
        });
        expect(JSON.parse(afterRelocation.at(-1)!.snapshot_json)).toMatchObject({
          evidence: replacement.evidence,
          status: 'proposed',
          actor: host.actor,
          sourceRevision: replacement.sourceRevision,
          targetRevision: replacement.targetRevision,
        });
        await expect(
          reviewNoteRelationship(
            ...pair(c.id),
            {
              status: 'rejected',
              expectedRevision: original.revision,
            },
            scope,
            { provenance: 'user' },
          ),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(history(scope)).toEqual(afterRelocation);
        expect(await listNoteRelationships(scope)).toEqual(relationships);
        expect(
          await reviewNoteRelationship(
            ...pair(c.id),
            {
              status: 'rejected',
              expectedRevision: relocated.revision,
            },
            scope,
            { provenance: 'user' },
          ),
        ).toMatchObject({ status: 'rejected', revision: relocated.revision + 1 });
      });
    }
  }

  test('moves incoming and outgoing decisions together without changing snapshots or losing edges', async () => {
    const scope = join(root, 'all-statuses');
    mkdirSync(scope);
    for (const name of ['a', 'b', 'c'])
      writeFileSync(join(scope, `${name}.md`), `# Document ${name}\n`);
    await syncProjectDocuments(scope);
    const a = await document(scope, 'a.md');
    const b = await document(scope, 'b.md');
    const c = await document(scope, 'c.md');
    const accepted = await propose(scope, a.id, b.id, 'Accepted evidence');
    await reviewNoteRelationship(
      a.id,
      b.id,
      { status: 'accepted', expectedRevision: accepted.revision },
      scope,
      { provenance: 'user' },
    );
    const rejected = await propose(scope, b.id, a.id, 'Rejected evidence');
    await reviewNoteRelationship(
      b.id,
      a.id,
      { status: 'rejected', expectedRevision: rejected.revision },
      scope,
      { provenance: 'user' },
    );
    await propose(scope, a.id, c.id, 'Pending outgoing evidence');
    await propose(scope, c.id, a.id, 'Pending incoming evidence');
    const before = await listNoteRelationships(scope);
    const beforeHistory = history(scope);
    const moved = await move(scope, 'a.md', 'moved.md');
    const after = await listNoteRelationships(scope);
    expect(after).toHaveLength(before.length);
    for (const relationship of before) {
      expect(after).toContainEqual({
        ...relationship,
        fromId: relationship.fromId === a.id ? moved.id : relationship.fromId,
        toId: relationship.toId === a.id ? moved.id : relationship.toId,
        fromTitle: relationship.fromId === a.id ? moved.title : relationship.fromTitle,
        toTitle: relationship.toId === a.id ? moved.title : relationship.toTitle,
        revision: relationship.revision + 1,
        stale: true,
      });
    }
    expect(history(scope).slice(0, beforeHistory.length)).toEqual(beforeHistory);
    expect(history(scope)).toHaveLength(beforeHistory.length + before.length);
    expect(getDb().query('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
