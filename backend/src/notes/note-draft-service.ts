import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import type { Database } from 'bun:sqlite';
import { nanoid } from 'nanoid';
import { getDb } from '../db';
import {
  ConflictError,
  NotFoundError,
  PayloadTooLargeError,
  ValidationError,
} from '../errors/types';
import { PROJECT_ROOT } from '../runtime/paths';
import { loadNotesSettings, NOTES_HARD_MAX_BYTES } from './notes-settings';
import { getLocalNotesPrincipalId } from './notes-principal';

const PROJECT_DOCUMENT_PREFIX = 'project-document:';
const MAX_DRAFT_ID_LENGTH = 512;
const MAX_TITLE_LENGTH = 300;
const MAX_FOLDER_PATH_LENGTH = 1_000;
const MAX_TAGS = 100;
const MAX_TAG_LENGTH = 100;

export const NOTE_DRAFT_MAX_PER_NOTE = 10;
export const NOTE_DRAFT_MAX_PER_PROJECT = 1_000;
export const NOTE_DRAFT_MAX_AGGREGATE_BYTES = 100 * 1024 * 1024;

export type NoteDraftState = 'recoverable' | 'conflict' | 'trashed' | 'orphaned';
export type NoteDraftFormat = 'markdown' | 'html';

export interface CreateNoteDraftInput {
  noteId: string;
  baseRevision: number;
  /** Used only when the original note is already absent. */
  baseTitle?: string;
  title: string;
  content: string;
  folderPath: string;
  tags: string[];
  pinned: boolean;
  includeInContext: boolean;
  format: NoteDraftFormat;
}

export interface UpdateNoteDraftInput {
  expectedDraftRevision: number;
  title: string;
  content: string;
  folderPath: string;
  tags: string[];
  pinned: boolean;
  includeInContext: boolean;
  format: NoteDraftFormat;
}

export interface NoteDraftSummary {
  id: string;
  noteId: string;
  baseRevision: number;
  draftRevision: number;
  baseTitle: string;
  sourcePathAtBase?: string;
  title: string;
  contentBytes: number;
  payloadHash: string;
  createdAt: Date;
  updatedAt: Date;
  state: NoteDraftState;
  currentRevision?: number;
}

export interface NoteDraft extends NoteDraftSummary {
  content: string;
  folderPath: string;
  tags: string[];
  pinned: boolean;
  includeInContext: boolean;
  format: NoteDraftFormat;
}

type DraftSummaryRow = {
  id: string;
  note_id: string;
  base_revision: number;
  draft_revision: number;
  base_title: string;
  source_path_at_base: string | null;
  title: string;
  content_bytes: number;
  payload_hash: string;
  created_at: number;
  updated_at: number;
  stored_note_id: string | null;
  current_revision: number | null;
  note_project_root: string | null;
  note_trashed_at: number | null;
};

type DraftRow = DraftSummaryRow & {
  principal_id: string;
  project_root: string;
  content: string;
  folder_path: string;
  tags: string;
  pinned: number;
  include_in_context: number;
  format: string;
};

type StoredNoteRow = {
  id: string;
  title: string;
  revision: number;
  project_root: string | null;
  trashed_at: number | null;
};

type RevisionIdentityRow = {
  title: string;
  source_path: string | null;
  project_root: string;
};

type CountRow = { count: number };
type BytesRow = { bytes: number | null };

interface ValidatedDraftPayload {
  title: string;
  content: string;
  contentBytes: number;
  folderPath: string;
  tags: string[];
  pinned: boolean;
  includeInContext: boolean;
  format: NoteDraftFormat;
  payloadHash: string;
}

export interface NoteDraftServiceOptions {
  legacyProjectRoot?: string;
  maxDraftsPerNote?: number;
  maxDraftsPerProject?: number;
  maxAggregateBytes?: number;
  contentLimitForProject?: (projectRoot: string) => number;
  now?: () => number;
  idFactory?: () => string;
}

function requireSafePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ValidationError(`${label} must be a positive integer`);
  }
  return value;
}

function requireBoundedText(value: string, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new ValidationError(`${label} must be text`);
  if (value.length > maxLength) {
    throw new ValidationError(`${label} cannot exceed ${maxLength} characters`);
  }
  if (/\p{Cc}/u.test(value)) throw new ValidationError(`${label} contains control characters`);
  return value;
}

function normalizeProjectRoot(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || !isAbsolute(trimmed)) {
    throw new ValidationError('Draft project scope must be an absolute path');
  }
  return resolve(trimmed);
}

function validateIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_DRAFT_ID_LENGTH || /\p{Cc}/u.test(normalized)) {
    throw new ValidationError(`${label} is invalid`);
  }
  return normalized;
}

function validateTags(tags: string[]): string[] {
  if (!Array.isArray(tags) || tags.length > MAX_TAGS) {
    throw new ValidationError(`A draft can have at most ${MAX_TAGS} tags`);
  }
  return tags.map((tag) => requireBoundedText(tag, 'Draft tag', MAX_TAG_LENGTH));
}

function projectDocumentIdentity(
  id: string,
): { projectRoot: string; sourcePath: string } | undefined {
  if (!id.startsWith(PROJECT_DOCUMENT_PREFIX)) return undefined;
  try {
    const decoded = JSON.parse(
      Buffer.from(id.slice(PROJECT_DOCUMENT_PREFIX.length), 'base64url').toString('utf8'),
    ) as unknown;
    if (!Array.isArray(decoded) || decoded.length !== 2) return undefined;
    const [projectRoot, sourcePath] = decoded;
    if (typeof projectRoot !== 'string' || typeof sourcePath !== 'string') return undefined;
    if (!projectRoot || !sourcePath || sourcePath.startsWith('/')) return undefined;
    if (sourcePath.split(/[\\/]/).includes('..')) return undefined;
    return { projectRoot: resolve(projectRoot), sourcePath };
  } catch {
    return undefined;
  }
}

function canonicalPayloadHash(
  payload: Omit<ValidatedDraftPayload, 'contentBytes' | 'payloadHash'>,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        payload.title,
        payload.content,
        payload.folderPath,
        payload.tags,
        payload.pinned,
        payload.includeInContext,
        payload.format,
      ]),
      'utf8',
    )
    .digest('hex');
}

function parseDraftTags(value: string, draftId: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((tag) => typeof tag === 'string')) {
      throw new Error('not a string array');
    }
    return parsed;
  } catch {
    throw new Error(`Stored Notes draft ${draftId} has invalid tag metadata`);
  }
}

/**
 * Crash-durable, non-authoritative Notes recovery storage.
 *
 * Draft writes never touch notes, note revisions, project files, links, or
 * attachments. Promotion remains an explicit optimistic write through the
 * authoritative Notes service.
 */
export class NoteDraftService {
  private readonly databaseProvider: () => Database;
  private readonly legacyProjectRoot: string;
  private readonly maxDraftsPerNote: number;
  private readonly maxDraftsPerProject: number;
  private readonly maxAggregateBytes: number;
  private readonly contentLimitForProject: (projectRoot: string) => number;
  private readonly now: () => number;
  private readonly idFactory: () => string;

  constructor(database: Database | (() => Database), options: NoteDraftServiceOptions = {}) {
    this.databaseProvider = typeof database === 'function' ? database : () => database;
    this.legacyProjectRoot = resolve(options.legacyProjectRoot ?? PROJECT_ROOT);
    this.maxDraftsPerNote = options.maxDraftsPerNote ?? NOTE_DRAFT_MAX_PER_NOTE;
    this.maxDraftsPerProject = options.maxDraftsPerProject ?? NOTE_DRAFT_MAX_PER_PROJECT;
    this.maxAggregateBytes = options.maxAggregateBytes ?? NOTE_DRAFT_MAX_AGGREGATE_BYTES;
    this.contentLimitForProject =
      options.contentLimitForProject ??
      ((projectRoot) => {
        const settings = loadNotesSettings(projectRoot);
        return settings.noteSizeLimitEnabled ? settings.maxNoteBytes : NOTES_HARD_MAX_BYTES;
      });
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? (() => nanoid(24));
  }

  getLocalPrincipalId(): string {
    return getLocalNotesPrincipalId(this.databaseProvider());
  }

  listDrafts(projectRoot: string): NoteDraftSummary[] {
    const database = this.databaseProvider();
    const scope = normalizeProjectRoot(projectRoot);
    const principalId = getLocalNotesPrincipalId(database);
    return database
      .query<DraftSummaryRow, [string, string]>(
        `${this.draftSummarySelectSql()}
        WHERE draft.principal_id = ? AND draft.project_root = ?
        ORDER BY draft.updated_at DESC, draft.id ASC`,
      )
      .all(principalId, scope)
      .map((row) => this.rowToSummary(row, scope));
  }

  getDraft(id: string, projectRoot: string): NoteDraft | null {
    const database = this.databaseProvider();
    const scope = normalizeProjectRoot(projectRoot);
    const principalId = getLocalNotesPrincipalId(database);
    const row = database
      .query<DraftRow, [string, string, string]>(
        `${this.draftSelectSql()}
        WHERE draft.id = ? AND draft.principal_id = ? AND draft.project_root = ?`,
      )
      .get(validateIdentifier(id, 'Draft ID'), principalId, scope);
    return row ? this.rowToDraft(row, scope) : null;
  }

  createDraft(input: CreateNoteDraftInput, projectRoot: string): NoteDraft {
    const database = this.databaseProvider();
    const scope = normalizeProjectRoot(projectRoot);
    const principalId = getLocalNotesPrincipalId(database);
    const noteId = validateIdentifier(input.noteId, 'Note ID');
    const baseRevision = requireSafePositiveInteger(input.baseRevision, 'baseRevision');
    const payload = this.validatePayload(input, scope);
    const noteRow = this.getStoredNoteRow(database, noteId);
    if (noteRow && !this.noteRowIsVisible(noteRow, scope)) {
      throw new NotFoundError('Note', noteId);
    }
    if (noteRow && baseRevision > noteRow.revision) {
      throw new ValidationError('baseRevision cannot be newer than the current note revision');
    }

    const revisionIdentity = this.getRevisionIdentity(database, noteId, baseRevision, scope);
    const documentIdentity = projectDocumentIdentity(noteId);
    const baseTitle =
      requireBoundedText(
        revisionIdentity?.title ?? noteRow?.title ?? input.baseTitle ?? input.title ?? '',
        'Draft base title',
        MAX_TITLE_LENGTH,
      ).trim() || 'Untitled';
    const sourcePathAtBase =
      revisionIdentity?.source_path ??
      (documentIdentity?.projectRoot === scope ? documentIdentity.sourcePath : null);
    const id = validateIdentifier(this.idFactory(), 'Draft ID');
    const timestamp = this.now();

    const insert = database.transaction(() => {
      const noteCount =
        database
          .query<CountRow, [string, string, string]>(
            `SELECT COUNT(*) AS count FROM note_drafts
           WHERE principal_id = ? AND project_root = ? AND note_id = ?`,
          )
          .get(principalId, scope, noteId)?.count ?? 0;
      if (noteCount >= this.maxDraftsPerNote) {
        throw new ConflictError(
          `This note already has ${this.maxDraftsPerNote} recovery drafts. Review or discard one before creating another.`,
        );
      }

      const projectCount =
        database
          .query<CountRow, [string, string]>(
            `SELECT COUNT(*) AS count FROM note_drafts
           WHERE principal_id = ? AND project_root = ?`,
          )
          .get(principalId, scope)?.count ?? 0;
      if (projectCount >= this.maxDraftsPerProject) {
        throw new ConflictError(
          `This project has reached its ${this.maxDraftsPerProject} recovery-draft limit. Review or discard old drafts first.`,
        );
      }

      this.assertAggregateBudget(database, principalId, scope, payload.contentBytes);
      database.run(
        `INSERT INTO note_drafts (
           id, principal_id, project_root, note_id, base_revision, draft_revision,
           base_title, source_path_at_base, title, content, content_bytes,
           folder_path, tags, pinned, include_in_context, format, payload_hash,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          principalId,
          scope,
          noteId,
          baseRevision,
          baseTitle,
          sourcePathAtBase,
          payload.title,
          payload.content,
          payload.contentBytes,
          payload.folderPath,
          JSON.stringify(payload.tags),
          payload.pinned ? 1 : 0,
          payload.includeInContext ? 1 : 0,
          payload.format,
          payload.payloadHash,
          timestamp,
          timestamp,
        ],
      );
    });
    insert();

    const created = this.getDraft(id, scope);
    if (!created) throw new Error(`Notes draft ${id} was not readable after insertion`);
    return created;
  }

  updateDraft(id: string, input: UpdateNoteDraftInput, projectRoot: string): NoteDraft {
    const database = this.databaseProvider();
    const scope = normalizeProjectRoot(projectRoot);
    const principalId = getLocalNotesPrincipalId(database);
    const draftId = validateIdentifier(id, 'Draft ID');
    const expectedDraftRevision = requireSafePositiveInteger(
      input.expectedDraftRevision,
      'expectedDraftRevision',
    );
    const payload = this.validatePayload(input, scope);
    const current = this.getScopedDraftRow(database, draftId, principalId, scope);
    if (!current) throw new NotFoundError('Notes draft', draftId);
    if (current.draft_revision !== expectedDraftRevision) {
      throw this.draftConflict(expectedDraftRevision, current.draft_revision);
    }
    if (current.draft_revision >= Number.MAX_SAFE_INTEGER) {
      throw new ConflictError('This recovery draft cannot advance beyond its current revision.');
    }
    const timestamp = Math.max(this.now(), current.updated_at + 1);

    const update = database.transaction(() => {
      this.assertAggregateBudget(
        database,
        principalId,
        scope,
        payload.contentBytes - current.content_bytes,
      );
      const result = database
        .query(
          `UPDATE note_drafts
           SET title = ?, content = ?, content_bytes = ?, folder_path = ?, tags = ?,
               pinned = ?, include_in_context = ?, format = ?, payload_hash = ?,
               draft_revision = draft_revision + 1, updated_at = ?
           WHERE id = ? AND principal_id = ? AND project_root = ? AND draft_revision = ?`,
        )
        .run(
          payload.title,
          payload.content,
          payload.contentBytes,
          payload.folderPath,
          JSON.stringify(payload.tags),
          payload.pinned ? 1 : 0,
          payload.includeInContext ? 1 : 0,
          payload.format,
          payload.payloadHash,
          timestamp,
          draftId,
          principalId,
          scope,
          expectedDraftRevision,
        );
      if (result.changes !== 1) {
        const latest = this.getScopedDraftRow(database, draftId, principalId, scope);
        if (!latest) throw new NotFoundError('Notes draft', draftId);
        throw this.draftConflict(expectedDraftRevision, latest.draft_revision);
      }
    });
    update();

    const updated = this.getDraft(draftId, scope);
    if (!updated) throw new Error(`Notes draft ${draftId} disappeared after update`);
    return updated;
  }

  discardDraft(id: string, expectedDraftRevision: number, projectRoot: string): void {
    const database = this.databaseProvider();
    const scope = normalizeProjectRoot(projectRoot);
    const principalId = getLocalNotesPrincipalId(database);
    const draftId = validateIdentifier(id, 'Draft ID');
    const expected = requireSafePositiveInteger(expectedDraftRevision, 'expectedDraftRevision');
    const current = this.getScopedDraftRow(database, draftId, principalId, scope);
    if (!current) throw new NotFoundError('Notes draft', draftId);
    if (current.draft_revision !== expected) {
      throw this.draftConflict(expected, current.draft_revision);
    }

    const result = database
      .query(
        `DELETE FROM note_drafts
         WHERE id = ? AND principal_id = ? AND project_root = ? AND draft_revision = ?`,
      )
      .run(draftId, principalId, scope, expected);
    if (result.changes !== 1) {
      const latest = this.getScopedDraftRow(database, draftId, principalId, scope);
      if (!latest) throw new NotFoundError('Notes draft', draftId);
      throw this.draftConflict(expected, latest.draft_revision);
    }
  }

  private validatePayload(
    input:
      Omit<CreateNoteDraftInput, 'noteId' | 'baseRevision' | 'baseTitle'> | UpdateNoteDraftInput,
    projectRoot: string,
  ): ValidatedDraftPayload {
    const title = requireBoundedText(input.title, 'Draft title', MAX_TITLE_LENGTH);
    const content = input.content;
    if (typeof content !== 'string') throw new ValidationError('Draft content must be text');
    const contentBytes = Buffer.byteLength(content, 'utf8');
    const maxBytes = Math.min(NOTES_HARD_MAX_BYTES, this.contentLimitForProject(projectRoot));
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new Error('Notes draft content-limit invariant failed');
    }
    if (contentBytes > maxBytes) {
      throw new PayloadTooLargeError(`${maxBytes} bytes`, { actualBytes: contentBytes, maxBytes });
    }
    const folderPath = requireBoundedText(
      input.folderPath,
      'Draft folder path',
      MAX_FOLDER_PATH_LENGTH,
    );
    const tags = validateTags(input.tags);
    if (input.format !== 'markdown' && input.format !== 'html') {
      throw new ValidationError('Draft format must be markdown or html');
    }
    if (typeof input.pinned !== 'boolean' || typeof input.includeInContext !== 'boolean') {
      throw new ValidationError('Draft boolean fields are invalid');
    }
    const hashInput = {
      title,
      content,
      folderPath,
      tags,
      pinned: input.pinned,
      includeInContext: input.includeInContext,
      format: input.format,
    };
    return {
      ...hashInput,
      contentBytes,
      payloadHash: canonicalPayloadHash(hashInput),
    };
  }

  private draftSummarySelectSql(): string {
    return `SELECT
      draft.id, draft.note_id,
      draft.base_revision, draft.draft_revision, draft.base_title,
      draft.source_path_at_base, draft.title, draft.content_bytes,
      draft.payload_hash, draft.created_at, draft.updated_at,
      note.id AS stored_note_id, note.revision AS current_revision,
      note.project_root AS note_project_root, note.trashed_at AS note_trashed_at
    FROM note_drafts AS draft
    LEFT JOIN notes AS note ON note.id = draft.note_id`;
  }

  private draftSelectSql(): string {
    return `SELECT
      draft.id, draft.principal_id, draft.project_root, draft.note_id,
      draft.base_revision, draft.draft_revision, draft.base_title,
      draft.source_path_at_base, draft.title, draft.content, draft.content_bytes,
      draft.folder_path, draft.tags, draft.pinned, draft.include_in_context,
      draft.format, draft.payload_hash, draft.created_at, draft.updated_at,
      note.id AS stored_note_id, note.revision AS current_revision,
      note.project_root AS note_project_root, note.trashed_at AS note_trashed_at
    FROM note_drafts AS draft
    LEFT JOIN notes AS note ON note.id = draft.note_id`;
  }

  private getScopedDraftRow(
    database: Database,
    id: string,
    principalId: string,
    projectRoot: string,
  ): DraftRow | null {
    return (
      database
        .query<DraftRow, [string, string, string]>(
          `${this.draftSelectSql()}
          WHERE draft.id = ? AND draft.principal_id = ? AND draft.project_root = ?`,
        )
        .get(id, principalId, projectRoot) ?? null
    );
  }

  private getStoredNoteRow(database: Database, noteId: string): StoredNoteRow | null {
    return (
      database
        .query<StoredNoteRow, [string]>(
          `SELECT id, title, revision, project_root, trashed_at FROM notes WHERE id = ?`,
        )
        .get(noteId) ?? null
    );
  }

  private getRevisionIdentity(
    database: Database,
    noteId: string,
    revision: number,
    projectRoot: string,
  ): RevisionIdentityRow | null {
    const row = database
      .query<RevisionIdentityRow, [string, number]>(
        `SELECT title, source_path, project_root
         FROM note_revisions WHERE note_id = ? AND revision = ?`,
      )
      .get(noteId, revision);
    return row && resolve(row.project_root || this.legacyProjectRoot) === projectRoot ? row : null;
  }

  private noteRowIsVisible(
    row: Pick<StoredNoteRow, 'id' | 'project_root'>,
    projectRoot: string,
  ): boolean {
    const identity = projectDocumentIdentity(row.id);
    const rowRoot = identity?.projectRoot ?? resolve(row.project_root || this.legacyProjectRoot);
    return rowRoot === projectRoot;
  }

  private rowToSummary(row: DraftSummaryRow, projectRoot: string): NoteDraftSummary {
    const storedNoteVisible =
      row.stored_note_id !== null &&
      this.noteRowIsVisible(
        { id: row.stored_note_id, project_root: row.note_project_root },
        projectRoot,
      );
    let state: NoteDraftState;
    let currentRevision: number | undefined;
    if (!storedNoteVisible) {
      state = 'orphaned';
    } else {
      currentRevision = row.current_revision ?? undefined;
      state =
        row.note_trashed_at !== null
          ? 'trashed'
          : row.current_revision === row.base_revision
            ? 'recoverable'
            : 'conflict';
    }

    return {
      id: row.id,
      noteId: row.note_id,
      baseRevision: row.base_revision,
      draftRevision: row.draft_revision,
      baseTitle: row.base_title,
      ...(row.source_path_at_base ? { sourcePathAtBase: row.source_path_at_base } : {}),
      title: row.title,
      contentBytes: row.content_bytes,
      payloadHash: row.payload_hash,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      state,
      ...(currentRevision !== undefined ? { currentRevision } : {}),
    };
  }

  private rowToDraft(row: DraftRow, projectRoot: string): NoteDraft {
    return {
      ...this.rowToSummary(row, projectRoot),
      content: row.content,
      folderPath: row.folder_path,
      tags: parseDraftTags(row.tags, row.id),
      pinned: Boolean(row.pinned),
      includeInContext: Boolean(row.include_in_context),
      format: row.format === 'html' ? 'html' : 'markdown',
    };
  }

  private assertAggregateBudget(
    database: Database,
    principalId: string,
    projectRoot: string,
    addedBytes: number,
  ): void {
    const current =
      database
        .query<BytesRow, [string, string]>(
          `SELECT COALESCE(SUM(content_bytes), 0) AS bytes
         FROM note_drafts WHERE principal_id = ? AND project_root = ?`,
        )
        .get(principalId, projectRoot)?.bytes ?? 0;
    if (current + addedBytes > this.maxAggregateBytes) {
      throw new ConflictError(
        `This project has reached its ${this.maxAggregateBytes}-byte recovery-draft budget. Review or discard old drafts first.`,
      );
    }
  }

  private draftConflict(expected: number, current: number): ConflictError {
    return new ConflictError(
      'This recovery draft changed in another editor. Reload it before saving or discarding.',
      { expectedDraftRevision: expected, currentDraftRevision: current },
    );
  }
}

/** Production singleton follows `getDb()` across test/runtime database reopen. */
export const noteDraftService = new NoteDraftService(() => getDb());
