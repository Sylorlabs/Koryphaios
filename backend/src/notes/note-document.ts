/**
 * File-backed project documents: identity, body access, and derived content
 * fields.
 *
 * A `project-document:` note's body lives in its source file on disk; the DB
 * keeps only an empty `content` column plus derived metadata (`content_hash`,
 * `content_bytes`, `aliases`, `has_refs`) so no SQL path ever needs the text.
 * Rows whose source is missing keep their last body in `content` so
 * restore-from-trash can recreate the file.
 *
 * This module is a leaf: it must never import `notes-service` so every notes
 * subsystem (service, context, semantic index, properties, vault, compaction)
 * can share it without an import cycle.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { serverLog } from '../logger';
import { isContainedBy } from '../runtime/platform';
import { resolveProjectIdentity } from '../runtime/request-project';

export const PROJECT_DOCUMENT_PREFIX = 'project-document:';
export const DOCUMENT_EXTENSIONS = new Set(['.md', '.markdown', '.html', '.htm']);

/** Generated/vendor checkout directories that are never document sources. */
export const IGNORED_DOCUMENT_DIRS = new Set([
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
  // Git worktree checkouts mirror every document a second (or nth) time —
  // 179 worktrees produced ~48k pure-duplicate catalog rows.
  '.worktrees',
]);

/** A single path segment that disqualifies a file as a document source: any
 * hidden (dot-prefixed) entry plus the generated/vendor names above. */
export function isIgnoredDocumentPathSegment(segment: string): boolean {
  return segment.startsWith('.') || IGNORED_DOCUMENT_DIRS.has(segment);
}

/** Whether any segment of a relative document path — directories and the
 * basename alike — is hidden or a generated/vendor directory name. */
export function isIgnoredDocumentPath(sourcePath: string): boolean {
  return sourcePath.split(/[\\/]/).some(isIgnoredDocumentPathSegment);
}

export function projectDocumentId(projectRoot: string, sourcePath: string): string {
  return (
    PROJECT_DOCUMENT_PREFIX +
    Buffer.from(JSON.stringify([resolveProjectIdentity(projectRoot), sourcePath])).toString(
      'base64url',
    )
  );
}

export function projectDocumentIdentity(
  id: string,
): { projectRoot: string; sourcePath: string } | undefined {
  if (!id.startsWith(PROJECT_DOCUMENT_PREFIX)) return undefined;
  try {
    const [projectRoot, path] = JSON.parse(
      Buffer.from(id.slice(PROJECT_DOCUMENT_PREFIX.length), 'base64url').toString('utf8'),
    ) as [string, string];
    if (!path || path.startsWith('/') || path.split(/[\\/]/).includes('..')) return undefined;
    if (!projectRoot) return undefined;
    return { projectRoot: resolveProjectIdentity(projectRoot), sourcePath: path };
  } catch (err: unknown) {
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'project document identity decode failed — returning undefined',
    );
    return undefined;
  }
}

/** Absolute path of a project document's source file, or undefined for
 * DB-native notes and unsafe/escaped identities. */
export function resolveProjectDocument(id: string): string | undefined {
  const identity = projectDocumentIdentity(id);
  if (!identity) return undefined;
  const absolute = resolve(identity.projectRoot, identity.sourcePath);
  const root = identity.projectRoot;
  if (!isContainedBy(root, absolute)) return undefined;
  return absolute;
}

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

export interface NoteContentFields {
  /** sha256 hex of the indexed body — change detection never re-reads the row. */
  contentHash: string;
  contentBytes: number;
  /** JSON array of frontmatter aliases, precomputed so SQL never parses text. */
  aliases: string;
  /** 1 when the body can contain document references ([[, .md, .htm). */
  hasRefs: number;
}

/** The one derivation run at every write/sync/index point. */
export function noteContentFields(text: string): NoteContentFields {
  return {
    contentHash: createHash('sha256').update(text, 'utf8').digest('hex'),
    contentBytes: Buffer.byteLength(text, 'utf8'),
    aliases: JSON.stringify(parseFrontmatter(text).aliases),
    hasRefs: text.includes('[[') || text.includes('.md') || text.includes('.htm') ? 1 : 0,
  };
}

/** The single body accessor. For a project document whose source file exists
 * the disk text wins (it is authoritative); anything else returns the stored
 * `content`, which retains the last body for missing-source and native notes. */
export function readNoteBody(row: { id: string; content: string | null | undefined }): string {
  const source = resolveProjectDocument(row.id);
  if (source && existsSync(source)) {
    try {
      return readFileSync(source, 'utf8');
    } catch (err: unknown) {
      serverLog.debug(
        { err: err instanceof Error ? err.message : String(err), noteId: row.id },
        'project document body read failed — falling back to stored content',
      );
    }
  }
  return row.content ?? '';
}

/** What the `content` column should hold for a body we already have in hand:
 * nothing when the source file backs it, the body otherwise. */
export function storedNoteContent(noteId: string, body: string): string {
  const source = resolveProjectDocument(noteId);
  return source && existsSync(source) ? '' : body;
}

/** Whether `text` is the body the DB last indexed. `content_hash` is the
 * authoritative comparison once set; rows still awaiting the backfill
 * compaction (hash unset) compare against the stored `content`, which was
 * authoritative before file-backed documents were introduced. */
export function noteContentMatches(
  row: { id: string; content: string | null | undefined; contentHash?: string | null },
  text: string,
): boolean {
  if (row.contentHash) {
    return createHash('sha256').update(text, 'utf8').digest('hex') === row.contentHash;
  }
  return (row.content ?? '') === text;
}

export function parseStoredAliases(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}
