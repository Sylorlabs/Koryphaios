import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  closeSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { Database } from 'bun:sqlite';
import { getDb } from '../db';
import { ConflictError, PayloadTooLargeError, ValidationError } from '../errors/types';
import { PROJECT_ROOT } from '../runtime/paths';
import {
  NOTE_DRAFT_MAX_AGGREGATE_BYTES,
  NOTE_DRAFT_MAX_PER_NOTE,
  NOTE_DRAFT_MAX_PER_PROJECT,
} from './note-draft-service';
import { getLocalNotesPrincipalId } from './notes-principal';
import { validateNoteBaseDefinition } from './note-bases-service';
import { invalidateNotesCache } from './notes-service';
import {
  previewVaultArchiveRestore,
  restoreVaultArchive,
  type VaultArchiveInput,
  type VaultArchiveRestorePlan,
  type VaultArchiveRestoreResult,
  type VaultProjectInventory,
  type VaultRestoreAdapter,
  type VaultRestoreCommitCounts,
} from './vault-archive';
import { NOTES_HARD_MAX_ATTACHMENT_BYTES, NOTES_HARD_MAX_BYTES } from './notes-settings';

const PROJECT_DOCUMENT_PREFIX = 'project-document:';
const INTERNAL_ROOT = '.koryphaios';
const JOURNAL_DIRECTORY = `${INTERNAL_ROOT}/vault-restore-journal`;
const STAGING_DIRECTORY = `${INTERNAL_ROOT}/vault-restore-staging`;
const LOCK_DIRECTORY = `${INTERNAL_ROOT}/vault-restore.lock`;
const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 50;
const MAX_JOURNAL_BYTES = 128 * 1024 * 1024;
const MAX_BASES_PER_PROJECT = 500;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RESTORE_QUEUES = new Map<string, Promise<void>>();

interface RestoreFile {
  kind: 'source' | 'attachment';
  targetRelative: string;
  bytes: Buffer;
  sha256: string;
  mode: number;
  mtimeMs?: number;
}

interface RestoreJournalFile {
  kind: RestoreFile['kind'];
  targetRelative: string;
  stageRelative: string;
  bytes: number;
  sha256: string;
  mode: number;
  mtimeMs?: number;
}

interface RestoreJournal {
  format: 'koryphaios-vault-restore-journal';
  version: 1;
  archiveSha256: string;
  manifestSha256: string;
  planToken: string;
  projectRoot: string;
  stagingRelative: string;
  files: RestoreJournalFile[];
}

interface RestoreLockOwner {
  format: 'koryphaios-vault-restore-lock';
  version: 1;
  pid: number;
  token: string;
  startedAt: number;
}

interface RestoredNote {
  id: string;
  archivedId: string;
  title: string;
  content: string;
  folderPath: string;
  tagsJson: string;
  pinned: number;
  includeInContext: number;
  format: 'markdown' | 'html';
  projectRoot: string;
  revision: number;
  trashedAt: number | null;
  trashReason: 'user' | 'source_removed' | null;
  userId: string | null;
  createdAt: number;
  updatedAt: number;
  sourcePath: string | null;
}

interface RestoredRevision {
  noteId: string;
  revision: number;
  operation: string;
  title: string;
  content: string;
  contentBytes: number;
  folderPath: string;
  tagsJson: string;
  pinned: number;
  includeInContext: number;
  format: 'markdown' | 'html';
  sourcePath: string | null;
  trashedAt: number | null;
  trashReason: 'user' | 'source_removed' | null;
  noteCreatedAt: number;
  noteUpdatedAt: number;
  createdAt: number;
}

interface RestoredAttachment {
  id: string;
  noteId: string;
  filename: string;
  mimeType: string;
  size: number;
  storagePath: string;
  createdAt: number;
}

interface RestoredBaseRevision {
  baseId: string;
  revision: number;
  operation: 'create' | 'update' | 'trash' | 'restore';
  name: string;
  definition: string;
  trashedAt: number | null;
  baseCreatedAt: number;
  baseUpdatedAt: number;
  createdAt: number;
}

interface RestoredBase {
  id: string;
  name: string;
  definition: string;
  revision: number;
  trashedAt: number | null;
  createdAt: number;
  updatedAt: number;
  revisions: RestoredBaseRevision[];
}

interface RestoredDraft {
  id: string;
  noteId: string;
  baseRevision: number;
  draftRevision: number;
  baseTitle: string;
  sourcePathAtBase: string | null;
  title: string;
  content: string;
  contentBytes: number;
  folderPath: string;
  tagsJson: string;
  pinned: number;
  includeInContext: number;
  format: 'markdown' | 'html';
  payloadHash: string;
  createdAt: number;
  updatedAt: number;
}

interface RestoreModel {
  notes: RestoredNote[];
  revisions: RestoredRevision[];
  attachments: RestoredAttachment[];
  links: Array<{ fromNoteId: string; toNoteId: string }>;
  bases: RestoredBase[];
  drafts: RestoredDraft[];
  files: RestoreFile[];
}

export type SerializableVaultRestorePlan = Omit<VaultArchiveRestorePlan, 'archive'>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sha256File(path: string): string {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  const chunk = Buffer.allocUnsafe(256 * 1024);
  try {
    let count = 0;
    do {
      count = readSync(fd, chunk, 0, chunk.length, null);
      if (count > 0) hash.update(chunk.subarray(0, count));
    } while (count > 0);
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

function canonicalProjectRoot(projectRoot: string): string {
  const root = realpathSync(resolve(projectRoot));
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ValidationError('Vault restore project root must be a real directory');
  }
  return root;
}

function portableRelativePath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 4096 ||
    value.startsWith('/') ||
    value.includes('\\') ||
    /^[a-zA-Z]:/.test(value) ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new ValidationError(`${label} must be a portable relative path`);
  }
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new ValidationError(`${label} contains an unsafe path segment`);
  }
  return value;
}

function containedTarget(projectRoot: string, targetRelative: string): string {
  const safe = portableRelativePath(targetRelative, 'Restore target');
  const target = resolve(projectRoot, safe);
  const scoped = relative(projectRoot, target);
  if (!scoped || scoped === '..' || scoped.startsWith(`..${sep}`)) {
    throw new ValidationError('Vault restore target escapes the selected project');
  }
  return target;
}

function ensureSafeDirectory(projectRoot: string, relativeDirectory: string): string {
  const safe = portableRelativePath(relativeDirectory, 'Restore directory');
  let cursor = projectRoot;
  for (const segment of safe.split('/')) {
    cursor = join(cursor, segment);
    try {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new ConflictError(`Vault restore directory is unsafe: ${safe}`);
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try {
        mkdirSync(cursor, { mode: 0o700 });
      } catch (mkdirError: unknown) {
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
      }
      const created = lstatSync(cursor);
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw new ConflictError(`Vault restore directory is unsafe: ${safe}`);
      }
    }
  }
  return cursor;
}

function assertSafeExistingParents(projectRoot: string, targetRelative: string): void {
  const segments = portableRelativePath(targetRelative, 'Restore target').split('/');
  let cursor = projectRoot;
  for (const segment of segments.slice(0, -1)) {
    cursor = join(cursor, segment);
    try {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new ConflictError(
          `Vault restore target crosses an unsafe directory: ${targetRelative}`,
        );
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

function requireString(
  value: unknown,
  label: string,
  options: { max?: number; allowEmpty?: boolean } = {},
): string {
  const max = options.max ?? 4096;
  if (
    typeof value !== 'string' ||
    (!options.allowEmpty && value.length === 0) ||
    value.length > max ||
    value.includes('\0')
  ) {
    throw new ValidationError(`${label} is invalid`);
  }
  return value;
}

function requireInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new ValidationError(`${label} must be an integer of at least ${minimum}`);
  }
  return value as number;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new ValidationError(`${label} must be boolean`);
  return value;
}

function requireDateMs(value: unknown, label: string, nullable = false): number | null {
  if (nullable && value === null) return null;
  const text = requireString(value, label, { max: 64 });
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds)) throw new ValidationError(`${label} must be a valid date`);
  return milliseconds;
}

function requireSha256(value: unknown, label: string): string {
  const digest = requireString(value, label, { max: 64 }).toLowerCase();
  if (!SHA256_PATTERN.test(digest)) throw new ValidationError(`${label} must be a SHA-256 digest`);
  return digest;
}

function requireTags(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new ValidationError(`${label} must contain at most 100 tags`);
  }
  return value.map((tag, index) => {
    const text = requireString(tag, `${label}[${index}]`, { max: 100, allowEmpty: true });
    if (/\p{Cc}/u.test(text)) throw new ValidationError(`${label}[${index}] contains controls`);
    return text;
  });
}

function requireFormat(value: unknown, label: string): 'markdown' | 'html' {
  if (value !== 'markdown' && value !== 'html') {
    throw new ValidationError(`${label} must be markdown or html`);
  }
  return value;
}

function requireTrashReason(value: unknown, label: string): 'user' | 'source_removed' | null {
  if (value === null || value === undefined) return null;
  if (value !== 'user' && value !== 'source_removed') {
    throw new ValidationError(`${label} is invalid`);
  }
  return value;
}

function decodeUtf8(bytes: Buffer, label: string): string {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.includes('\0')) throw new Error('NUL');
    return text;
  } catch {
    throw new ValidationError(`${label} is not valid UTF-8 text`);
  }
}

function projectDocumentIdentity(id: string): { projectRoot: string; sourcePath: string } | null {
  if (!id.startsWith(PROJECT_DOCUMENT_PREFIX)) return null;
  try {
    const decoded = JSON.parse(
      Buffer.from(id.slice(PROJECT_DOCUMENT_PREFIX.length), 'base64url').toString('utf8'),
    ) as unknown;
    if (!Array.isArray(decoded) || decoded.length !== 2) return null;
    const [projectRoot, sourcePath] = decoded;
    if (typeof projectRoot !== 'string' || typeof sourcePath !== 'string') return null;
    return {
      projectRoot: resolve(projectRoot),
      sourcePath: portableRelativePath(sourcePath, 'Project-document source path'),
    };
  } catch {
    return null;
  }
}

function projectDocumentId(projectRoot: string, sourcePath: string): string {
  return (
    PROJECT_DOCUMENT_PREFIX +
    Buffer.from(JSON.stringify([projectRoot, sourcePath]), 'utf8').toString('base64url')
  );
}

function mappedNoteId(id: string, projectRoot: string, sourcePath?: string | null): string {
  const path = sourcePath ?? projectDocumentIdentity(id)?.sourcePath;
  return path ? projectDocumentId(projectRoot, portableRelativePath(path, 'Note source path')) : id;
}

function canonicalDraftPayloadHash(input: {
  title: string;
  content: string;
  folderPath: string;
  tags: string[];
  pinned: boolean;
  includeInContext: boolean;
  format: 'markdown' | 'html';
}): string {
  return sha256(
    JSON.stringify([
      input.title,
      input.content,
      input.folderPath,
      input.tags,
      input.pinned,
      input.includeInContext,
      input.format,
    ]),
  );
}

function buildRestoreModel(plan: Readonly<VaultArchiveRestorePlan>): RestoreModel {
  const { archive, projectRoot } = plan;
  if (archive.manifest.files.length > 0) {
    throw new ValidationError(
      'This archive contains generic workspace files, but no safe destination contract exists for them.',
    );
  }

  const idMap = new Map<string, string>();
  const notes: RestoredNote[] = archive.manifest.notes.map((record, index) => {
    const sourcePath = record.sourcePath
      ? portableRelativePath(record.sourcePath, `notes[${index}].sourcePath`)
      : null;
    if (sourcePath?.split('/')[0] === INTERNAL_ROOT) {
      throw new ValidationError('A restored note cannot target Koryphaios internal storage');
    }
    const archivedId = requireString(record.id, `notes[${index}].id`, { max: 512 });
    const id = mappedNoteId(archivedId, projectRoot, sourcePath);
    if ([...idMap.values()].includes(id)) {
      throw new ValidationError(`Multiple archived notes map to the same target note id: ${id}`);
    }
    idMap.set(archivedId, id);
    const content = decodeUtf8(
      archive.readEntry(requireString(record.contentPath, `notes[${index}].contentPath`)),
      `notes[${index}] content`,
    );
    if (Buffer.byteLength(content, 'utf8') > NOTES_HARD_MAX_BYTES) {
      throw new PayloadTooLargeError(`${NOTES_HARD_MAX_BYTES} note bytes`);
    }
    const title = requireString(record.title, `notes[${index}].title`, {
      max: 300,
      allowEmpty: true,
    });
    const folderPath = requireString(record.folderPath, `notes[${index}].folderPath`, {
      max: 1000,
      allowEmpty: true,
    });
    const tags = requireTags(record.tags, `notes[${index}].tags`);
    const internalTags = record.internalTags
      ? requireTags(record.internalTags, `notes[${index}].internalTags`)
      : [];
    const trashedAt = requireDateMs(record.trashedAt, `notes[${index}].trashedAt`, true);
    const trashReason = requireTrashReason(record.trashReason, `notes[${index}].trashReason`);
    if ((trashedAt === null) !== (trashReason === null)) {
      throw new ValidationError(`notes[${index}] has inconsistent Trash metadata`);
    }
    return {
      id,
      archivedId,
      title,
      content,
      folderPath,
      tagsJson: JSON.stringify([...new Set([...tags, ...internalTags])]),
      pinned: requireBoolean(record.pinned, `notes[${index}].pinned`) ? 1 : 0,
      includeInContext: requireBoolean(record.includeInContext, `notes[${index}].includeInContext`)
        ? 1
        : 0,
      format: requireFormat(record.format, `notes[${index}].format`),
      projectRoot,
      revision: requireInteger(record.revision, `notes[${index}].revision`, 1),
      trashedAt,
      trashReason,
      userId:
        record.userId === null || record.userId === undefined
          ? null
          : requireString(record.userId, `notes[${index}].userId`, { max: 512 }),
      createdAt: Math.floor(requireDateMs(record.createdAt, `notes[${index}].createdAt`)! / 1000),
      updatedAt: Math.floor(requireDateMs(record.updatedAt, `notes[${index}].updatedAt`)! / 1000),
      sourcePath,
    };
  });

  const noteByArchiveId = new Map(notes.map((note) => [note.archivedId, note]));
  const revisions: RestoredRevision[] = archive.manifest.revisions.map((record, index) => {
    const archivedNoteId = requireString(record.noteId, `revisions[${index}].noteId`);
    const note = noteByArchiveId.get(archivedNoteId);
    if (!note) throw new ValidationError(`revisions[${index}] refers to an unknown note`);
    const content = decodeUtf8(
      archive.readEntry(requireString(record.contentPath, `revisions[${index}].contentPath`)),
      `revisions[${index}] content`,
    );
    const contentBytes = Buffer.byteLength(content, 'utf8');
    if (contentBytes > NOTES_HARD_MAX_BYTES) {
      throw new PayloadTooLargeError(`${NOTES_HARD_MAX_BYTES} revision bytes`);
    }
    const sourcePath = record.sourcePath
      ? portableRelativePath(record.sourcePath, `revisions[${index}].sourcePath`)
      : note.sourcePath;
    const tags = requireTags(record.tags, `revisions[${index}].tags`);
    const internalTags = record.internalTags
      ? requireTags(record.internalTags, `revisions[${index}].internalTags`)
      : [];
    const operation = requireString(record.operation, `revisions[${index}].operation`, {
      max: 64,
    });
    if (
      ![
        'create',
        'update',
        'external_sync',
        'trash',
        'source_removed',
        'restore',
        'revision_restore',
      ].includes(operation)
    ) {
      throw new ValidationError(`revisions[${index}].operation is unsupported`);
    }
    return {
      noteId: note.id,
      revision: requireInteger(record.revision, `revisions[${index}].revision`, 1),
      operation,
      title: requireString(record.title, `revisions[${index}].title`, {
        max: 300,
        allowEmpty: true,
      }),
      content,
      contentBytes,
      folderPath: requireString(record.folderPath, `revisions[${index}].folderPath`, {
        max: 1000,
        allowEmpty: true,
      }),
      tagsJson: JSON.stringify([...new Set([...tags, ...internalTags])]),
      pinned: requireBoolean(record.pinned, `revisions[${index}].pinned`) ? 1 : 0,
      includeInContext: requireBoolean(
        record.includeInContext,
        `revisions[${index}].includeInContext`,
      )
        ? 1
        : 0,
      format: requireFormat(record.format, `revisions[${index}].format`),
      sourcePath,
      trashedAt: requireDateMs(record.trashedAt, `revisions[${index}].trashedAt`, true),
      trashReason: requireTrashReason(record.trashReason, `revisions[${index}].trashReason`),
      noteCreatedAt: Math.floor(
        requireDateMs(record.noteCreatedAt, `revisions[${index}].noteCreatedAt`)! / 1000,
      ),
      noteUpdatedAt: Math.floor(
        requireDateMs(record.noteUpdatedAt, `revisions[${index}].noteUpdatedAt`)! / 1000,
      ),
      createdAt: requireDateMs(record.createdAt, `revisions[${index}].createdAt`)!,
    };
  });

  const files: RestoreFile[] = [];
  for (const note of notes) {
    if (!note.sourcePath || note.trashReason === 'source_removed') continue;
    files.push({
      kind: 'source',
      targetRelative: note.sourcePath,
      bytes: Buffer.from(note.content, 'utf8'),
      sha256: sha256(note.content),
      mode: 0o600,
      mtimeMs: note.updatedAt * 1000,
    });
  }

  const attachments: RestoredAttachment[] = archive.manifest.attachments.map((record, index) => {
    const id = requireString(record.id, `attachments[${index}].id`, { max: 512 });
    const archivedNoteId = requireString(record.noteId, `attachments[${index}].noteId`);
    const noteId = idMap.get(archivedNoteId);
    if (!noteId) throw new ValidationError(`attachments[${index}] refers to an unknown note`);
    const size = requireInteger(record.size, `attachments[${index}].size`);
    if (size > NOTES_HARD_MAX_ATTACHMENT_BYTES) {
      throw new PayloadTooLargeError(`${NOTES_HARD_MAX_ATTACHMENT_BYTES} attachment bytes`);
    }
    const bytes = archive.readEntry(requireString(record.path, `attachments[${index}].path`));
    const targetRelative = `${INTERNAL_ROOT}/attachments/${id}`;
    files.push({
      kind: 'attachment',
      targetRelative,
      bytes,
      sha256: requireSha256(record.sha256, `attachments[${index}].sha256`),
      mode: 0o600,
    });
    return {
      id,
      noteId,
      filename: requireString(record.filename, `attachments[${index}].filename`, { max: 4096 }),
      mimeType: requireString(record.mimeType, `attachments[${index}].mimeType`, { max: 512 }),
      size,
      storagePath: containedTarget(projectRoot, targetRelative),
      createdAt: Math.floor(
        requireDateMs(record.createdAt, `attachments[${index}].createdAt`)! / 1000,
      ),
    };
  });

  const links = archive.manifest.links.map((record, index) => {
    const fromNoteId = idMap.get(requireString(record.fromNoteId, `links[${index}].fromNoteId`));
    const toNoteId = idMap.get(requireString(record.toNoteId, `links[${index}].toNoteId`));
    if (!fromNoteId || !toNoteId) throw new ValidationError(`links[${index}] is invalid`);
    return { fromNoteId, toNoteId };
  });

  const bases: RestoredBase[] = archive.manifest.bases.map((record, index) => {
    const id = requireString(record.id, `bases[${index}].id`, { max: 512 });
    const name = requireString(record.name, `bases[${index}].name`, { max: 120 });
    const revision = requireInteger(record.revision, `bases[${index}].revision`, 1);
    const trashedAt = requireDateMs(record.trashedAt, `bases[${index}].trashedAt`, true);
    const createdAt = requireDateMs(record.createdAt, `bases[${index}].createdAt`)!;
    const updatedAt = requireDateMs(record.updatedAt, `bases[${index}].updatedAt`)!;
    const payloadPath = requireString(record.definitionPath, `bases[${index}].definitionPath`);
    const payloadText = decodeUtf8(archive.readEntry(payloadPath), `bases[${index}] definition`);
    let payload: unknown;
    try {
      payload = JSON.parse(payloadText);
    } catch {
      throw new ValidationError(`bases[${index}] definition is not JSON`);
    }
    if (!isRecord(payload) || payload.format !== 'koryphaios-note-base' || payload.version !== 1) {
      throw new ValidationError(`bases[${index}] definition format is unsupported`);
    }
    if (!isRecord(payload.current) || !Array.isArray(payload.revisions)) {
      throw new ValidationError(`bases[${index}] definition payload is incomplete`);
    }
    const current = payload.current;
    const definition = validateNoteBaseDefinition(current.definition);
    if (
      current.name !== name ||
      current.revision !== revision ||
      current.trashedAt !== (record.trashedAt ?? null) ||
      current.createdAt !== record.createdAt ||
      current.updatedAt !== record.updatedAt
    ) {
      throw new ValidationError(`bases[${index}] manifest does not match its definition payload`);
    }
    if (payload.revisions.length !== revision) {
      throw new ValidationError(`bases[${index}] is missing immutable revision history`);
    }
    const restoredRevisions = payload.revisions.map((entry, revisionIndex) => {
      if (!isRecord(entry) || entry.revision !== revisionIndex + 1) {
        throw new ValidationError(`bases[${index}] revision history is not contiguous`);
      }
      if (!['create', 'update', 'trash', 'restore'].includes(String(entry.operation))) {
        throw new ValidationError(`bases[${index}] has an unsupported revision operation`);
      }
      const entryDefinition = validateNoteBaseDefinition(entry.definition);
      return {
        baseId: id,
        revision: revisionIndex + 1,
        operation: entry.operation as RestoredBaseRevision['operation'],
        name: requireString(entry.name, `bases[${index}].revisions[${revisionIndex}].name`, {
          max: 120,
        }),
        definition: JSON.stringify(entryDefinition),
        trashedAt: requireDateMs(
          entry.trashedAt,
          `bases[${index}].revisions[${revisionIndex}].trashedAt`,
          true,
        ),
        baseCreatedAt: requireDateMs(
          entry.baseCreatedAt,
          `bases[${index}].revisions[${revisionIndex}].baseCreatedAt`,
        )!,
        baseUpdatedAt: requireDateMs(
          entry.baseUpdatedAt,
          `bases[${index}].revisions[${revisionIndex}].baseUpdatedAt`,
        )!,
        createdAt: requireDateMs(
          entry.createdAt,
          `bases[${index}].revisions[${revisionIndex}].createdAt`,
        )!,
      };
    });
    const latest = restoredRevisions.at(-1)!;
    if (
      latest.name !== name ||
      latest.definition !== JSON.stringify(definition) ||
      latest.trashedAt !== trashedAt ||
      latest.baseCreatedAt !== createdAt ||
      latest.baseUpdatedAt !== updatedAt
    ) {
      throw new ValidationError(`bases[${index}] current state disagrees with its latest revision`);
    }
    return {
      id,
      name,
      definition: JSON.stringify(definition),
      revision,
      trashedAt,
      createdAt,
      updatedAt,
      revisions: restoredRevisions,
    };
  });

  const drafts: RestoredDraft[] = archive.manifest.drafts.map((record, index) => {
    const archivedNoteId = requireString(record.noteId, `drafts[${index}].noteId`, { max: 512 });
    const noteId = idMap.get(archivedNoteId) ?? mappedNoteId(archivedNoteId, projectRoot);
    const content = decodeUtf8(
      archive.readEntry(requireString(record.contentPath, `drafts[${index}].contentPath`)),
      `drafts[${index}] content`,
    );
    const contentBytes = Buffer.byteLength(content, 'utf8');
    if (contentBytes > NOTES_HARD_MAX_BYTES) {
      throw new PayloadTooLargeError(`${NOTES_HARD_MAX_BYTES} draft bytes`);
    }
    const title = requireString(record.title, `drafts[${index}].title`, {
      max: 300,
      allowEmpty: true,
    });
    const folderPath = requireString(record.folderPath, `drafts[${index}].folderPath`, {
      max: 1000,
      allowEmpty: true,
    });
    const tags = requireTags(record.tags, `drafts[${index}].tags`);
    const pinned = requireBoolean(record.pinned, `drafts[${index}].pinned`);
    const includeInContext = requireBoolean(
      record.includeInContext,
      `drafts[${index}].includeInContext`,
    );
    const format = requireFormat(record.format, `drafts[${index}].format`);
    const expectedPayloadHash = canonicalDraftPayloadHash({
      title,
      content,
      folderPath,
      tags,
      pinned,
      includeInContext,
      format,
    });
    const payloadHash = requireSha256(record.payloadHash, `drafts[${index}].payloadHash`);
    if (payloadHash !== expectedPayloadHash) {
      throw new ValidationError(`drafts[${index}] snapshot hash does not match its metadata`);
    }
    return {
      id: requireString(record.id, `drafts[${index}].id`, { max: 512 }),
      noteId,
      baseRevision: requireInteger(record.baseRevision, `drafts[${index}].baseRevision`, 1),
      draftRevision: requireInteger(record.draftRevision, `drafts[${index}].draftRevision`, 1),
      baseTitle: requireString(record.baseTitle, `drafts[${index}].baseTitle`, {
        max: 300,
        allowEmpty: true,
      }),
      sourcePathAtBase:
        record.sourcePathAtBase === null || record.sourcePathAtBase === undefined
          ? (projectDocumentIdentity(archivedNoteId)?.sourcePath ?? null)
          : portableRelativePath(record.sourcePathAtBase, `drafts[${index}].sourcePathAtBase`),
      title,
      content,
      contentBytes,
      folderPath,
      tagsJson: JSON.stringify(tags),
      pinned: pinned ? 1 : 0,
      includeInContext: includeInContext ? 1 : 0,
      format,
      payloadHash,
      createdAt: requireDateMs(record.createdAt, `drafts[${index}].createdAt`)!,
      updatedAt: requireDateMs(record.updatedAt, `drafts[${index}].updatedAt`)!,
    };
  });

  if (bases.length > MAX_BASES_PER_PROJECT) {
    throw new PayloadTooLargeError(`${MAX_BASES_PER_PROJECT} Bases per project`);
  }
  if (drafts.length > NOTE_DRAFT_MAX_PER_PROJECT) {
    throw new PayloadTooLargeError(`${NOTE_DRAFT_MAX_PER_PROJECT} drafts per project`);
  }
  const draftBytes = drafts.reduce((total, draft) => total + draft.contentBytes, 0);
  if (draftBytes > NOTE_DRAFT_MAX_AGGREGATE_BYTES) {
    throw new PayloadTooLargeError(`${NOTE_DRAFT_MAX_AGGREGATE_BYTES} aggregate draft bytes`);
  }
  const perNoteDrafts = new Map<string, number>();
  for (const draft of drafts) {
    const count = (perNoteDrafts.get(draft.noteId) ?? 0) + 1;
    if (count > NOTE_DRAFT_MAX_PER_NOTE) {
      throw new PayloadTooLargeError(`${NOTE_DRAFT_MAX_PER_NOTE} drafts per note`);
    }
    perNoteDrafts.set(draft.noteId, count);
  }

  return { notes, revisions, attachments, links, bases, drafts, files };
}

function serializablePlan(plan: VaultArchiveRestorePlan): SerializableVaultRestorePlan {
  const { archive: _archive, ...result } = plan;
  return result;
}

async function withProjectQueue<T>(projectRoot: string, work: () => Promise<T> | T): Promise<T> {
  const previous = RESTORE_QUEUES.get(projectRoot) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveRelease) => {
    release = resolveRelease;
  });
  RESTORE_QUEUES.set(projectRoot, current);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (RESTORE_QUEUES.get(projectRoot) === current) RESTORE_QUEUES.delete(projectRoot);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function readLockOwner(path: string): RestoreLockOwner | null {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
    const ownerPath = join(path, 'owner.json');
    const ownerStat = lstatSync(ownerPath);
    if (ownerStat.isSymbolicLink() || !ownerStat.isFile() || ownerStat.size > 4096) return null;
    const value = JSON.parse(readFileSync(ownerPath, 'utf8')) as unknown;
    if (
      !isRecord(value) ||
      value.format !== 'koryphaios-vault-restore-lock' ||
      value.version !== 1 ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid as number) < 1 ||
      typeof value.token !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(value.token) ||
      !Number.isSafeInteger(value.startedAt) ||
      (value.startedAt as number) < 1
    ) {
      return null;
    }
    return value as unknown as RestoreLockOwner;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function acquireProjectLock(projectRoot: string): Promise<{
  owner: RestoreLockOwner;
  path: string;
}> {
  const internalDirectory = ensureSafeDirectory(projectRoot, INTERNAL_ROOT);
  const lockPath = containedTarget(projectRoot, LOCK_DIRECTORY);
  const owner: RestoreLockOwner = {
    format: 'koryphaios-vault-restore-lock',
    version: 1,
    pid: process.pid,
    token: randomUUID(),
    startedAt: Date.now(),
  };
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    const prepared = join(internalDirectory, `.vault-restore-lock-${process.pid}-${owner.token}`);
    try {
      mkdirSync(prepared, { mode: 0o700 });
      writeFileSync(join(prepared, 'owner.json'), JSON.stringify(owner), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      renameSync(prepared, lockPath);
      return { owner, path: lockPath };
    } catch (error: unknown) {
      if (existsSync(prepared)) rmSync(prepared, { recursive: true, force: true });
      const code = (error as NodeJS.ErrnoException).code;
      if (!['EEXIST', 'ENOTEMPTY', 'EACCES', 'EPERM'].includes(code ?? '')) throw error;
    }

    const current = readLockOwner(lockPath);
    // The process-local queue proves that a lock carrying this PID cannot
    // belong to another live operation in this process. A dead owner is the
    // normal post-crash case. Remove only the fixed internal lock directory.
    if (current && (current.pid === process.pid || !processIsAlive(current.pid))) {
      rmSync(lockPath, { recursive: true, force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      throw new ConflictError(
        current
          ? 'Another Koryphaios process is currently inspecting or restoring this vault.'
          : 'The vault restore lock is malformed; restore stopped without touching project data.',
      );
    }
    await delay(LOCK_POLL_MS);
  }
}

function releaseProjectLock(lock: { owner: RestoreLockOwner; path: string }): void {
  const current = readLockOwner(lock.path);
  if (current?.token === lock.owner.token && current.pid === lock.owner.pid) {
    rmSync(lock.path, { recursive: true, force: true });
  }
}

function journalPath(projectRoot: string, archiveSha256: string): string {
  return containedTarget(projectRoot, `${JOURNAL_DIRECTORY}/${archiveSha256}.json`);
}

function writeJournal(projectRoot: string, journal: RestoreJournal): string {
  const directory = ensureSafeDirectory(projectRoot, JOURNAL_DIRECTORY);
  const path = journalPath(projectRoot, journal.archiveSha256);
  const temp = join(directory, `.${journal.archiveSha256}.${process.pid}.tmp`);
  const encoded = JSON.stringify(journal);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_JOURNAL_BYTES) {
    throw new PayloadTooLargeError(`${MAX_JOURNAL_BYTES} restore-journal bytes`);
  }
  try {
    writeFileSync(temp, encoded, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
  return path;
}

function stageRestoreFiles(
  projectRoot: string,
  plan: VaultArchiveRestorePlan,
  files: RestoreFile[],
) {
  const stagingRoot = ensureSafeDirectory(projectRoot, STAGING_DIRECTORY);
  const stageDirectory = mkdtempSync(join(stagingRoot, `${plan.archiveSha256.slice(0, 16)}-`));
  chmodSync(stageDirectory, 0o700);
  const stagingRelative = relative(projectRoot, stageDirectory).split(sep).join('/');
  const journalFiles: RestoreJournalFile[] = [];
  try {
    for (const [index, file] of files.entries()) {
      containedTarget(projectRoot, file.targetRelative);
      assertSafeExistingParents(projectRoot, file.targetRelative);
      const stageRelative = String(index);
      const stagePath = join(stageDirectory, stageRelative);
      writeFileSync(stagePath, file.bytes, { mode: 0o600, flag: 'wx' });
      journalFiles.push({
        kind: file.kind,
        targetRelative: file.targetRelative,
        stageRelative,
        bytes: file.bytes.length,
        sha256: file.sha256,
        mode: file.mode,
        ...(file.mtimeMs !== undefined ? { mtimeMs: file.mtimeMs } : {}),
      });
    }
    const journal: RestoreJournal = {
      format: 'koryphaios-vault-restore-journal',
      version: 1,
      archiveSha256: plan.archiveSha256,
      manifestSha256: plan.manifestSha256,
      planToken: plan.planToken,
      projectRoot,
      stagingRelative,
      files: journalFiles,
    };
    const path = writeJournal(projectRoot, journal);
    return { journal, path, stageDirectory };
  } catch (error) {
    rmSync(stageDirectory, { recursive: true, force: true });
    throw error;
  }
}

function parseJournal(projectRoot: string, path: string): RestoreJournal {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_JOURNAL_BYTES) {
    throw new ConflictError(`Vault restore journal is unsafe: ${basename(path)}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new ConflictError(`Vault restore journal is malformed: ${basename(path)}`);
  }
  if (
    !isRecord(value) ||
    value.format !== 'koryphaios-vault-restore-journal' ||
    value.version !== 1 ||
    value.projectRoot !== projectRoot ||
    !Array.isArray(value.files)
  ) {
    throw new ConflictError(`Vault restore journal has an invalid identity: ${basename(path)}`);
  }
  const archiveSha256 = requireSha256(value.archiveSha256, 'Journal archive digest');
  if (basename(path) !== `${archiveSha256}.json`) {
    throw new ConflictError('Vault restore journal filename does not match its archive digest');
  }
  const stagingRelative = portableRelativePath(value.stagingRelative, 'Journal staging directory');
  if (!stagingRelative.startsWith(`${STAGING_DIRECTORY}/`)) {
    throw new ConflictError('Vault restore journal staging directory is outside internal storage');
  }
  const files = value.files.map((entry, index): RestoreJournalFile => {
    if (!isRecord(entry) || (entry.kind !== 'source' && entry.kind !== 'attachment')) {
      throw new ConflictError(`Vault restore journal file ${index} is invalid`);
    }
    const targetRelative = portableRelativePath(entry.targetRelative, 'Journal target');
    if (
      entry.kind === 'attachment' &&
      !targetRelative.startsWith(`${INTERNAL_ROOT}/attachments/`)
    ) {
      throw new ConflictError(
        'Vault restore attachment journal target is outside attachment storage',
      );
    }
    if (entry.kind === 'source' && targetRelative.startsWith(`${INTERNAL_ROOT}/`)) {
      throw new ConflictError('Vault restore source journal target is inside internal storage');
    }
    const mode = requireInteger(entry.mode, 'Journal file mode');
    if (mode !== 0o600) throw new ConflictError('Vault restore journal file mode is unsupported');
    return {
      kind: entry.kind,
      targetRelative,
      stageRelative: portableRelativePath(entry.stageRelative, 'Journal staged file'),
      bytes: requireInteger(entry.bytes, 'Journal file bytes'),
      sha256: requireSha256(entry.sha256, 'Journal file digest'),
      mode,
      ...(entry.mtimeMs === undefined
        ? {}
        : { mtimeMs: requireInteger(entry.mtimeMs, 'Journal file timestamp') }),
    };
  });
  return {
    format: 'koryphaios-vault-restore-journal',
    version: 1,
    archiveSha256,
    manifestSha256: requireSha256(value.manifestSha256, 'Journal manifest digest'),
    planToken: requireSha256(value.planToken, 'Journal plan token'),
    projectRoot,
    stagingRelative,
    files,
  };
}

function cleanRecoveredJournal(projectRoot: string, journal: RestoreJournal, path: string): void {
  const stageDirectory = containedTarget(projectRoot, journal.stagingRelative);
  rmSync(stageDirectory, { recursive: true, force: true });
  if (existsSync(path)) unlinkSync(path);
}

function recoverJournal(database: Database, projectRoot: string, path: string): void {
  const journal = parseJournal(projectRoot, path);
  const committed = database
    .query<
      { archive_sha256: string; manifest_sha256: string; plan_token: string },
      [string, string]
    >(
      `SELECT archive_sha256, manifest_sha256, plan_token FROM note_vault_restore_commits
       WHERE archive_sha256 = ? AND project_root = ?`,
    )
    .get(journal.archiveSha256, projectRoot);
  if (
    committed &&
    (committed.manifest_sha256 !== journal.manifestSha256 ||
      committed.plan_token !== journal.planToken)
  ) {
    throw new ConflictError('Vault restore journal does not match its durable commit witness.');
  }
  for (const file of journal.files) {
    const target = containedTarget(projectRoot, file.targetRelative);
    const stage = containedTarget(projectRoot, `${journal.stagingRelative}/${file.stageRelative}`);
    if (!existsSync(target)) {
      if (committed) {
        throw new ConflictError(
          `A committed vault restore is missing ${file.targetRelative}; recovery stopped.`,
        );
      }
      continue;
    }
    const stat = lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new ConflictError(`Vault restore recovery target is unsafe: ${file.targetRelative}`);
    }
    if (committed && (stat.size !== file.bytes || sha256File(target) !== file.sha256)) {
      throw new ConflictError(
        `Vault restore recovery found changed data at ${file.targetRelative}; it was not removed.`,
      );
    }
    if (!committed) {
      if (!existsSync(stage)) {
        throw new ConflictError(
          `Vault restore recovery cannot prove ownership of ${file.targetRelative}; it was not removed.`,
        );
      }
      const stageStat = lstatSync(stage);
      const installedByRestore =
        !stageStat.isSymbolicLink() &&
        stageStat.isFile() &&
        stageStat.dev === stat.dev &&
        stageStat.ino === stat.ino;
      if (installedByRestore) {
        if (stat.size !== file.bytes || sha256File(target) !== file.sha256) {
          throw new ConflictError(
            `Vault restore recovery found changed data at ${file.targetRelative}; it was not removed.`,
          );
        }
        unlinkSync(target);
      }
      // A different inode was created by somebody else after preview. It is
      // not ours, even if its bytes happen to match, and must be preserved.
    }
  }
  cleanRecoveredJournal(projectRoot, journal, path);
}

function recoverPendingJournals(database: Database, projectRoot: string): void {
  const directory = containedTarget(projectRoot, JOURNAL_DIRECTORY);
  if (!existsSync(directory)) return;
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new ConflictError('Vault restore journal directory is unsafe');
  }
  for (const entry of readdirSync(directory).sort()) {
    if (!entry.endsWith('.json')) continue;
    recoverJournal(database, projectRoot, join(directory, entry));
  }
}

function assertNoDatabaseConflicts(
  database: Database,
  projectRoot: string,
  principalId: string,
  model: RestoreModel,
  archiveSha256: string,
): void {
  if (
    database
      .query(
        `SELECT 1 FROM note_vault_restore_commits WHERE archive_sha256 = ? AND project_root = ?`,
      )
      .get(archiveSha256, projectRoot)
  ) {
    throw new ConflictError('This exact vault archive was already restored into the project.');
  }
  const conflict = (table: string, column: string, values: string[]): boolean => {
    if (values.length === 0) return false;
    const placeholders = values.map(() => '?').join(',');
    return !!database
      .query(`SELECT 1 FROM ${table} WHERE ${column} IN (${placeholders}) LIMIT 1`)
      .get(...values);
  };
  if (
    conflict(
      'notes',
      'id',
      model.notes.map((note) => note.id),
    )
  ) {
    throw new ConflictError('A target note id was created after vault preview.');
  }
  if (
    conflict(
      'note_attachments',
      'id',
      model.attachments.map((attachment) => attachment.id),
    )
  ) {
    throw new ConflictError('A target attachment id was created after vault preview.');
  }
  if (
    conflict(
      'note_bases',
      'id',
      model.bases.map((base) => base.id),
    )
  ) {
    throw new ConflictError('A target Base id was created after vault preview.');
  }
  if (
    conflict(
      'note_drafts',
      'id',
      model.drafts.map((draft) => draft.id),
    )
  ) {
    throw new ConflictError('A target recovery-draft id was created after vault preview.');
  }
  for (const base of model.bases) {
    if (
      database
        .query(
          `SELECT 1 FROM note_bases
           WHERE principal_id = ? AND project_root = ? AND lower(name) = lower(?) LIMIT 1`,
        )
        .get(principalId, projectRoot, base.name)
    ) {
      throw new ConflictError(`A Base named ${base.name} was created after vault preview.`);
    }
  }
  const baseCount =
    database
      .query<{ count: number }, [string, string]>(
        `SELECT COUNT(*) AS count FROM note_bases WHERE principal_id = ? AND project_root = ?`,
      )
      .get(principalId, projectRoot)?.count ?? 0;
  if (baseCount + model.bases.length > MAX_BASES_PER_PROJECT) {
    throw new ConflictError(`Vault restore would exceed the ${MAX_BASES_PER_PROJECT}-Base limit.`);
  }
  const projectDrafts = database
    .query<{ count: number; bytes: number }, [string, string]>(
      `SELECT COUNT(*) AS count, COALESCE(SUM(content_bytes), 0) AS bytes
       FROM note_drafts WHERE principal_id = ? AND project_root = ?`,
    )
    .get(principalId, projectRoot) ?? { count: 0, bytes: 0 };
  if (projectDrafts.count + model.drafts.length > NOTE_DRAFT_MAX_PER_PROJECT) {
    throw new ConflictError('Vault restore would exceed the project recovery-draft limit.');
  }
  const addedDraftBytes = model.drafts.reduce((total, draft) => total + draft.contentBytes, 0);
  if (projectDrafts.bytes + addedDraftBytes > NOTE_DRAFT_MAX_AGGREGATE_BYTES) {
    throw new ConflictError('Vault restore would exceed the recovery-draft storage budget.');
  }
  for (const [noteId, added] of new Map(
    model.drafts.map((draft) => [
      draft.noteId,
      model.drafts.filter((candidate) => candidate.noteId === draft.noteId).length,
    ]),
  )) {
    const current =
      database
        .query<{ count: number }, [string, string, string]>(
          `SELECT COUNT(*) AS count FROM note_drafts
           WHERE principal_id = ? AND project_root = ? AND note_id = ?`,
        )
        .get(principalId, projectRoot, noteId)?.count ?? 0;
    if (current + added > NOTE_DRAFT_MAX_PER_NOTE) {
      throw new ConflictError('Vault restore would exceed the per-note recovery-draft limit.');
    }
  }
  for (const file of model.files) {
    assertSafeExistingParents(projectRoot, file.targetRelative);
    const target = containedTarget(projectRoot, file.targetRelative);
    if (existsSync(target)) {
      throw new ConflictError(`Vault restore target now exists: ${file.targetRelative}`);
    }
  }
}

function installJournalFiles(projectRoot: string, journal: RestoreJournal): void {
  const stageDirectory = containedTarget(projectRoot, journal.stagingRelative);
  for (const file of journal.files) {
    const stagePath = containedTarget(
      projectRoot,
      `${journal.stagingRelative}/${file.stageRelative}`,
    );
    const stageStat = lstatSync(stagePath);
    if (stageStat.isSymbolicLink() || !stageStat.isFile() || stageStat.size !== file.bytes) {
      throw new ConflictError(`Vault restore staging file is unsafe: ${file.stageRelative}`);
    }
    if (sha256File(stagePath) !== file.sha256) {
      throw new ConflictError(`Vault restore staging file changed: ${file.stageRelative}`);
    }
    const targetParent = dirname(file.targetRelative).split(sep).join('/');
    if (targetParent !== '.') ensureSafeDirectory(projectRoot, targetParent);
    const target = containedTarget(projectRoot, file.targetRelative);
    // Staging is deliberately on the selected project filesystem. A hard link
    // gives both atomic no-clobber creation and an inode-level ownership
    // witness for post-crash rollback.
    linkSync(stagePath, target);
    chmodSync(target, file.mode);
    if (file.mtimeMs !== undefined) {
      const timestamp = new Date(file.mtimeMs);
      utimesSync(target, timestamp, timestamp);
    }
  }
  // Keep staged copies until the SQLite marker commits. They are cheap proof
  // for diagnosis, and recovery removes the directory in either outcome.
  void stageDirectory;
}

function insertRestoreRows(
  database: Database,
  plan: VaultArchiveRestorePlan,
  model: RestoreModel,
  principalId: string,
): VaultRestoreCommitCounts {
  for (const note of model.notes) {
    const userExists = note.userId
      ? !!database.query(`SELECT 1 FROM users WHERE id = ?`).get(note.userId)
      : false;
    database
      .query(
        `INSERT INTO notes (
          id, title, content, folder_path, tags, pinned, include_in_context,
          format, project_root, revision, trashed_at, trash_reason, user_id,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        note.id,
        note.title,
        note.content,
        note.folderPath,
        note.tagsJson,
        note.pinned,
        note.includeInContext,
        note.format,
        note.projectRoot,
        note.revision,
        note.trashedAt,
        note.trashReason,
        userExists ? note.userId : null,
        note.createdAt,
        note.updatedAt,
      );
  }
  for (const revision of model.revisions) {
    database
      .query(
        `INSERT INTO note_revisions (
          note_id, revision, project_root, operation, title, content, content_bytes,
          folder_path, tags, pinned, include_in_context, format, source_path,
          trashed_at, trash_reason, note_created_at, note_updated_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        revision.noteId,
        revision.revision,
        plan.projectRoot,
        revision.operation,
        revision.title,
        revision.content,
        revision.contentBytes,
        revision.folderPath,
        revision.tagsJson,
        revision.pinned,
        revision.includeInContext,
        revision.format,
        revision.sourcePath,
        revision.trashedAt,
        revision.trashReason,
        revision.noteCreatedAt,
        revision.noteUpdatedAt,
        revision.createdAt,
      );
  }
  for (const link of model.links) {
    database
      .query(`INSERT INTO note_links (from_note_id, to_note_id) VALUES (?, ?)`)
      .run(link.fromNoteId, link.toNoteId);
  }
  for (const attachment of model.attachments) {
    database
      .query(
        `INSERT INTO note_attachments
         (id, note_id, filename, mime_type, size, storage_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        attachment.id,
        attachment.noteId,
        attachment.filename,
        attachment.mimeType,
        attachment.size,
        attachment.storagePath,
        attachment.createdAt,
      );
  }
  for (const base of model.bases) {
    database
      .query(
        `INSERT INTO note_bases
         (id, principal_id, project_root, name, definition, revision, trashed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        base.id,
        principalId,
        plan.projectRoot,
        base.name,
        base.definition,
        base.revision,
        base.trashedAt,
        base.createdAt,
        base.updatedAt,
      );
    for (const revision of base.revisions) {
      database
        .query(
          `INSERT INTO note_base_revisions (
           base_id, revision, project_root, operation, name, definition,
           trashed_at, base_created_at, base_updated_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          revision.baseId,
          revision.revision,
          plan.projectRoot,
          revision.operation,
          revision.name,
          revision.definition,
          revision.trashedAt,
          revision.baseCreatedAt,
          revision.baseUpdatedAt,
          revision.createdAt,
        );
    }
  }
  for (const draft of model.drafts) {
    database
      .query(
        `INSERT INTO note_drafts (
          id, principal_id, project_root, note_id, base_revision, draft_revision,
          base_title, source_path_at_base, title, content, content_bytes,
          folder_path, tags, pinned, include_in_context, format, payload_hash,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        draft.id,
        principalId,
        plan.projectRoot,
        draft.noteId,
        draft.baseRevision,
        draft.draftRevision,
        draft.baseTitle,
        draft.sourcePathAtBase,
        draft.title,
        draft.content,
        draft.contentBytes,
        draft.folderPath,
        draft.tagsJson,
        draft.pinned,
        draft.includeInContext,
        draft.format,
        draft.payloadHash,
        draft.createdAt,
        draft.updatedAt,
      );
  }
  database
    .query(
      `INSERT INTO note_vault_restore_commits
       (archive_sha256, project_root, manifest_sha256, plan_token, committed_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(plan.archiveSha256, plan.projectRoot, plan.manifestSha256, plan.planToken, Date.now());
  return {
    restoredNotes: model.notes.length,
    restoredRevisions: model.revisions.length,
    restoredAttachments: model.attachments.length,
    restoredLinks: model.links.length,
    restoredBases: model.bases.length,
    restoredDrafts: model.drafts.length,
  };
}

export interface ProductionVaultRestoreAdapterOptions {
  legacyProjectRoot?: string;
}

/** Production restore boundary. SQLite rows and the commit witness are one
 * IMMEDIATE transaction; project-local source/attachment files are protected
 * by a durable journal and atomic no-clobber hard-link installation. */
export class ProductionVaultRestoreAdapter implements VaultRestoreAdapter {
  private readonly databaseProvider: () => Database;
  private readonly legacyProjectRoot: string;

  constructor(
    database: Database | (() => Database) = () => getDb(),
    options: ProductionVaultRestoreAdapterOptions = {},
  ) {
    this.databaseProvider = typeof database === 'function' ? database : () => database;
    this.legacyProjectRoot = resolve(options.legacyProjectRoot ?? PROJECT_ROOT);
  }

  async inspectProject(projectRoot: string): Promise<VaultProjectInventory> {
    const root = canonicalProjectRoot(projectRoot);
    return withProjectQueue(root, async () => {
      const lock = await acquireProjectLock(root);
      try {
        const database = this.databaseProvider();
        recoverPendingJournals(database, root);
        const allNoteRows = database
          .query<{ id: string; project_root: string | null }, []>(
            `SELECT id, project_root FROM notes`,
          )
          .all();
        const sourcePaths: string[] = [];
        const noteIds: string[] = [];
        for (const row of allNoteRows) {
          const identity = projectDocumentIdentity(row.id);
          const rowRoot =
            identity?.projectRoot ?? resolve(row.project_root || this.legacyProjectRoot);
          if (rowRoot === root && identity) sourcePaths.push(identity.sourcePath);
          // A project-document ID is deterministically re-keyed to the target
          // root. IDs from other projects are not collisions; the destination
          // source path plus the mapped-ID transaction check are authoritative.
          if (!identity || identity.projectRoot === root) noteIds.push(row.id);
        }
        return {
          noteIds,
          attachmentIds: database
            .query<{ id: string }, []>(`SELECT id FROM note_attachments`)
            .all()
            .map((row) => row.id),
          sourcePaths,
          baseIds: database
            .query<{ id: string }, []>(`SELECT id FROM note_bases`)
            .all()
            .map((row) => row.id),
          baseNames: database
            .query<{ name: string }, [string]>(`SELECT name FROM note_bases WHERE project_root = ?`)
            .all(root)
            .map((row) => row.name),
          draftIds: database
            .query<{ id: string }, []>(`SELECT id FROM note_drafts`)
            .all()
            .map((row) => row.id),
        };
      } finally {
        releaseProjectLock(lock);
      }
    });
  }

  async commitNoOverwriteAtomically(
    plan: Readonly<VaultArchiveRestorePlan>,
  ): Promise<VaultRestoreCommitCounts> {
    const root = canonicalProjectRoot(plan.projectRoot);
    if (root !== plan.projectRoot) throw new ConflictError('Vault restore project root changed');
    return withProjectQueue(root, async () => {
      const lock = await acquireProjectLock(root);
      try {
        const database = this.databaseProvider();
        recoverPendingJournals(database, root);
        const model = buildRestoreModel(plan);
        const principalId = getLocalNotesPrincipalId(database);
        const staged = stageRestoreFiles(root, plan as VaultArchiveRestorePlan, model.files);
        let counts: VaultRestoreCommitCounts;
        try {
          const transaction = database.transaction(() => {
            assertNoDatabaseConflicts(database, root, principalId, model, plan.archiveSha256);
            installJournalFiles(root, staged.journal);
            return insertRestoreRows(database, plan as VaultArchiveRestorePlan, model, principalId);
          });
          counts = transaction.immediate();
        } catch (error) {
          try {
            recoverJournal(database, root, staged.path);
          } catch (recoveryError) {
            throw new ConflictError(
              'Vault restore stopped and automatic rollback needs attention; recovery data was preserved.',
              {
                restoreError: error instanceof Error ? error.message : String(error),
                recoveryError:
                  recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
                journal: relative(root, staged.path),
              },
            );
          }
          throw error;
        }
        // The commit witness is durable. Cleanup is now housekeeping; if it is
        // interrupted, the next inventory pass validates the witness and file
        // hashes before removing the retained journal.
        try {
          cleanRecoveredJournal(root, staged.journal, staged.path);
        } catch {
          // Retain the journal for deterministic recovery on the next pass.
        }
        invalidateNotesCache();
        return counts;
      } finally {
        releaseProjectLock(lock);
      }
    });
  }
}

/** Production singleton follows database reopen in tests and backend restarts. */
export const vaultRestoreAdapter = new ProductionVaultRestoreAdapter(() => getDb());

export async function previewVaultRestore(
  input: VaultArchiveInput,
  projectRoot = PROJECT_ROOT,
): Promise<SerializableVaultRestorePlan> {
  const inventory = await vaultRestoreAdapter.inspectProject(projectRoot);
  const plan = await previewVaultArchiveRestore(input, { projectRoot, inventory });
  // Preview means the exact archive is executable by the production adapter,
  // not merely that its tar/checksums are well formed. This also fails closed
  // on future generic `files` entries until they have an explicit destination
  // contract, so the UI cannot call a lossy archive safe to restore.
  buildRestoreModel(plan);
  return serializablePlan(plan);
}

export async function commitVaultRestore(
  input: VaultArchiveInput,
  projectRoot: string,
  expectedArchiveSha256: string,
): Promise<VaultArchiveRestoreResult> {
  return restoreVaultArchive(input, {
    projectRoot,
    expectedArchiveSha256,
    adapter: vaultRestoreAdapter,
  });
}
