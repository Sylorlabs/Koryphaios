import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb, initDb } from '../../db';
import {
  createNote,
  expandNoteGraph,
  getGraphData,
  getNote,
  getNoteOutlinks,
  invalidateNotesCache,
  linkNotes,
  listNotes,
  listNoteRevisions,
  parseAndSaveLinks,
  restoreNote,
  syncProjectDocuments,
  trashNote,
  unlinkNotes,
  updateNote,
} from '../notes-service';

let root: string;
beforeAll(async () => {
  await initDb();
  root = mkdtempSync(join(tmpdir(), 'kory-network-durability-'));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
function project(name: string) {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  return path;
}
async function outlinks(id: string, scope: string) {
  return (await getNoteOutlinks(id, scope)).map((note) => note.id).sort();
}

describe('durable Note Network relationships', () => {
  test('graph-only links survive body saves, explicit reparsing, and cache invalidation', async () => {
    const scope = project('graph-only');
    const target = await createNote({ title: 'Related design', content: 'decision' }, scope);
    const source = await createNote({ title: 'Implementation', content: 'original' }, scope);
    await linkNotes(source.id, target.id, { syncContent: false }, scope);
    expect((await getNote(source.id, scope))?.content).toBe('original');
    const current = (await getNote(source.id, scope))!;
    await updateNote(
      source.id,
      { content: 'unrelated body edit', expectedRevision: current.revision },
      scope,
    );
    await parseAndSaveLinks(source.id, 'unrelated body edit', { projectRoot: scope });
    invalidateNotesCache();
    expect(await outlinks(source.id, scope)).toEqual([target.id]);
    expect((await getGraphData(scope)).edges).toContainEqual(
      expect.objectContaining({ from: source.id, to: target.id }),
    );
  });

  test('removing a derived wikilink does not erase an explicit relationship to the same target', async () => {
    const scope = project('mixed-provenance');
    const target = await createNote({ title: 'Mixed target' }, scope);
    const source = await createNote({ title: 'Mixed source', content: '[[Mixed target]]' }, scope);
    await linkNotes(source.id, target.id, { syncContent: false }, scope);
    await updateNote(source.id, { content: 'Reference removed from prose' }, scope);
    expect(await outlinks(source.id, scope)).toEqual([target.id]);
    await unlinkNotes(source.id, target.id, { syncContent: false }, scope);
    expect(await outlinks(source.id, scope)).toEqual([]);
  });

  test('ordinary derived links are still removed when their wikilink is deleted', async () => {
    const scope = project('derived-removal');
    const target = await createNote({ title: 'Derived target' }, scope);
    const source = await createNote(
      { title: 'Derived source', content: '[[Derived target]]' },
      scope,
    );
    expect(await outlinks(source.id, scope)).toEqual([target.id]);
    await updateNote(source.id, { content: 'No references remain' }, scope);
    expect(await outlinks(source.id, scope)).toEqual([]);
  });

  test('content-synchronized linking records immutable history and preserves other durable links', async () => {
    const scope = project('link-history');
    const first = await createNote({ title: 'First target' }, scope);
    const second = await createNote({ title: 'Second target' }, scope);
    const source = await createNote({ title: 'Source', content: 'Keep existing text.' }, scope);
    await linkNotes(source.id, first.id, { syncContent: false }, scope);
    const before = (await getNote(source.id, scope))!;
    await linkNotes(source.id, second.id, { syncContent: true }, scope);
    const linked = (await getNote(source.id, scope))!;
    expect(linked.content).toContain('Keep existing text.');
    expect(linked.content).toContain('[[Second target]]');
    expect(linked.revision).toBe(before.revision + 1);
    expect((await listNoteRevisions(source.id, scope))[0]?.revision).toBe(linked.revision);
    expect(await outlinks(source.id, scope)).toEqual([first.id, second.id].sort());
    await unlinkNotes(source.id, second.id, { syncContent: true }, scope);
    const unlinked = (await getNote(source.id, scope))!;
    expect(unlinked.content).not.toContain('[[Second target]]');
    expect(unlinked.revision).toBe(linked.revision + 1);
    expect(await outlinks(source.id, scope)).toEqual([first.id]);
  });

  test('trash hides relationships without destroying them, and foreign endpoints cannot be linked', async () => {
    const scope = project('trash-scope');
    const other = project('foreign-scope');
    const source = await createNote({ title: 'Visible source' }, scope);
    const target = await createNote({ title: 'Recoverable target' }, scope);
    const foreign = await createNote({ title: 'Foreign secret' }, other);
    await linkNotes(source.id, target.id, { syncContent: false }, scope);
    await expect(linkNotes(source.id, foreign.id, { syncContent: false }, scope)).rejects.toThrow();
    const trashed = await trashNote(target.id, scope);
    expect(await outlinks(source.id, scope)).toEqual([]);
    expect((await getGraphData(scope)).edges.some((edge) => edge.to === target.id)).toBe(false);
    await restoreNote(target.id, scope, trashed.revision);
    expect(await outlinks(source.id, scope)).toEqual([target.id]);
  });

  test('stale source and relationship revisions reject edits without modifying content, history, or edges', async () => {
    const scope = project('relationship-cas');
    const source = await createNote({ title: 'CAS source', content: 'Original' }, scope);
    const target = await createNote({ title: 'CAS target' }, scope);
    await linkNotes(
      source.id,
      target.id,
      {
        syncContent: false,
        expectedRevision: source.revision,
        expectedRelationshipRevision: 0,
        provenance: 'agent',
        evidence: 'Observed shared interface',
        weight: 0.75,
      },
      scope,
    );
    const linked = (await getNote(source.id, scope))!;
    expect(linked.revision).toBe(source.revision + 1);
    const beforeHistory = await listNoteRevisions(source.id, scope);
    const beforeGraph = await expandNoteGraph([source.id], scope);
    expect(beforeGraph.edges).toContainEqual(
      expect.objectContaining({
        from: source.id,
        to: target.id,
        kind: 'association',
        provenance: 'agent',
        evidence: 'Observed shared interface',
        weight: 0.75,
        revision: 1,
      }),
    );
    await expect(
      unlinkNotes(
        source.id,
        target.id,
        { syncContent: true, expectedRevision: source.revision },
        scope,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      linkNotes(
        source.id,
        target.id,
        { syncContent: true, expectedRevision: linked.revision, expectedRelationshipRevision: 0 },
        scope,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await getNote(source.id, scope)).toEqual(linked);
    expect(await listNoteRevisions(source.id, scope)).toEqual(beforeHistory);
    expect(await expandNoteGraph([source.id], scope)).toEqual(beforeGraph);
    await unlinkNotes(
      source.id,
      target.id,
      { syncContent: false, expectedRevision: linked.revision, expectedRelationshipRevision: 1 },
      scope,
    );
    expect(await outlinks(source.id, scope)).toEqual([]);
  });

  test('a relationship storage failure rolls back the synchronized body and revision together', async () => {
    const scope = project('relationship-atomicity');
    const source = await createNote({ title: 'Atomic source', content: 'Retain original' }, scope);
    const target = await createNote({ title: 'Atomic target' }, scope);
    const database = getDb();
    const history = await listNoteRevisions(source.id, scope);
    database.exec(
      `CREATE TEMP TRIGGER reject_test_relationship BEFORE INSERT ON note_relationships BEGIN SELECT RAISE(ABORT, 'fixture relationship failure'); END`,
    );
    try {
      await expect(linkNotes(source.id, target.id, { syncContent: true }, scope)).rejects.toThrow(
        'fixture relationship failure',
      );
      expect(await getNote(source.id, scope)).toEqual(source);
      expect(await listNoteRevisions(source.id, scope)).toEqual(history);
      expect(await outlinks(source.id, scope)).toEqual([]);
    } finally {
      database.exec('DROP TRIGGER reject_test_relationship');
    }
  });

  test('stale parsing cannot replace derived edges belonging to a newer body revision', async () => {
    const scope = project('parse-cas');
    const oldTarget = await createNote({ title: 'Old parse target' }, scope);
    const newTarget = await createNote({ title: 'New parse target' }, scope);
    const source = await createNote(
      { title: 'Parse source', content: '[[Old parse target]]' },
      scope,
    );
    await updateNote(
      source.id,
      { content: '[[New parse target]]', expectedRevision: source.revision },
      scope,
    );
    await expect(
      parseAndSaveLinks(source.id, source.content, {
        projectRoot: scope,
        expectedRevision: source.revision,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await outlinks(source.id, scope)).toEqual([newTarget.id]);
    expect(await outlinks(source.id, scope)).not.toContain(oldTarget.id);
  });

  test('bounded graph expansion follows incoming and outgoing associations without cycles or duplicates', async () => {
    const scope = project('bounded-expansion');
    const a = await createNote({ title: 'Seed' }, scope);
    const b = await createNote({ title: 'Incoming neighbor' }, scope);
    const c = await createNote({ title: 'Outgoing neighbor' }, scope);
    const d = await createNote({ title: 'Second hop' }, scope);
    await linkNotes(b.id, a.id, { syncContent: false }, scope);
    await linkNotes(a.id, c.id, { syncContent: false }, scope);
    await linkNotes(c.id, d.id, { syncContent: false }, scope);
    await linkNotes(d.id, a.id, { syncContent: false }, scope);
    const graph = await expandNoteGraph([a.id, a.id], scope, {
      maxDepth: 2,
      maxNodes: 10,
      maxEdges: 10,
    });
    expect(graph.nodes.map((node) => node.id).sort()).toEqual([a.id, b.id, c.id, d.id].sort());
    expect(new Set(graph.nodes.map((node) => node.id)).size).toBe(graph.nodes.length);
    const incoming = graph.nodes.find((node) => node.id === b.id)!;
    expect(incoming.depth).toBe(1);
    expect(incoming.seedId).toBe(a.id);
    expect(incoming.path).toContainEqual(
      expect.objectContaining({ from: b.id, to: a.id, kind: 'association' }),
    );
    expect(graph.nodes.every((node) => node.depth <= 2)).toBe(true);
    expect(
      await expandNoteGraph([a.id], scope, { maxDepth: 2, maxNodes: 10, maxEdges: 10 }),
    ).toEqual(graph);
    const limited = await expandNoteGraph([a.id], scope, { maxDepth: 2, maxNodes: 2, maxEdges: 1 });
    expect(limited.nodes.length).toBeLessThanOrEqual(2);
    expect(limited.edges.length).toBeLessThanOrEqual(1);
    expect(limited.truncated).toBe(true);
    const noHops = await expandNoteGraph([a.id], scope, { maxDepth: 0 });
    expect(noHops.nodes.map((node) => node.id)).toEqual([a.id]);
    expect(noHops.edges).toEqual([]);
  });

  test('graph traversal excludes foreign and trashed seeds/endpoints before applying budgets', async () => {
    const scope = project('expansion-scope');
    const other = project('expansion-foreign');
    const a = await createNote({ title: 'Local seed' }, scope);
    const b = await createNote({ title: 'Local neighbor' }, scope);
    const hidden = await createNote({ title: 'Trashed neighbor' }, scope);
    const foreign = await createNote({ title: 'Foreign seed' }, other);
    await linkNotes(a.id, b.id, { syncContent: false }, scope);
    await linkNotes(a.id, hidden.id, { syncContent: false }, scope);
    await trashNote(hidden.id, scope);
    const graph = await expandNoteGraph([foreign.id, hidden.id, a.id], scope, {
      maxDepth: 2,
      maxNodes: 2,
    });
    expect(graph.nodes.map((node) => node.id).sort()).toEqual([a.id, b.id].sort());
    expect(
      graph.edges.every(
        (edge) =>
          ![hidden.id, foreign.id].includes(edge.from) &&
          ![hidden.id, foreign.id].includes(edge.to),
      ),
    ).toBe(true);
  });

  test('project-document resynchronization retains graph-only relationships', async () => {
    const scope = project('file-resync');
    writeFileSync(join(scope, 'source.md'), '# Source\n\nInitial prose.\n');
    await syncProjectDocuments(scope);
    const source = (await listNotes(undefined, scope)).find(
      (note) => note.sourcePath === 'source.md',
    )!;
    expect(source).toBeDefined();
    const target = await createNote({ title: 'Persistent association' }, scope);
    await linkNotes(source.id, target.id, { syncContent: false }, scope);
    writeFileSync(
      join(scope, 'source.md'),
      '# Source\n\nExternally changed prose with no wikilinks.\n',
    );
    await syncProjectDocuments(scope);
    expect((await getNote(source.id, scope))?.content).toContain('Externally changed');
    expect(await outlinks(source.id, scope)).toEqual([target.id]);
  });
});
