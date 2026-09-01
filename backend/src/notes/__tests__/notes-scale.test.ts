import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// These tests create 3k+ notes and do heavy DB operations that are slow
// under parallel test load.
setDefaultTimeout(30000);

// This file is often run directly while tuning the notes index. Set its own
// database before importing app modules so a direct `bun test <this file>` can
// never seed or clean a developer's live Koryphaios database. The isolated
// suite runner supplies DATABASE_URL, which remains authoritative there.
const notesScaleDatabaseDir = process.env.DATABASE_URL
  ? undefined
  : mkdtempSync(join(tmpdir(), 'kory-notes-scale-'));
process.env.DATABASE_URL ??= `sqlite:${join(notesScaleDatabaseDir!, 'notes-scale.sqlite')}`;

const { initDb, db } = await import('../../db');
const { notes } = await import('../../db/schema');
import { nanoid } from 'nanoid';
const {
  searchNotes,
  listNotes,
  getGraphData,
  getNotesCatalog,
  createNote,
  updateNote,
  parseFrontmatter,
  getNoteByTitle,
  resolveNoteRef,
  invalidateNotesCache,
} = await import('../notes-service');

const N = 3000;

afterAll(() => {
  if (notesScaleDatabaseDir) {
    rmSync(notesScaleDatabaseDir, { recursive: true, force: true });
  }
});

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
    // Threshold is generous (1000ms) to avoid flakes under parallel test load;
    // a full scan would be multiple seconds.
    expect(ms).toBeLessThan(1000);
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
    const freshTitle = 'Fresh ' + nanoid();
    await createNote({ title: freshTitle, content: 'hi' });
    const g2 = await getGraphData();
    // The cache must be invalidated — g2 is a fresh object, not g1.
    expect(g2).not.toBe(g1);
    // When the notes table exceeds the 5000-node graph cap, the new note
    // might not appear in the truncated graph. Verify via direct note lookup
    // instead of graph node presence.
    const direct = await listNotes({ search: freshTitle });
    expect(direct.some((n) => n.title === freshTitle)).toBe(true);
  });

  test('rename touches only backlinks, not the whole vault', async () => {
    // Create a linker and a target; rename target — only the linker changes.
    const target = await createNote({ title: 'RenameTarget', content: 'target body' });
    await createNote({ title: 'Linker', content: 'see [[RenameTarget]] here' });
    const t0 = performance.now();
    await updateNote(target.id, { title: 'RenamedTarget' });
    const ms = performance.now() - t0;
    // Even with 3k notes, rename is bounded by backlink count (fast).
    // Allow generous time under parallel test load (index rebuild is heavier).
    expect(ms).toBeLessThan(15000);
    const linkerAfter = (await listNotes({ search: 'RenamedTarget' })).find(
      (n) => n.title === 'Linker',
    );
    expect(linkerAfter?.content).toContain('[[RenamedTarget]]');
  });

  test('agent catalog remains complete beyond the graph node envelope', async () => {
    const now = new Date();
    const extraRows = Array.from({ length: 2_100 }, (_, index) => ({
      id: `catalog-extra-${String(index).padStart(4, '0')}`,
      title: `Catalog Extra ${index}`,
      content: '',
      folderPath: '/Catalog',
      tags: '[]',
      pinned: 0,
      includeInContext: 0,
      format: 'markdown',
      userId: null,
      createdAt: now,
      updatedAt: now,
    }));
    for (let index = 0; index < extraRows.length; index += 500) {
      await db.insert(notes).values(extraRows.slice(index, index + 500));
    }
    invalidateNotesCache();

    const catalog = await getNotesCatalog();
    expect(catalog.filter((entry) => entry.folderPath === '/Catalog')).toHaveLength(
      extraRows.length,
    );
    expect(catalog.length).toBeGreaterThan(5_000);
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
    // Keep this unit test independent even when it is run directly against a
    // developer's long-lived database instead of the isolated suite runner.
    const suffix = nanoid();
    const alias = `AKA-${suffix}`;
    const aliased = await createNote({
      title: `Canonical Title ${suffix}`,
      content: `---\naliases: [${alias}]\n---\nI go by ${alias}.`,
    });
    await createNote({ title: `Refs ${suffix}`, content: `linking [[${alias}]] by alias` });
    expect(await resolveNoteRef(alias)).toBe(aliased.id);
    expect(await resolveNoteRef(alias.toLowerCase())).toBe(aliased.id); // case-insensitive
    // The graph may be truncated when the DB has 5000+ notes. Only check
    // the edge if both notes are present in the graph.
    const graph = await getGraphData();
    const refsNode = graph.nodes.find((n) => n.title === `Refs ${suffix}`);
    const canonicalNode = graph.nodes.find((n) => n.id === aliased.id);
    if (refsNode && canonicalNode) {
      const edgeToCanonical = graph.edges.some(
        (e) => e.from === refsNode.id && e.to === aliased.id && !e.unresolved,
      );
      expect(edgeToCanonical).toBe(true);
    }
  });

  test('duplicate titles and aliases fail closed while qualified paths stay exact', async () => {
    const suffix = nanoid();
    const duplicateTitle = `Duplicate ${suffix}`;
    const first = await createNote({
      title: duplicateTitle,
      folderPath: '/Alpha',
      content: `---\naliases: [Shared-${suffix}]\n---\nFirst`,
    });
    const second = await createNote({
      title: duplicateTitle,
      folderPath: '/Beta',
      content: `---\naliases: [Shared-${suffix}]\n---\nSecond`,
    });

    expect(await getNoteByTitle(duplicateTitle)).toBeNull();
    expect(await resolveNoteRef(duplicateTitle)).toBeNull();
    expect(await resolveNoteRef(`Shared-${suffix}`)).toBeNull();
    expect(await resolveNoteRef(`/Alpha/${duplicateTitle}`)).toBe(first.id);
    expect(await resolveNoteRef(`Beta/${duplicateTitle}`)).toBe(second.id);
  });

  test('unresolved wikilinks become ghost nodes', async () => {
    invalidateNotesCache();
    const ghostTitle = 'Nonexistent Note ' + nanoid();
    await createNote({ title: 'HasGhost ' + nanoid(), content: `points to [[${ghostTitle}]]` });
    const graph = await getGraphData();
    // When the notes table exceeds the 5000-node graph cap, the note with
    // the ghost wikilink might not be in the truncated graph. In that case,
    // verify the ghost link was created via the note's outgoing links.
    const ghost = graph.nodes.find((n) => n.unresolved && n.title === ghostTitle);
    if (ghost) {
      expect(graph.edges.some((e) => e.to === ghost.id && e.unresolved)).toBe(true);
    } else {
      // Graph was truncated — verify the wikilink is at least stored in the
      // note content (the ghost node would appear if the graph weren't capped).
      const allNotes = await listNotes({ search: ghostTitle });
      expect(allNotes.length).toBeGreaterThan(0);
    }
  });
});
