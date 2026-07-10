import { test, expect, describe, beforeAll } from 'bun:test';
import { initDb, db } from '../../db';
import { notes } from '../../db/schema';
import { nanoid } from 'nanoid';
import {
  searchNotes,
  listNotes,
  getGraphData,
  createNote,
  updateNote,
  parseFrontmatter,
  resolveNoteRef,
  invalidateNotesCache,
} from '../notes-service';

const N = 3000;

describe('notes at scale', () => {
  beforeAll(async () => {
    await initDb();
    // Bulk-seed N notes with searchable content and a few wikilinks.
    const now = new Date();
    const rows = Array.from({ length: N }, (_, i) => ({
      id: nanoid(),
      title: `Seed Note ${i}`,
      content:
        `This is body ${i} about ${i % 7 === 0 ? 'kubernetes deployment' : 'general topic'} ` +
        `and links [[Seed Note ${(i + 1) % N}]].`,
      folderPath: i % 2 === 0 ? '/A' : '/B',
      tags: JSON.stringify(i % 5 === 0 ? ['tagged'] : []),
      pinned: 0,
      includeInContext: 0,
      format: 'markdown',
      userId: null,
      createdAt: now,
      updatedAt: now,
    }));
    // Insert in chunks (FTS triggers keep the index in sync).
    for (let i = 0; i < rows.length; i += 500) {
      await db.insert(notes).values(rows.slice(i, i + 500));
    }
    invalidateNotesCache();
  });

  test('FTS search is fast and correct at 3k notes', async () => {
    const t0 = performance.now();
    const results = await searchNotes('kubernetes');
    const ms = performance.now() - t0;
    // Every kubernetes note (i % 7 === 0) should be findable; result is bounded.
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.content.toLowerCase().includes('kubernetes'))).toBe(true);
    // Indexed search over 3k notes must be well under the old full-scan cost.
    expect(ms).toBeLessThan(150);
  });

  test('prefix search matches partial tokens', async () => {
    const results = await searchNotes('kubern');
    expect(results.length).toBeGreaterThan(0);
  });

  test('pagination returns bounded pages', async () => {
    const page1 = await listNotes({ limit: 25 });
    expect(page1.length).toBe(25);
    const page2 = await listNotes({ limit: 25, offset: 25 });
    expect(page2.length).toBe(25);
    expect(page1[0].id).not.toBe(page2[0].id);
  });

  test('graph builds and is cached (2nd call is the same object)', async () => {
    invalidateNotesCache();
    const t0 = performance.now();
    const g1 = await getGraphData();
    const buildMs = performance.now() - t0;
    expect(g1.nodes.length).toBeGreaterThanOrEqual(N);
    const t1 = performance.now();
    const g2 = await getGraphData();
    const cachedMs = performance.now() - t1;
    expect(g2).toBe(g1); // same cached reference
    expect(cachedMs).toBeLessThan(buildMs); // cache hit is cheaper
  });

  test('graph cache invalidates on mutation', async () => {
    const g1 = await getGraphData();
    await createNote({ title: 'Fresh ' + nanoid(), content: 'hi' });
    const g2 = await getGraphData();
    expect(g2).not.toBe(g1);
    expect(g2.nodes.length).toBeGreaterThan(g1.nodes.length);
  });

  test('rename touches only backlinks, not the whole vault', async () => {
    // Create a linker and a target; rename target — only the linker changes.
    const target = await createNote({ title: 'RenameTarget', content: 'target body' });
    await createNote({ title: 'Linker', content: 'see [[RenameTarget]] here' });
    const t0 = performance.now();
    await updateNote(target.id, { title: 'RenamedTarget' });
    const ms = performance.now() - t0;
    // Even with 3k notes, rename is bounded by backlink count (fast).
    expect(ms).toBeLessThan(150);
    const linkerAfter = (await listNotes({ search: 'RenamedTarget' })).find(
      (n) => n.title === 'Linker',
    );
    expect(linkerAfter?.content).toContain('[[RenamedTarget]]');
  });
});

describe('frontmatter, aliases, ghost nodes', () => {
  test('parseFrontmatter reads inline and block lists', () => {
    const inline = parseFrontmatter('---\naliases: [Foo, "Bar Baz"]\ntags: [x, y]\n---\nbody');
    expect(inline.aliases).toEqual(['Foo', 'Bar Baz']);
    expect(inline.tags).toEqual(['x', 'y']);
    expect(inline.body).toBe('body');

    const block = parseFrontmatter('---\naliases:\n  - Alpha\n  - Beta\n---\nx');
    expect(block.aliases).toEqual(['Alpha', 'Beta']);

    expect(parseFrontmatter('no frontmatter here').aliases).toEqual([]);
  });

  test('wikilinks resolve by alias', async () => {
    invalidateNotesCache();
    const aliased = await createNote({
      title: 'Canonical Title',
      content: '---\naliases: [AKA]\n---\nI go by AKA.',
    });
    await createNote({ title: 'Refs', content: 'linking [[AKA]] by alias' });
    expect(await resolveNoteRef('AKA')).toBe(aliased.id);
    expect(await resolveNoteRef('aka')).toBe(aliased.id); // case-insensitive
    const graph = await getGraphData();
    // The alias link is a real edge, not a ghost.
    const refsNode = graph.nodes.find((n) => n.title === 'Refs');
    const edgeToCanonical = graph.edges.some(
      (e) => e.from === refsNode!.id && e.to === aliased.id && !e.unresolved,
    );
    expect(edgeToCanonical).toBe(true);
  });

  test('unresolved wikilinks become ghost nodes', async () => {
    invalidateNotesCache();
    await createNote({ title: 'HasGhost', content: 'points to [[Nonexistent Note XYZ]]' });
    const graph = await getGraphData();
    const ghost = graph.nodes.find((n) => n.unresolved && n.title === 'Nonexistent Note XYZ');
    expect(ghost).toBeTruthy();
    expect(graph.edges.some((e) => e.to === ghost!.id && e.unresolved)).toBe(true);
  });
});
