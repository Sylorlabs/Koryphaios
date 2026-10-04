import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, getDb } from '../../db';
import { Database } from 'bun:sqlite';
import { MIGRATIONS } from '../../db/migrations';
import {
  createNote,
  getNote,
  getNoteOutlinks,
  expandNoteGraph,
  getGraphData,
  linkNotes,
  listNoteRelationships,
  proposeNoteRelationship,
  reviewNoteRelationship,
  syncProjectDocuments,
  unlinkNotes,
  updateNote,
} from '../notes-service';
import { retrieveNoteContext } from '../note-context';

const root = mkdtempSync(join(tmpdir(), 'kory-lifecycle-'));
const host = {
  provenance: 'agent' as const,
  actor: { sessionId: 'trusted-session', model: 'trusted-model' },
};
beforeAll(async () => {
  await initDb();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
async function pair(label: string) {
  const from = await createNote({ title: `${label} source`, content: 'Source evidence' }, root);
  const to = await createNote({ title: `${label} target`, content: 'Target evidence' }, root);
  const input = {
    fromId: from.id,
    toId: to.id,
    type: 'supports' as const,
    evidence: 'Explicit quoted supporting evidence',
    expectedSourceRevision: from.revision,
    expectedTargetRevision: to.revision,
  };
  return { from, to, input };
}
describe('typed relationship lifecycle', () => {
  test('0047 migrates existing explicit edges as accepted related_to with a legacy audit snapshot', () => {
    const database = new Database(':memory:');
    try {
      database.exec(
        "CREATE TABLE notes(id TEXT PRIMARY KEY); INSERT INTO notes VALUES ('source'),('target');",
      );
      database.exec(MIGRATIONS.find((row) => row.version === '0046')!.up);
      database.exec(
        "INSERT INTO note_relationships(from_note_id,to_note_id,project_root,source_revision,target_revision,created_at,updated_at) VALUES ('source','target','/project',1,1,10,10)",
      );
      database.exec(MIGRATIONS.find((row) => row.version === '0047')!.up);
      expect(database.query('SELECT type,status,actor_json FROM note_relationships').get()).toEqual(
        { type: 'related_to', status: 'accepted', actor_json: '{}' },
      );
      expect(database.query('SELECT action FROM note_relationship_history').get()).toEqual({
        action: 'legacy',
      });
      expect(() => database.exec("UPDATE note_relationships SET status='invented'")).toThrow();
      database.exec(MIGRATIONS.find((row) => row.version === '0048')!.up);
      expect(
        database.query("SELECT name FROM sqlite_master WHERE name='note_semantic_vectors'").get(),
      ).not.toBeNull();
    } finally {
      database.close();
    }
  });
  test('deleted/recreated pairs retain monotonic revisions and deleting actor audit', async () => {
    const { from, to, input } = await pair('ABA');
    const first = await proposeNoteRelationship(input, root, host);
    await unlinkNotes(
      from.id,
      to.id,
      { syncContent: false, provenance: 'agent', actor: { sessionId: 'deleting-session' } },
      root,
    );
    const source = (await getNote(from.id, root))!;
    const second = await proposeNoteRelationship(
      { ...input, expectedSourceRevision: source.revision },
      root,
      host,
    );
    expect(second.revision).toBeGreaterThan(first.revision);
    await expect(
      reviewNoteRelationship(
        from.id,
        to.id,
        { status: 'accepted', expectedRevision: first.revision },
        root,
        { provenance: 'user' },
      ),
    ).rejects.toThrow();
    const deleted = getDb()
      .query<{ snapshot_json: string }, [string]>(
        "SELECT snapshot_json FROM note_relationship_history WHERE from_note_id=? AND action='delete'",
      )
      .get(from.id)!;
    expect(JSON.parse(deleted.snapshot_json).actor.sessionId).toBe('deleting-session');
  });
  test('proposals are not traversal facts, acceptance is CAS and preserves typed provenance/history', async () => {
    const { from, to, input } = await pair('Accepted');
    const proposed = await proposeNoteRelationship(input, root, host);
    expect(proposed).toMatchObject({
      status: 'proposed',
      type: 'supports',
      revision: 1,
      stale: false,
      actor: host.actor,
    });
    expect(await getNoteOutlinks(from.id, root)).toEqual([]);
    expect((await expandNoteGraph([from.id], root)).edges).toEqual([]);
    expect(
      (await getGraphData(root)).edges.some((edge) => edge.from === from.id && edge.to === to.id),
    ).toBe(false);
    expect(
      (
        await retrieveNoteContext(
          { query: 'not-present-token', seedIds: [from.id], semantic: false },
          root,
        )
      ).results.some((row) => row.id === to.id),
    ).toBe(false);
    await expect(linkNotes(from.id, to.id, { syncContent: false }, root)).rejects.toThrow('review');
    await expect(
      reviewNoteRelationship(from.id, to.id, { status: 'accepted', expectedRevision: 2 }, root, {
        provenance: 'user',
      }),
    ).rejects.toThrow();
    const accepted = await reviewNoteRelationship(
      from.id,
      to.id,
      { status: 'accepted', expectedRevision: 1 },
      root,
      { provenance: 'user' },
    );
    expect(accepted).toMatchObject({ status: 'accepted', revision: 2, provenance: 'user' });
    expect((await getNoteOutlinks(from.id, root)).map((note) => note.id)).toEqual([to.id]);
    expect((await expandNoteGraph([from.id], root)).edges[0]).toMatchObject({
      type: 'supports',
      status: 'accepted',
    });
    const history = getDb()
      .query<{ action: string; snapshot_json: string }, [string]>(
        'SELECT action,snapshot_json FROM note_relationship_history WHERE from_note_id=? ORDER BY id',
      )
      .all(from.id);
    expect(history.map((row) => row.action)).toEqual(['insert', 'update']);
    expect(JSON.parse(history[0]!.snapshot_json)).toMatchObject({
      status: 'proposed',
      actor: host.actor,
    });
    expect(JSON.parse(history[1]!.snapshot_json)).toMatchObject({
      status: 'accepted',
      provenance: 'user',
    });
    expect((await getNote(from.id, root))?.revision).toBe(from.revision);
    await expect(
      reviewNoteRelationship(from.id, to.id, { status: 'rejected', expectedRevision: 2 }, root, {
        provenance: 'user',
      }),
    ).rejects.toThrow();
  });
  test('rejection never enters normal traversal and cannot be silently reproposed', async () => {
    const { from, to, input } = await pair('Rejected');
    await proposeNoteRelationship(input, root, host);
    await reviewNoteRelationship(
      from.id,
      to.id,
      { status: 'rejected', expectedRevision: 1 },
      root,
      { provenance: 'user' },
    );
    expect(
      (await listNoteRelationships(root, { noteId: from.id, status: 'rejected' }))[0]?.revision,
    ).toBe(2);
    expect((await expandNoteGraph([from.id], root)).edges).toEqual([]);
    await expect(proposeNoteRelationship(input, root, host)).rejects.toThrow();
  });
  test('stale endpoints reject proposals/acceptance but still allow explicit rejection', async () => {
    const { from, to, input } = await pair('Stale');
    await expect(
      proposeNoteRelationship({ ...input, expectedTargetRevision: 2 }, root, host),
    ).rejects.toThrow();
    await proposeNoteRelationship(input, root, host);
    await updateNote(to.id, { content: 'Changed evidence', expectedRevision: to.revision }, root);
    expect((await listNoteRelationships(root, { noteId: from.id }))[0]?.stale).toBe(true);
    await expect(
      reviewNoteRelationship(from.id, to.id, { status: 'accepted', expectedRevision: 1 }, root, {
        provenance: 'user',
      }),
    ).rejects.toThrow('Stale');
    expect(
      (
        await reviewNoteRelationship(
          from.id,
          to.id,
          { status: 'rejected', expectedRevision: 1 },
          root,
          { provenance: 'user' },
        )
      ).status,
    ).toBe('rejected');
  });
  test('project isolation, evidence limits and unknown types fail closed', async () => {
    const { input } = await pair('Scoped');
    for (const bad of [
      { evidence: ' ' },
      { evidence: 'x'.repeat(2001) },
      { type: 'invented' },
      { weight: 0 },
    ])
      await expect(
        proposeNoteRelationship({ ...input, ...bad } as typeof input, root, host),
      ).rejects.toThrow();
    await expect(proposeNoteRelationship(input, join(root, 'other'), host)).rejects.toThrow();
    await proposeNoteRelationship(input, root, host);
    expect(await listNoteRelationships(join(root, 'other'))).toEqual([]);
    await expect(
      reviewNoteRelationship(
        input.fromId,
        input.toId,
        { status: 'accepted', expectedRevision: 1 },
        join(root, 'other'),
        { provenance: 'user' },
      ),
    ).rejects.toThrow();
  });
  test('legacy explicit links default to accepted related_to and document references remain distinct', async () => {
    const { from, to } = await pair('Legacy');
    await linkNotes(from.id, to.id, { syncContent: false }, root);
    expect((await listNoteRelationships(root, { noteId: from.id }))[0]).toMatchObject({
      type: 'related_to',
      status: 'accepted',
    });
    await updateNote(from.id, { content: `[[${to.title}]]` }, root);
    expect((await expandNoteGraph([from.id], root)).edges.map((edge) => edge.kind).sort()).toEqual([
      'association',
      'document_link',
    ]);
  });
  test('new title, rename and later project sync resolve existing forward references', async () => {
    const source = await createNote(
      { title: 'Forward source', content: '[[Future title]] [[Renamed title]] [[Future disk]]' },
      root,
    );
    const future = await createNote({ title: 'Future title' }, root);
    expect((await getNoteOutlinks(source.id, root)).map((row) => row.id)).toContain(future.id);
    const renamed = await createNote({ title: 'Before rename' }, root);
    await updateNote(renamed.id, { title: 'Renamed title' }, root);
    expect((await getNoteOutlinks(source.id, root)).map((row) => row.id)).toContain(renamed.id);
    writeFileSync(join(root, 'Future disk.md'), '# Future disk\n');
    await syncProjectDocuments(root);
    expect((await getNoteOutlinks(source.id, root)).map((row) => row.title)).toContain(
      'Future disk',
    );
  });
});
