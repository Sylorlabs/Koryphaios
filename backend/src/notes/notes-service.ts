/**
 * Notes Service
 *
 * Core service for the Obsidian-style note knowledge network.
 * Provides CRUD, wikilink graph management, full-text search,
 * folder tree, attachment storage, and context assembly.
 */

import { nanoid } from 'nanoid';
import { db } from '../db';
import { notes, noteLinks, noteAttachments } from '../db/schema';
import { eq, like, and, or, inArray } from 'drizzle-orm';
import type {
  Note,
  NoteLink,
  NoteAttachment,
  CreateNoteInput,
  UpdateNoteInput,
  GraphData,
  GraphNode,
  GraphEdge,
  FolderNode,
  NoteWithLinks,
} from '@koryphaios/shared';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { PROJECT_ROOT } from '../runtime/paths';

// ============================================================================
// Paths & Helpers
// ============================================================================

const ATTACHMENTS_DIR = join(PROJECT_ROOT, '.koryphaios', 'attachments');

function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

/**
 * Parse [[wikilinks]] and ![[embeds]] from note content.
 * Returns an array of unique linked note titles.
 */
function extractWikilinks(content: string): string[] {
  // Matches [[Title]], [[Title|Alias]], [[Title#Heading]], ![[embed]]
  const pattern = /!?\[\[([^\]|#]+?)(?:[|#][^\]]+?)?\]\]/g;
  const titles: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(content)) !== null) {
    const title = m[1].trim();
    if (title) titles.push(title);
  }
  return [...new Set(titles)];
}

/**
 * Convert a raw DB row to a typed Note object.
 * Handles JSON parsing for tags and boolean coercion.
 */
function rowToNote(row: typeof notes.$inferSelect): Note {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    folderPath: row.folderPath,
    tags: (() => {
      try {
        return JSON.parse(row.tags || '[]');
      } catch {
        return [];
      }
    })(),
    pinned: Boolean(row.pinned),
    includeInContext: Boolean(row.includeInContext),
    userId: row.userId ?? undefined,
    createdAt: row.createdAt instanceof Date ? row.createdAt : new Date((row.createdAt as number) * 1000),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt : new Date((row.updatedAt as number) * 1000),
  };
}

// ============================================================================
// CRUD — Notes
// ============================================================================

export async function createNote(input: CreateNoteInput): Promise<Note> {
  const id = nanoid();
  const now = new Date();

  await db.insert(notes).values({
    id,
    title: input.title,
    content: input.content ?? '',
    folderPath: input.folderPath ?? '/',
    tags: JSON.stringify(input.tags ?? []),
    pinned: input.pinned ? 1 : 0,
    includeInContext: input.includeInContext ? 1 : 0,
    userId: input.userId ?? null,
    createdAt: now,
    updatedAt: now,
  });

  if (input.content) {
    await parseAndSaveLinks(id, input.content);
  }

  return (await getNote(id))!;
}

export async function getNote(id: string): Promise<Note | null> {
  const rows = await db.select().from(notes).where(eq(notes.id, id));
  return rows[0] ? rowToNote(rows[0]) : null;
}

export async function getNoteByTitle(title: string): Promise<Note | null> {
  const rows = await db.select().from(notes).where(eq(notes.title, title));
  return rows[0] ? rowToNote(rows[0]) : null;
}

export async function updateNote(id: string, input: UpdateNoteInput): Promise<Note> {
  const existing = await getNote(id);
  if (!existing) throw new Error('Note not found');

  const now = new Date();
  const updateData: Partial<typeof notes.$inferInsert> = { updatedAt: now };

  if (input.title !== undefined) updateData.title = input.title;
  if (input.content !== undefined) updateData.content = input.content;
  if (input.folderPath !== undefined) updateData.folderPath = input.folderPath;
  if (input.tags !== undefined) updateData.tags = JSON.stringify(input.tags);
  if (input.pinned !== undefined) updateData.pinned = input.pinned ? 1 : 0;
  if (input.includeInContext !== undefined) updateData.includeInContext = input.includeInContext ? 1 : 0;

  await db.update(notes).set(updateData).where(eq(notes.id, id));

  if (input.title !== undefined && input.title !== existing.title) {
    await propagateTitleRename(existing.title, input.title);
  }

  const contentForLinks = input.content ?? (input.title !== undefined ? (await getNote(id))?.content : undefined);
  if (contentForLinks !== undefined) {
    await parseAndSaveLinks(id, contentForLinks);
  }

  return (await getNote(id))!;
}

export async function deleteNote(id: string): Promise<void> {
  // Delete attachment files from disk before DB rows are cascade-deleted
  const attachments = await db
    .select()
    .from(noteAttachments)
    .where(eq(noteAttachments.noteId, id));

  for (const att of attachments) {
    try {
      unlinkSync(att.storagePath);
    } catch {
      // Ignore missing files — DB row will still be removed via cascade
    }
  }

  await db.delete(notes).where(eq(notes.id, id));
}

export async function listNotes(filters?: {
  folderPath?: string;
  tags?: string[];
  search?: string;
}): Promise<Note[]> {
  let q = db.select().from(notes).$dynamic();
  const conditions = [];

  if (filters?.folderPath && filters.folderPath !== '/') {
    conditions.push(like(notes.folderPath, filters.folderPath + '%'));
  }

  if (filters?.search) {
    const term = '%' + filters.search + '%';
    const searchCond = or(like(notes.title, term), like(notes.content, term));
    if (searchCond) conditions.push(searchCond);
  }

  if (conditions.length > 0) {
    q = q.where(and(...conditions));
  }

  const rows = await q.orderBy(notes.updatedAt);
  return rows.map(rowToNote);
}

// ============================================================================
// Link Graph
// ============================================================================

export async function getNoteBacklinks(id: string): Promise<Note[]> {
  const links = await db
    .select()
    .from(noteLinks)
    .where(eq(noteLinks.toNoteId, id));

  if (!links.length) return [];

  const ids = links.map((l) => l.fromNoteId);
  const rows = await db.select().from(notes).where(inArray(notes.id, ids));
  return rows.map(rowToNote);
}

export async function getNoteOutlinks(id: string): Promise<Note[]> {
  const links = await db
    .select()
    .from(noteLinks)
    .where(eq(noteLinks.fromNoteId, id));

  if (!links.length) return [];

  const ids = links.map((l) => l.toNoteId);
  const rows = await db.select().from(notes).where(inArray(notes.id, ids));
  return rows.map(rowToNote);
}

/** Resolve a note ID from id or title lookup. */
export async function resolveNoteId(id?: string, title?: string): Promise<string | null> {
  if (id) {
    const note = await getNote(id);
    return note?.id ?? null;
  }
  if (title) {
    const note = await getNoteByTitle(title);
    return note?.id ?? null;
  }
  return null;
}

/**
 * Create an explicit graph edge between two notes.
 * Optionally appends a [[wikilink]] to the source note content.
 */
export async function linkNotes(
  fromId: string,
  toId: string,
  options?: { syncContent?: boolean },
): Promise<void> {
  if (fromId === toId) return;

  const [fromNote, toNote] = await Promise.all([getNote(fromId), getNote(toId)]);
  if (!fromNote || !toNote) throw new Error('Note not found');

  try {
    await db.insert(noteLinks).values({ fromNoteId: fromId, toNoteId: toId });
  } catch {
    // Already linked
  }

  if (options?.syncContent !== false) {
    const linkPattern = new RegExp(
      `!?\\[\\[${escapeRegExp(toNote.title)}(?:[|#][^\\]]+?)?\\]\\]`,
    );
    if (!linkPattern.test(fromNote.content)) {
      const suffix = fromNote.content.endsWith('\n') || !fromNote.content ? '' : '\n';
      await updateNote(fromId, {
        content: fromNote.content + suffix + `[[${toNote.title}]]`,
      });
    }
  }
}

/**
 * Remove a directed edge between two notes.
 * Optionally strips the matching [[wikilink]] from source content.
 */
export async function unlinkNotes(
  fromId: string,
  toId: string,
  options?: { syncContent?: boolean },
): Promise<void> {
  const [fromNote, toNote] = await Promise.all([getNote(fromId), getNote(toId)]);
  if (!fromNote || !toNote) throw new Error('Note not found');

  await db
    .delete(noteLinks)
    .where(and(eq(noteLinks.fromNoteId, fromId), eq(noteLinks.toNoteId, toId)));

  if (options?.syncContent !== false) {
    const linkPattern = new RegExp(
      `!?\\[\\[${escapeRegExp(toNote.title)}(?:[|#][^\\]]+?)?\\]\\]\\n?`,
      'g',
    );
    const stripped = fromNote.content.replace(linkPattern, '').trimEnd();
    if (stripped !== fromNote.content) {
      await updateNote(fromId, { content: stripped });
    }
  }
}

/** Update [[wikilinks]] across the vault when a note is renamed. */
async function propagateTitleRename(oldTitle: string, newTitle: string): Promise<void> {
  const allNotes = await db.select().from(notes);
  const pattern = new RegExp(
    `(!?)\\[\\[${escapeRegExp(oldTitle)}((?:[|#][^\\]]+?)?)\\]\\]`,
    'g',
  );

  for (const row of allNotes) {
    if (!pattern.test(row.content)) continue;
    pattern.lastIndex = 0;
    const updated = row.content.replace(pattern, `$1[[${newTitle}$2]]`);
    await db
      .update(notes)
      .set({ content: updated, updatedAt: new Date() })
      .where(eq(notes.id, row.id));
    await parseAndSaveLinks(row.id, updated);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface NoteCatalogEntry {
  id: string;
  title: string;
  folderPath: string;
  tags: string[];
  linkCount: number;
  includeInContext: boolean;
  updatedAt: Date;
}

/** Compact index of every note for agent discovery and recall. */
export async function getNotesCatalog(): Promise<NoteCatalogEntry[]> {
  const graph = await getGraphData();
  const linkCountById = new Map(graph.nodes.map((n) => [n.id, n.linkCount]));
  const rows = await db.select().from(notes).orderBy(notes.updatedAt);
  return rows.map((row) => {
    const note = rowToNote(row);
    return {
      id: note.id,
      title: note.title,
      folderPath: note.folderPath,
      tags: note.tags,
      linkCount: linkCountById.get(note.id) ?? 0,
      includeInContext: note.includeInContext,
      updatedAt: note.updatedAt,
    };
  });
}

export interface RecallNotesOptions {
  query?: string;
  ids?: string[];
  titles?: string[];
  limit?: number;
}

/** Recall full note content by search query, IDs, or titles. */
export async function recallNotes(options: RecallNotesOptions): Promise<NoteWithLinks[]> {
  const limit = options.limit ?? 10;
  const found = new Map<string, Note>();

  if (options.ids?.length) {
    for (const id of options.ids) {
      const note = await getNote(id);
      if (note) found.set(note.id, note);
    }
  }

  if (options.titles?.length) {
    for (const title of options.titles) {
      const note = await getNoteByTitle(title);
      if (note) found.set(note.id, note);
    }
  }

  if (options.query?.trim()) {
    const searched = await searchNotes(options.query);
    for (const note of searched) {
      found.set(note.id, note);
    }
  }

  if (!options.query && !options.ids?.length && !options.titles?.length) {
    const all = await listNotes();
    for (const note of all.slice(0, limit)) {
      found.set(note.id, note);
    }
  }

  const results: NoteWithLinks[] = [];
  for (const note of found.values()) {
    if (results.length >= limit) break;
    const withLinks = await getNoteWithLinks(note.id);
    if (withLinks) results.push(withLinks);
  }
  return results;
}

/**
 * Re-parse wikilinks in a note's content and update the noteLinks table.
 * Removes all previous outgoing edges from this note, then re-inserts.
 */
export async function parseAndSaveLinks(noteId: string, content: string): Promise<void> {
  // Remove old outgoing links from this note
  await db.delete(noteLinks).where(eq(noteLinks.fromNoteId, noteId));

  const titles = extractWikilinks(content);

  for (const title of titles) {
    const target = await getNoteByTitle(title);
    if (target && target.id !== noteId) {
      try {
        await db.insert(noteLinks).values({
          fromNoteId: noteId,
          toNoteId: target.id,
        });
      } catch {
        // Ignore duplicate primary key (already linked)
      }
    }
  }
}

// ============================================================================
// Graph
// ============================================================================

export async function getGraphData(): Promise<GraphData> {
  const allNotes = await db.select().from(notes);
  const allLinks = await db.select().from(noteLinks);

  // Build link-count map (both directions count as "connected")
  const linkCountMap = new Map<string, number>();
  for (const link of allLinks) {
    linkCountMap.set(link.fromNoteId, (linkCountMap.get(link.fromNoteId) ?? 0) + 1);
    linkCountMap.set(link.toNoteId, (linkCountMap.get(link.toNoteId) ?? 0) + 1);
  }

  const nodes: GraphNode[] = allNotes.map((n) => ({
    id: n.id,
    title: n.title,
    folderPath: n.folderPath,
    tags: (() => {
      try {
        return JSON.parse(n.tags || '[]');
      } catch {
        return [];
      }
    })(),
    linkCount: linkCountMap.get(n.id) ?? 0,
    includeInContext: Boolean(n.includeInContext),
  }));

  const edges: GraphEdge[] = allLinks.map((l) => ({
    from: l.fromNoteId,
    to: l.toNoteId,
  }));

  return { nodes, edges };
}

// ============================================================================
// Folder Tree
// ============================================================================

export async function getFolderTree(): Promise<FolderNode[]> {
  const allNotes = await db.select({ folderPath: notes.folderPath }).from(notes);

  // Count notes per folder (exact path match)
  const folderCounts = new Map<string, number>();
  for (const n of allNotes) {
    const path = n.folderPath;
    folderCounts.set(path, (folderCounts.get(path) ?? 0) + 1);
  }

  function buildTree(prefix: string, allPaths: string[]): FolderNode[] {
    const immediate = new Set<string>();
    for (const p of allPaths) {
      if (p === prefix) continue;
      const base = prefix === '/' ? '/' : prefix + '/';
      if (!p.startsWith(base)) continue;
      const rest = p.slice(base.length);
      const next = rest.split('/')[0];
      if (next) immediate.add(next);
    }

    return [...immediate].sort().map((name) => {
      const childPath = (prefix === '/' ? '' : prefix) + '/' + name;
      return {
        path: childPath,
        name,
        noteCount: folderCounts.get(childPath) ?? 0,
        children: buildTree(childPath, allPaths),
      };
    });
  }

  const allPaths = [...new Set(allNotes.map((n) => n.folderPath))];
  return buildTree('/', allPaths);
}

// ============================================================================
// Search
// ============================================================================

export async function searchNotes(query: string): Promise<Note[]> {
  if (!query.trim()) return listNotes();

  const term = '%' + query + '%';
  const cond = or(
    like(notes.title, term),
    like(notes.content, term),
    like(notes.tags, term),
  );
  const rows = await db
    .select()
    .from(notes)
    .where(cond!)
    .limit(20);

  return rows.map(rowToNote);
}

// ============================================================================
// Attachments
// ============================================================================

export async function saveAttachment(
  noteId: string,
  filename: string,
  mimeType: string,
  data: Buffer,
): Promise<NoteAttachment> {
  const id = nanoid();
  const noteDir = join(ATTACHMENTS_DIR, noteId);
  ensureDir(noteDir);

  const storagePath = join(noteDir, id + '_' + filename);
  writeFileSync(storagePath, data);

  const now = new Date();
  await db.insert(noteAttachments).values({
    id,
    noteId,
    filename,
    mimeType,
    size: data.length,
    storagePath,
    createdAt: now,
  });

  return {
    id,
    noteId,
    filename,
    mimeType,
    size: data.length,
    storagePath,
    createdAt: now,
  };
}

export async function getAttachment(id: string): Promise<NoteAttachment | null> {
  const rows = await db
    .select()
    .from(noteAttachments)
    .where(eq(noteAttachments.id, id));

  if (!rows[0]) return null;

  const row = rows[0];
  return {
    id: row.id,
    noteId: row.noteId,
    filename: row.filename,
    mimeType: row.mimeType,
    size: row.size,
    storagePath: row.storagePath,
    createdAt: row.createdAt instanceof Date
      ? row.createdAt
      : new Date((row.createdAt as number) * 1000),
  };
}

export async function deleteAttachment(id: string): Promise<void> {
  const att = await getAttachment(id);
  if (!att) return;

  try {
    unlinkSync(att.storagePath);
  } catch {
    // File may already be gone — DB row still needs removal
  }

  await db.delete(noteAttachments).where(eq(noteAttachments.id, id));
}

// ============================================================================
// Memory Import
// ============================================================================

/**
 * Import universal and project memory files as notes.
 * Creates a note for each non-empty memory file, or updates an existing one
 * with the same title so repeated calls are idempotent.
 */
export async function importMemoryAsNotes(projectRoot: string): Promise<Note[]> {
  const { readUniversalMemory, readProjectMemory } = await import('../memory/unified-memory');

  const candidates = [
    { title: 'Universal Memory', content: readUniversalMemory().content },
    { title: 'Project Memory', content: readProjectMemory(projectRoot).content },
  ];

  const created: Note[] = [];

  for (const { title, content } of candidates) {
    if (!content.trim()) continue;

    const existing = await getNoteByTitle(title);
    if (existing) {
      const updated = await updateNote(existing.id, { content });
      created.push(updated);
    } else {
      const note = await createNote({
        title,
        content,
        folderPath: '/Memory',
        includeInContext: true,
      });
      created.push(note);
    }
  }

  return created;
}

// ============================================================================
// Composite Queries
// ============================================================================

export async function getNoteWithLinks(id: string): Promise<NoteWithLinks | null> {
  const note = await getNote(id);
  if (!note) return null;

  const [outRows, inRows, attRows] = await Promise.all([
    db.select().from(noteLinks).where(eq(noteLinks.fromNoteId, id)),
    db.select().from(noteLinks).where(eq(noteLinks.toNoteId, id)),
    db.select().from(noteAttachments).where(eq(noteAttachments.noteId, id)),
  ]);

  return {
    ...note,
    outlinks: outRows.map((r) => r.toNoteId),
    backlinks: inRows.map((r) => r.fromNoteId),
    attachments: attRows.map((a) => ({
      id: a.id,
      noteId: a.noteId,
      filename: a.filename,
      mimeType: a.mimeType,
      size: a.size,
      storagePath: a.storagePath,
      createdAt: a.createdAt instanceof Date
        ? a.createdAt
        : new Date((a.createdAt as number) * 1000),
    })),
  };
}
