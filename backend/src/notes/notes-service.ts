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
import { eq, like, and, or, inArray, isNull, sql, desc } from 'drizzle-orm';
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
  renameSync,
} from 'fs';
import { readdir, readFile, stat } from 'fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'path';
import { createHash } from 'node:crypto';
import { PROJECT_ROOT } from '../runtime/paths';
import { serverLog } from '../logger';
import {
  ConflictError,
  NotFoundError,
  PayloadTooLargeError,
  ValidationError,
} from '../errors/types';
import {
  loadNotesSettings,
  NOTES_HARD_MAX_ATTACHMENT_BYTES,
  NOTES_HARD_MAX_BYTES,
} from './notes-settings';

// ============================================================================
// Paths & Helpers
// ============================================================================

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
  // Koryphaios internal directories — contain thousands of plugin/skill .md
  // files that are not user notes and must not be synced into the notes graph.
  // Syncing them caused the backend to crash (Bun VM trap from 3000+ synchronous
  // SQLite writes blocking the event loop).
  '.koryphaios',
  '.claude',
  '.devin',
  '.trees',
  '.agents',
]);
const MAX_TITLE_LENGTH = 300;
const MAX_FOLDER_PATH_LENGTH = 1_000;
const MAX_TAGS = 100;
const MAX_TAG_LENGTH = 100;
const INTERNAL_NOTE_TAG_PREFIXES = ['koryphaios-memory-import:'] as const;
const ALLOWED_ATTACHMENT_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/markdown',
  'application/json',
  'application/zip',
]);

function resolvedProjectRoot(projectRoot?: string): string | undefined {
  return projectRoot ? resolve(projectRoot) : undefined;
}

function rowProjectRoot(row: { id: string; projectRoot?: string | null }): string {
  return projectDocumentIdentity(row.id)?.projectRoot ?? resolve(row.projectRoot || PROJECT_ROOT);
}

function isVisibleInProject(
  row: { id: string; projectRoot?: string | null },
  projectRoot?: string,
): boolean {
  const root = resolvedProjectRoot(projectRoot);
  return !root || rowProjectRoot(row) === root;
}

function scopedNotesCondition(projectRoot?: string) {
  const root = resolvedProjectRoot(projectRoot);
  if (!root) return undefined;
  return root === resolve(PROJECT_ROOT)
    ? or(eq(notes.projectRoot, root), isNull(notes.projectRoot))
    : eq(notes.projectRoot, root);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function validateTitle(title: string): string {
  const normalized = title.trim();
  if (!normalized) throw new ValidationError('Note title cannot be empty');
  if (normalized.length > MAX_TITLE_LENGTH) {
    throw new ValidationError(`Note title cannot exceed ${MAX_TITLE_LENGTH} characters`);
  }
  if (/\p{Cc}/u.test(normalized))
    throw new ValidationError('Note title contains control characters');
  return normalized;
}

function validateFolderPath(folderPath: string): string {
  const normalized = folderPath.trim() || '/';
  if (normalized.length > MAX_FOLDER_PATH_LENGTH) {
    throw new ValidationError(`Folder path cannot exceed ${MAX_FOLDER_PATH_LENGTH} characters`);
  }
  if (/\p{Cc}/u.test(normalized) || normalized.split(/[\\/]/).includes('..')) {
    throw new ValidationError('Folder path contains unsafe segments');
  }
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

function validateTags(tags: string[]): string[] {
  if (tags.length > MAX_TAGS) throw new ValidationError(`A note can have at most ${MAX_TAGS} tags`);
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))].map((tag) => {
    if (tag.length > MAX_TAG_LENGTH || /\p{Cc}/u.test(tag)) {
      throw new ValidationError(
        `Tags cannot exceed ${MAX_TAG_LENGTH} characters or contain controls`,
      );
    }
    return tag;
  });
}

function parseStoredTags(value: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(value || '[]') as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((tag): tag is string => typeof tag === 'string')
      : [];
  } catch (err: unknown) {
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'note tags parse failed — returning empty array',
    );
    return [];
  }
}

function isInternalNoteTag(tag: string): boolean {
  return INTERNAL_NOTE_TAG_PREFIXES.some((prefix) => tag.startsWith(prefix));
}

function publicNoteTags(value: string | null | undefined): string[] {
  return parseStoredTags(value).filter((tag) => !isInternalNoteTag(tag));
}

function assertContentBudget(content: string, projectRoot: string): void {
  const settings = loadNotesSettings(projectRoot);
  const maxBytes = settings.noteSizeLimitEnabled ? settings.maxNoteBytes : NOTES_HARD_MAX_BYTES;
  const actualBytes = byteLength(content);
  if (actualBytes > maxBytes) {
    throw new PayloadTooLargeError(`${maxBytes} bytes`, { actualBytes, maxBytes });
  }
}

function atomicWrite(path: string, data: string | Buffer): void {
  ensureDir(dirname(path));
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${nanoid(8)}.tmp`);
  const mode = existsSync(path) ? statSync(path).mode : 0o600;
  try {
    writeFileSync(temp, data, { encoding: typeof data === 'string' ? 'utf8' : undefined, mode });
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

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
  } catch (err: unknown) {
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'project document identity decode failed — returning undefined',
    );
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
// Lowercased title|alias → note id, for wikilink resolution. Rebuilt on demand
// and keyed by project so same-titled notes never cross workspace boundaries.
const resolveIndexCache = new Map<string, Map<string, string>>();

/** Drop derived caches. Called by every mutation path. */
export function invalidateNotesCache(): void {
  graphCache.clear();
  resolveIndexCache.clear();
}

// Project-document sync is heavy (recursive FS walk). Throttle it per project so
// it runs at most once per window on the request path; refreshes happen in the
// background so reads never block on a full re-scan after the first one.
const SYNC_THROTTLE_MS = 5_000;
const lastSyncAt = new Map<string, number>();
const fileMtimeCache = new Map<string, number>(); // absolute path -> mtimeMs
/** Tracks whether the initial sync has completed for a given project root.
 * The notes catalog is empty until this resolves — skipping catalog assembly
 * during the initial sync avoids racing with synchronous SQLite writes that
 * would block the event loop. */
const initialSyncComplete = new Map<string, boolean>();
const projectSyncs = new Map<string, Promise<ProjectDocumentSyncResult>>();
export interface ProjectSyncStatus {
  state: 'idle' | 'running' | 'complete' | 'partial' | 'failed';
  discovered?: number;
  error?: string;
}
const projectSyncStatus = new Map<string, ProjectSyncStatus>();

export function getProjectSyncStatus(projectRoot: string): ProjectSyncStatus {
  return projectSyncStatus.get(resolve(projectRoot)) ?? { state: 'idle' };
}

/** Ensure a project's docs are mirrored without blocking every call on a full
 *  re-scan. The first caller waits for the single-flight initial scan so it
 *  never receives a false empty catalog; the walker and write batches yield to
 *  keep health and other API work responsive. Later stale scans refresh in the
 *  background. */
export async function ensureProjectSync(projectRoot: string): Promise<void> {
  const key = resolve(projectRoot);
  const now = Date.now();
  const last = lastSyncAt.get(key);
  if (!initialSyncComplete.get(key)) {
    if (last === undefined) lastSyncAt.set(key, now);
    try {
      // syncProjectDocuments is single-flight. Every concurrent first reader
      // joins that same promise instead of observing an empty catalog while
      // the first caller is still walking the project.
      await syncProjectDocuments(projectRoot);
    } catch (err) {
      serverLog.error({ err, key }, 'Initial project sync failed');
      // A failed initial scan is not an empty vault. Propagate the failure so
      // the client can show recovery, and let the next request retry it.
      throw err;
    }
    return;
  }
  if (last === undefined || now - last >= SYNC_THROTTLE_MS) {
    lastSyncAt.set(key, now);
    void syncProjectDocuments(projectRoot).catch((err) => {
      serverLog.error({ err, key }, 'Background project sync failed');
    });
  }
}

/** Returns true only after the initial project sync produced a catalog. */
export function isInitialSyncComplete(projectRoot: string): boolean {
  return initialSyncComplete.get(resolve(projectRoot)) === true;
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
    tags: publicNoteTags(row.tags),
    pinned: Boolean(row.pinned),
    includeInContext: Boolean(row.includeInContext),
    userId: row.userId ?? undefined,
    createdAt:
      row.createdAt instanceof Date ? row.createdAt : new Date((row.createdAt as number) * 1000),
    updatedAt:
      row.updatedAt instanceof Date ? row.updatedAt : new Date((row.updatedAt as number) * 1000),
    revision: row.revision ?? 1,
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

function rowToNoteMeta(row: {
  id: string;
  title: string;
  folderPath: string;
  tags: string;
  pinned: number;
  includeInContext: number;
  format: string | null;
  userId: string | null;
  createdAt: Date | number;
  updatedAt: Date | number;
  projectRoot: string | null;
  revision: number;
}): Note {
  const sourcePath = projectDocumentIdentity(row.id)?.sourcePath;
  const extension = sourcePath ? extname(sourcePath).toLowerCase() : '';
  return {
    id: row.id,
    title: row.title,
    content: '',
    folderPath: row.folderPath,
    tags: publicNoteTags(row.tags),
    pinned: Boolean(row.pinned),
    includeInContext: Boolean(row.includeInContext),
    userId: row.userId ?? undefined,
    createdAt:
      row.createdAt instanceof Date ? row.createdAt : new Date((row.createdAt as number) * 1000),
    updatedAt:
      row.updatedAt instanceof Date ? row.updatedAt : new Date((row.updatedAt as number) * 1000),
    revision: row.revision ?? 1,
    sourcePath,
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

const noteMutationQueues = new Map<string, Promise<void>>();

async function withNoteMutation<T>(id: string, work: () => Promise<T>): Promise<T> {
  const previous = noteMutationQueues.get(id) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveQueue) => {
    release = resolveQueue;
  });
  noteMutationQueues.set(id, current);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (noteMutationQueues.get(id) === current) noteMutationQueues.delete(id);
  }
}

export async function createNote(
  input: CreateNoteInput,
  projectRoot = PROJECT_ROOT,
): Promise<Note> {
  const id = nanoid();
  const now = new Date();
  const root = resolve(projectRoot);
  const title = validateTitle(input.title);
  const content = input.content ?? '';
  assertContentBudget(content, root);

  await db.insert(notes).values({
    id,
    title,
    content,
    folderPath: validateFolderPath(input.folderPath ?? '/'),
    tags: JSON.stringify(validateTags(input.tags ?? [])),
    pinned: input.pinned ? 1 : 0,
    includeInContext: input.includeInContext ? 1 : 0,
    format: input.format ?? 'markdown',
    projectRoot: root,
    revision: 1,
    userId: input.userId ?? null,
    createdAt: now,
    updatedAt: now,
  });

  // New title/alias → the resolution index is stale.
  invalidateNotesCache();
  if (content) {
    await parseAndSaveLinks(id, content, { projectRoot: root });
  }

  return (await getNote(id, root))!;
}

export async function getNote(id: string, projectRoot?: string): Promise<Note | null> {
  const rows = await db.select().from(notes).where(eq(notes.id, id));
  return rows[0] && isVisibleInProject(rows[0], projectRoot) ? rowToNote(rows[0]) : null;
}

export async function getNoteByTitle(title: string, projectRoot?: string): Promise<Note | null> {
  const scope = scopedNotesCondition(projectRoot);
  const rows = await db
    .select()
    .from(notes)
    .where(scope ? and(eq(notes.title, title), scope) : eq(notes.title, title));
  return rows[0] ? rowToNote(rows[0]) : null;
}

export async function updateNote(
  id: string,
  input: UpdateNoteInput,
  projectRoot?: string,
): Promise<Note> {
  return withNoteMutation(id, async () => {
    const existing = await getNote(id, projectRoot);
    if (!existing) throw new NotFoundError('Note', id);
    if (input.expectedRevision !== undefined && input.expectedRevision !== existing.revision) {
      throw new ConflictError(
        'This note changed after it was opened. Review the newer version before saving.',
        {
          expectedRevision: input.expectedRevision,
          currentRevision: existing.revision,
        },
      );
    }

    const root = rowProjectRoot({ id, projectRoot: resolvedProjectRoot(projectRoot) });
    if (input.content !== undefined) assertContentBudget(input.content, root);
    const sourceFile = resolveProjectDocument(id);
    if (sourceFile && input.content !== undefined) {
      const sourceExists = existsSync(sourceFile);
      if (!sourceExists && !input.restoreDeletedSource) {
        throw new ConflictError(
          'The source document was removed outside Koryphaios. Review the deletion before recreating it.',
          { sourceDeleted: true, currentRevision: existing.revision },
        );
      }
      const diskContent = sourceExists ? readFileSync(sourceFile, 'utf8') : null;
      if (diskContent !== null && diskContent !== existing.content) {
        assertContentBudget(diskContent, root);
        const diskStat = statSync(sourceFile);
        const diskRevision = existing.revision + 1;
        const refreshedRows = await db
          .update(notes)
          .set({
            content: diskContent,
            projectRoot: root,
            revision: diskRevision,
            updatedAt: diskStat.mtime,
          })
          .where(and(eq(notes.id, id), eq(notes.revision, existing.revision)))
          .returning({ id: notes.id });
        if (refreshedRows.length === 1) {
          fileMtimeCache.set(sourceFile, diskStat.mtimeMs);
          invalidateNotesCache();
          await parseAndSaveLinks(id, diskContent, { projectRoot: root });
        }
        const current = await getNote(id, root);
        throw new ConflictError(
          'The source document changed on disk. The newer disk revision is ready for review.',
          {
            expectedRevision: input.expectedRevision,
            currentRevision: current?.revision ?? diskRevision,
            sourceChanged: true,
          },
        );
      }
    }
    const now = new Date();
    const nextRevision = existing.revision + 1;
    const updateData: Partial<typeof notes.$inferInsert> = {
      updatedAt: now,
      revision: nextRevision,
      projectRoot: root,
    };

    if (input.title !== undefined) updateData.title = validateTitle(input.title);
    if (input.content !== undefined) updateData.content = input.content;
    if (input.folderPath !== undefined)
      updateData.folderPath = validateFolderPath(input.folderPath);
    if (input.tags !== undefined) {
      const [rawRow] = await db.select({ tags: notes.tags }).from(notes).where(eq(notes.id, id));
      const internalTags = parseStoredTags(rawRow?.tags).filter(isInternalNoteTag);
      updateData.tags = JSON.stringify([...validateTags(input.tags), ...internalTags]);
    }
    if (input.pinned !== undefined) updateData.pinned = input.pinned ? 1 : 0;
    if (input.includeInContext !== undefined)
      updateData.includeInContext = input.includeInContext ? 1 : 0;
    if (input.format !== undefined) updateData.format = input.format;

    if (sourceFile && input.content !== undefined) {
      atomicWrite(sourceFile, input.content);
    }

    const updatedRows = await db
      .update(notes)
      .set(updateData)
      .where(and(eq(notes.id, id), eq(notes.revision, existing.revision)))
      .returning({ id: notes.id });
    if (updatedRows.length !== 1) {
      throw new ConflictError(
        'This note changed while it was being saved. Reload and review the newer version.',
      );
    }

    // Title/alias may have changed → drop the resolution index before re-linking.
    invalidateNotesCache();

    if (input.title !== undefined && input.title !== existing.title) {
      await propagateTitleRename(id, existing.title, validateTitle(input.title), root);
    }

    const contentForLinks =
      input.content ?? (input.title !== undefined ? (await getNote(id, root))?.content : undefined);
    if (contentForLinks !== undefined) {
      await parseAndSaveLinks(id, contentForLinks, { projectRoot: root });
    }

    invalidateNotesCache();
    return (await getNote(id, root))!;
  });
}

export async function deleteNote(
  id: string,
  projectRoot?: string,
  expectedRevision?: number,
): Promise<void> {
  await withNoteMutation(id, async () => {
    const existing = await getNote(id, projectRoot);
    if (!existing) throw new NotFoundError('Note', id);
    if (expectedRevision !== undefined && expectedRevision !== existing.revision) {
      throw new ConflictError(
        'This note changed after it was opened. Review the newer version before deleting it.',
        {
          expectedRevision,
          currentRevision: existing.revision,
        },
      );
    }
    const root = rowProjectRoot({ id, projectRoot: resolvedProjectRoot(projectRoot) });
    const sourceFile = resolveProjectDocument(id);
    // Delete attachment files from disk before DB rows are cascade-deleted.
    const attachments = await db
      .select()
      .from(noteAttachments)
      .where(eq(noteAttachments.noteId, id));

    // The revision predicate closes the read/delete race even when another
    // writer changes the row after the precondition check above.
    const deletedRows = await db
      .delete(notes)
      .where(and(eq(notes.id, id), eq(notes.revision, existing.revision)))
      .returning({ id: notes.id });
    if (deletedRows.length !== 1) {
      throw new ConflictError(
        'This note changed while it was being deleted. Reload and review the newer version.',
      );
    }

    if (sourceFile && existsSync(sourceFile)) unlinkSync(sourceFile);

    for (const att of attachments) {
      if (!attachmentStorageIsAuthorized(att, root)) {
        serverLog.warn(
          { attachmentId: att.id, noteId: id },
          'Refused to delete an attachment outside the project attachment directory',
        );
        continue;
      }
      try {
        unlinkSync(att.storagePath);
      } catch (err: unknown) {
        // Ignore missing files — DB row will still be removed via cascade.
        serverLog.debug(
          { err: err instanceof Error ? err.message : String(err) },
          'Note attachment file already gone during delete',
        );
      }
    }

    invalidateNotesCache();
  });
}

export interface ProjectDocumentSyncResult {
  discovered: number;
  created: number;
  updated: number;
  removed: number;
  /** False only after a complete traversal; partial scans never prune unseen rows. */
  truncated: boolean;
}

/** Mirror every project Markdown/HTML document into the note graph. The real
 * project file remains authoritative; edits through Koryphaios are written
 * through to disk. Generated/vendor directories are intentionally excluded. */
export async function syncProjectDocuments(
  projectRoot = PROJECT_ROOT,
): Promise<ProjectDocumentSyncResult> {
  const root = resolve(projectRoot);
  const active = projectSyncs.get(root);
  if (active) return active;
  projectSyncStatus.set(root, { state: 'running' });
  const sync = performProjectDocumentSync(root)
    .then((result) => {
      initialSyncComplete.set(root, true);
      lastSyncAt.set(root, Date.now());
      projectSyncStatus.set(root, {
        state: result.truncated ? 'partial' : 'complete',
        discovered: result.discovered,
        ...(result.truncated
          ? {
              error:
                'Some project documents could not be inspected; existing entries were preserved.',
            }
          : {}),
      });
      return result;
    })
    .catch((err: unknown) => {
      initialSyncComplete.delete(root);
      projectSyncStatus.set(root, {
        state: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    })
    .finally(() => {
      if (projectSyncs.get(root) === sync) projectSyncs.delete(root);
    });
  projectSyncs.set(root, sync);
  return sync;
}

async function performProjectDocumentSync(projectRoot: string): Promise<ProjectDocumentSyncResult> {
  const root = resolve(projectRoot);
  const files: string[] = [];
  let scanComplete = true;

  // Safety limit: cap the number of files we'll scan/insert to prevent
  // runaway syncs from crashing the backend (Bun VM trap from too many
  // synchronous SQLite writes). 1000 is generous for real project docs
  // while excluding the thousands of plugin/skill files in internal dirs.
  const MAX_FILES = 1000;

  // Use async readdir so the event loop stays responsive during the
  // recursive directory walk. The synchronous readdirSync would block
  // for 10+ seconds on large projects, making the backend unresponsive
  // to health checks and other API calls.
  async function walk(directory: string): Promise<void> {
    if (files.length >= MAX_FILES) {
      scanComplete = false;
      return;
    }
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (err) {
      serverLog.error({ err, directory }, 'Failed to read directory during project sync');
      scanComplete = false;
      return;
    }

    for (const entry of entries) {
      if (files.length >= MAX_FILES) {
        scanComplete = false;
        return;
      }
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!IGNORED_DOCUMENT_DIRS.has(entry.name)) await walk(join(directory, entry.name));
        continue;
      }
      if (entry.isFile() && DOCUMENT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        files.push(join(directory, entry.name));
      }
    }
  }

  await walk(root);
  const foundIds = new Set<string>();
  const changed: Array<{ id: string; content: string; sourcePath: string; existed: boolean }> = [];
  // Limit the scan of existing rows to prevent loading the entire notes table.
  // Project-document IDs are prefixed, so we filter on that prefix.
  const existingProjectRows = (
    await db
      .select({
        id: notes.id,
        content: notes.content,
        title: notes.title,
        folderPath: notes.folderPath,
        projectRoot: notes.projectRoot,
        revision: notes.revision,
      })
      .from(notes)
      .where(like(notes.id, PROJECT_DOCUMENT_PREFIX + '%'))
      .limit(5000)
  ).filter((row) => projectDocumentIdentity(row.id)?.projectRoot === root);
  const existingById = new Map(existingProjectRows.map((row) => [row.id, row]));
  const pendingInserts: Array<typeof notes.$inferInsert> = [];
  let created = 0;
  let updated = 0;

  for (let fileIdx = 0; fileIdx < files.length; fileIdx++) {
    // Yield every 25 files to let health checks and API calls run between
    // synchronous SQLite writes (bun:sqlite is synchronous).
    if (fileIdx > 0 && fileIdx % 25 === 0) await new Promise<void>((r) => setImmediate(r));
    const absolute = files[fileIdx];
    const sourcePath = relative(root, absolute).split(sep).join('/');
    const id = projectDocumentId(root, sourcePath);
    foundIds.add(id);

    let fileStat;
    try {
      fileStat = await stat(absolute);
    } catch (err) {
      serverLog.error({ err, file: absolute }, 'Failed to stat file during project sync');
      continue;
    }
    // Skip unchanged files entirely — no read, no DB write, no re-link.
    if (fileMtimeCache.get(absolute) === fileStat.mtimeMs) continue;

    let content: string;
    try {
      content = await readFile(absolute, 'utf8');
    } catch (err) {
      serverLog.error({ err, file: absolute }, 'Failed to read file during project sync');
      scanComplete = false;
      continue;
    }
    if (byteLength(content) > NOTES_HARD_MAX_BYTES) {
      serverLog.warn(
        { file: absolute, size: byteLength(content), maxBytes: NOTES_HARD_MAX_BYTES },
        'Skipping oversized project document during note sync',
      );
      scanComplete = false;
      continue;
    }

    const title = basename(sourcePath, extname(sourcePath));
    const parent = dirname(sourcePath).split(sep).join('/');
    const folderPath = parent === '.' ? '/Project' : `/Project/${parent}`;
    const extension = extname(sourcePath).toLowerCase();
    const tags = JSON.stringify([
      'project-file',
      extension === '.html' || extension === '.htm' ? 'html' : 'markdown',
    ]);
    const existing = existingById.get(id);
    let synced = false;
    if (existing) {
      try {
        await withNoteMutation(id, async () => {
          // Re-read after acquiring the same mutation queue used by editor
          // saves. A user save may have replaced the source file while this
          // scan was waiting; applying the pre-lock bytes would lose it.
          const latestStat = statSync(absolute);
          const latestContent = readFileSync(absolute, 'utf8');
          if (byteLength(latestContent) > NOTES_HARD_MAX_BYTES) {
            scanComplete = false;
            return;
          }
          const current = await getNote(id, root);
          if (!current) {
            scanComplete = false;
            return;
          }
          content = latestContent;
          fileStat = latestStat;
          if (
            current.content !== latestContent ||
            current.title !== title ||
            current.folderPath !== folderPath ||
            existing.projectRoot !== root
          ) {
            const changedRows = await db
              .update(notes)
              .set({
                title,
                content: latestContent,
                folderPath,
                tags,
                projectRoot: root,
                revision: current.revision + 1,
                updatedAt: latestStat.mtime,
              })
              .where(and(eq(notes.id, id), eq(notes.revision, current.revision)))
              .returning({ id: notes.id });
            if (changedRows.length !== 1) {
              throw new ConflictError('The project document changed while it was being indexed.');
            }
            updated++;
          }
          synced = true;
        });
      } catch (err) {
        scanComplete = false;
        serverLog.error({ err, noteId: id }, 'Failed to update synced note');
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
        projectRoot: root,
        revision: 1,
        userId: null,
        createdAt: fileStat.birthtime,
        updatedAt: fileStat.mtime,
      });
      synced = true;
      created++;
    }
    if (!synced) continue;
    fileMtimeCache.set(absolute, fileStat.mtimeMs);
    changed.push({ id, content, sourcePath, existed: Boolean(existing) });
  }

  // A fresh project used to perform one SELECT and one INSERT per document.
  // Bulk insertion removes that N+1 startup cost while preserving per-file
  // write-through updates for documents already in the graph.
  // Yield between batches so synchronous SQLite writes don't block the
  // event loop for too long in a single chunk.
  const yieldBetweenBatches = () => new Promise<void>((r) => setImmediate(r));
  for (let i = 0; i < pendingInserts.length; i += 100) {
    if (i > 0) await yieldBetweenBatches();
    const batch = pendingInserts.slice(i, i + 100);
    try {
      await db.insert(notes).values(batch).onConflictDoNothing();
    } catch (err) {
      serverLog.error({ err }, 'Bulk note insert failed during project sync; retrying row-by-row');
      for (const row of batch) {
        try {
          await db.insert(notes).values(row).onConflictDoNothing();
          await yieldBetweenBatches();
        } catch (rowErr) {
          serverLog.error(
            { err: rowErr, noteId: row.id },
            'Failed to insert project document note',
          );
        }
      }
    }
  }

  let removed = 0;
  for (let idx = 0; scanComplete && idx < existingProjectRows.length; idx++) {
    if (idx > 0 && idx % 50 === 0) await yieldBetweenBatches();
    const row = existingProjectRows[idx];
    if (!foundIds.has(row.id)) {
      try {
        await db.delete(notes).where(eq(notes.id, row.id));
        removed++;
      } catch (err) {
        serverLog.error({ err, noteId: row.id }, 'Failed to remove orphaned project note');
      }
    }
  }

  // Re-resolve links only for files that changed this pass. Build the
  // title/alias index ONCE and reuse it (no per-link DB round-trip).
  if (changed.length > 0 || removed > 0) {
    invalidateNotesCache();
    const needsWikilinkIndex = changed.some(({ content }) => content.includes('[['));
    const index = needsWikilinkIndex ? await getResolveIndex(root) : undefined;
    for (let ci = 0; ci < changed.length; ci++) {
      if (ci > 0 && ci % 25 === 0) await new Promise<void>((r) => setImmediate(r));
      const { id, content, sourcePath, existed } = changed[ci];
      // Existing documents must clear stale links even if their new content
      // has none. Brand-new unlinked documents need no DELETE/INSERT work.
      if (existed || content.includes('[[')) {
        try {
          await parseAndSaveLinks(id, content, { index, skipInvalidate: true, projectRoot: root });
        } catch (err) {
          serverLog.error({ err, noteId: id }, 'Failed to sync wikilinks for note');
        }
      }
      for (const targetPath of extractProjectDocumentLinks(sourcePath, content)) {
        const targetId = projectDocumentId(root, targetPath);
        if (targetId === id || !foundIds.has(targetId)) continue;
        try {
          await db.insert(noteLinks).values({ fromNoteId: id, toNoteId: targetId });
        } catch (err: unknown) {
          // Existing edge (a wikilink and a path link to the same document).
          serverLog.debug(
            {
              err: err instanceof Error ? err.message : String(err),
              fromNoteId: id,
              toNoteId: targetId,
            },
            'project document link edge already exists — skipping duplicate insert',
          );
        }
      }
    }
    invalidateNotesCache();
  }

  return { discovered: files.length, created, updated, removed, truncated: !scanComplete };
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

  const isProjectVisible = (row: { id: string; projectRoot?: string | null }) =>
    isVisibleInProject(row, projectRoot);

  // Full-text search goes through the FTS index, not a LIKE scan.
  if (filters?.search?.trim()) {
    const ids = ftsSearchIds(filters.search, filters.limit ?? 200, projectRoot);
    if (ids.length === 0) return [];
    const scope = scopedNotesCondition(projectRoot);
    const rows = await db
      .select()
      .from(notes)
      .where(scope ? and(inArray(notes.id, ids), scope) : inArray(notes.id, ids));
    const byId = new Map(rows.map((r) => [r.id, r]));
    let out = ids.map((id) => byId.get(id)).filter((r): r is (typeof rows)[number] => !!r);
    if (filters.folderPath && filters.folderPath !== '/') {
      out = out.filter((r) => r.folderPath.startsWith(filters.folderPath!));
    }
    out = out.filter(isProjectVisible);
    const start = filters.offset ?? 0;
    return out.slice(start, filters.limit ? start + filters.limit : undefined).map(rowToNote);
  }

  let q = db
    .select({
      id: notes.id,
      title: notes.title,
      folderPath: notes.folderPath,
      tags: notes.tags,
      pinned: notes.pinned,
      includeInContext: notes.includeInContext,
      format: notes.format,
      userId: notes.userId,
      createdAt: notes.createdAt,
      updatedAt: notes.updatedAt,
      projectRoot: notes.projectRoot,
      revision: notes.revision,
    })
    .from(notes)
    .$dynamic();
  const folderCondition =
    filters?.folderPath && filters.folderPath !== '/'
      ? like(notes.folderPath, filters.folderPath + '%')
      : undefined;
  const scopeCondition = scopedNotesCondition(projectRoot);
  const whereCondition = folderCondition
    ? scopeCondition
      ? and(folderCondition, scopeCondition)
      : folderCondition
    : scopeCondition;
  if (whereCondition) q = q.where(whereCondition);
  q = q.orderBy(desc(notes.pinned), desc(notes.updatedAt));
  if (filters?.limit) q = q.limit(filters.limit);
  if (filters?.offset) q = q.offset(filters.offset);

  const rows = await q;
  return rows.filter(isProjectVisible).map(rowToNoteMeta);
}

// ============================================================================
// Link Graph
// ============================================================================

export async function getNoteBacklinks(id: string, projectRoot?: string): Promise<Note[]> {
  if (!(await getNote(id, projectRoot))) return [];
  const links = await db.select().from(noteLinks).where(eq(noteLinks.toNoteId, id));

  if (!links.length) return [];

  const ids = links.map((l) => l.fromNoteId);
  const rows = await db.select().from(notes).where(inArray(notes.id, ids));
  return rows.filter((row) => isVisibleInProject(row, projectRoot)).map(rowToNote);
}

export async function getNoteOutlinks(id: string, projectRoot?: string): Promise<Note[]> {
  if (!(await getNote(id, projectRoot))) return [];
  const links = await db.select().from(noteLinks).where(eq(noteLinks.fromNoteId, id));

  if (!links.length) return [];

  const ids = links.map((l) => l.toNoteId);
  const rows = await db.select().from(notes).where(inArray(notes.id, ids));
  return rows.filter((row) => isVisibleInProject(row, projectRoot)).map(rowToNote);
}

/** Resolve a note ID from id or title lookup. */
export async function resolveNoteId(
  id?: string,
  title?: string,
  projectRoot?: string,
): Promise<string | null> {
  if (id) {
    const note = await getNote(id, projectRoot);
    return note?.id ?? null;
  }
  if (title) {
    const note = await getNoteByTitle(title, projectRoot);
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
  projectRoot?: string,
): Promise<void> {
  if (fromId === toId) return;

  const [fromNote, toNote] = await Promise.all([
    getNote(fromId, projectRoot),
    getNote(toId, projectRoot),
  ]);
  if (!fromNote || !toNote) throw new NotFoundError('Note');

  try {
    await db.insert(noteLinks).values({ fromNoteId: fromId, toNoteId: toId });
  } catch (err: unknown) {
    // Already linked
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err), fromNoteId: fromId, toNoteId: toId },
      'note link edge already exists — skipping duplicate insert',
    );
  }
  graphCache.clear();

  if (options?.syncContent !== false) {
    const linkPattern = new RegExp(`!?\\[\\[${escapeRegExp(toNote.title)}(?:[|#][^\\]]+?)?\\]\\]`);
    if (!linkPattern.test(fromNote.content)) {
      const suffix = fromNote.content.endsWith('\n') || !fromNote.content ? '' : '\n';
      await updateNote(
        fromId,
        {
          content: fromNote.content + suffix + `[[${toNote.title}]]`,
        },
        projectRoot,
      );
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
  projectRoot?: string,
): Promise<void> {
  const [fromNote, toNote] = await Promise.all([
    getNote(fromId, projectRoot),
    getNote(toId, projectRoot),
  ]);
  if (!fromNote || !toNote) throw new NotFoundError('Note');

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
      await updateNote(fromId, { content: stripped }, projectRoot);
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
  projectRoot?: string,
): Promise<void> {
  // Notes that link to the renamed one are exactly its backlinks.
  const backlinks = await db
    .select({ id: noteLinks.fromNoteId })
    .from(noteLinks)
    .where(eq(noteLinks.toNoteId, renamedId));
  if (backlinks.length === 0) return;

  const pattern = new RegExp(`(!?)\\[\\[${escapeRegExp(oldTitle)}((?:[|#][^\\]]+?)?)\\]\\]`, 'g');
  const ids = backlinks.map((b) => b.id);
  const rows = (await db.select().from(notes).where(inArray(notes.id, ids))).filter((row) =>
    isVisibleInProject(row, projectRoot),
  );
  for (const row of rows) {
    pattern.lastIndex = 0;
    if (!pattern.test(row.content)) continue;
    pattern.lastIndex = 0;
    const updated = row.content.replace(pattern, `$1[[${newTitle}$2]]`);
    try {
      // Use the same CAS, source-file conflict checks, and per-note queue as a
      // direct edit. A simultaneous human save wins instead of being silently
      // overwritten by rename propagation.
      await updateNote(row.id, { content: updated, expectedRevision: row.revision }, projectRoot);
    } catch (error) {
      if (error instanceof ConflictError) {
        serverLog.warn(
          { noteId: row.id, renamedId },
          'Skipped wikilink rename because the backlink changed concurrently',
        );
        continue;
      }
      throw error;
    }
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
  if (projectRoot) {
    await ensureProjectSync(projectRoot);
    // Skip catalog assembly while the initial sync is still running.
    // The sync does recursive FS walks + SQLite writes that block the event
    // loop; racing a catalog read against it causes multi-second stalls.
    // The catalog will be populated on the next message after sync completes.
    if (!isInitialSyncComplete(projectRoot)) return [];
  }
  const graph = await getGraphData(projectRoot);
  const linkCountById = new Map(graph.nodes.map((n) => [n.id, n.linkCount]));
  const scope = scopedNotesCondition(projectRoot);
  const catalogQuery = db.select().from(notes).$dynamic();
  const rows = await (scope ? catalogQuery.where(scope) : catalogQuery)
    .orderBy(notes.updatedAt)
    .limit(5000);
  return rows
    .filter((row) => isVisibleInProject(row, projectRoot))
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

/** Full bodies explicitly selected for automatic agent context, project-scoped. */
export async function getContextNotes(projectRoot?: string, limit = 1_000): Promise<Note[]> {
  const scope = scopedNotesCondition(projectRoot);
  const includeCondition = eq(notes.includeInContext, 1);
  const rows = await db
    .select()
    .from(notes)
    .where(scope ? and(includeCondition, scope) : includeCondition)
    .orderBy(notes.updatedAt)
    .limit(Math.min(5_000, Math.max(1, limit)));
  return rows.filter((row) => isVisibleInProject(row, projectRoot)).map(rowToNote);
}

export interface RecallNotesOptions {
  query?: string;
  ids?: string[];
  titles?: string[];
  limit?: number;
  projectRoot?: string;
}

/** Recall full note content by search query, IDs, or titles. */
export async function recallNotes(options: RecallNotesOptions): Promise<NoteWithLinks[]> {
  const limit = options.limit ?? 10;
  const found = new Map<string, Note>();

  if (options.ids?.length) {
    const scope = scopedNotesCondition(options.projectRoot);
    const rows = await db
      .select()
      .from(notes)
      .where(scope ? and(inArray(notes.id, options.ids), scope) : inArray(notes.id, options.ids));
    for (const row of rows) found.set(row.id, rowToNote(row));
  }

  if (options.titles?.length) {
    const scope = scopedNotesCondition(options.projectRoot);
    const rows = await db
      .select()
      .from(notes)
      .where(
        scope
          ? and(inArray(notes.title, options.titles), scope)
          : inArray(notes.title, options.titles),
      );
    for (const row of rows) found.set(row.id, rowToNote(row));
  }

  if (options.query?.trim()) {
    const searched = await searchNotes(options.query, 50, options.projectRoot);
    for (const note of searched) {
      found.set(note.id, note);
    }
  }

  if (!options.query && !options.ids?.length && !options.titles?.length) {
    const all = await listNotes(undefined, options.projectRoot);
    for (const note of all.slice(0, limit)) {
      found.set(note.id, note);
    }
  }

  const candidates = [...found.values()].slice(0, limit);
  if (candidates.length === 0) return [];
  const candidateIds = candidates.map((n) => n.id);

  const [outLinks, inLinks, attRows] = await Promise.all([
    db.select().from(noteLinks).where(inArray(noteLinks.fromNoteId, candidateIds)),
    db.select().from(noteLinks).where(inArray(noteLinks.toNoteId, candidateIds)),
    db.select().from(noteAttachments).where(inArray(noteAttachments.noteId, candidateIds)),
  ]);

  const outlinksById = new Map<string, string[]>();
  for (const l of outLinks) {
    const arr = outlinksById.get(l.fromNoteId);
    if (arr) arr.push(l.toNoteId);
    else outlinksById.set(l.fromNoteId, [l.toNoteId]);
  }
  const backlinksById = new Map<string, string[]>();
  for (const l of inLinks) {
    const arr = backlinksById.get(l.toNoteId);
    if (arr) arr.push(l.fromNoteId);
    else backlinksById.set(l.toNoteId, [l.fromNoteId]);
  }
  const attachmentsById = new Map<string, typeof attRows>();
  for (const a of attRows) {
    const arr = attachmentsById.get(a.noteId);
    if (arr) arr.push(a);
    else attachmentsById.set(a.noteId, [a]);
  }

  const results: NoteWithLinks[] = [];
  for (const note of candidates) {
    results.push({
      ...note,
      outlinks: outlinksById.get(note.id) ?? [],
      backlinks: backlinksById.get(note.id) ?? [],
      attachments: (attachmentsById.get(note.id) ?? []).map((a) => ({
        id: a.id,
        noteId: a.noteId,
        filename: a.filename,
        mimeType: a.mimeType,
        size: a.size,
        createdAt:
          a.createdAt instanceof Date ? a.createdAt : new Date((a.createdAt as number) * 1000),
      })),
    });
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
  opts?: { index?: Map<string, string>; skipInvalidate?: boolean; projectRoot?: string },
): Promise<void> {
  await db.delete(noteLinks).where(eq(noteLinks.fromNoteId, noteId));

  const titles = extractWikilinks(content);
  if (titles.length > 0) {
    const index = opts?.index ?? (await getResolveIndex(opts?.projectRoot));
    const targetIds = new Set<string>();
    for (const title of titles) {
      let id = index.get(title.toLowerCase());
      if (!id) {
        // Fallback: resolve via DB for notes beyond the 5000-row index cap.
        id = (await resolveNoteRef(title, opts?.projectRoot)) ?? undefined;
      }
      if (id && id !== noteId) targetIds.add(id);
    }
    for (const toId of targetIds) {
      try {
        await db.insert(noteLinks).values({ fromNoteId: noteId, toNoteId: toId });
      } catch (err: unknown) {
        // Ignore duplicate primary key (already linked)
        serverLog.debug(
          {
            err: err instanceof Error ? err.message : String(err),
            fromNoteId: noteId,
            toNoteId: toId,
          },
          'wikilink edge already exists — skipping duplicate insert',
        );
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

  // Safety limit: loading unbounded notes into memory can crash the Bun VM
  // (the notes table previously had 134K test seed notes). Cap at 5000 —
  // more than enough for real usage, prevents OOM on pathological datasets.
  const GRAPH_MAX_NODES = 5000;
  const scope = scopedNotesCondition(projectRoot);
  const allRows = scope
    ? await db
        .select()
        .from(notes)
        .where(scope)
        .limit(GRAPH_MAX_NODES + 1)
    : await db
        .select()
        .from(notes)
        .limit(GRAPH_MAX_NODES + 1);
  if (allRows.length > GRAPH_MAX_NODES) {
    serverLog.warn(
      { maxNodes: GRAPH_MAX_NODES, totalRows: allRows.length },
      'Graph data truncated to maximum nodes (table has more rows)',
    );
  }
  const allNotes = allRows
    .slice(0, GRAPH_MAX_NODES)
    .filter((row) => isVisibleInProject(row, projectRoot));
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
      } catch (err: unknown) {
        serverLog.debug(
          { err: err instanceof Error ? err.message : String(err) },
          'note tags parse failed in getGraphData — returning empty array',
        );
        return [];
      }
    })(),
    linkCount: linkCountMap.get(n.id) ?? 0,
    includeInContext: Boolean(n.includeInContext),
  }));

  const edges: GraphEdge[] = allLinks.map((l) => ({ from: l.fromNoteId, to: l.toNoteId }));

  // Ghost nodes: [[wikilinks]] whose target title/alias doesn't exist yet.
  // Resolve against title + aliases so an alias link isn't falsely "unresolved".
  const resolveMap = await getResolveIndex(projectRoot);
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
  const scope = scopedNotesCondition(projectRoot);
  const query = db
    .select({ id: notes.id, folderPath: notes.folderPath, projectRoot: notes.projectRoot })
    .from(notes)
    .$dynamic();
  const allNotes = (await (scope ? query.where(scope) : query).limit(5000))
    .filter((row) => isVisibleInProject(row, projectRoot))
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
function ftsSearchIds(query: string, limit: number, projectRoot?: string): string[] {
  const match = ftsMatchExpr(query);
  if (!match) return [];
  const raw = getDb();
  const root = resolvedProjectRoot(projectRoot);
  const includeLegacy = root === resolve(PROJECT_ROOT);
  try {
    const rows = (
      root
        ? raw
            .query(
              `SELECT notes_fts.note_id
             FROM notes_fts
             JOIN notes ON notes.id = notes_fts.note_id
             WHERE notes_fts MATCH ?
               AND ${includeLegacy ? '(notes.project_root = ? OR notes.project_root IS NULL)' : 'notes.project_root = ?'}
             ORDER BY bm25(notes_fts)
             LIMIT ?`,
            )
            .all(match, root, limit)
        : raw
            .query(
              'SELECT note_id FROM notes_fts WHERE notes_fts MATCH ? ORDER BY bm25(notes_fts) LIMIT ?',
            )
            .all(match, limit)
    ) as Array<{ note_id: string }>;
    return rows.map((r) => r.note_id);
  } catch (err: unknown) {
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'FTS5 search unavailable — falling back to bounded LIKE scan',
    );
    const term = '%' + query + '%';
    const rows = (
      root
        ? raw
            .query(
              `SELECT id FROM notes
             WHERE (title LIKE ? OR content LIKE ?)
               AND ${includeLegacy ? '(project_root = ? OR project_root IS NULL)' : 'project_root = ?'}
             LIMIT ?`,
            )
            .all(term, term, root, limit)
        : raw
            .query('SELECT id FROM notes WHERE title LIKE ? OR content LIKE ? LIMIT ?')
            .all(term, term, limit)
    ) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }
}

export async function searchNotes(
  query: string,
  limit = 50,
  projectRoot?: string,
): Promise<Note[]> {
  if (!query.trim()) return listNotes({ limit }, projectRoot);
  const ids = ftsSearchIds(query, limit, projectRoot);
  if (ids.length === 0) return [];
  const scope = scopedNotesCondition(projectRoot);
  const rows = await db
    .select()
    .from(notes)
    .where(scope ? and(inArray(notes.id, ids), scope) : inArray(notes.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r]));
  // Preserve FTS rank order.
  return ids
    .map((id) => byId.get(id))
    .filter((r): r is (typeof rows)[number] => !!r && isVisibleInProject(r, projectRoot))
    .map(rowToNote);
}

// ============================================================================
// Link resolution index (title + frontmatter aliases → note id)
// ============================================================================

/** Lowercased title|alias → note id. Cached; invalidated on any note change. */
async function getResolveIndex(projectRoot?: string): Promise<Map<string, string>> {
  const cacheKey = resolvedProjectRoot(projectRoot) ?? '';
  const cached = resolveIndexCache.get(cacheKey);
  if (cached) return cached;
  // Limit to prevent OOM on pathological datasets (134K test seed notes
  // previously crashed the Bun VM here). 5000 is generous for real usage.
  const scope = scopedNotesCondition(projectRoot);
  const query = db
    .select({ id: notes.id, title: notes.title, content: notes.content })
    .from(notes)
    .$dynamic();
  const rows = await (scope ? query.where(scope) : query).limit(5000);
  const map = new Map<string, string>();
  for (const r of rows) {
    map.set(r.title.toLowerCase(), r.id);
    for (const alias of parseFrontmatter(r.content).aliases) {
      const key = alias.toLowerCase();
      if (!map.has(key)) map.set(key, r.id);
    }
  }
  resolveIndexCache.set(cacheKey, map);
  return map;
}

/** Resolve a wikilink reference (title or alias) to a note id. */
export async function resolveNoteRef(ref: string, projectRoot?: string): Promise<string | null> {
  const key = ref.trim().toLowerCase();
  // Fast path: check the cached index first.
  const cached = (await getResolveIndex(projectRoot)).get(key);
  if (cached) return cached;
  // Fallback: query the DB directly. This handles notes beyond the 5000-row
  // in-memory index cap. Search by title first, then by content (for aliases
  // embedded in frontmatter).
  const scope = scopedNotesCondition(projectRoot);
  const titleRows = await db
    .select({ id: notes.id, title: notes.title })
    .from(notes)
    .where(scope ? and(like(notes.title, ref.trim()), scope) : like(notes.title, ref.trim()));
  for (const r of titleRows) {
    if (r.title.toLowerCase() === key) return r.id;
  }
  // Search for aliases in note content using the FTS index (fast, indexed).
  // Then parse frontmatter to confirm the exact alias match.
  const candidateIds = ftsSearchIds(ref.trim(), 50, projectRoot);
  if (candidateIds.length > 0) {
    const candidateRows = await db
      .select({ id: notes.id, content: notes.content })
      .from(notes)
      .where(scope ? and(inArray(notes.id, candidateIds), scope) : inArray(notes.id, candidateIds));
    for (const r of candidateRows) {
      for (const alias of parseFrontmatter(r.content).aliases) {
        if (alias.toLowerCase() === key) return r.id;
      }
    }
  }
  return null;
}

// ============================================================================
// Attachments
// ============================================================================

export interface StoredNoteAttachment extends NoteAttachment {
  storagePath: string;
}

const ATTACHMENT_EXTENSIONS: Record<string, readonly string[]> = {
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/gif': ['.gif'],
  'image/webp': ['.webp'],
  'application/pdf': ['.pdf'],
  'text/plain': ['.txt', '.log'],
  'text/markdown': ['.md', '.markdown'],
  'application/json': ['.json'],
  'application/zip': ['.zip'],
};

function attachmentStorageIsAuthorized(
  attachment: { id: string; noteId: string; storagePath: string },
  projectRoot: string,
): boolean {
  const attachmentRoot = resolve(projectRoot, '.koryphaios', 'attachments');
  const storagePath = resolve(attachment.storagePath);
  const generatedPath = resolve(attachmentRoot, attachment.id);
  if (storagePath === generatedPath) return true;

  // Keep older attachments readable. Legacy builds stored them below a
  // note-specific directory as `<attachment-id>_<original-name>`; constrain
  // that shape to the same project root instead of trusting the DB path.
  const legacyRoot = resolve(attachmentRoot, attachment.noteId);
  return (
    storagePath.startsWith(legacyRoot + sep) &&
    basename(storagePath).startsWith(`${attachment.id}_`)
  );
}

function hasPrefix(data: Buffer, bytes: number[]): boolean {
  return bytes.every((byte, index) => data[index] === byte);
}

function validateAttachmentContent(mimeType: string, data: Buffer): void {
  let valid = true;
  if (mimeType === 'image/png') valid = hasPrefix(data, [0x89, 0x50, 0x4e, 0x47]);
  else if (mimeType === 'image/jpeg') valid = hasPrefix(data, [0xff, 0xd8, 0xff]);
  else if (mimeType === 'image/gif')
    valid =
      data.subarray(0, 6).toString('ascii') === 'GIF87a' ||
      data.subarray(0, 6).toString('ascii') === 'GIF89a';
  else if (mimeType === 'image/webp')
    valid =
      data.subarray(0, 4).toString('ascii') === 'RIFF' &&
      data.subarray(8, 12).toString('ascii') === 'WEBP';
  else if (mimeType === 'application/pdf')
    valid = data.subarray(0, 5).toString('ascii') === '%PDF-';
  else if (mimeType === 'application/zip') valid = hasPrefix(data, [0x50, 0x4b]);
  else if (mimeType === 'application/json') {
    try {
      JSON.parse(data.toString('utf8'));
    } catch {
      valid = false;
    }
  } else if (mimeType.startsWith('text/')) {
    valid = !data.includes(0);
  }
  if (!valid) throw new ValidationError('Attachment contents do not match the declared file type');
}

export async function saveAttachment(
  noteId: string,
  filename: string,
  mimeType: string,
  data: Buffer,
  projectRoot = PROJECT_ROOT,
): Promise<NoteAttachment> {
  return withNoteMutation(noteId, () =>
    saveAttachmentUnlocked(noteId, filename, mimeType, data, projectRoot),
  );
}

async function saveAttachmentUnlocked(
  noteId: string,
  filename: string,
  mimeType: string,
  data: Buffer,
  projectRoot: string,
): Promise<NoteAttachment> {
  const root = resolve(projectRoot);
  if (!(await getNote(noteId, root))) throw new NotFoundError('Note', noteId);
  if (!ALLOWED_ATTACHMENT_MIME_TYPES.has(mimeType)) {
    throw new ValidationError(`Attachment type is not allowed: ${mimeType || 'unknown'}`);
  }
  const safeFilename = basename(filename)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  if (
    !safeFilename ||
    safeFilename !== filename ||
    safeFilename.length > 255 ||
    /["\\]/.test(safeFilename)
  ) {
    throw new ValidationError('Attachment filename is invalid');
  }
  const extension = extname(safeFilename).toLowerCase();
  if (!ATTACHMENT_EXTENSIONS[mimeType]?.includes(extension)) {
    throw new ValidationError('Attachment extension does not match its declared file type');
  }
  const settings = loadNotesSettings(root);
  const maxBytes = settings.attachmentSizeLimitEnabled
    ? settings.maxAttachmentBytes
    : NOTES_HARD_MAX_ATTACHMENT_BYTES;
  if (data.length > maxBytes) {
    throw new PayloadTooLargeError(`${maxBytes} bytes`, { actualBytes: data.length, maxBytes });
  }
  validateAttachmentContent(mimeType, data);
  const existing = await db
    .select({ id: noteAttachments.id })
    .from(noteAttachments)
    .where(eq(noteAttachments.noteId, noteId))
    .limit(settings.maxAttachmentsPerNote + 1);
  if (existing.length >= settings.maxAttachmentsPerNote) {
    throw new ValidationError(
      `A note can have at most ${settings.maxAttachmentsPerNote} attachments`,
    );
  }

  const id = nanoid();
  const attachmentDir = join(root, '.koryphaios', 'attachments');
  const storagePath = join(attachmentDir, id);
  atomicWrite(storagePath, data);

  const now = new Date();
  try {
    await db.insert(noteAttachments).values({
      id,
      noteId,
      filename: safeFilename,
      mimeType,
      size: data.length,
      storagePath,
      createdAt: now,
    });
  } catch (error) {
    if (existsSync(storagePath)) unlinkSync(storagePath);
    throw error;
  }

  return {
    id,
    noteId,
    filename: safeFilename,
    mimeType,
    size: data.length,
    createdAt: now,
  };
}

export async function getAttachment(
  id: string,
  projectRoot?: string,
): Promise<StoredNoteAttachment | null> {
  const rows = await db.select().from(noteAttachments).where(eq(noteAttachments.id, id));

  if (!rows[0]) return null;

  const row = rows[0];
  if (!(await getNote(row.noteId, projectRoot))) return null;
  const root = resolve(projectRoot || PROJECT_ROOT);
  if (!attachmentStorageIsAuthorized(row, root)) {
    serverLog.warn(
      { attachmentId: row.id, noteId: row.noteId },
      'Refused to read an attachment outside the project attachment directory',
    );
    return null;
  }
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

export async function deleteAttachment(id: string, projectRoot?: string): Promise<void> {
  const candidate = await getAttachment(id, projectRoot);
  if (!candidate) throw new NotFoundError('Attachment', id);
  await withNoteMutation(candidate.noteId, async () => {
    const att = await getAttachment(id, projectRoot);
    if (!att) throw new NotFoundError('Attachment', id);

    try {
      unlinkSync(att.storagePath);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT') {
        // A missing file is already in the requested on-disk state, so the
        // stale metadata can be removed safely.
        serverLog.debug(
          { attachmentId: att.id, noteId: att.noteId },
          'Attachment file already gone during delete',
        );
      } else {
        // Keep the row addressable when storage cleanup fails. The caller can
        // fix the filesystem problem and retry the same attachment deletion;
        // deleting the metadata here would strand the storage entry forever.
        serverLog.warn(
          { attachmentId: att.id, noteId: att.noteId, errorCode: code ?? 'UNKNOWN' },
          'Attachment file delete failed; metadata retained for retry',
        );
        throw err;
      }
    }

    await db.delete(noteAttachments).where(eq(noteAttachments.id, id));
  });
}

// ============================================================================
// Memory Import
// ============================================================================

const MEMORY_IMPORT_TAG_PREFIX = 'koryphaios-memory-import:';

function memoryImportTag(importKey: string): string {
  return (
    MEMORY_IMPORT_TAG_PREFIX +
    createHash('sha256').update(importKey, 'utf8').digest('base64url').slice(0, 32)
  );
}

/**
 * Import universal memory plus every Markdown document in the active project's
 * memory folder. Imported notes carry an internal source tag, so re-importing
 * updates only the note created for that source — never an unrelated note with
 * a coincidentally matching title.
 */
export interface MemoryImportEntry {
  source: { kind: 'universal' | 'project'; name: string };
  status: 'created' | 'updated' | 'unchanged' | 'failed';
  note?: Note;
  error?: string;
}

export interface MemoryImportReport {
  entries: MemoryImportEntry[];
  counts: Record<MemoryImportEntry['status'], number>;
  partial: boolean;
}

export interface MemoryImportOptions {
  /** Test seam for keeping fixture imports independent from the operator's
   * real universal-memory file. Production callers omit this override. */
  readUniversalContent?: () => string;
}

export async function importMemoryAsNotesWithReport(
  projectRoot: string,
  options: MemoryImportOptions = {},
): Promise<MemoryImportReport> {
  const { listProjectMemoryDocuments, readUniversalMemory } =
    await import('../memory/unified-memory');
  const entries: MemoryImportEntry[] = [];
  const candidates: Array<{
    title: string;
    readContent: () => string;
    folderPath: string;
    importKey: string;
    source: MemoryImportEntry['source'];
  }> = [
    {
      title: 'Universal Memory',
      readContent: options.readUniversalContent ?? (() => readUniversalMemory().content),
      folderPath: '/Memory/Universal',
      importKey: 'universal',
      source: { kind: 'universal' as const, name: 'universal-memory.md' },
    },
  ];
  try {
    candidates.push(
      ...listProjectMemoryDocuments(projectRoot)
        .filter((document) => document.kind === 'memory')
        .map((document) => ({
          title:
            document.name === 'project.md'
              ? 'Project Memory'
              : `Memory: ${basename(document.name, '.md')}`,
          readContent: () => readFileSync(document.path, 'utf8'),
          folderPath: '/Memory/Project',
          importKey: `project:${resolve(document.path)}`,
          source: { kind: 'project' as const, name: document.name },
        })),
    );
  } catch (err: unknown) {
    entries.push({
      source: { kind: 'project', name: 'project-memory-directory' },
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    });
  }

  for (const { title, readContent, folderPath, importKey, source } of candidates) {
    try {
      const content = readContent();
      if (!content.trim()) continue;
      const importTag = memoryImportTag(importKey);
      // Older Koryphaios versions persisted the full absolute source path in an
      // internal tag. Keep those imports readable/idempotent, but never create a
      // new path-bearing tag or expose a local path in newly imported notes.
      const legacyImportTag = MEMORY_IMPORT_TAG_PREFIX + importKey;
      // The Notes database can be very large. Narrow by the stable title/folder
      // pair first instead of wildcard-scanning every tags payload, then confirm
      // the exact source identity from the internal import tag.
      const scope = scopedNotesCondition(projectRoot);
      const matchingRows = await db
        .select()
        .from(notes)
        .where(
          scope
            ? and(eq(notes.title, title), eq(notes.folderPath, folderPath), scope)
            : and(eq(notes.title, title), eq(notes.folderPath, folderPath)),
        )
        .limit(100);
      const existingRow = matchingRows.find((row) => {
        const tags = parseStoredTags(row.tags);
        return tags.includes(importTag) || tags.includes(legacyImportTag);
      });

      if (existingRow) {
        const storedTags = parseStoredTags(existingRow.tags);
        if (storedTags.includes(legacyImportTag) && !storedTags.includes(importTag)) {
          const migratedTags = storedTags.filter((tag) => tag !== legacyImportTag);
          migratedTags.push(importTag);
          await db
            .update(notes)
            .set({ tags: JSON.stringify(migratedTags) })
            .where(and(eq(notes.id, existingRow.id), eq(notes.revision, existingRow.revision)));
          existingRow.tags = JSON.stringify(migratedTags);
        }
        const existing = rowToNote(existingRow);
        // Avoid touching timestamps, graph caches, or the database when nothing
        // changed. This also makes repeated button presses genuinely idempotent.
        if (
          existing.content === content &&
          existing.title === title &&
          existing.folderPath === folderPath
        ) {
          entries.push({ source, status: 'unchanged', note: existing });
        } else {
          entries.push({
            source,
            status: 'updated',
            note: await updateNote(existing.id, { title, content, folderPath }, projectRoot),
          });
        }
      } else {
        const note = await createNote(
          {
            title,
            content,
            folderPath,
            includeInContext: true,
            tags: ['memory-import', importTag],
          },
          projectRoot,
        );
        entries.push({ source, status: 'created', note });
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      serverLog.error({ err: error, source: source.name }, 'Memory source import failed');
      entries.push({ source, status: 'failed', error });
    }
  }

  const counts = {
    created: entries.filter((entry) => entry.status === 'created').length,
    updated: entries.filter((entry) => entry.status === 'updated').length,
    unchanged: entries.filter((entry) => entry.status === 'unchanged').length,
    failed: entries.filter((entry) => entry.status === 'failed').length,
  };
  return { entries, counts, partial: counts.failed > 0 };
}

/** Compatibility helper for callers that only need the resulting notes. */
export async function importMemoryAsNotes(
  projectRoot: string,
  options: MemoryImportOptions = {},
): Promise<Note[]> {
  const report = await importMemoryAsNotesWithReport(projectRoot, options);
  return report.entries.flatMap((entry) => (entry.note ? [entry.note] : []));
}

// ============================================================================
// Composite Queries
// ============================================================================

export async function getNoteWithLinks(
  id: string,
  projectRoot?: string,
): Promise<NoteWithLinks | null> {
  const note = await getNote(id, projectRoot);
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
      createdAt:
        a.createdAt instanceof Date ? a.createdAt : new Date((a.createdAt as number) * 1000),
    })),
  };
}
