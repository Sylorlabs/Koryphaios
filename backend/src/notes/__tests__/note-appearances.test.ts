import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb, initDb } from '../../db';
import { createNote, proposeNoteRelationship, reviewNoteRelationship } from '../notes-service';
import { createNoteBase } from '../note-bases-service';
import { listNoteAppearances } from '../note-appearances';

const root = mkdtempSync(join(tmpdir(), 'kory-appearances-'));
const host = { provenance: 'agent' as const, actor: { sessionId: 'appearance-test' } };
beforeAll(async () => {
  await initDb();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('note appearance discovery', () => {
  test('aggregates document backlinks, relationship pairs, canvas cards and Base membership', async () => {
    const target = await createNote({ title: 'Appearance target', content: 'Body' }, root);
    // Document backlink through a [[wikilink]] parsed at creation.
    await createNote({ title: 'Appearance linker', content: `See [[${target.title}]]` }, root);

    // Relationship pair where the target is the incoming endpoint.
    const source = await createNote({ title: 'Appearance source' }, root);
    const proposal = await proposeNoteRelationship(
      {
        fromId: source.id,
        toId: target.id,
        type: 'supports',
        evidence: 'Quoted supporting passage',
        expectedSourceRevision: source.revision,
        expectedTargetRevision: target.revision,
      },
      root,
      host,
    );
    await reviewNoteRelationship(
      source.id,
      target.id,
      { status: 'accepted', expectedRevision: proposal.revision },
      root,
      host,
    );

    // Canvas card referencing the note, plus a board that does not.
    await createNote(
      {
        title: 'Appearance board',
        tags: ['canvas'],
        content: JSON.stringify({
          v: 1,
          name: 'Appearance board',
          cards: [
            {
              id: 'card-1',
              x: 0,
              y: 0,
              w: 200,
              h: 120,
              text: 'The target lives here',
              noteId: target.id,
              color: '#336699',
            },
          ],
          edges: [],
        }),
      },
      root,
    );

    // Saved Base whose deterministic query contains the note.
    const base = createNoteBase(
      {
        name: 'Everything',
        definition: {
          version: 1,
          sort: [],
          view: { kind: 'table', fields: [{ source: 'system', field: 'title' }] },
        },
      },
      root,
    );

    const appearances = await listNoteAppearances(target.id, root);
    expect(appearances.noteId).toBe(target.id);
    // Backlinks use the product's unified reference view (document wikilinks
    // plus accepted relationships), so the accepted pair's source note also
    // appears here; the relationships bucket adds the typed pair context.
    expect(appearances.counts).toEqual({
      backlinks: 2,
      relationships: 1,
      canvases: 1,
      bases: 1,
    });
    expect(appearances.backlinks.map((row) => row.title)).toContain('Appearance linker');
    expect(appearances.backlinks.map((row) => row.title)).toContain('Appearance source');

    const relationship = appearances.relationships[0]!;
    expect(relationship.direction).toBe('incoming');
    expect(relationship.counterpartyId).toBe(source.id);
    expect(relationship.counterpartyTitle).toBe('Appearance source');
    expect(relationship.status).toBe('accepted');

    expect(appearances.canvases[0]).toMatchObject({
      title: 'Appearance board',
      cardId: 'card-1',
      cardText: 'The target lives here',
    });

    expect(appearances.bases[0]).toMatchObject({ baseId: base.id, name: 'Everything' });
    expect(appearances.truncated).toBe(false);
  });

  test('outgoing relationship directions and missing notes fail closed', async () => {
    const a = await createNote({ title: 'Direction A' }, root);
    const b = await createNote({ title: 'Direction B' }, root);
    const proposal = await proposeNoteRelationship(
      {
        fromId: a.id,
        toId: b.id,
        type: 'depends_on',
        evidence: 'A depends on B',
        expectedSourceRevision: a.revision,
        expectedTargetRevision: b.revision,
      },
      root,
      host,
    );
    const appearances = await listNoteAppearances(a.id, root);
    const pair = appearances.relationships.find((row) => row.toId === b.id)!;
    expect(pair.direction).toBe('outgoing');
    expect(pair.counterpartyId).toBe(b.id);
    expect(pair.status).toBe('proposed');
    expect(proposal.revision).toBeGreaterThan(0);
    await expect(listNoteAppearances('missing-note', root)).rejects.toThrow(/not found/i);
  });

  test('malformed canvas boards are skipped instead of failing the scan', async () => {
    const target = await createNote({ title: 'Broken board target' }, root);
    // createNote validates canvas JSON on write, so corrupt the board after
    // creation to model on-disk drift; the scan must tolerate it.
    const board = await createNote(
      {
        title: 'Later corrupted board',
        tags: ['canvas'],
        content: JSON.stringify({ v: 1, name: 'Later corrupted board', cards: [], edges: [] }),
      },
      root,
    );
    getDb().query(`UPDATE notes SET content = '{not json' WHERE id = ?`).run(board.id);
    const appearances = await listNoteAppearances(target.id, root);
    expect(appearances.canvases).toEqual([]);
    expect(appearances.truncated).toBe(false);
  });
});
