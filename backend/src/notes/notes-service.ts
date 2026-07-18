/**
 * Notes Service
 *
 * Core service for the Obsidian-style note knowledge network.
 * Provides CRUD, wikilink graph management, full-text search,
 * folder tree, attachment storage, and context assembly.
 */

import { nanoid } from 'nanoid';
import { db, getDb } from '../db';
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
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  unlinkSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'path';
import { PROJECT_ROOT } from '../runtime/paths';

// ============================================================================
// Paths & Helpers
// ============================================================================

const ATTACHMENTS_DIR = join(PROJECT_ROOT, '.koryphaios', 'attachments');
const PROJECT_DOCUMENT_PREFIX = 'project-document:';
const DOCUMENT_EXTENSIONS = new Set(['.md', '.markdown', '.html', '.htm']);
const IGNORED_DOCUMENT_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'target',
  '.svelte-kit',
  '.next',
  'coverage',
]);

function projectDocumentId(projectRoot: string, sourcePath: string): string {
  return (
    PROJECT_DOCUMENT_PREFIX +
    Buffer.from(JSON.stringify([resolve(projectRoot), sourcePath])).toString('base64url')
  );
}

function projectDocumentIdentity(
  id: string,
): { projectRoot: string; sourcePath: string } | undefined {
  if (!id.startsWith(PROJECT_DOCUMENT_PREFIX)) return undefined;
  try {
    const [projectRoot, path] = JSON.parse(
      Buffer.from(id.slice(PROJECT_DOCUMENT_PREFIX.length), 'base64url').toString('utf8'),
    ) as [string, string];
    if (!path || path.startsWith('/') || path.split(/[\\/]/).includes('..')) return undefined;
    if (!projectRoot) return undefined;
    return { projectRoot: resolve(projectRoot), sourcePath: path };
  } catch {
    return undefined;
  }
}

function resolveProjectDocument(id: string): string | undefined {
  const identity = projectDocumentIdentity(id);
  if (!identity) return undefined;
  const absolute = resolve(identity.projectRoot, identity.sourcePath);
  const root = identity.projectRoot;
  if (absolute !== root && !absolute.startsWith(root + sep)) return undefined;
  return absolute;
}

function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

// ============================================================================
// Caches & throttles (scale: avoid O(n) work on every read)
// ============================================================================

// Graph payload is expensive to build, so cache it and drop the cache whenever
// any note/link changes. Keyed by resolved project root ('' = all).
const graphCache = new Map<string, GraphData>();
// Lowercased title|alias → note id, for wikilink resolution. Rebuilt on demand.
let resolveIndexCache: Map<string, string> | null = null;

/** Drop derived caches. Called by every mutation path. */
export function invalidateNotesCache(): void {
  graphCache.clear();
  resolveIndexCache = null;
}

// Project-document sync is heavy (recursive FS walk). Throttle it per project so
// it runs at most once per window on the request path; refreshes happen in the
// background so reads never block on a full re-scan after the first one.
const SYNC_THROTTLE_MS = 5_000;
const lastSyncAt = new Map<string, number>();
const fileMtimeCache = new Map<string, number>(); // absolute path -> mtimeMs

/** Ensure a project's docs are mirrored without blocking every call on a full
 *  re-scan. First call for a project awaits; later calls return immediately and
 *  refresh in the background when the throttle window has elapsed. */
export async function ensureProjectSync(projectRoot: string): Promise<void> {
  const key = resolve(projectRoot);
  const now = Date.now();
  const last = lastSyncAt.get(key);
  if (last === undefined) {
    lastSyncAt.set(key, now);
    await syncProjectDocuments(projectRoot);
    return;
  }
  if (now - last >= SYNC_THROTTLE_MS) {
    lastSyncAt.set(key, now);
    void syncProjectDocuments(projectRoot).catch(() => {});
  }
}

// ============================================================================
// Frontmatter & aliases
// ============================================================================

export interface ParsedFrontmatter {
  aliases: string[];
  tags: string[];
  body: string;
}

/** Parse a leading YAML frontmatter block for `aliases` and `tags` (the two
 *  Obsidian properties that affect linking/search). Supports inline
 *  `[a, b]` lists and block `- a` lists. Content without frontmatter is
 *  returned unchanged with empty aliases/tags. */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!m) return { aliases: [], tags: [], body: content };
  const lines = m[1].split(/\r?\n/);
  const body = content.slice(m[0].length);
  const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, '');

  const readList = (key: string): string[] => {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const head = new RegExp(`^${key}\\s*:(.*)$`, 'i').exec(line);
      if (!head) continue;
      const rest = head[1].trim();
      // inline list: key: [a, b]
      const inline = /^\[(.*)\]$/.exec(rest);
      if (inline) return inline[1].split(',').map(unquote).filter(Boolean);
      // scalar: key: value
      if (rest) return [unquote(rest)];
      // block list: subsequent indented "- item" lines
      const items: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const item = /^\s+-\s+(.+)$/.exec(lines[j]);
        if (!item) break;
        const v = unquote(item[1]);
        if (v) items.push(v);
      }
      return items;
    }
    return [];
  };

  return { aliases: readList('aliases'), tags: readList('tags'), body };
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

function extractProjectDocumentLinks(sourcePath: string, content: string): string[] {
  const links: string[] = [];
  const pattern = /(?:\[[^\]]*\]\(|(?:href|src)\s*=\s*["'])([^)"'#?]+)(?:#[^)]*)?(?:\)|["'])/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const target = match[1].trim();
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) continue;
    const resolved = target.startsWith('/')
      ? target.slice(1)
      : join(dirname(sourcePath), target).split(sep).join('/');
    const normalized = resolved
      .split('/')
      .reduce<string[]>((parts, part) => {
        if (!part || part === '.') return parts;
        if (part === '..') parts.pop();
        else parts.push(part);
        return parts;
      }, [])
      .join('/');
    if (DOCUMENT_EXTENSIONS.has(extname(normalized).toLowerCase())) links.push(normalized);
  }
  return [...new Set(links)];
}

/**
 * Convert a raw DB row to a typed Note object.
 * Handles JSON parsing for tags and boolean coercion.
 */
function rowToNote(row: typeof notes.$inferSelect): Note {
  const sourcePath = projectDocumentIdentity(row.id)?.sourcePath;
  const extension = sourcePath ? extname(sourcePath).toLowerCase() : '';
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
    createdAt:
      row.createdAt instanceof Date ? row.createdAt : new Date((row.createdAt as number) * 1000),
    updatedAt:
      row.updatedAt instanceof Date ? row.updatedAt : new Date((row.updatedAt as number) * 1000),
    sourcePath,
    // Project documents derive format from the file extension; DB notes carry
    // their own format column ('markdown' default, 'html' → sandboxed preview).
    format: sourcePath
      ? extension === '.html' || extension === '.htm'
        ? 'html'
        : 'markdown'
      : ((row.format as 'markdown' | 'html' | undefined) ?? 'markdown'),
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
    format: input.format ?? 'markdown',
    userId: input.userId ?? null,
    createdAt: now,
    updatedAt: now,
  });

  // New title/alias → the resolution index is stale.
  invalidateNotesCache();
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
  if (input.includeInContext !== undefined)
    updateData.includeInContext = input.includeInContext ? 1 : 0;
  if (input.format !== undefined) updateData.format = input.format;

  await db.update(notes).set(updateData).where(eq(notes.id, id));

  const sourceFile = resolveProjectDocument(id);
  if (sourceFile && input.content !== undefined) {
    writeFileSync(sourceFile, input.content, 'utf8');
  }

  // Title/alias may have changed → drop the resolution index before re-linking.
  invalidateNotesCache();

  if (input.title !== undefined && input.title !== existing.title) {
    await propagateTitleRename(id, existing.title, input.title);
  }

  const contentForLinks =
    input.content ?? (input.title !== undefined ? (await getNote(id))?.content : undefined);
  if (contentForLinks !== undefined) {
    await parseAndSaveLinks(id, contentForLinks);
  }

  invalidateNotesCache();
  return (await getNote(id))!;
}

export async function deleteNote(id: string): Promise<void> {
  const sourceFile = resolveProjectDocument(id);
  if (sourceFile && existsSync(sourceFile)) unlinkSync(sourceFile);
  // Delete attachment files from disk before DB rows are cascade-deleted
  const attachments = await db.select().from(noteAttachments).where(eq(noteAttachments.noteId, id));

  for (const att of attachments) {
    try {
      unlinkSync(att.storagePath);
    } catch {
      // Ignore missing files — DB row will still be removed via cascade
    }
  }

  await db.delete(notes).where(eq(notes.id, id));
  invalidateNotesCache();
}

export interface ProjectDocumentSyncResult {
  discovered: number;
  created: number;
  updated: number;
  removed: number;
}

/** Mirror every project Markdown/HTML document into the note graph. The real
 * project file remains authoritative; edits through Koryphaios are written
 * through to disk. Generated/vendor directories are intentionally excluded. */
export async function syncProjectDocuments(
  projectRoot = PROJECT_ROOT,
): Promise<ProjectDocumentSyncResult> {
  const root = resolve(projectRoot);
  const files: string[] = [];

  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!IGNORED_DOCUMENT_DIRS.has(entry.name)) walk(join(directory, entry.name));
        continue;
      }
      if (entry.isFile() && DOCUMENT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        files.push(join(directory, entry.name));
      }
    }
  }

  walk(root);
  const foundIds = new Set<string>();
  const changed: Array<{ id: string; content: string; sourcePath: string; existed: boolean }> = [];
  const existingProjectRows = (await db.select().from(notes)).filter(
    (row) => projectDocumentIdentity(row.id)?.projectRoot === root,
  );
  const existingById = new Map(existingProjectRows.map((row) => [row.id, row]));
  const pendingInserts: Array<typeof notes.$inferInsert> = [];
  let created = 0;
  let updated = 0;

  for (const absolute of files) {
    const sourcePath = relative(root, absolute).split(sep).join('/');
    const id = projectDocumentId(root, sourcePath);
    foundIds.add(id);
    const stat = statSync(absolute);
    // Skip unchanged files entirely — no read, no DB write, no re-link.
    if (fileMtimeCache.get(absolute) === stat.mtimeMs) continue;

    const content = readFileSync(absolute, 'utf8');
    const title = basename(sourcePath, extname(sourcePath));
    const parent = dirname(sourcePath).split(sep).join('/');
    const folderPath = parent === '.' ? '/Project' : `/Project/${parent}`;
    const extension = extname(sourcePath).toLowerCase();
    const tags = JSON.stringify([
      'project-file',
      extension === '.html' || extension === '.htm' ? 'html' : 'markdown',
    ]);
    const existing = existingById.get(id);
    if (existing) {
      if (
        existing.content !== content ||
        existing.title !== title ||
        existing.folderPath !== folderPath
      ) {
        await db
          .update(notes)
          .set({ title, content, folderPath, tags, updatedAt: stat.mtime })
          .where(eq(notes.id, id));
        updated++;
      }
    } else {
      pendingInserts.push({
        id,
        title,
        content,
        folderPath,
        tags,
        pinned: 0,
        includeInContext: 0,
        userId: null,
        createdAt: stat.birthtime,
        updatedAt: stat.mtime,
      });
      created++;
    }
    fileMtimeCache.set(absolute, stat.mtimeMs);
    changed.push({ id, content, sourcePath, existed: Boolean(existing) });
  }

  // A fresh project used to perform one SELECT and one INSERT per document.
  // Bulk insertion removes that N+1 startup cost while preserving per-file
  // write-through updates for documents already in the graph.
  for (let i = 0; i < pendingInserts.length; i += 500) {
    await db.insert(notes).values(pendingInserts.slice(i, i + 500));
  }

  let removed = 0;
  for (const row of existingProjectRows) {
    if (!foundIds.has(row.id)) {
      await db.delete(notes).where(eq(notes.id, row.id));
      removed++;
    }
  }

  // Re-resolve links only for files that changed this pass. Build the
  // title/alias index ONCE and reuse it (no per-link DB round-trip).
  if (changed.length > 0 || removed > 0) {
    invalidateNotesCache();
    const needsWikilinkIndex = changed.some(({ content }) => content.includes('[['));
    const index = needsWikilinkIndex ? await getResolveIndex() : undefined;
    for (const { id, content, sourcePath, existed } of changed) {
      // Existing documents must clear stale links even if their new content
      // has none. Brand-new unlinked documents need no DELETE/INSERT work.
      if (existed || content.includes('[[')) {
        await parseAndSaveLinks(id, content, { index, skipInvalidate: true });
      }
      for (const targetPath of extractProjectDocumentLinks(sourcePath, content)) {
        const targetId = projectDocumentId(root, targetPath);
        if (targetId === id || !foundIds.has(targetId)) continue;
        try {
          await db.insert(noteLinks).values({ fromNoteId: id, toNoteId: targetId });
        } catch {
          // Existing edge (a wikilink and a path link to the same document).
        }
      }
    }
    invalidateNotesCache();
  }

  return { discovered: files.length, created, updated, removed };
}

export async function listNotes(
  filters?: {
    folderPath?: string;
    tags?: string[];
    search?: string;
    /** Page size. Omit for all (agent context injection caps elsewhere). */
    limit?: number;
    offset?: number;
  },
  projectRoot?: string,
): Promise<Note[]> {
  if (projectRoot) await ensureProjectSync(projectRoot);

  const isProjectVisible = (id: string) => {
    const identity = projectDocumentIdentity(id);
    return !identity || !projectRoot || identity.projectRoot === resolve(projectRoot);
  };

  // Full-text search goes through the FTS index, not a LIKE scan.
  if (filters?.search?.trim()) {
    const ids = ftsSearchIds(filters.search, filters.limit ?? 200);
    if (ids.length === 0) return [];
    const rows = await db.select().from(notes).where(inArray(notes.id, ids));
    const byId = new Map(rows.map((r) => [r.id, r]));
    let out = ids.map((id) => byId.get(id)).filter((r): r is (typeof rows)[number] => !!r);
    if (filters.folderPath && filters.folderPath !== '/') {
      out = out.filter((r) => r.folderPath.startsWith(filters.folderPath!));
    }
    out = out.filter((r) => isProjectVisible(r.id));
    const start = filters.offset ?? 0;
    return out.slice(start, filters.limit ? start + filters.limit : undefined).map(rowToNote);
  }

  let q = db.select().from(notes).$dynamic();
  if (filters?.folderPath && filters.folderPath !== '/') {
    q = q.where(like(notes.folderPath, filters.folderPath + '%'));
  }
  q = q.orderBy(notes.updatedAt);
  if (filters?.limit) q = q.limit(filters.limit);
  if (filters?.offset) q = q.offset(filters.offset);

  const rows = await q;
  return rows.filter((row) => isProjectVisible(row.id)).map(rowToNote);
}

// ============================================================================
// Link Graph
// ============================================================================

export async function getNoteBacklinks(id: string): Promise<Note[]> {
  const links = await db.select().from(noteLinks).where(eq(noteLinks.toNoteId, id));

  if (!links.length) return [];

  const ids = links.map((l) => l.fromNoteId);
  const rows = await db.select().from(notes).where(inArray(notes.id, ids));
  return rows.map(rowToNote);
}

export async function getNoteOutlinks(id: string): Promise<Note[]> {
  const links = await db.select().from(noteLinks).where(eq(noteLinks.fromNoteId, id));

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
  graphCache.clear();

  if (options?.syncContent !== false) {
    const linkPattern = new RegExp(`!?\\[\\[${escapeRegExp(toNote.title)}(?:[|#][^\\]]+?)?\\]\\]`);
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
  graphCache.clear();

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

/** Update [[wikilinks]] across the vault when a note is renamed. Only the notes
 *  that actually link to the renamed note are touched — found via the link graph
 *  (indexed), not a full-table scan. */
async function propagateTitleRename(
  renamedId: string,
  oldTitle: string,
  newTitle: string,
): Promise<void> {
  // Notes that link to the renamed one are exactly its backlinks.
  const backlinks = await db
    .select({ id: noteLinks.fromNoteId })
    .from(noteLinks)
    .where(eq(noteLinks.toNoteId, renamedId));
  if (backlinks.length === 0) return;

  const pattern = new RegExp(`(!?)\\[\\[${escapeRegExp(oldTitle)}((?:[|#][^\\]]+?)?)\\]\\]`, 'g');
  const ids = backlinks.map((b) => b.id);
  const rows = await db.select().from(notes).where(inArray(notes.id, ids));
  for (const row of rows) {
    pattern.lastIndex = 0;
    if (!pattern.test(row.content)) continue;
    pattern.lastIndex = 0;
    const updated = row.content.replace(pattern, `$1[[${newTitle}$2]]`);
    await db
      .update(notes)
      .set({ content: updated, updatedAt: new Date() })
      .where(eq(notes.id, row.id));
  }
  graphCache.clear();
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
export async function getNotesCatalog(projectRoot?: string): Promise<NoteCatalogEntry[]> {
  if (projectRoot) await ensureProjectSync(projectRoot);
  const graph = await getGraphData(projectRoot);
  const linkCountById = new Map(graph.nodes.map((n) => [n.id, n.linkCount]));
  const rows = await db.select().from(notes).orderBy(notes.updatedAt);
  return rows
    .filter((row) => {
      const identity = projectDocumentIdentity(row.id);
      return !identity || !projectRoot || identity.projectRoot === resolve(projectRoot);
    })
    .map((row) => {
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
 * Removes all previous outgoing edges from this note, then re-inserts resolved
 * ones. Resolution is a single indexed map lookup per link (title OR alias) —
 * no per-link database round-trip.
 */
export async function parseAndSaveLinks(
  noteId: string,
  content: string,
  opts?: { index?: Map<string, string>; skipInvalidate?: boolean },
): Promise<void> {
  await db.delete(noteLinks).where(eq(noteLinks.fromNoteId, noteId));

  const titles = extractWikilinks(content);
  if (titles.length > 0) {
    const index = opts?.index ?? (await getResolveIndex());
    const targetIds = new Set<string>();
    for (const title of titles) {
      const id = index.get(title.toLowerCase());
      if (id && id !== noteId) targetIds.add(id);
    }
    for (const toId of targetIds) {
      try {
        await db.insert(noteLinks).values({ fromNoteId: noteId, toNoteId: toId });
      } catch {
        // Ignore duplicate primary key (already linked)
      }
    }
  }
  if (!opts?.skipInvalidate) graphCache.clear();
}

// ============================================================================
// Graph
// ============================================================================

export async function getGraphData(projectRoot?: string): Promise<GraphData> {
  const cacheKey = projectRoot ? resolve(projectRoot) : '';
  const cached = graphCache.get(cacheKey);
  if (cached) return cached;

  const allRows = await db.select().from(notes);
  const allNotes = allRows.filter((row) => {
    const identity = projectDocumentIdentity(row.id);
    return !identity || !projectRoot || identity.projectRoot === resolve(projectRoot);
  });
  const visibleIds = new Set(allNotes.map((row) => row.id));
  const allLinks = (await db.select().from(noteLinks)).filter(
    (link) => visibleIds.has(link.fromNoteId) && visibleIds.has(link.toNoteId),
  );

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

  const edges: GraphEdge[] = allLinks.map((l) => ({ from: l.fromNoteId, to: l.toNoteId }));

  // Ghost nodes: [[wikilinks]] whose target title/alias doesn't exist yet.
  // Resolve against title + aliases so an alias link isn't falsely "unresolved".
  const resolveMap = await getResolveIndex();
  const titleSet = new Set(allNotes.map((n) => n.title.toLowerCase()));
  const ghostNodes = new Map<string, GraphNode>(); // lowered title -> ghost node
  for (const n of allNotes) {
    for (const ref of extractWikilinks(n.content)) {
      const key = ref.toLowerCase();
      if (resolveMap.has(key) || titleSet.has(key)) continue; // resolved
      let ghost = ghostNodes.get(key);
      if (!ghost) {
        ghost = {
          id: 'ghost:' + key,
          title: ref,
          folderPath: '/',
          tags: [],
          linkCount: 0,
          includeInContext: false,
          unresolved: true,
        };
        ghostNodes.set(key, ghost);
        nodes.push(ghost);
      }
      ghost.linkCount += 1;
      edges.push({ from: n.id, to: ghost.id, unresolved: true });
    }
  }

  const data = { nodes, edges };
  graphCache.set(cacheKey, data);
  return data;
}

// ============================================================================
// Folder Tree
// ============================================================================

export async function getFolderTree(projectRoot?: string): Promise<FolderNode[]> {
  const allNotes = (await db.select().from(notes))
    .filter((row) => {
      const identity = projectDocumentIdentity(row.id);
      return !identity || !projectRoot || identity.projectRoot === resolve(projectRoot);
    })
    .map((row) => ({ folderPath: row.folderPath }));

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
// Search (FTS5 — indexed & ranked)
// ============================================================================

/** Build an FTS5 MATCH expression: prefix-match each alphanumeric token, ANDed.
 *  Tokens are alphanumeric only, so they're safe to interpolate as `token*`. */
function ftsMatchExpr(query: string): string {
  const tokens = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return tokens.map((t) => `${t}*`).join(' ');
}

/** Ranked full-text search over the notes_fts index. Falls back to a bounded
 *  LIKE scan only if the FTS table is somehow unavailable (pre-migration DBs). */
function ftsSearchIds(query: string, limit: number): string[] {
  const match = ftsMatchExpr(query);
  if (!match) return [];
  const raw = getDb();
  try {
    const rows = raw
      .query(
        'SELECT note_id FROM notes_fts WHERE notes_fts MATCH ? ORDER BY bm25(notes_fts) LIMIT ?',
      )
      .all(match, limit) as Array<{ note_id: string }>;
    return rows.map((r) => r.note_id);
  } catch {
    const term = '%' + query + '%';
    const rows = raw
      .query('SELECT id FROM notes WHERE title LIKE ? OR content LIKE ? LIMIT ?')
      .all(term, term, limit) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }
}

export async function searchNotes(query: string, limit = 50): Promise<Note[]> {
  if (!query.trim()) return listNotes({ limit });
  const ids = ftsSearchIds(query, limit);
  if (ids.length === 0) return [];
  const rows = await db.select().from(notes).where(inArray(notes.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r]));
  // Preserve FTS rank order.
  return ids
    .map((id) => byId.get(id))
    .filter((r): r is (typeof rows)[number] => !!r)
    .map(rowToNote);
}

// ============================================================================
// Link resolution index (title + frontmatter aliases → note id)
// ============================================================================

/** Lowercased title|alias → note id. Cached; invalidated on any note change. */
async function getResolveIndex(): Promise<Map<string, string>> {
  if (resolveIndexCache) return resolveIndexCache;
  const rows = await db
    .select({ id: notes.id, title: notes.title, content: notes.content })
    .from(notes);
  const map = new Map<string, string>();
  for (const r of rows) {
    map.set(r.title.toLowerCase(), r.id);
    for (const alias of parseFrontmatter(r.content).aliases) {
      const key = alias.toLowerCase();
      if (!map.has(key)) map.set(key, r.id);
    }
  }
  resolveIndexCache = map;
  return map;
}

/** Resolve a wikilink reference (title or alias) to a note id. */
export async function resolveNoteRef(ref: string): Promise<string | null> {
  return (await getResolveIndex()).get(ref.trim().toLowerCase()) ?? null;
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
  const rows = await db.select().from(noteAttachments).where(eq(noteAttachments.id, id));

  if (!rows[0]) return null;

  const row = rows[0];
  return {
    id: row.id,
    noteId: row.noteId,
    filename: row.filename,
    mimeType: row.mimeType,
    size: row.size,
    storagePath: row.storagePath,
    createdAt:
      row.createdAt instanceof Date ? row.createdAt : new Date((row.createdAt as number) * 1000),
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
      createdAt:
        a.createdAt instanceof Date ? a.createdAt : new Date((a.createdAt as number) * 1000),
    })),
  };
}
