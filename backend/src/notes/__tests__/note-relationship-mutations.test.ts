import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb, initDb } from '../../db';
import {
  createNote,
  expandNoteGraph,
  getNote,
  getNoteOutlinks,
  linkNotes,
  listNotes,
  parseAndSaveLinks,
  syncProjectDocuments,
  unlinkNotes,
  updateNote,
} from '../notes-service';

const root = mkdtempSync(join(tmpdir(), 'kory-association-mutations-'));
beforeAll(async () => {
  await initDb();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('revision-safe association mutations', () => {
  test('rejects stale source and association revisions without changing content or evidence', async () => {
    const source = await createNote({ title: 'CAS source', content: 'original' }, root);
    const target = await createNote({ title: 'CAS target' }, root);
    await linkNotes(
      source.id,
      target.id,
      {
        syncContent: false,
        expectedRevision: source.revision,
        expectedRelationshipRevision: 0,
        provenance: 'agent',
        evidence: 'Reviewed design dependency',
        weight: 0.8,
      },
      root,
    );
    const current = (await getNote(source.id, root))!;
    expect(current.revision).toBe(source.revision + 1);
    await expect(
      linkNotes(
        source.id,
        target.id,
        {
          expectedRevision: source.revision,
          evidence: 'stale overwrite',
        },
        root,
      ),
    ).rejects.toThrow();
    await expect(
      unlinkNotes(
        source.id,
        target.id,
        {
          expectedRevision: current.revision,
          expectedRelationshipRevision: 0,
        },
        root,
      ),
    ).rejects.toThrow();
    expect((await getNote(source.id, root))?.content).toBe('original');
    const graph = await expandNoteGraph([source.id], root);
    expect(graph.edges[0]).toMatchObject({
      kind: 'association',
      provenance: 'agent',
      evidence: 'Reviewed design dependency',
      weight: 0.8,
      revision: 1,
      sourceRevision: current.revision,
      targetRevision: target.revision,
      stale: false,
    });
    await updateNote(target.id, { content: 'changed after confirmation' }, root);
    expect((await expandNoteGraph([source.id], root)).edges[0]?.stale).toBe(true);
  });

  test('an old content reparse cannot replace current document links', async () => {
    const first = await createNote({ title: 'Old parse target' }, root);
    const second = await createNote({ title: 'Current parse target' }, root);
    const source = await createNote(
      { title: 'Parse source', content: '[[Old parse target]]' },
      root,
    );
    await updateNote(source.id, { content: '[[Current parse target]]' }, root);
    await expect(
      parseAndSaveLinks(source.id, source.content, { projectRoot: root }),
    ).rejects.toThrow();
    expect((await getNoteOutlinks(source.id, root)).map((note) => note.id)).toEqual([second.id]);
    expect((await getNoteOutlinks(source.id, root)).map((note) => note.id)).not.toContain(first.id);
  });

  test('derived-edge database failure rolls back synchronized relationship, source, history, and file', async () => {
    const original = '# Atomic file\n\nPreserve this source.\n';
    const file = join(root, 'atomic-source.md');
    writeFileSync(file, original);
    await syncProjectDocuments(root);
    const source = (await listNotes(undefined, root)).find(
      (note) => note.sourcePath === 'atomic-source.md',
    )!;
    const target = await createNote({ title: 'Atomic association target' }, root);
    const sqlite = getDb();
    sqlite.exec(`CREATE TRIGGER test_association_derived_abort BEFORE INSERT ON note_links
      WHEN NEW.from_note_id = '${source.id}' BEGIN SELECT RAISE(ABORT, 'forced derived failure'); END;`);
    try {
      await expect(linkNotes(source.id, target.id, { syncContent: true }, root)).rejects.toThrow();
      expect((await getNote(source.id, root))?.revision).toBe(source.revision);
      expect((await getNote(source.id, root))?.content).toBe(original);
      expect(readFileSync(file, 'utf8')).toBe(original);
      expect(await getNoteOutlinks(source.id, root)).toEqual([]);
      expect(
        sqlite
          .query<{ count: number }, [string]>(
            'SELECT count(*) AS count FROM note_relationships WHERE from_note_id = ?',
          )
          .get(source.id)?.count,
      ).toBe(0);
      expect(
        sqlite
          .query<{ revision: number }, [string]>(
            'SELECT max(revision) AS revision FROM note_revisions WHERE note_id = ?',
          )
          .get(source.id)?.revision,
      ).toBe(source.revision);
    } finally {
      sqlite.exec('DROP TRIGGER test_association_derived_abort');
    }
  });
});
