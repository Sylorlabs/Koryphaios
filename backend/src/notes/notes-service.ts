/**
 * Notes Service
 *
 * Core service for the Obsidian-style note knowledge network.
 * Provides CRUD, wikilink graph management, full-text search,
 * folder tree, attachment storage, and context assembly.
 */

import { nanoid } from 'nanoid';
import { db, getDb } from '../db';
import {
  notes,
  noteLinks,
  noteAttachments,
  noteRevisions,
  noteBases,
  noteBaseRevisions,
  noteDrafts,
} from '../db/schema';
import {
  eq,
  like,
  and,
  or,
  inArray,
  isNull,
  isNotNull,
  sql,
  desc,
  asc,
  gt,
  count,
} from 'drizzle-orm';
import type {
  Note,
  TrashedNote,
  NoteRevision,
  NoteRevisionSummary,
  NoteRevisionOperation,
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
  lstatSync,
  fstatSync,
  constants as fsConstants,
  renameSync,
  openSync,
  closeSync,
  readSync,
  writeSync,
  mkdtempSync,
  rmSync,
} from 'fs';
import type { Stats } from 'fs';
import { readdir, readFile, stat } from 'fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'path';
import { tmpdir } from 'node:os';
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
import { getLocalNotesPrincipalId } from './notes-principal';

// ============================================================================
// Paths & Helpers
// ============================================================================

const PROJECT_DOCUMENT_PREFIX = 'project-document:';
const DOCUMENT_EXTENSIONS = new Set(['.md', '.markdown', '.html', '.htm']);
export const PROJECT_DOCUMENT_SCAN_LIMIT = 5_000;
const IGNORED_DOCUMENT_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'target',
  '.svelte-kit',
  '.next',
  'coverage',
  '.cache',
  '.turbo',
  '.vite',
  '.yarn',
  '.pnpm-store',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.gradle',
  'vendor',
  'out',
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

function projectNotesCondition(projectRoot?: string) {
  const root = resolvedProjectRoot(projectRoot);
  if (!root) return undefined;
  return root === resolve(PROJECT_ROOT)
    ? or(eq(notes.projectRoot, root), isNull(notes.projectRoot))
    : eq(notes.projectRoot, root);
}

/** Every ordinary Notes query excludes the recoverable trash by default. */
function scopedNotesCondition(projectRoot?: string) {
  const project = projectNotesCondition(projectRoot);
  return project ? and(project, isNull(notes.trashedAt)) : isNull(notes.trashedAt);
}

function scopedTrashCondition(projectRoot?: string) {
  const project = projectNotesCondition(projectRoot);
  return project ? and(project, isNotNull(notes.trashedAt)) : isNotNull(notes.trashedAt);
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
// Normalized title|alias|qualified-path → note id. `null` is an intentional
// ambiguity marker: duplicate titles/aliases must never resolve according to
// insertion or filesystem order. Rebuilt on demand and keyed by project so
// same-titled notes never cross workspace boundaries.
type NoteResolveIndex = Map<string, string | null>;
const resolveIndexCache = new Map<string, NoteResolveIndex>();

/** Drop derived caches. Called by every mutation path. */
export function invalidateNotesCache(): void {
  graphCache.clear();
  resolveIndexCache.clear();
}

// Project-document sync is heavy (recursive FS walk). Throttle it per project so
// it runs at most once per window on the request path; refreshes happen in the
// background so reads never block on a full re-scan after the first one.
// A multi-thousand-document workspace can legitimately take several seconds to
// traverse even when no files changed. A five-second freshness window made
// ordinary panel refreshes start another walk as soon as the previous one had
// settled, which looked like permanent indexing and wasted an entire core.
// Explicit Retry/Refresh actions still bypass this window.
const SYNC_THROTTLE_MS = 60_000;
// Keep the HTTP request comfortably below Bun's 10-second request timeout.
// Small vaults still load atomically; large first imports continue through the
// single-flight sync and surface `running` status for client-side polling.
const INITIAL_SYNC_REQUEST_BUDGET_MS = 750;
const lastSyncAt = new Map<string, number>();
const fileMtimeCache = new Map<string, number>(); // absolute path -> mtimeMs
// Same-process source moves can be proven without a schema migration by the
// filesystem object identity retained across a rename. Never infer identity
// from content alone: identical templates are common and metadata must not
// jump between unrelated files.
const fileIdentityCache = new Map<string, string>(); // absolute path -> dev:ino

function fileObjectIdentity(fileStat: Stats): string | null {
  const dev = Number(fileStat.dev);
  const ino = Number(fileStat.ino);
  return Number.isSafeInteger(dev) && Number.isSafeInteger(ino) && ino > 0 ? `${dev}:${ino}` : null;
}
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
      // joins that same promise. Give small vaults a short atomic-load budget;
      // large vaults keep indexing in the background instead of timing out the
      // API and leaving Notes stuck behind a loading state.
      await Promise.race([
        syncProjectDocuments(projectRoot),
        new Promise<void>((resolveBudget) =>
          setTimeout(resolveBudget, INITIAL_SYNC_REQUEST_BUDGET_MS),
        ),
      ]);
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

function normalizeNoteReference(value: string): string | null {
  const trimmed = value.trim().replace(/\\/g, '/');
  if (!trimmed) return null;
  const parts: string[] = [];
  for (const part of trimmed.split('/')) {
    if (!part || part === '.') continue;
    // Wikilinks are note references, not filesystem traversal. Reject an
    // unsafe qualified reference instead of normalizing it into another note.
    if (part === '..') return null;
    parts.push(part);
  }
  return parts.join('/').toLowerCase();
}

function referenceLookupKeys(value: string): string[] {
  const normalized = normalizeNoteReference(value);
  if (!normalized) return [];
  const keys = new Set([normalized]);
  const withoutExtension = normalized.replace(/\.(?:md|markdown|html|htm)$/i, '');
  keys.add(withoutExtension);
  return [...keys];
}

function noteReferenceKeys(row: {
  id: string;
  title: string;
  content: string;
  folderPath: string;
}): string[] {
  const keys = new Set<string>();
  const add = (value: string) => {
    for (const key of referenceLookupKeys(value)) keys.add(key);
  };

  add(row.title);
  for (const alias of parseFrontmatter(row.content).aliases) add(alias);

  const folder = row.folderPath.replace(/^\/+|\/+$/g, '');
  if (folder) add(`${folder}/${row.title}`);

  const sourcePath = projectDocumentIdentity(row.id)?.sourcePath;
  if (sourcePath) {
    add(sourcePath);
    add(`Project/${sourcePath}`);
  }
  return [...keys];
}

function addResolvableReference(index: NoteResolveIndex, key: string, noteId: string): void {
  if (!index.has(key)) {
    index.set(key, noteId);
    return;
  }
  if (index.get(key) !== noteId) index.set(key, null);
}

function resolveNoteRefFromIndex(ref: string, index: NoteResolveIndex): string | null {
  const keys = referenceLookupKeys(ref);
  if (keys.length === 0) return null;
  const matches = new Set<string>();
  for (const key of keys) {
    const match = index.get(key);
    if (match === null) return null;
    if (match) matches.add(match);
  }
  return matches.size === 1 ? [...matches][0] : null;
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

function rowToTrashedNote(row: typeof notes.$inferSelect): TrashedNote {
  const note = rowToNote(row);
  const rawTrashedAt = row.trashedAt;
  if (!rawTrashedAt) throw new Error(`Trashed note ${row.id} has no trash timestamp`);
  return {
    ...note,
    trashedAt:
      rawTrashedAt instanceof Date ? rawTrashedAt : new Date(rawTrashedAt as unknown as number),
    trashReason: row.trashReason === 'source_removed' ? 'source_removed' : 'user',
  };
}

function revisionSnapshotSql(
  noteId: string,
  operation: NoteRevisionOperation,
  snapshotAt = Date.now(),
) {
  const identity = projectDocumentIdentity(noteId);
  return sql`
    INSERT OR IGNORE INTO note_revisions (
      note_id, revision, project_root, operation, title, content, content_bytes,
      folder_path, tags, pinned, include_in_context, format, source_path,
      trashed_at, trash_reason, note_created_at, note_updated_at, created_at
    )
    SELECT
      id, revision, COALESCE(project_root, ${identity?.projectRoot ?? ''}), ${operation},
      title, content, length(CAST(content AS BLOB)), folder_path, tags, pinned,
      include_in_context, format, ${identity?.sourcePath ?? null}, trashed_at,
      trash_reason, created_at, updated_at, ${snapshotAt}
    FROM notes WHERE id = ${noteId}
  `;
}

function revisionBatchSnapshotSql(
  noteIds: string[],
  operation: NoteRevisionOperation,
  snapshotAt = Date.now(),
) {
  if (noteIds.length === 0) return sql`SELECT 1`;
  return sql`
    INSERT OR IGNORE INTO note_revisions (
      note_id, revision, project_root, operation, title, content, content_bytes,
      folder_path, tags, pinned, include_in_context, format, source_path,
      trashed_at, trash_reason, note_created_at, note_updated_at, created_at
    )
    SELECT
      id, revision, COALESCE(project_root, ''), ${operation}, title, content,
      length(CAST(content AS BLOB)), folder_path, tags, pinned,
      include_in_context, format, NULL, trashed_at, trash_reason,
      created_at, updated_at, ${snapshotAt}
    FROM notes WHERE ${inArray(notes.id, noteIds)}
  `;
}

function revisionRowToSummary(row: typeof noteRevisions.$inferSelect): NoteRevisionSummary {
  const derivedSourcePath = projectDocumentIdentity(row.noteId)?.sourcePath;
  return {
    noteId: row.noteId,
    revision: row.revision,
    operation: row.operation as NoteRevisionOperation,
    title: row.title,
    folderPath: row.folderPath,
    tags: publicNoteTags(row.tags),
    pinned: Boolean(row.pinned),
    includeInContext: Boolean(row.includeInContext),
    format: row.format === 'html' ? 'html' : 'markdown',
    sourcePath: row.sourcePath ?? derivedSourcePath,
    trashedAt: row.trashedAt
      ? row.trashedAt instanceof Date
        ? row.trashedAt
        : new Date(row.trashedAt as unknown as number)
      : undefined,
    trashReason:
      row.trashReason === 'source_removed'
        ? 'source_removed'
        : row.trashReason === 'user'
          ? 'user'
          : undefined,
    contentBytes: row.contentBytes,
    noteCreatedAt:
      row.noteCreatedAt instanceof Date
        ? row.noteCreatedAt
        : new Date((row.noteCreatedAt as number) * 1000),
    noteUpdatedAt:
      row.noteUpdatedAt instanceof Date
        ? row.noteUpdatedAt
        : new Date((row.noteUpdatedAt as number) * 1000),
    createdAt:
      row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt as unknown as number),
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

  db.transaction((tx) => {
    tx.insert(notes)
      .values({
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
        trashedAt: null,
        trashReason: null,
        userId: input.userId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    tx.run(revisionSnapshotSql(id, 'create', now.getTime()));
  });

  // New title/alias → the resolution index is stale.
  invalidateNotesCache();
  if (content) {
    await parseAndSaveLinks(id, content, { projectRoot: root });
  }

  return (await getNote(id, root))!;
}

export async function getNote(id: string, projectRoot?: string): Promise<Note | null> {
  const rows = await db
    .select()
    .from(notes)
    .where(and(eq(notes.id, id), isNull(notes.trashedAt)));
  return rows[0] && isVisibleInProject(rows[0], projectRoot) ? rowToNote(rows[0]) : null;
}

export async function getNoteByTitle(title: string, projectRoot?: string): Promise<Note | null> {
  const scope = scopedNotesCondition(projectRoot);
  const normalized = title.trim().toLowerCase();
  if (!normalized) return null;
  const rows = await db
    .select()
    .from(notes)
    .where(
      scope
        ? and(sql`lower(${notes.title}) = ${normalized}`, scope)
        : sql`lower(${notes.title}) = ${normalized}`,
    )
    // Two rows are enough to prove ambiguity. Never choose based on row order.
    .limit(2);
  return rows.length === 1 ? rowToNote(rows[0]) : null;
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
        const refreshedRows = db.transaction((tx) => {
          const changed = tx
            .update(notes)
            .set({
              content: diskContent,
              projectRoot: root,
              revision: diskRevision,
              updatedAt: diskStat.mtime,
            })
            .where(
              and(eq(notes.id, id), eq(notes.revision, existing.revision), isNull(notes.trashedAt)),
            )
            .returning({ id: notes.id })
            .all();
          if (changed.length === 1) {
            tx.run(revisionSnapshotSql(id, 'external_sync'));
          }
          return changed;
        });
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

    const updatedRows = db.transaction((tx) => {
      const changed = tx
        .update(notes)
        .set(updateData)
        .where(
          and(eq(notes.id, id), eq(notes.revision, existing.revision), isNull(notes.trashedAt)),
        )
        .returning({ id: notes.id })
        .all();
      if (changed.length === 1) tx.run(revisionSnapshotSql(id, 'update'));
      return changed;
    });
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

async function getStoredNoteRow(
  id: string,
  projectRoot?: string,
): Promise<typeof notes.$inferSelect | null> {
  const rows = await db.select().from(notes).where(eq(notes.id, id));
  return rows[0] && isVisibleInProject(rows[0], projectRoot) ? rows[0] : null;
}

/** Move a note to recoverable trash. Source documents and attachment files are
 * deliberately retained; this is the default DELETE contract. */
export async function trashNote(
  id: string,
  projectRoot?: string,
  expectedRevision?: number,
  reason: 'user' | 'source_removed' = 'user',
): Promise<TrashedNote> {
  return withNoteMutation(id, async () => {
    const row = await getStoredNoteRow(id, projectRoot);
    if (!row || row.trashedAt) throw new NotFoundError('Note', id);
    const existing = rowToNote(row);
    if (expectedRevision !== undefined && expectedRevision !== existing.revision) {
      throw new ConflictError(
        'This note changed after it was opened. Review the newer version before deleting it.',
        {
          expectedRevision,
          currentRevision: existing.revision,
        },
      );
    }
    const trashedAt = new Date();
    const changedRows = db.transaction((tx) => {
      const changed = tx
        .update(notes)
        .set({
          trashedAt,
          trashReason: reason,
          revision: existing.revision + 1,
          updatedAt: trashedAt,
        })
        .where(
          and(eq(notes.id, id), eq(notes.revision, existing.revision), isNull(notes.trashedAt)),
        )
        .returning({ id: notes.id })
        .all();
      if (changed.length === 1) {
        tx.run(revisionSnapshotSql(id, reason === 'source_removed' ? reason : 'trash'));
      }
      return changed;
    });
    if (changedRows.length !== 1) {
      throw new ConflictError(
        'This note changed while it was being deleted. Reload and review the newer version.',
      );
    }
    invalidateNotesCache();
    return rowToTrashedNote((await getStoredNoteRow(id, projectRoot))!);
  });
}

/** Compatibility name retained for agent tools and callers. Deletion is now a
 * reversible trash operation; no ordinary call permanently removes data. */
export async function deleteNote(
  id: string,
  projectRoot?: string,
  expectedRevision?: number,
): Promise<TrashedNote> {
  return trashNote(id, projectRoot, expectedRevision, 'user');
}

export async function listTrashedNotes(projectRoot?: string): Promise<TrashedNote[]> {
  if (projectRoot) await ensureProjectSync(projectRoot);
  const rows = await db
    .select()
    .from(notes)
    .where(scopedTrashCondition(projectRoot))
    .orderBy(desc(notes.trashedAt), desc(notes.updatedAt));
  return rows.filter((row) => isVisibleInProject(row, projectRoot)).map(rowToTrashedNote);
}

export async function restoreNote(
  id: string,
  projectRoot?: string,
  expectedRevision?: number,
): Promise<Note> {
  return withNoteMutation(id, async () => {
    const row = await getStoredNoteRow(id, projectRoot);
    if (!row || !row.trashedAt) throw new NotFoundError('Trashed note', id);
    const current = rowToNote(row);
    if (expectedRevision !== undefined && expectedRevision !== current.revision) {
      throw new ConflictError('This trashed note changed before it could be restored.', {
        expectedRevision,
        currentRevision: current.revision,
      });
    }
    const root = rowProjectRoot(row);
    let content = current.content;
    const sourceFile = resolveProjectDocument(id);
    if (sourceFile) {
      if (existsSync(sourceFile)) {
        content = readFileSync(sourceFile, 'utf8');
        assertContentBudget(content, root);
      } else {
        // Restore is explicit authority to recreate a source that disappeared
        // while its catalog entry was in trash.
        atomicWrite(sourceFile, content);
      }
    }
    const restoredAt = new Date();
    const changedRows = db.transaction((tx) => {
      const changed = tx
        .update(notes)
        .set({
          content,
          trashedAt: null,
          trashReason: null,
          revision: current.revision + 1,
          projectRoot: root,
          updatedAt: restoredAt,
        })
        .where(
          and(eq(notes.id, id), eq(notes.revision, current.revision), isNotNull(notes.trashedAt)),
        )
        .returning({ id: notes.id })
        .all();
      if (changed.length === 1) tx.run(revisionSnapshotSql(id, 'restore'));
      return changed;
    });
    if (changedRows.length !== 1) {
      throw new ConflictError('This trashed note changed while it was being restored.');
    }
    invalidateNotesCache();
    await parseAndSaveLinks(id, content, { projectRoot: root });
    return (await getNote(id, root))!;
  });
}

async function assertStoredNoteInProject(id: string, projectRoot?: string): Promise<void> {
  if (!(await getStoredNoteRow(id, projectRoot))) throw new NotFoundError('Note', id);
}

export async function listNoteRevisions(
  id: string,
  projectRoot?: string,
): Promise<NoteRevisionSummary[]> {
  await assertStoredNoteInProject(id, projectRoot);
  const rows = await db
    .select()
    .from(noteRevisions)
    .where(eq(noteRevisions.noteId, id))
    .orderBy(desc(noteRevisions.revision));
  return rows.map(revisionRowToSummary);
}

export async function getNoteRevision(
  id: string,
  revision: number,
  projectRoot?: string,
): Promise<NoteRevision | null> {
  await assertStoredNoteInProject(id, projectRoot);
  const rows = await db
    .select()
    .from(noteRevisions)
    .where(and(eq(noteRevisions.noteId, id), eq(noteRevisions.revision, revision)));
  return rows[0] ? { ...revisionRowToSummary(rows[0]), content: rows[0].content } : null;
}

export async function restoreNoteRevision(
  id: string,
  revision: number,
  expectedRevision: number,
  projectRoot?: string,
): Promise<Note> {
  return withNoteMutation(id, async () => {
    const row = await getStoredNoteRow(id, projectRoot);
    if (!row) throw new NotFoundError('Note', id);
    if (row.revision !== expectedRevision) {
      throw new ConflictError(
        'This note changed before its historical revision could be restored.',
        {
          expectedRevision,
          currentRevision: row.revision,
        },
      );
    }
    const targetRows = await db
      .select()
      .from(noteRevisions)
      .where(and(eq(noteRevisions.noteId, id), eq(noteRevisions.revision, revision)));
    const target = targetRows[0];
    if (!target) throw new NotFoundError('Note revision', `${id}@${revision}`);
    const root = rowProjectRoot(row);
    assertContentBudget(target.content, root);
    const sourceFile = resolveProjectDocument(id);
    if (sourceFile) atomicWrite(sourceFile, target.content);
    const restoredAt = new Date();
    const changedRows = db.transaction((tx) => {
      const changed = tx
        .update(notes)
        .set({
          title: target.title,
          content: target.content,
          folderPath: target.folderPath,
          tags: target.tags,
          pinned: target.pinned,
          includeInContext: target.includeInContext,
          format: target.format,
          projectRoot: root,
          revision: row.revision + 1,
          trashedAt: null,
          trashReason: null,
          updatedAt: restoredAt,
        })
        .where(and(eq(notes.id, id), eq(notes.revision, row.revision)))
        .returning({ id: notes.id })
        .all();
      if (changed.length === 1) tx.run(revisionSnapshotSql(id, 'revision_restore'));
      return changed;
    });
    if (changedRows.length !== 1) {
      throw new ConflictError('This note changed while its historical revision was restored.');
    }
    invalidateNotesCache();
    await parseAndSaveLinks(id, target.content, { projectRoot: root });
    if (target.title !== row.title) {
      await propagateTitleRename(id, row.title, target.title, root);
    }
    return (await getNote(id, root))!;
  });
}

// ============================================================================
// Deterministic whole-vault export
// ============================================================================

export interface VaultExportArtifact {
  filename: string;
  contentType: 'application/x-tar';
  contentLength: number;
  body: ReadableStream<Uint8Array>;
}

function archiveObjectKey(id: string): string {
  return createHash('sha256').update(id, 'utf8').digest('hex');
}

function stableStringCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function dateIso(value: Date | number | null | undefined, milliseconds = false): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(milliseconds ? value : value * 1000).toISOString();
}

function parseVaultJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new ConflictError(
      `${label} contains invalid JSON; vault export stopped without omission.`,
    );
  }
}

function parseVaultStringArray(value: string, label: string): string[] {
  const parsed = parseVaultJson(value, label);
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === 'string')) {
    throw new ConflictError(
      `${label} is not a string array; vault export stopped without omission.`,
    );
  }
  return parsed;
}

function draftPayloadHash(row: {
  title: string;
  content: string;
  folderPath: string;
  tags: string[];
  pinned: number;
  includeInContext: number;
  format: string;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        row.title,
        row.content,
        row.folderPath,
        row.tags,
        Boolean(row.pinned),
        Boolean(row.includeInContext),
        row.format,
      ]),
      'utf8',
    )
    .digest('hex');
}

function writeTarText(header: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > length) throw new ValidationError(`Archive path is too long: ${value}`);
  bytes.copy(header, offset);
}

function writeTarOctal(header: Buffer, offset: number, length: number, value: number): void {
  const encoded = Math.max(0, Math.trunc(value))
    .toString(8)
    .padStart(length - 1, '0');
  writeTarText(header, offset, length, encoded.slice(-(length - 1)) + '\0');
}

class DeterministicTarWriter {
  private readonly fd: number;
  private closed = false;

  constructor(private readonly archivePath: string) {
    this.fd = openSync(archivePath, 'w', 0o600);
  }

  private writeHeader(path: string, size: number): void {
    if (!Number.isSafeInteger(size) || size < 0) throw new ValidationError('Invalid archive size');
    const header = Buffer.alloc(512);
    writeTarText(header, 0, 100, path);
    writeTarOctal(header, 100, 8, 0o600);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, size);
    writeTarOctal(header, 136, 12, 0); // stable mtime makes identical snapshots byte-identical
    header.fill(0x20, 148, 156);
    header[156] = '0'.charCodeAt(0);
    writeTarText(header, 257, 6, 'ustar\0');
    writeTarText(header, 263, 2, '00');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    const encodedChecksum = checksum.toString(8).padStart(6, '0').slice(-6);
    writeTarText(header, 148, 8, `${encodedChecksum}\0 `);
    writeSync(this.fd, header);
  }

  private writePadding(size: number): void {
    const padding = (512 - (size % 512)) % 512;
    if (padding) writeSync(this.fd, Buffer.alloc(padding));
  }

  addBuffer(path: string, data: Buffer): string {
    this.writeHeader(path, data.length);
    if (data.length) writeSync(this.fd, data);
    this.writePadding(data.length);
    return createHash('sha256').update(data).digest('hex');
  }

  addFile(path: string, sourcePath: string, expectedSize: number): string {
    const sourceFd = openSync(sourcePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const digest = createHash('sha256');
    let copied = 0;
    const before = fstatSync(sourceFd);
    if (!before.isFile() || before.size !== expectedSize) {
      closeSync(sourceFd);
      throw new ConflictError('An attachment changed before it could be exported.', {
        sourcePath,
        expectedSize,
        actualSize: before.size,
      });
    }
    try {
      this.writeHeader(path, expectedSize);
      const chunk = Buffer.allocUnsafe(256 * 1024);
      while (copied < expectedSize) {
        const bytesRead = readSync(
          sourceFd,
          chunk,
          0,
          Math.min(chunk.length, expectedSize - copied),
          copied,
        );
        if (bytesRead === 0) break;
        const part = chunk.subarray(0, bytesRead);
        writeSync(this.fd, part);
        digest.update(part);
        copied += bytesRead;
      }
      const growthProbe = Buffer.allocUnsafe(1);
      if (copied === expectedSize && readSync(sourceFd, growthProbe, 0, 1, copied) > 0) {
        throw new ConflictError('An attachment grew while the vault export was being built.', {
          sourcePath,
          expectedSize,
        });
      }
      const after = fstatSync(sourceFd);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
        throw new ConflictError('An attachment changed while the vault export was being built.', {
          sourcePath,
          expectedSize,
        });
      }
    } finally {
      closeSync(sourceFd);
    }
    if (copied !== expectedSize) {
      throw new ConflictError('An attachment changed while the vault export was being built.', {
        sourcePath,
        expectedSize,
        actualSize: copied,
      });
    }
    this.writePadding(expectedSize);
    return digest.digest('hex');
  }

  finish(): void {
    if (this.closed) return;
    writeSync(this.fd, Buffer.alloc(1024));
    closeSync(this.fd);
    this.closed = true;
  }

  abort(): void {
    if (this.closed) return;
    closeSync(this.fd);
    this.closed = true;
  }
}

function cleanupExport(path: string, directory: string): void {
  try {
    rmSync(path, { force: true });
    rmSync(directory, { recursive: true, force: true });
  } catch (err: unknown) {
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'Failed to clean a completed Notes export staging directory',
    );
  }
}

function streamStagedArchive(
  archivePath: string,
  stagingDirectory: string,
  size: number,
): ReadableStream<Uint8Array> {
  const fd = openSync(archivePath, 'r');
  let offset = 0;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    closeSync(fd);
    cleanupExport(archivePath, stagingDirectory);
  };
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= size) {
        finish();
        controller.close();
        return;
      }
      const chunk = Buffer.allocUnsafe(Math.min(256 * 1024, size - offset));
      const bytesRead = readSync(fd, chunk, 0, chunk.length, offset);
      if (bytesRead <= 0) {
        finish();
        controller.error(new Error('Vault export staging file ended unexpectedly'));
        return;
      }
      offset += bytesRead;
      controller.enqueue(chunk.subarray(0, bytesRead));
    },
    cancel() {
      finish();
    },
  });
}

/** Build a portable manifest + content/revision/attachment files. Queries are
 * captured in one SQLite read transaction and the tar is staged on disk, so
 * archive size is bounded by disk rather than process memory. */
export async function createVaultExport(projectRoot = PROJECT_ROOT): Promise<VaultExportArtifact> {
  const root = resolve(projectRoot);
  const syncResult = await syncProjectDocuments(root);
  if (syncResult.truncated || syncResult.unreadablePaths > 0 || syncResult.oversizedFiles > 0) {
    throw new ConflictError(
      'The project index is incomplete, so a lossless vault export cannot be produced yet.',
      {
        scanLimitReached: syncResult.scanLimitReached,
        unreadablePaths: syncResult.unreadablePaths,
        oversizedFiles: syncResult.oversizedFiles,
        message: syncResult.message,
      },
    );
  }
  const projectScope = projectNotesCondition(root)!;
  const principalId = getLocalNotesPrincipalId(getDb());
  const snapshot = db.transaction((tx) => {
    const noteRows = tx.select().from(notes).where(projectScope).all();
    const noteIds = noteRows.map((row) => row.id);
    const baseRows = tx
      .select()
      .from(noteBases)
      .where(and(eq(noteBases.principalId, principalId), eq(noteBases.projectRoot, root)))
      .all();
    const draftRows = tx
      .select()
      .from(noteDrafts)
      .where(and(eq(noteDrafts.principalId, principalId), eq(noteDrafts.projectRoot, root)))
      .all();
    const revisionRows: Array<typeof noteRevisions.$inferSelect> = noteIds.length
      ? tx.select().from(noteRevisions).where(inArray(noteRevisions.noteId, noteIds)).all()
      : [];
    const attachmentRows: Array<typeof noteAttachments.$inferSelect> = noteIds.length
      ? tx.select().from(noteAttachments).where(inArray(noteAttachments.noteId, noteIds)).all()
      : [];
    const allLinkRows: Array<typeof noteLinks.$inferSelect> = noteIds.length
      ? tx
          .select()
          .from(noteLinks)
          .where(or(inArray(noteLinks.fromNoteId, noteIds), inArray(noteLinks.toNoteId, noteIds)))
          .all()
      : [];
    const baseIds = baseRows.map((row) => row.id);
    const baseRevisionRows: Array<typeof noteBaseRevisions.$inferSelect> = baseIds.length
      ? tx
          .select()
          .from(noteBaseRevisions)
          .where(
            and(
              eq(noteBaseRevisions.projectRoot, root),
              inArray(noteBaseRevisions.baseId, baseIds),
            ),
          )
          .all()
      : [];
    const ids = new Set(noteIds);
    return {
      noteRows,
      revisionRows,
      attachmentRows,
      linkRows: allLinkRows.filter((link) => ids.has(link.fromNoteId) && ids.has(link.toNoteId)),
      baseRows,
      baseRevisionRows,
      draftRows,
    };
  });

  snapshot.noteRows.sort((a, b) => stableStringCompare(a.id, b.id));
  snapshot.revisionRows.sort(
    (a, b) => stableStringCompare(a.noteId, b.noteId) || a.revision - b.revision,
  );
  snapshot.attachmentRows.sort(
    (a, b) => stableStringCompare(a.noteId, b.noteId) || stableStringCompare(a.id, b.id),
  );
  snapshot.linkRows.sort(
    (a, b) =>
      stableStringCompare(a.fromNoteId, b.fromNoteId) ||
      stableStringCompare(a.toNoteId, b.toNoteId),
  );
  snapshot.baseRows.sort((a, b) => stableStringCompare(a.id, b.id));
  snapshot.baseRevisionRows.sort(
    (a, b) => stableStringCompare(a.baseId, b.baseId) || a.revision - b.revision,
  );
  snapshot.draftRows.sort((a, b) => stableStringCompare(a.id, b.id));

  const stagingDirectory = mkdtempSync(join(tmpdir(), 'kory-notes-export-'));
  const archivePath = join(stagingDirectory, 'vault.tar');
  const writer = new DeterministicTarWriter(archivePath);
  try {
    const manifestNotes = [] as Array<Record<string, unknown>>;
    for (const row of snapshot.noteRows) {
      const key = archiveObjectKey(row.id);
      const extension = row.format === 'html' ? 'html' : 'md';
      const contentPath = `notes/${key}.${extension}`;
      const content = Buffer.from(row.content, 'utf8');
      const contentSha256 = writer.addBuffer(contentPath, content);
      manifestNotes.push({
        id: row.id,
        title: row.title,
        folderPath: row.folderPath,
        tags: publicNoteTags(row.tags),
        internalTags: parseStoredTags(row.tags).filter(isInternalNoteTag),
        pinned: Boolean(row.pinned),
        includeInContext: Boolean(row.includeInContext),
        format: row.format === 'html' ? 'html' : 'markdown',
        sourcePath: projectDocumentIdentity(row.id)?.sourcePath ?? null,
        revision: row.revision,
        userId: row.userId ?? null,
        createdAt: dateIso(row.createdAt),
        updatedAt: dateIso(row.updatedAt),
        trashedAt: dateIso(row.trashedAt, true),
        trashReason: row.trashReason ?? null,
        contentPath,
        contentBytes: content.length,
        contentSha256,
      });
    }

    const manifestRevisions = [] as Array<Record<string, unknown>>;
    for (const row of snapshot.revisionRows) {
      const key = archiveObjectKey(row.noteId);
      const extension = row.format === 'html' ? 'html' : 'md';
      const contentPath = `revisions/${key}/${row.revision}.${extension}`;
      const content = Buffer.from(row.content, 'utf8');
      const contentSha256 = writer.addBuffer(contentPath, content);
      manifestRevisions.push({
        noteId: row.noteId,
        revision: row.revision,
        operation: row.operation,
        title: row.title,
        folderPath: row.folderPath,
        tags: publicNoteTags(row.tags),
        internalTags: parseStoredTags(row.tags).filter(isInternalNoteTag),
        pinned: Boolean(row.pinned),
        includeInContext: Boolean(row.includeInContext),
        format: row.format === 'html' ? 'html' : 'markdown',
        sourcePath: row.sourcePath ?? projectDocumentIdentity(row.noteId)?.sourcePath ?? null,
        trashedAt: dateIso(row.trashedAt, true),
        trashReason: row.trashReason ?? null,
        noteCreatedAt: dateIso(row.noteCreatedAt),
        noteUpdatedAt: dateIso(row.noteUpdatedAt),
        createdAt: dateIso(row.createdAt, true),
        contentPath,
        contentBytes: content.length,
        contentSha256,
      });
    }

    const manifestAttachments = [] as Array<Record<string, unknown>>;
    for (const row of snapshot.attachmentRows) {
      if (!attachmentStorageIsAuthorized(row, root)) {
        throw new ValidationError(`Attachment ${row.id} is outside this project's storage`);
      }
      if (!existsSync(row.storagePath)) {
        throw new ConflictError('A vault attachment is missing; export stopped without omission.', {
          attachmentId: row.id,
          noteId: row.noteId,
        });
      }
      const attachmentStat = lstatSync(row.storagePath);
      if (attachmentStat.isSymbolicLink() || !attachmentStat.isFile()) {
        throw new ConflictError('A vault attachment is not a regular file; export stopped.', {
          attachmentId: row.id,
          noteId: row.noteId,
        });
      }
      const actualSize = attachmentStat.size;
      if (actualSize !== row.size) {
        throw new ConflictError('A vault attachment changed; export stopped without omission.', {
          attachmentId: row.id,
          expectedSize: row.size,
          actualSize,
        });
      }
      const archivePathForAttachment = `attachments/${archiveObjectKey(row.id)}`;
      const sha256 = writer.addFile(archivePathForAttachment, row.storagePath, row.size);
      manifestAttachments.push({
        id: row.id,
        noteId: row.noteId,
        filename: row.filename,
        mimeType: row.mimeType,
        size: row.size,
        createdAt: dateIso(row.createdAt),
        path: archivePathForAttachment,
        sha256,
      });
    }

    const baseRevisionsById = new Map<string, Array<(typeof snapshot.baseRevisionRows)[number]>>();
    for (const revision of snapshot.baseRevisionRows) {
      const revisions = baseRevisionsById.get(revision.baseId) ?? [];
      revisions.push(revision);
      baseRevisionsById.set(revision.baseId, revisions);
    }
    const manifestBases = [] as Array<Record<string, unknown>>;
    for (const row of snapshot.baseRows) {
      const revisions = baseRevisionsById.get(row.id) ?? [];
      const currentRevision = revisions.at(-1);
      const hasCompleteHistory =
        revisions.length === row.revision &&
        revisions.every((revision, index) => revision.revision === index + 1);
      const currentSnapshotMatches =
        currentRevision?.revision === row.revision &&
        currentRevision.name === row.name &&
        currentRevision.definition === row.definition &&
        (currentRevision.trashedAt?.getTime() ?? null) === (row.trashedAt?.getTime() ?? null) &&
        currentRevision.baseCreatedAt.getTime() === row.createdAt.getTime() &&
        currentRevision.baseUpdatedAt.getTime() === row.updatedAt.getTime();
      if (!hasCompleteHistory || !currentSnapshotMatches) {
        throw new ConflictError(
          `Base ${row.id} has incomplete immutable history; vault export stopped without omission.`,
          { baseId: row.id, revision: row.revision, historyEntries: revisions.length },
        );
      }
      const definition = parseVaultJson(row.definition, `Base ${row.id} definition`);
      const definitionPath = `bases/${archiveObjectKey(row.id)}.json`;
      const payload = Buffer.from(
        JSON.stringify(
          {
            format: 'koryphaios-note-base',
            version: 1,
            current: {
              name: row.name,
              definition,
              revision: row.revision,
              trashedAt: dateIso(row.trashedAt, true),
              createdAt: dateIso(row.createdAt, true),
              updatedAt: dateIso(row.updatedAt, true),
            },
            revisions: revisions.map((revision) => ({
              revision: revision.revision,
              operation: revision.operation,
              name: revision.name,
              definition: parseVaultJson(
                revision.definition,
                `Base ${row.id} revision ${revision.revision} definition`,
              ),
              trashedAt: dateIso(revision.trashedAt, true),
              baseCreatedAt: dateIso(revision.baseCreatedAt, true),
              baseUpdatedAt: dateIso(revision.baseUpdatedAt, true),
              createdAt: dateIso(revision.createdAt, true),
            })),
          },
          null,
          2,
        ) + '\n',
        'utf8',
      );
      const definitionSha256 = writer.addBuffer(definitionPath, payload);
      manifestBases.push({
        id: row.id,
        name: row.name,
        revision: row.revision,
        trashedAt: dateIso(row.trashedAt, true),
        createdAt: dateIso(row.createdAt, true),
        updatedAt: dateIso(row.updatedAt, true),
        definitionPath,
        definitionBytes: payload.length,
        definitionSha256,
      });
    }

    const manifestDrafts = [] as Array<Record<string, unknown>>;
    for (const row of snapshot.draftRows) {
      const tags = parseVaultStringArray(row.tags, `Draft ${row.id} tags`);
      const content = Buffer.from(row.content, 'utf8');
      if (content.length !== row.contentBytes) {
        throw new ConflictError(
          `Draft ${row.id} byte count is inconsistent; vault export stopped without omission.`,
          { draftId: row.id, expectedBytes: row.contentBytes, actualBytes: content.length },
        );
      }
      const actualPayloadHash = draftPayloadHash({
        title: row.title,
        content: row.content,
        folderPath: row.folderPath,
        tags,
        pinned: row.pinned,
        includeInContext: row.includeInContext,
        format: row.format,
      });
      if (actualPayloadHash !== row.payloadHash) {
        throw new ConflictError(
          `Draft ${row.id} payload hash is inconsistent; vault export stopped without omission.`,
          { draftId: row.id },
        );
      }
      const extension = row.format === 'html' ? 'html' : 'md';
      const contentPath = `drafts/${archiveObjectKey(row.id)}.${extension}`;
      const contentSha256 = writer.addBuffer(contentPath, content);
      manifestDrafts.push({
        id: row.id,
        noteId: row.noteId,
        baseRevision: row.baseRevision,
        draftRevision: row.draftRevision,
        baseTitle: row.baseTitle,
        sourcePathAtBase: row.sourcePathAtBase ?? null,
        title: row.title,
        folderPath: row.folderPath,
        tags,
        pinned: Boolean(row.pinned),
        includeInContext: Boolean(row.includeInContext),
        format: row.format,
        payloadHash: row.payloadHash,
        createdAt: dateIso(row.createdAt, true),
        updatedAt: dateIso(row.updatedAt, true),
        contentPath,
        contentBytes: content.length,
        contentSha256,
      });
    }

    const manifest = {
      format: 'koryphaios-notes-vault',
      version: 2,
      project: { name: basename(root) || 'project' },
      notes: manifestNotes,
      revisions: manifestRevisions,
      attachments: manifestAttachments,
      links: snapshot.linkRows.map((link) => ({
        fromNoteId: link.fromNoteId,
        toNoteId: link.toNoteId,
      })),
      bases: manifestBases,
      drafts: manifestDrafts,
      files: [],
    };
    writer.addBuffer(
      'manifest.json',
      Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8'),
    );
    writer.finish();
  } catch (error) {
    writer.abort();
    cleanupExport(archivePath, stagingDirectory);
    throw error;
  }

  const contentLength = statSync(archivePath).size;
  const safeProjectName =
    basename(root)
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '') || 'project';
  return {
    filename: `koryphaios-${safeProjectName}-vault.tar`,
    contentType: 'application/x-tar',
    contentLength,
    body: streamStagedArchive(archivePath, stagingDirectory, contentLength),
  };
}

export interface ProjectDocumentSyncResult {
  discovered: number;
  created: number;
  updated: number;
  removed: number;
  /** False only after a complete traversal; partial scans never prune unseen rows. */
  truncated: boolean;
  scanLimitReached: boolean;
  unreadablePaths: number;
  oversizedFiles: number;
  /** Documents whose relationship edges were rebuilt during this pass. */
  relinked: number;
  /** Byte-identical one-to-one source moves whose DB-owned metadata survived. */
  identityRelocations: number;
  /** Move-like candidates deliberately left separate because identity was not provable. */
  ambiguousMoveCandidates: number;
  /** Actionable summary for a non-fatal partial index. */
  message?: string;
}

type ProjectDocumentSyncRow = {
  id: string;
  content: string;
  title: string;
  folderPath: string;
  tags: string;
  pinned: number;
  includeInContext: number;
  format: string;
  userId: string | null;
  createdAt: Date;
  updatedAt: Date;
  projectRoot: string | null;
  revision: number;
  trashedAt: Date | null;
  trashReason: 'user' | 'source_removed' | null;
};

interface RelocatedProjectDocument {
  id: string;
  title: string;
  content: string;
  folderPath: string;
  tags: string;
  format: 'markdown' | 'html';
  sourcePath: string;
  modifiedAt: Date;
}

/**
 * Move a path-derived project note to its new ID while carrying forward every
 * database-owned relationship. Exact-content, one-to-one detection plus a
 * retained filesystem object identity happens in the scanner before this
 * helper is called. Legacy note-ID-addressed attachment paths are rejected by
 * the caller because rewriting those bytes cannot be made atomic with SQLite.
 */
async function relocateProjectDocumentRow(
  oldRow: ProjectDocumentSyncRow,
  target: RelocatedProjectDocument,
  projectRoot: string,
): Promise<void> {
  const oldSourcePath = projectDocumentIdentity(oldRow.id)?.sourcePath ?? null;
  await withNoteMutation(oldRow.id, async () => {
    db.transaction((tx) => {
      tx.insert(notes)
        .values({
          id: target.id,
          title: target.title,
          content: target.content,
          folderPath: target.folderPath,
          tags: target.tags,
          pinned: oldRow.pinned,
          includeInContext: oldRow.includeInContext,
          format: target.format,
          projectRoot,
          revision: oldRow.revision + 1,
          trashedAt: null,
          trashReason: null,
          userId: oldRow.userId,
          createdAt: oldRow.createdAt,
          updatedAt: target.modifiedAt,
        })
        .run();

      // Re-key immutable history first; deleting the old row cascades only the
      // old-key copies after these new-key rows exist.
      tx.run(sql`
        INSERT OR IGNORE INTO note_revisions (
          note_id, revision, project_root, operation, title, content, content_bytes,
          folder_path, tags, pinned, include_in_context, format, source_path,
          trashed_at, trash_reason, note_created_at, note_updated_at, created_at
        )
        SELECT
          ${target.id}, revision, ${projectRoot}, operation, title, content, content_bytes,
          folder_path, tags, pinned, include_in_context, format,
          COALESCE(source_path, ${oldSourcePath}),
          trashed_at, trash_reason, note_created_at, note_updated_at, created_at
        FROM note_revisions WHERE note_id = ${oldRow.id}
      `);

      // Preserve both incoming and outgoing explicit edges. The moved note's
      // outgoing content edges are re-parsed after the scan transaction.
      tx.run(sql`
        INSERT OR IGNORE INTO note_links (from_note_id, to_note_id)
        SELECT
          CASE WHEN from_note_id = ${oldRow.id} THEN ${target.id} ELSE from_note_id END,
          CASE WHEN to_note_id = ${oldRow.id} THEN ${target.id} ELSE to_note_id END
        FROM note_links
        WHERE from_note_id = ${oldRow.id} OR to_note_id = ${oldRow.id}
      `);
      tx.update(noteAttachments)
        .set({ noteId: target.id })
        .where(eq(noteAttachments.noteId, oldRow.id))
        .run();
      tx.delete(notes).where(eq(notes.id, oldRow.id)).run();
      tx.run(revisionSnapshotSql(target.id, 'external_sync'));
    });
  });
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
        ...(result.message ? { error: result.message } : {}),
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
  let scanLimitReached = false;
  let unreadablePaths = 0;
  let oversizedFiles = 0;

  // Match the graph/catalog envelope. Inserts are batched below and the walk
  // yields regularly, so real multi-thousand-document vaults do not get stuck
  // in a permanent partial-index state at the old 1,000-file boundary.
  const MAX_FILES = PROJECT_DOCUMENT_SCAN_LIMIT;

  // Use async readdir so the event loop stays responsive during the
  // recursive directory walk. The synchronous readdirSync would block
  // for 10+ seconds on large projects, making the backend unresponsive
  // to health checks and other API calls.
  async function walk(directory: string): Promise<void> {
    if (files.length >= MAX_FILES) {
      scanComplete = false;
      scanLimitReached = true;
      return;
    }
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (err) {
      serverLog.error({ err, directory }, 'Failed to read directory during project sync');
      scanComplete = false;
      unreadablePaths++;
      return;
    }

    // Filesystem iteration order differs by platform. Stable ordering makes a
    // capped scan reproducible and prevents notes from appearing/disappearing
    // between refreshes on the same unchanged vault.
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= MAX_FILES) {
        scanComplete = false;
        scanLimitReached = true;
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
  const projectRowSelection = {
    id: notes.id,
    content: notes.content,
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
    trashedAt: notes.trashedAt,
    trashReason: notes.trashReason,
  };
  // Scope in SQL before applying the per-vault safety limit. A global prefix
  // query let another 5k-note project consume the whole limit, making existing
  // documents in this project look new on every scan. Keep a bounded legacy
  // null-root pass for databases created before projectRoot was persisted.
  const [scopedProjectRows, legacyProjectRows] = await Promise.all([
    db
      .select(projectRowSelection)
      .from(notes)
      .where(and(like(notes.id, PROJECT_DOCUMENT_PREFIX + '%'), eq(notes.projectRoot, root)))
      .limit(PROJECT_DOCUMENT_SCAN_LIMIT),
    db
      .select(projectRowSelection)
      .from(notes)
      .where(and(like(notes.id, PROJECT_DOCUMENT_PREFIX + '%'), isNull(notes.projectRoot)))
      .limit(PROJECT_DOCUMENT_SCAN_LIMIT),
  ]);
  const existingProjectRows = [
    ...scopedProjectRows,
    ...legacyProjectRows.filter((row) => projectDocumentIdentity(row.id)?.projectRoot === root),
  ] as ProjectDocumentSyncRow[];
  const existingById = new Map(existingProjectRows.map((row) => [row.id, row]));
  const discoveredIds = new Set(
    files.map((absolute) => {
      const sourcePath = relative(root, absolute).split(sep).join('/');
      return projectDocumentId(root, sourcePath);
    }),
  );

  // A path-derived ID necessarily changes when a source file is moved. Detect
  // only byte-identical, one-to-one moves whose same-process filesystem object
  // identity also matches. That lets us carry
  // revisions, attachments, pin/context state, and explicit links to the new
  // ID without ever guessing between duplicate documents.
  const missingRowsByDigest = new Map<string, ProjectDocumentSyncRow[]>();
  for (const row of existingProjectRows) {
    if (discoveredIds.has(row.id) || row.trashReason === 'user') continue;
    const digest = createHash('sha256').update(row.content, 'utf8').digest('hex');
    const matches = missingRowsByDigest.get(digest);
    if (matches) matches.push(row);
    else missingRowsByDigest.set(digest, [row]);
  }

  type PreloadedNewDocument = { content: string; fileStat: Stats };
  const preloadedNewDocuments = new Map<string, PreloadedNewDocument>();
  const failedNewDocuments = new Set<string>();
  const newIdsByDigest = new Map<string, string[]>();
  for (const absolute of files) {
    const sourcePath = relative(root, absolute).split(sep).join('/');
    const id = projectDocumentId(root, sourcePath);
    if (existingById.has(id)) continue;
    try {
      const [fileStat, content] = await Promise.all([stat(absolute), readFile(absolute, 'utf8')]);
      if (byteLength(content) > NOTES_HARD_MAX_BYTES) {
        serverLog.warn(
          { file: absolute, size: byteLength(content), maxBytes: NOTES_HARD_MAX_BYTES },
          'Skipping oversized project document during move detection',
        );
        scanComplete = false;
        oversizedFiles++;
        failedNewDocuments.add(id);
        continue;
      }
      preloadedNewDocuments.set(id, { content, fileStat });
      const digest = createHash('sha256').update(content, 'utf8').digest('hex');
      const matches = newIdsByDigest.get(digest);
      if (matches) matches.push(id);
      else newIdsByDigest.set(digest, [id]);
    } catch (err) {
      serverLog.error({ err, file: absolute }, 'Failed to inspect new project document');
      scanComplete = false;
      unreadablePaths++;
      failedNewDocuments.add(id);
    }
  }

  const relocationSourceByNewId = new Map<string, ProjectDocumentSyncRow>();
  let ambiguousMoveCandidates = 0;
  for (const [digest, newIds] of newIdsByDigest) {
    const oldRows = missingRowsByDigest.get(digest) ?? [];
    if (oldRows.length === 0) continue;
    if (newIds.length !== 1 || oldRows.length !== 1) {
      ambiguousMoveCandidates += newIds.length;
      serverLog.warn(
        { digest, oldCandidates: oldRows.length, newCandidates: newIds.length },
        'Project-document move candidates were ambiguous; preserving them as separate notes',
      );
      continue;
    }
    const oldRow = oldRows[0];
    const oldSource = resolveProjectDocument(oldRow.id);
    const newSnapshot = preloadedNewDocuments.get(newIds[0]);
    const oldObjectIdentity = oldSource ? fileIdentityCache.get(oldSource) : undefined;
    const newObjectIdentity = newSnapshot ? fileObjectIdentity(newSnapshot.fileStat) : null;
    if (!oldObjectIdentity || oldObjectIdentity !== newObjectIdentity) {
      ambiguousMoveCandidates++;
      serverLog.warn(
        { oldNoteId: oldRow.id, newNoteId: newIds[0] },
        'Project-document content matched, but source identity was not provable; preserving separate notes',
      );
      continue;
    }
    const attachments = await db
      .select({ id: noteAttachments.id, storagePath: noteAttachments.storagePath })
      .from(noteAttachments)
      .where(eq(noteAttachments.noteId, oldRow.id));
    const hasLegacyAttachmentPath = attachments.some(
      (attachment) =>
        resolve(attachment.storagePath) !==
        resolve(root, '.koryphaios', 'attachments', attachment.id),
    );
    if (hasLegacyAttachmentPath) {
      ambiguousMoveCandidates++;
      serverLog.warn(
        { oldNoteId: oldRow.id, newNoteId: newIds[0] },
        'Skipped project-document identity relocation because a legacy attachment path is note-ID-addressed',
      );
      continue;
    }
    relocationSourceByNewId.set(newIds[0], oldRow);
  }

  const pendingInserts: Array<typeof notes.$inferInsert> = [];
  let created = 0;
  let updated = 0;
  let identityRelocations = 0;

  for (let fileIdx = 0; fileIdx < files.length; fileIdx++) {
    // Yield every 25 files to let health checks and API calls run between
    // synchronous SQLite writes (bun:sqlite is synchronous).
    if (fileIdx > 0 && fileIdx % 25 === 0) await new Promise<void>((r) => setImmediate(r));
    const absolute = files[fileIdx];
    const sourcePath = relative(root, absolute).split(sep).join('/');
    const id = projectDocumentId(root, sourcePath);
    foundIds.add(id);

    if (failedNewDocuments.has(id)) continue;

    let fileStat: Stats;
    const preloaded = preloadedNewDocuments.get(id);
    if (preloaded) fileStat = preloaded.fileStat;
    else {
      try {
        fileStat = await stat(absolute);
      } catch (err) {
        serverLog.error({ err, file: absolute }, 'Failed to stat file during project sync');
        scanComplete = false;
        unreadablePaths++;
        continue;
      }
    }
    // Skip unchanged files entirely — no read, no DB write, no re-link.
    if (existingById.has(id) && fileMtimeCache.get(absolute) === fileStat.mtimeMs) continue;

    let content: string;
    if (preloaded) content = preloaded.content;
    else {
      try {
        content = await readFile(absolute, 'utf8');
      } catch (err) {
        serverLog.error({ err, file: absolute }, 'Failed to read file during project sync');
        scanComplete = false;
        unreadablePaths++;
        continue;
      }
    }
    if (byteLength(content) > NOTES_HARD_MAX_BYTES) {
      serverLog.warn(
        { file: absolute, size: byteLength(content), maxBytes: NOTES_HARD_MAX_BYTES },
        'Skipping oversized project document during note sync',
      );
      scanComplete = false;
      oversizedFiles++;
      continue;
    }

    const title = basename(sourcePath, extname(sourcePath));
    const parent = dirname(sourcePath).split(sep).join('/');
    const folderPath = parent === '.' ? '/Project' : `/Project/${parent}`;
    const extension = extname(sourcePath).toLowerCase();
    // Project documents retain their source-authored tags. Internal tags are
    // additive and de-duplicated; they no longer overwrite YAML frontmatter on
    // each scan. Invalid/over-budget metadata fails this document explicitly
    // through the partial-sync contract instead of being silently truncated.
    let tags: string;
    try {
      tags = JSON.stringify(
        validateTags([
          'project-file',
          extension === '.html' || extension === '.htm' ? 'html' : 'markdown',
          ...parseFrontmatter(content).tags,
        ]),
      );
    } catch (err) {
      scanComplete = false;
      unreadablePaths++;
      serverLog.error({ err, file: absolute }, 'Project document metadata is invalid');
      continue;
    }
    const existing = existingById.get(id);
    let synced = false;
    let needsRelink = false;
    if (existing) {
      if (existing.trashedAt && existing.trashReason === 'user') {
        // An ordinary trash action only hides the catalog entry. The source
        // stays authoritative on disk and a refresh must not silently untrash it.
        fileMtimeCache.set(absolute, fileStat.mtimeMs);
        const identity = fileObjectIdentity(fileStat);
        if (identity) fileIdentityCache.set(absolute, identity);
        continue;
      }
      if (existing.trashedAt && existing.trashReason === 'source_removed') {
        try {
          const restored = await restoreNote(id, root, existing.revision);
          updated++;
          synced = true;
          needsRelink = true;
          content = restored.content;
        } catch (err) {
          scanComplete = false;
          unreadablePaths++;
          serverLog.error({ err, noteId: id }, 'Failed to restore a reappeared project document');
        }
      } else {
        try {
          await withNoteMutation(id, async () => {
            // Re-read after acquiring the same mutation queue used by editor
            // saves. A user save may have replaced the source file while this
            // scan was waiting; applying the pre-lock bytes would lose it.
            const latestStat = statSync(absolute);
            const latestContent = readFileSync(absolute, 'utf8');
            if (byteLength(latestContent) > NOTES_HARD_MAX_BYTES) {
              scanComplete = false;
              oversizedFiles++;
              return;
            }
            tags = JSON.stringify(
              validateTags([
                'project-file',
                extension === '.html' || extension === '.htm' ? 'html' : 'markdown',
                ...parseFrontmatter(latestContent).tags,
              ]),
            );
            const current = await getNote(id, root);
            if (!current) {
              scanComplete = false;
              unreadablePaths++;
              return;
            }
            content = latestContent;
            fileStat = latestStat;
            if (
              current.content !== latestContent ||
              current.title !== title ||
              current.folderPath !== folderPath ||
              JSON.stringify(current.tags) !== tags ||
              existing.projectRoot !== root
            ) {
              const changedRows = db.transaction((tx) => {
                const changedRows = tx
                  .update(notes)
                  .set({
                    title,
                    content: latestContent,
                    folderPath,
                    tags,
                    format: extension === '.html' || extension === '.htm' ? 'html' : 'markdown',
                    projectRoot: root,
                    revision: current.revision + 1,
                    updatedAt: latestStat.mtime,
                  })
                  .where(
                    and(
                      eq(notes.id, id),
                      eq(notes.revision, current.revision),
                      isNull(notes.trashedAt),
                    ),
                  )
                  .returning({ id: notes.id })
                  .all();
                if (changedRows.length === 1) {
                  tx.run(revisionSnapshotSql(id, 'external_sync'));
                }
                return changedRows;
              });
              if (changedRows.length !== 1) {
                throw new ConflictError('The project document changed while it was being indexed.');
              }
              updated++;
              needsRelink = true;
            }
            synced = true;
          });
        } catch (err) {
          scanComplete = false;
          unreadablePaths++;
          serverLog.error({ err, noteId: id }, 'Failed to update synced note');
        }
      }
    } else {
      const relocationSource = relocationSourceByNewId.get(id);
      if (relocationSource) {
        try {
          await relocateProjectDocumentRow(
            relocationSource,
            {
              id,
              title,
              content,
              folderPath,
              tags,
              format: extension === '.html' || extension === '.htm' ? 'html' : 'markdown',
              sourcePath,
              modifiedAt: fileStat.mtime,
            },
            root,
          );
          // The old path is no longer authoritative. Remove its cached mtime
          // and mark the old ID found so the orphan pass does not attempt to
          // trash a row that was intentionally re-keyed.
          const oldSource = resolveProjectDocument(relocationSource.id);
          if (oldSource) {
            fileMtimeCache.delete(oldSource);
            fileIdentityCache.delete(oldSource);
          }
          foundIds.add(relocationSource.id);
          existingById.delete(relocationSource.id);
          synced = true;
          updated++;
          identityRelocations++;
          needsRelink = true;
          if (relocationSource.title !== title) {
            try {
              await propagateTitleRename(id, relocationSource.title, title, root);
            } catch (err) {
              // The identity relocation is already durable. A backlink rewrite
              // failure is non-destructive and can be repaired independently;
              // do not misreport the relocated source as absent.
              scanComplete = false;
              unreadablePaths++;
              serverLog.error(
                { err, oldTitle: relocationSource.title, newTitle: title },
                'Project document moved, but one or more backlink titles could not be rewritten',
              );
            }
          }
        } catch (err) {
          scanComplete = false;
          unreadablePaths++;
          serverLog.error(
            { err, oldNoteId: relocationSource.id, newNoteId: id },
            'Failed to preserve project-document metadata across a source move',
          );
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
        needsRelink = true;
      }
    }
    if (!synced) continue;
    fileMtimeCache.set(absolute, fileStat.mtimeMs);
    const identity = fileObjectIdentity(fileStat);
    if (identity) fileIdentityCache.set(absolute, identity);
    if (needsRelink) changed.push({ id, content, sourcePath, existed: Boolean(existing) });
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
      db.transaction((tx) => {
        tx.insert(notes).values(batch).onConflictDoNothing().run();
        tx.run(
          revisionBatchSnapshotSql(
            batch.map((row) => row.id),
            'create',
          ),
        );
      });
    } catch (err) {
      serverLog.error({ err }, 'Bulk note insert failed during project sync; retrying row-by-row');
      for (const row of batch) {
        try {
          db.transaction((tx) => {
            tx.insert(notes).values(row).onConflictDoNothing().run();
            tx.run(revisionSnapshotSql(row.id, 'create'));
          });
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
    if (!foundIds.has(row.id) && !row.trashedAt) {
      try {
        await trashNote(row.id, root, row.revision, 'source_removed');
        const missingSource = resolveProjectDocument(row.id);
        if (missingSource) {
          fileMtimeCache.delete(missingSource);
          fileIdentityCache.delete(missingSource);
        }
        removed++;
      } catch (err) {
        serverLog.error({ err, noteId: row.id }, 'Failed to trash an orphaned project note');
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

  const issueParts: string[] = [];
  if (scanLimitReached) {
    issueParts.push(
      `the ${PROJECT_DOCUMENT_SCAN_LIMIT.toLocaleString()}-document scan limit was reached`,
    );
  }
  if (unreadablePaths > 0) {
    issueParts.push(
      `${unreadablePaths.toLocaleString()} path${unreadablePaths === 1 ? '' : 's'} could not be read`,
    );
  }
  if (oversizedFiles > 0) {
    issueParts.push(
      `${oversizedFiles.toLocaleString()} file${oversizedFiles === 1 ? '' : 's'} exceeded the ${Math.round(NOTES_HARD_MAX_BYTES / 1_000_000)} MB note limit`,
    );
  }
  const message = issueParts.length
    ? `Indexed ${files.length.toLocaleString()} project documents; ${issueParts.join(' and ')}. Existing entries that could not be verified were preserved.`
    : undefined;

  return {
    discovered: files.length,
    created,
    updated,
    removed,
    truncated: !scanComplete,
    scanLimitReached,
    unreadablePaths,
    oversizedFiles,
    relinked: changed.length,
    identityRelocations,
    ambiguousMoveCandidates,
    ...(message ? { message } : {}),
  };
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
  const rows = await db
    .select()
    .from(notes)
    .where(and(inArray(notes.id, ids), scopedNotesCondition(projectRoot)));
  return rows.filter((row) => isVisibleInProject(row, projectRoot)).map(rowToNote);
}

export async function getNoteOutlinks(id: string, projectRoot?: string): Promise<Note[]> {
  if (!(await getNote(id, projectRoot))) return [];
  const links = await db.select().from(noteLinks).where(eq(noteLinks.fromNoteId, id));

  if (!links.length) return [];

  const ids = links.map((l) => l.toNoteId);
  const rows = await db
    .select()
    .from(notes)
    .where(and(inArray(notes.id, ids), scopedNotesCondition(projectRoot)));
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
    return resolveNoteRef(title, projectRoot);
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
  // The renamed note's mutation queue is already held by callers. A self-link
  // must not recursively enqueue an update for the same note and deadlock the
  // save/restore path.
  const ids = backlinks.map((b) => b.id).filter((id) => id !== renamedId);
  if (ids.length === 0) return;
  const rows = (
    await db
      .select()
      .from(notes)
      .where(and(inArray(notes.id, ids), scopedNotesCondition(projectRoot)))
  ).filter((row) => isVisibleInProject(row, projectRoot));
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
  const scope = scopedNotesCondition(projectRoot);
  // This compact catalog is intentionally complete. It previously selected
  // full note bodies and silently stopped at 5,000 rows, causing agents to
  // believe later notes did not exist. Two indexed scalar counts keep link
  // totals exact without loading the graph's separately bounded payload.
  const catalogQuery = db
    .select({
      id: notes.id,
      title: notes.title,
      folderPath: notes.folderPath,
      tags: notes.tags,
      includeInContext: notes.includeInContext,
      updatedAt: notes.updatedAt,
      projectRoot: notes.projectRoot,
      linkCount: sql<number>`
        (SELECT COUNT(*) FROM note_links WHERE from_note_id = ${notes.id}) +
        (SELECT COUNT(*) FROM note_links WHERE to_note_id = ${notes.id})
      `,
    })
    .from(notes)
    .$dynamic();
  const rows = await (scope ? catalogQuery.where(scope) : catalogQuery).orderBy(
    desc(notes.updatedAt),
    asc(notes.id),
  );
  return rows
    .filter((row) => isVisibleInProject(row, projectRoot))
    .map((row) => ({
      id: row.id,
      title: row.title,
      folderPath: row.folderPath,
      tags: publicNoteTags(row.tags),
      linkCount: Number(row.linkCount) || 0,
      includeInContext: Boolean(row.includeInContext),
      updatedAt:
        row.updatedAt instanceof Date
          ? row.updatedAt
          : new Date((row.updatedAt as unknown as number) * 1000),
    }));
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
    .limit(Math.max(1, limit));
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
  opts?: { index?: NoteResolveIndex; skipInvalidate?: boolean; projectRoot?: string },
): Promise<void> {
  const titles = extractWikilinks(content);
  const targetIds = new Set<string>();
  if (titles.length > 0) {
    const index = opts?.index ?? (await getResolveIndex(opts?.projectRoot));
    for (const title of titles) {
      const id = resolveNoteRefFromIndex(title, index) ?? undefined;
      if (id && id !== noteId) targetIds.add(id);
    }
  }

  // Replace a note's derived edges atomically. A failed resolution/index build
  // leaves the prior graph intact, and a failed insert rolls the delete back.
  db.transaction((tx) => {
    tx.delete(noteLinks).where(eq(noteLinks.fromNoteId, noteId)).run();
    for (const toId of targetIds) {
      tx.insert(noteLinks)
        .values({ fromNoteId: noteId, toNoteId: toId })
        .onConflictDoNothing()
        .run();
    }
  });
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
  const totalRows = (
    await (scope
      ? db.select({ count: count() }).from(notes).where(scope)
      : db.select({ count: count() }).from(notes))
  )[0]?.count;
  const allRows = scope
    ? await db
        .select()
        .from(notes)
        .where(scope)
        .orderBy(asc(notes.id))
        .limit(GRAPH_MAX_NODES + 1)
    : await db
        .select()
        .from(notes)
        .orderBy(asc(notes.id))
        .limit(GRAPH_MAX_NODES + 1);
  const truncated = (totalRows ?? 0) > GRAPH_MAX_NODES;
  if (truncated) {
    serverLog.warn(
      { maxNodes: GRAPH_MAX_NODES, totalRows: totalRows ?? allRows.length },
      'Graph data truncated to maximum nodes (table has more rows)',
    );
  }
  const allNotes = allRows
    .slice(0, GRAPH_MAX_NODES)
    .filter((row) => isVisibleInProject(row, projectRoot));
  const visibleIds = new Set(allNotes.map((row) => row.id));
  // Safety cap: pathological link tables must not stall the graph build.
  const MAX_GRAPH_LINKS = 50_000;
  const visibleIdList = [...visibleIds];
  // Scope to the selected project/node envelope in SQL *before* applying the
  // safety limit. A large unrelated project must not consume the global first
  // 50k rows and erase this project's edges.
  const linkRows =
    visibleIdList.length === 0
      ? []
      : await db
          .select()
          .from(noteLinks)
          .where(
            and(
              inArray(noteLinks.fromNoteId, visibleIdList),
              inArray(noteLinks.toNoteId, visibleIdList),
            ),
          )
          .orderBy(asc(noteLinks.fromNoteId), asc(noteLinks.toNoteId))
          .limit(MAX_GRAPH_LINKS + 1);
  let linksTruncated = linkRows.length > MAX_GRAPH_LINKS;
  const allLinks = linkRows.slice(0, MAX_GRAPH_LINKS);
  if (linksTruncated) {
    serverLog.warn(
      { maxLinks: MAX_GRAPH_LINKS, projectRoot: resolvedProjectRoot(projectRoot) ?? null },
      'Graph links truncated to maximum (link table has more rows)',
    );
  }

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
  const ghostNodes = new Map<string, GraphNode>(); // lowered title -> ghost node
  for (const n of allNotes) {
    for (const ref of extractWikilinks(n.content)) {
      const key = normalizeNoteReference(ref);
      if (!key || resolveNoteRefFromIndex(ref, resolveMap)) continue;
      if (edges.length >= MAX_GRAPH_LINKS) {
        linksTruncated = true;
        continue;
      }
      let ghost = ghostNodes.get(key);
      if (!ghost) {
        if (nodes.length >= GRAPH_MAX_NODES) {
          // The graph safety cap covers real + unresolved nodes. Do not add an
          // edge whose target was omitted; report that relationship payload as
          // truncated instead of returning a dangling edge.
          linksTruncated = true;
          continue;
        }
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

  // `shown` is the pre-ghost visible note count — ghost nodes are not notes,
  // so "showing X of Y" must not count them.
  const data = {
    nodes,
    edges,
    shown: allNotes.length,
    ...(truncated
      ? {
          truncated: true,
          // Approximate when truncated: legacy identity-filtered rows may be
          // included in the SQL count but absent from nodes.
          total: Math.max(totalRows ?? 0, allNotes.length),
        }
      : {}),
    ...(linksTruncated ? { linksTruncated: true } : {}),
  };
  graphCache.set(cacheKey, data);
  return data;
}

// ============================================================================
// Folder Tree
// ============================================================================

export async function getFolderTree(projectRoot?: string): Promise<FolderNode[]> {
  const scope = scopedNotesCondition(projectRoot);
  // Aggregate in SQL — loading every note row just to count folders stalled
  // the event loop on large tables (BLOCKING_OP getFolderTree).
  const baseQuery = db
    .select({ folderPath: notes.folderPath, noteCount: count() })
    .from(notes)
    .$dynamic();
  const folderRows = await (scope ? baseQuery.where(scope) : baseQuery).groupBy(notes.folderPath);

  type FolderTrieNode = { noteCount: number; children: Map<string, FolderTrieNode> };
  const root: FolderTrieNode = { noteCount: 0, children: new Map() };
  for (const row of folderRows) {
    let current = root;
    for (const segment of row.folderPath.split('/').filter(Boolean)) {
      let child = current.children.get(segment);
      if (!child) {
        child = { noteCount: 0, children: new Map() };
        current.children.set(segment, child);
      }
      current = child;
    }
    current.noteCount = row.noteCount;
  }

  const serialize = (node: FolderTrieNode, parentPath: string): FolderNode[] =>
    [...node.children.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, child]) => {
        const path = `${parentPath}/${name}`;
        return {
          path,
          name,
          noteCount: child.noteCount,
          children: serialize(child, path),
        };
      });

  return serialize(root, '');
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
               AND notes.trashed_at IS NULL
               AND ${includeLegacy ? '(notes.project_root = ? OR notes.project_root IS NULL)' : 'notes.project_root = ?'}
             ORDER BY bm25(notes_fts)
             LIMIT ?`,
            )
            .all(match, root, limit)
        : raw
            .query(
              `SELECT notes_fts.note_id FROM notes_fts
               JOIN notes ON notes.id = notes_fts.note_id
               WHERE notes_fts MATCH ? AND notes.trashed_at IS NULL
               ORDER BY bm25(notes_fts) LIMIT ?`,
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
               AND trashed_at IS NULL
               AND ${includeLegacy ? '(project_root = ? OR project_root IS NULL)' : 'project_root = ?'}
             LIMIT ?`,
            )
            .all(term, term, root, limit)
        : raw
            .query(
              'SELECT id FROM notes WHERE trashed_at IS NULL AND (title LIKE ? OR content LIKE ?) LIMIT ?',
            )
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

/**
 * Build the authoritative project-scoped reference index.
 *
 * Rows are streamed in stable keyset pages so a large vault never gets an
 * arbitrary "first 5,000 notes" answer and page offsets cannot grow
 * quadratically. Ambiguous references are retained as `null`, which makes
 * callers fail closed while still allowing folder/source-qualified links.
 */
async function getResolveIndex(projectRoot?: string): Promise<NoteResolveIndex> {
  const cacheKey = resolvedProjectRoot(projectRoot) ?? '';
  const cached = resolveIndexCache.get(cacheKey);
  if (cached) return cached;
  const scope = scopedNotesCondition(projectRoot);
  const map: NoteResolveIndex = new Map();
  const PAGE_SIZE = 500;
  let lastId: string | undefined;
  let page = 0;

  while (true) {
    const after = lastId ? gt(notes.id, lastId) : undefined;
    const condition = scope && after ? and(scope, after) : (scope ?? after);
    const query = db
      .select({
        id: notes.id,
        title: notes.title,
        content: notes.content,
        folderPath: notes.folderPath,
      })
      .from(notes)
      .$dynamic();
    const rows = await (condition ? query.where(condition) : query)
      .orderBy(asc(notes.id))
      .limit(PAGE_SIZE);
    if (rows.length === 0) break;

    for (const row of rows) {
      for (const key of noteReferenceKeys(row)) addResolvableReference(map, key, row.id);
    }
    lastId = rows[rows.length - 1].id;
    if (rows.length < PAGE_SIZE) break;
    page++;
    if (page % 10 === 0) await new Promise<void>((done) => setImmediate(done));
  }

  resolveIndexCache.set(cacheKey, map);
  return map;
}

/** Resolve a title, alias, folder path, or project-relative source path. */
export async function resolveNoteRef(ref: string, projectRoot?: string): Promise<string | null> {
  const index = await getResolveIndex(projectRoot);
  return resolveNoteRefFromIndex(ref, index);
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
        );
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
