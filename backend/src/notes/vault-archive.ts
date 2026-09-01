import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { ConflictError, PayloadTooLargeError, ValidationError } from '../errors/types';

const TAR_BLOCK_BYTES = 512;
const TAR_END_BYTES = TAR_BLOCK_BYTES * 2;
const MANIFEST_PATH = 'manifest.json';
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const WINDOWS_DRIVE_PATTERN = /^[a-zA-Z]:/;

export interface VaultArchiveLimits {
  maxArchiveBytes: number;
  maxEntryBytes: number;
  maxEntries: number;
  maxManifestBytes: number;
  maxNotes: number;
  maxRevisions: number;
  maxAttachments: number;
  maxLinks: number;
  maxBases: number;
  maxDrafts: number;
  maxInventoryItems: number;
}

/** Bounded defaults for an explicitly uploaded, in-memory restore archive.
 * Callers may lower these limits for an HTTP route, but never disable them. */
export const DEFAULT_VAULT_ARCHIVE_LIMITS: Readonly<VaultArchiveLimits> = Object.freeze({
  maxArchiveBytes: 1024 * 1024 * 1024,
  maxEntryBytes: 256 * 1024 * 1024,
  maxEntries: 250_000,
  maxManifestBytes: 64 * 1024 * 1024,
  maxNotes: 100_000,
  maxRevisions: 150_000,
  maxAttachments: 100_000,
  maxLinks: 1_000_000,
  maxBases: 10_000,
  maxDrafts: 100_000,
  maxInventoryItems: 1_000_000,
});

export type VaultArchiveInput = Blob | Buffer | Uint8Array | ArrayBuffer;

export interface VaultPayloadDescriptor {
  path: string;
  bytes: number;
  sha256: string;
  kind: 'note' | 'revision' | 'attachment' | 'base' | 'draft' | 'file';
  ownerId: string;
}

export interface VaultArchiveManifest {
  format: 'koryphaios-notes-vault';
  version: 1 | 2;
  project: { name: string; [key: string]: unknown };
  notes: Array<Record<string, unknown>>;
  revisions: Array<Record<string, unknown>>;
  attachments: Array<Record<string, unknown>>;
  links: Array<Record<string, unknown>>;
  bases: Array<Record<string, unknown>>;
  drafts: Array<Record<string, unknown>>;
  files: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

/** A fully checked archive. Entry buffers are private and returned by copy so
 * consumers cannot mutate bytes after integrity validation. */
export class ParsedVaultArchive {
  readonly archiveSha256: string;
  readonly manifestSha256: string;
  readonly manifest: VaultArchiveManifest;
  readonly payloads: ReadonlyArray<VaultPayloadDescriptor>;
  readonly entryPaths: ReadonlyArray<string>;
  readonly archiveBytes: number;
  readonly manifestBytes: number;
  readonly #entries: ReadonlyMap<string, Buffer>;

  constructor(input: {
    archiveSha256: string;
    manifestSha256: string;
    manifest: VaultArchiveManifest;
    payloads: VaultPayloadDescriptor[];
    entries: Map<string, Buffer>;
    archiveBytes: number;
    manifestBytes: number;
  }) {
    this.archiveSha256 = input.archiveSha256;
    this.manifestSha256 = input.manifestSha256;
    this.manifest = deepFreezeJson(input.manifest);
    this.payloads = Object.freeze(input.payloads.map((payload) => Object.freeze({ ...payload })));
    this.entryPaths = Object.freeze([...input.entries.keys()].sort(stableStringCompare));
    this.archiveBytes = input.archiveBytes;
    this.manifestBytes = input.manifestBytes;
    this.#entries = input.entries;
    Object.freeze(this);
  }

  readEntry(path: string): Buffer {
    const entry = this.#entries.get(path);
    if (!entry) throw new ValidationError(`Archive entry is not available: ${path}`);
    return Buffer.from(entry);
  }
}

export type VaultRestoreConflictKind =
  'source_exists' | 'note_id_exists' | 'attachment_exists' | 'base_name_exists' | 'archive_invalid';

export interface VaultRestoreConflict {
  kind: VaultRestoreConflictKind;
  archiveId?: string;
  path?: string;
  message: string;
}

export interface VaultProjectInventory {
  noteIds?: Iterable<string>;
  attachmentIds?: Iterable<string>;
  sourcePaths?: Iterable<string>;
  baseIds?: Iterable<string>;
  baseNames?: Iterable<string>;
  draftIds?: Iterable<string>;
}

export interface VaultArchiveRestorePlan {
  format: 'koryphaios-notes-vault';
  archiveVersion: 1 | 2;
  projectName: string;
  archiveSha256: string;
  manifestSha256: string;
  projectRoot: string;
  notes: number;
  revisions: number;
  attachments: number;
  links: number;
  bases: number;
  drafts: number;
  noOpNotes: number;
  conflicts: VaultRestoreConflict[];
  canRestore: boolean;
  mode: 'safe-merge';
  planToken: string;
  archive: ParsedVaultArchive;
}

export interface VaultRestoreCommitCounts {
  restoredNotes: number;
  restoredRevisions: number;
  restoredAttachments: number;
  restoredLinks: number;
  restoredBases: number;
  restoredDrafts: number;
}

export interface VaultArchiveRestoreResult
  extends Omit<VaultArchiveRestorePlan, 'archive'>, VaultRestoreCommitCounts {}

export interface VaultRestoreAdapter {
  /** Must inspect only the normalized project root supplied by this module. */
  inspectProject(projectRoot: string): Promise<VaultProjectInventory> | VaultProjectInventory;
  /** Must perform one atomic transaction and use insert/no-clobber semantics.
   * A race that introduces any duplicate must reject the whole transaction. */
  commitNoOverwriteAtomically(
    plan: Readonly<VaultArchiveRestorePlan>,
  ): Promise<VaultRestoreCommitCounts>;
}

export interface ParseVaultArchiveOptions {
  limits?: Partial<VaultArchiveLimits>;
  /** Optional out-of-band digest, such as the digest returned by preview. */
  expectedArchiveSha256?: string;
}

export interface PreviewVaultArchiveOptions extends ParseVaultArchiveOptions {
  projectRoot: string;
  inventory?: VaultProjectInventory;
}

export interface RestoreVaultArchiveOptions extends Omit<
  ParseVaultArchiveOptions,
  'expectedArchiveSha256'
> {
  projectRoot: string;
  /** Binds restore to the exact bytes that were previewed. */
  expectedArchiveSha256: string;
  adapter: VaultRestoreAdapter;
}

function stableStringCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function deepFreezeJson<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreezeJson(child);
  return Object.freeze(value);
}

function checkedLimit(value: number, name: keyof VaultArchiveLimits): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ValidationError(`Vault archive limit ${name} must be a non-negative integer`);
  }
  return value;
}

function resolveLimits(overrides?: Partial<VaultArchiveLimits>): VaultArchiveLimits {
  const limits = { ...DEFAULT_VAULT_ARCHIVE_LIMITS, ...overrides };
  for (const name of Object.keys(DEFAULT_VAULT_ARCHIVE_LIMITS) as Array<keyof VaultArchiveLimits>) {
    limits[name] = checkedLimit(limits[name], name);
  }
  return limits;
}

async function inputToBuffer(input: VaultArchiveInput, maxBytes: number): Promise<Buffer> {
  if (input instanceof ArrayBuffer) {
    if (input.byteLength > maxBytes) throwArchiveTooLarge(maxBytes, input.byteLength);
    return Buffer.from(new Uint8Array(input));
  }
  if (ArrayBuffer.isView(input)) {
    if (input.byteLength > maxBytes) throwArchiveTooLarge(maxBytes, input.byteLength);
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength).subarray().slice();
  }
  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    if (input.size > maxBytes) throwArchiveTooLarge(maxBytes, input.size);
    return Buffer.from(await input.arrayBuffer());
  }
  throw new ValidationError(
    'Vault archive must be provided as a File, Blob, Buffer, or byte array',
  );
}

function throwArchiveTooLarge(maxBytes: number, actualBytes: number): never {
  throw new PayloadTooLargeError(`${maxBytes} bytes`, { maxBytes, actualBytes });
}

function everyByteIsZero(bytes: Uint8Array): boolean {
  for (const byte of bytes) if (byte !== 0) return false;
  return true;
}

function decodeTarText(field: Buffer, label: string): string {
  const nul = field.indexOf(0);
  const end = nul === -1 ? field.length : nul;
  if (nul !== -1 && !everyByteIsZero(field.subarray(nul))) {
    throw new ValidationError(`Malformed ustar ${label} field`);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(field.subarray(0, end));
  } catch {
    throw new ValidationError(`Malformed UTF-8 in ustar ${label} field`);
  }
}

function parseTarOctal(field: Buffer, label: string): number {
  let end = field.length;
  while (end > 0 && (field[end - 1] === 0 || field[end - 1] === 0x20)) end -= 1;
  if (end === 0) throw new ValidationError(`Malformed ustar ${label}: empty octal field`);
  for (let index = 0; index < end; index += 1) {
    if (field[index] < 0x30 || field[index] > 0x37) {
      throw new ValidationError(`Malformed ustar ${label}: expected octal digits`);
    }
  }
  for (let index = end; index < field.length; index += 1) {
    if (field[index] !== 0 && field[index] !== 0x20) {
      throw new ValidationError(`Malformed ustar ${label} terminator`);
    }
  }
  const parsed = Number.parseInt(field.subarray(0, end).toString('latin1'), 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ValidationError(`Malformed ustar ${label}: value is out of range`);
  }
  return parsed;
}

function validateArchivePath(path: string, label = 'entry path', maxLength = 255): string {
  if (!path || path.length > maxLength || CONTROL_CHARACTER_PATTERN.test(path)) {
    throw new ValidationError(`Invalid vault ${label}`);
  }
  if (path.includes('\\') || path.startsWith('/') || WINDOWS_DRIVE_PATTERN.test(path)) {
    throw new ValidationError(`Vault ${label} must be a portable relative path: ${path}`);
  }
  const segments = path.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new ValidationError(`Vault ${label} contains an unsafe path segment: ${path}`);
  }
  return path;
}

function pathCollisionKey(path: string): string {
  return path.normalize('NFKC').toLocaleLowerCase('en-US');
}

function parseTarEntries(buffer: Buffer, limits: VaultArchiveLimits): Map<string, Buffer> {
  if (buffer.length < TAR_END_BYTES || buffer.length % TAR_BLOCK_BYTES !== 0) {
    throw new ValidationError('Vault archive is not a complete block-aligned ustar file');
  }
  const entries = new Map<string, Buffer>();
  const collisionKeys = new Set<string>();
  let offset = 0;
  let sawEnd = false;
  while (offset + TAR_BLOCK_BYTES <= buffer.length) {
    const header = buffer.subarray(offset, offset + TAR_BLOCK_BYTES);
    if (everyByteIsZero(header)) {
      const remaining = buffer.subarray(offset);
      if (remaining.length !== TAR_END_BYTES || !everyByteIsZero(remaining)) {
        throw new ValidationError('Vault archive has non-canonical data after its end marker');
      }
      sawEnd = true;
      break;
    }
    if (entries.size >= limits.maxEntries) {
      throw new PayloadTooLargeError(`${limits.maxEntries} archive entries`, {
        maxEntries: limits.maxEntries,
      });
    }
    const magic = header.subarray(257, 263).toString('binary');
    const version = header.subarray(263, 265).toString('binary');
    if (magic !== 'ustar\0' || version !== '00') {
      throw new ValidationError('Vault archive entry is not deterministic ustar');
    }
    const declaredChecksum = parseTarOctal(header.subarray(148, 156), 'checksum');
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    const actualChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
    if (actualChecksum !== declaredChecksum) {
      throw new ValidationError('Vault archive header checksum mismatch');
    }
    const typeFlag = header[156];
    if (typeFlag !== 0 && typeFlag !== 0x30) {
      throw new ValidationError('Vault archive contains a non-regular entry');
    }
    if (decodeTarText(header.subarray(157, 257), 'link name')) {
      throw new ValidationError('Vault archive regular entry unexpectedly has a link target');
    }
    const name = decodeTarText(header.subarray(0, 100), 'name');
    const prefix = decodeTarText(header.subarray(345, 500), 'prefix');
    const path = validateArchivePath(prefix ? `${prefix}/${name}` : name);
    const collisionKey = pathCollisionKey(path);
    if (entries.has(path) || collisionKeys.has(collisionKey)) {
      throw new ValidationError(`Vault archive contains a duplicate entry: ${path}`);
    }
    const size = parseTarOctal(header.subarray(124, 136), 'size');
    if (size > limits.maxEntryBytes) {
      throw new PayloadTooLargeError(`${limits.maxEntryBytes} bytes per archive entry`, {
        path,
        maxEntryBytes: limits.maxEntryBytes,
        actualBytes: size,
      });
    }
    const dataStart = offset + TAR_BLOCK_BYTES;
    const paddedSize = Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
    const nextOffset = dataStart + paddedSize;
    if (!Number.isSafeInteger(nextOffset) || nextOffset > buffer.length - TAR_END_BYTES) {
      throw new ValidationError(`Vault archive entry is truncated: ${path}`);
    }
    const padding = buffer.subarray(dataStart + size, nextOffset);
    if (!everyByteIsZero(padding)) {
      throw new ValidationError(`Vault archive entry has non-canonical padding: ${path}`);
    }
    entries.set(path, Buffer.from(buffer.subarray(dataStart, dataStart + size)));
    collisionKeys.add(collisionKey);
    offset = nextOffset;
  }
  if (!sawEnd) throw new ValidationError('Vault archive is missing its ustar end marker');
  return entries;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
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
    throw new ValidationError(`${label} must be a valid string`);
  }
  return value;
}

function requireId(value: unknown, label: string): string {
  const id = requireString(value, label, { max: 512 });
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:@-]*$/.test(id)) {
    throw new ValidationError(`${label} contains unsupported characters`);
  }
  return id;
}

function requireInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new ValidationError(`${label} must be an integer of at least ${minimum}`);
  }
  return value as number;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new ValidationError(`${label} must be a boolean`);
  return value;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 100_000) {
    throw new ValidationError(`${label} must be a bounded string array`);
  }
  return value.map((entry, index) => requireString(entry, `${label}[${index}]`, { max: 4096 }));
}

function requireDateString(value: unknown, label: string, nullable = false): string | null {
  if (nullable && value === null) return null;
  const date = requireString(value, label, { max: 64 });
  if (!Number.isFinite(Date.parse(date))) throw new ValidationError(`${label} is not a valid date`);
  return date;
}

function requireArray(
  value: unknown,
  label: string,
  max: number,
  optional = false,
): Array<Record<string, unknown>> {
  if (optional && value === undefined) return [];
  if (!Array.isArray(value)) throw new ValidationError(`${label} must be an array`);
  if (value.length > max) {
    throw new PayloadTooLargeError(`${max} ${label}`, { max, actual: value.length });
  }
  return value.map((entry, index) => requireRecord(entry, `${label}[${index}]`));
}

function requireSha256(value: unknown, label: string): string {
  const digest = requireString(value, label, { max: 64 });
  if (!SHA256_PATTERN.test(digest)) throw new ValidationError(`${label} must be a SHA-256 digest`);
  return digest.toLowerCase();
}

function optionalString(value: unknown, label: string, max = 4096): string | null {
  if (value === undefined || value === null) return null;
  return requireString(value, label, { max, allowEmpty: true });
}

function requireControlFreeString(value: unknown, label: string, max: number): string {
  const result = requireString(value, label, { max, allowEmpty: true });
  if (CONTROL_CHARACTER_PATTERN.test(result)) {
    throw new ValidationError(`${label} contains control characters`);
  }
  return result;
}

function validateSourcePath(value: unknown, label: string, format: string): string | null {
  if (value === undefined || value === null) return null;
  const path = validateArchivePath(requireString(value, label, { max: 4096 }), 'source path', 4096);
  const extension = extname(path).toLowerCase();
  const allowed = format === 'html' ? new Set(['.html', '.htm']) : new Set(['.md', '.markdown']);
  if (!allowed.has(extension)) {
    throw new ValidationError(`${label} extension does not match note format`);
  }
  return path;
}

function descriptorFromRecord(
  record: Record<string, unknown>,
  kind: VaultPayloadDescriptor['kind'],
  ownerId: string,
  fields: { path: string; bytes: string; sha256: string },
): VaultPayloadDescriptor {
  return {
    path: validateArchivePath(requireString(record[fields.path], `${kind} payload path`)),
    bytes: requireInteger(record[fields.bytes], `${kind} payload bytes`),
    sha256: requireSha256(record[fields.sha256], `${kind} payload sha256`),
    kind,
    ownerId,
  };
}

function optionalDescriptorFromRecord(
  record: Record<string, unknown>,
  kind: 'base' | 'draft',
  ownerId: string,
): VaultPayloadDescriptor | null {
  const candidates = [
    { path: 'contentPath', bytes: 'contentBytes', sha256: 'contentSha256' },
    { path: 'definitionPath', bytes: 'definitionBytes', sha256: 'definitionSha256' },
    { path: 'path', bytes: 'size', sha256: 'sha256' },
  ];
  for (const fields of candidates) {
    const present = [record[fields.path], record[fields.bytes], record[fields.sha256]].filter(
      (value) => value !== undefined,
    ).length;
    if (present === 0) continue;
    if (present !== 3) throw new ValidationError(`${kind} payload declaration is incomplete`);
    return descriptorFromRecord(record, kind, ownerId, fields);
  }
  return null;
}

function validateCommonNoteMetadata(record: Record<string, unknown>, label: string): string {
  const id = requireId(record.id, `${label}.id`);
  requireString(record.title, `${label}.title`, { max: 1024 * 1024, allowEmpty: true });
  requireString(record.folderPath, `${label}.folderPath`, { max: 4096, allowEmpty: true });
  requireStringArray(record.tags, `${label}.tags`);
  if (record.internalTags !== undefined)
    requireStringArray(record.internalTags, `${label}.internalTags`);
  requireBoolean(record.pinned, `${label}.pinned`);
  requireBoolean(record.includeInContext, `${label}.includeInContext`);
  const format = requireString(record.format, `${label}.format`, { max: 16 });
  if (format !== 'markdown' && format !== 'html') {
    throw new ValidationError(`${label}.format is unsupported`);
  }
  validateSourcePath(record.sourcePath, `${label}.sourcePath`, format);
  return id;
}

function validateManifest(
  raw: unknown,
  entries: Map<string, Buffer>,
  limits: VaultArchiveLimits,
): { manifest: VaultArchiveManifest; payloads: VaultPayloadDescriptor[] } {
  const root = requireRecord(raw, 'Vault manifest');
  if (root.format !== 'koryphaios-notes-vault') {
    throw new ValidationError('Unsupported vault archive format');
  }
  if (root.version !== 1 && root.version !== 2) {
    throw new ValidationError('Unsupported vault archive version');
  }
  const project = requireRecord(root.project, 'Vault manifest project');
  requireControlFreeString(project.name, 'Vault manifest project name', 512);
  const notes = requireArray(root.notes, 'notes', limits.maxNotes);
  const revisions = requireArray(root.revisions, 'revisions', limits.maxRevisions);
  const attachments = requireArray(root.attachments, 'attachments', limits.maxAttachments);
  const links = requireArray(root.links, 'links', limits.maxLinks);
  const bases = requireArray(root.bases, 'bases', limits.maxBases, true);
  const drafts = requireArray(root.drafts, 'drafts', limits.maxDrafts, true);
  const files = requireArray(root.files, 'files', limits.maxEntries, true);
  if (root.version === 1 && (bases.length || drafts.length || files.length)) {
    throw new ValidationError('Vault archive v1 cannot contain v2 workspace sections');
  }

  const payloads: VaultPayloadDescriptor[] = [];
  const noteIds = new Set<string>();
  const noteRevisions = new Map<string, number>();
  const noteContentDigests = new Map<string, string>();
  const sourcePaths = new Set<string>();
  for (const [index, note] of notes.entries()) {
    const label = `notes[${index}]`;
    const id = validateCommonNoteMetadata(note, label);
    if (noteIds.has(id)) throw new ValidationError(`Duplicate note id in vault manifest: ${id}`);
    noteIds.add(id);
    const revision = requireInteger(note.revision, `${label}.revision`, 1);
    noteRevisions.set(id, revision);
    optionalString(note.userId, `${label}.userId`, 512);
    requireDateString(note.createdAt, `${label}.createdAt`);
    requireDateString(note.updatedAt, `${label}.updatedAt`);
    requireDateString(note.trashedAt, `${label}.trashedAt`, true);
    if (note.trashReason !== undefined && note.trashReason !== null) {
      const reason = requireString(note.trashReason, `${label}.trashReason`, { max: 64 });
      if (reason !== 'user' && reason !== 'source_removed') {
        throw new ValidationError(`${label}.trashReason is unsupported`);
      }
    }
    const sourcePath = note.sourcePath as string | null | undefined;
    if (sourcePath) {
      const collision = pathCollisionKey(sourcePath);
      if (sourcePaths.has(collision)) {
        throw new ValidationError(`Duplicate project source path in vault manifest: ${sourcePath}`);
      }
      sourcePaths.add(collision);
    }
    const descriptor = descriptorFromRecord(note, 'note', id, {
      path: 'contentPath',
      bytes: 'contentBytes',
      sha256: 'contentSha256',
    });
    payloads.push(descriptor);
    noteContentDigests.set(id, descriptor.sha256);
  }

  const revisionKeys = new Set<string>();
  const currentRevisionDigests = new Map<string, string>();
  for (const [index, revision] of revisions.entries()) {
    const label = `revisions[${index}]`;
    const noteId = requireId(revision.noteId, `${label}.noteId`);
    if (!noteIds.has(noteId)) {
      throw new ValidationError(`${label} refers to a note outside the archive`);
    }
    requireString(revision.operation, `${label}.operation`, { max: 64 });
    requireString(revision.title, `${label}.title`, { max: 1024 * 1024, allowEmpty: true });
    requireString(revision.folderPath, `${label}.folderPath`, { max: 4096, allowEmpty: true });
    requireStringArray(revision.tags, `${label}.tags`);
    if (revision.internalTags !== undefined) {
      requireStringArray(revision.internalTags, `${label}.internalTags`);
    }
    requireBoolean(revision.pinned, `${label}.pinned`);
    requireBoolean(revision.includeInContext, `${label}.includeInContext`);
    const format = requireString(revision.format, `${label}.format`, { max: 16 });
    if (format !== 'markdown' && format !== 'html') {
      throw new ValidationError(`${label}.format is unsupported`);
    }
    validateSourcePath(revision.sourcePath, `${label}.sourcePath`, format);
    requireDateString(revision.noteCreatedAt, `${label}.noteCreatedAt`);
    requireDateString(revision.noteUpdatedAt, `${label}.noteUpdatedAt`);
    requireDateString(revision.createdAt, `${label}.createdAt`);
    requireDateString(revision.trashedAt, `${label}.trashedAt`, true);
    const revisionNumber = requireInteger(revision.revision, `${label}.revision`, 1);
    const key = `${noteId}\0${revisionNumber}`;
    if (revisionKeys.has(key)) {
      throw new ValidationError(
        `Duplicate note revision in vault manifest: ${noteId}@${revisionNumber}`,
      );
    }
    revisionKeys.add(key);
    if (revisionNumber > (noteRevisions.get(noteId) ?? 0)) {
      throw new ValidationError(`Revision ${noteId}@${revisionNumber} is newer than its note row`);
    }
    const descriptor = descriptorFromRecord(revision, 'revision', `${noteId}@${revisionNumber}`, {
      path: 'contentPath',
      bytes: 'contentBytes',
      sha256: 'contentSha256',
    });
    payloads.push(descriptor);
    if (revisionNumber === noteRevisions.get(noteId)) {
      currentRevisionDigests.set(noteId, descriptor.sha256);
    }
  }
  for (const noteId of noteIds) {
    if (!currentRevisionDigests.has(noteId)) {
      throw new ValidationError(`Vault note is missing its current immutable revision: ${noteId}`);
    }
    if (currentRevisionDigests.get(noteId) !== noteContentDigests.get(noteId)) {
      throw new ValidationError(
        `Vault note does not match its current immutable revision: ${noteId}`,
      );
    }
  }

  const attachmentIds = new Set<string>();
  for (const [index, attachment] of attachments.entries()) {
    const label = `attachments[${index}]`;
    const id = requireId(attachment.id, `${label}.id`);
    if (attachmentIds.has(id)) {
      throw new ValidationError(`Duplicate attachment id in vault manifest: ${id}`);
    }
    attachmentIds.add(id);
    const noteId = requireId(attachment.noteId, `${label}.noteId`);
    if (!noteIds.has(noteId)) throw new ValidationError(`${label} refers to an unknown note`);
    const filename = requireControlFreeString(attachment.filename, `${label}.filename`, 4096);
    if (!filename || filename.includes('/') || filename.includes('\\')) {
      throw new ValidationError(`${label}.filename must be a plain filename`);
    }
    requireControlFreeString(attachment.mimeType, `${label}.mimeType`, 512);
    requireDateString(attachment.createdAt, `${label}.createdAt`);
    payloads.push(
      descriptorFromRecord(attachment, 'attachment', id, {
        path: 'path',
        bytes: 'size',
        sha256: 'sha256',
      }),
    );
  }

  const linkKeys = new Set<string>();
  for (const [index, link] of links.entries()) {
    const from = requireId(link.fromNoteId, `links[${index}].fromNoteId`);
    const to = requireId(link.toNoteId, `links[${index}].toNoteId`);
    if (!noteIds.has(from) || !noteIds.has(to)) {
      throw new ValidationError(`links[${index}] refers to a note outside the archive`);
    }
    const key = `${from}\0${to}`;
    if (linkKeys.has(key)) throw new ValidationError(`Duplicate vault link: ${from} -> ${to}`);
    linkKeys.add(key);
  }

  const baseIds = new Set<string>();
  const baseNames = new Set<string>();
  for (const [index, base] of bases.entries()) {
    const id = requireId(base.id, `bases[${index}].id`);
    const name = requireControlFreeString(base.name, `bases[${index}].name`, 1024);
    if (baseIds.has(id) || baseNames.has(pathCollisionKey(name))) {
      throw new ValidationError(`Duplicate base id or name in vault manifest: ${id}`);
    }
    baseIds.add(id);
    baseNames.add(pathCollisionKey(name));
    const descriptor = optionalDescriptorFromRecord(base, 'base', id);
    if (descriptor) payloads.push(descriptor);
  }

  const draftIds = new Set<string>();
  for (const [index, draft] of drafts.entries()) {
    const id = requireId(draft.id, `drafts[${index}].id`);
    if (draftIds.has(id)) throw new ValidationError(`Duplicate draft id in vault manifest: ${id}`);
    draftIds.add(id);
    // Drafts deliberately outlive authoritative notes. An unknown noteId is a
    // valid orphan recovery branch and must remain portable rather than being
    // silently omitted from a whole-vault backup.
    requireId(draft.noteId, `drafts[${index}].noteId`);
    const descriptor = optionalDescriptorFromRecord(draft, 'draft', id);
    if (!descriptor)
      throw new ValidationError(`drafts[${index}] is missing its payload declaration`);
    payloads.push(descriptor);
  }

  const fileIds = new Set<string>();
  for (const [index, file] of files.entries()) {
    const id = requireId(file.id ?? `file-${index}`, `files[${index}].id`);
    if (fileIds.has(id)) throw new ValidationError(`Duplicate extra file id: ${id}`);
    fileIds.add(id);
    payloads.push(
      descriptorFromRecord(file, 'file', id, {
        path: 'path',
        bytes: 'size',
        sha256: 'sha256',
      }),
    );
  }

  const declaredPaths = new Set<string>();
  const declaredCollisionKeys = new Set<string>();
  for (const payload of payloads) {
    if (payload.path === MANIFEST_PATH) {
      throw new ValidationError('Vault manifest cannot declare itself as payload data');
    }
    const collision = pathCollisionKey(payload.path);
    if (declaredPaths.has(payload.path) || declaredCollisionKeys.has(collision)) {
      throw new ValidationError(`Vault payload path is declared more than once: ${payload.path}`);
    }
    declaredPaths.add(payload.path);
    declaredCollisionKeys.add(collision);
    const bytes = entries.get(payload.path);
    if (!bytes) throw new ValidationError(`Vault payload is missing: ${payload.path}`);
    if (bytes.length !== payload.bytes) {
      throw new ValidationError(`Vault payload byte count mismatch: ${payload.path}`);
    }
    if (sha256(bytes) !== payload.sha256) {
      throw new ValidationError(`Vault payload SHA-256 mismatch: ${payload.path}`);
    }
    if (payload.kind === 'note' || payload.kind === 'revision' || payload.kind === 'draft') {
      try {
        const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (content.includes('\0')) throw new Error('nul');
      } catch {
        throw new ValidationError(`Vault text payload is not valid UTF-8: ${payload.path}`);
      }
    }
  }
  for (const path of entries.keys()) {
    if (path !== MANIFEST_PATH && !declaredPaths.has(path)) {
      throw new ValidationError(`Vault archive contains an undeclared entry: ${path}`);
    }
  }

  const manifest: VaultArchiveManifest = {
    ...root,
    format: 'koryphaios-notes-vault',
    version: root.version,
    project: project as VaultArchiveManifest['project'],
    notes,
    revisions,
    attachments,
    links,
    bases,
    drafts,
    files,
  };
  return { manifest, payloads };
}

function validateExpectedArchiveSha256(actual: string, expected?: string): void {
  if (expected === undefined) return;
  const normalized = requireSha256(expected, 'Expected archive SHA-256');
  if (normalized !== actual) {
    throw new ConflictError('Vault archive does not match the bytes that were previewed.', {
      expectedArchiveSha256: normalized,
      actualArchiveSha256: actual,
    });
  }
}

export async function parseVaultArchive(
  input: VaultArchiveInput,
  options: ParseVaultArchiveOptions = {},
): Promise<ParsedVaultArchive> {
  const limits = resolveLimits(options.limits);
  const buffer = await inputToBuffer(input, limits.maxArchiveBytes);
  const archiveSha256 = sha256(buffer);
  validateExpectedArchiveSha256(archiveSha256, options.expectedArchiveSha256);
  const entries = parseTarEntries(buffer, limits);
  const manifestBytes = entries.get(MANIFEST_PATH);
  if (!manifestBytes) throw new ValidationError('Vault archive is missing manifest.json');
  if (manifestBytes.length > limits.maxManifestBytes) {
    throw new PayloadTooLargeError(`${limits.maxManifestBytes} manifest bytes`, {
      maxManifestBytes: limits.maxManifestBytes,
      actualBytes: manifestBytes.length,
    });
  }
  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
  } catch {
    throw new ValidationError('Vault manifest is not valid UTF-8 JSON');
  }
  const { manifest, payloads } = validateManifest(rawManifest, entries, limits);
  return new ParsedVaultArchive({
    archiveSha256,
    manifestSha256: sha256(manifestBytes),
    manifest,
    payloads,
    entries,
    archiveBytes: buffer.length,
    manifestBytes: manifestBytes.length,
  });
}

function normalizeProjectRoot(projectRoot: string): string {
  const requested = resolve(requireString(projectRoot, 'Project root', { max: 32_768 }));
  let canonical: string;
  try {
    canonical = realpathSync(requested);
  } catch {
    throw new ValidationError('Vault restore project root does not exist');
  }
  const canonicalStat = lstatSync(canonical);
  if (!canonicalStat.isDirectory() || canonicalStat.isSymbolicLink()) {
    throw new ValidationError('Vault restore project root must be a real directory');
  }
  return canonical;
}

function boundedStringSet(
  values: Iterable<string> | undefined,
  label: string,
  limit: number,
  normalize: (value: string) => string = (value) => value,
): Set<string> {
  const result = new Set<string>();
  if (!values) return result;
  for (const value of values) {
    if (result.size >= limit) {
      throw new PayloadTooLargeError(`${limit} ${label}`, { maxInventoryItems: limit });
    }
    result.add(normalize(requireString(value, label, { max: 4096 })));
  }
  return result;
}

function sourcePathFilesystemConflict(projectRoot: string, sourcePath: string): string | null {
  const target = resolve(projectRoot, sourcePath);
  const scopedRelative = relative(projectRoot, target);
  if (!scopedRelative || scopedRelative === '..' || scopedRelative.startsWith(`..${sep}`)) {
    return 'Source path resolves outside the selected project';
  }
  let cursor = projectRoot;
  for (const segment of sourcePath.split('/')) {
    cursor = join(cursor, segment);
    let stat;
    try {
      stat = lstatSync(cursor);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      return 'Source path could not be inspected safely';
    }
    if (stat.isSymbolicLink()) return 'Source path crosses a symbolic link';
    if (cursor === target) return 'Source path already exists';
    if (!stat.isDirectory()) return 'Source path parent is not a directory';
  }
  return null;
}

function buildRestorePlan(
  archive: ParsedVaultArchive,
  projectRoot: string,
  inventory: VaultProjectInventory,
  limits: VaultArchiveLimits,
): VaultArchiveRestorePlan {
  const existingNoteIds = boundedStringSet(
    inventory.noteIds,
    'existing note ids',
    limits.maxInventoryItems,
  );
  const existingAttachmentIds = boundedStringSet(
    inventory.attachmentIds,
    'existing attachment ids',
    limits.maxInventoryItems,
  );
  const existingSourcePaths = boundedStringSet(
    inventory.sourcePaths,
    'existing source paths',
    limits.maxInventoryItems,
    (path) => pathCollisionKey(validateArchivePath(path, 'existing source path', 4096)),
  );
  const existingBaseNames = boundedStringSet(
    inventory.baseNames,
    'existing base names',
    limits.maxInventoryItems,
    pathCollisionKey,
  );
  const existingBaseIds = boundedStringSet(
    inventory.baseIds,
    'existing base ids',
    limits.maxInventoryItems,
  );
  const existingDraftIds = boundedStringSet(
    inventory.draftIds,
    'existing draft ids',
    limits.maxInventoryItems,
  );
  const conflicts: VaultRestoreConflict[] = [];
  for (const note of archive.manifest.notes) {
    const id = note.id as string;
    if (existingNoteIds.has(id)) {
      conflicts.push({
        kind: 'note_id_exists',
        archiveId: id,
        message: `Note id already exists in this project: ${id}`,
      });
    }
    const sourcePath = note.sourcePath as string | null | undefined;
    if (!sourcePath) continue;
    const inventoryConflict = existingSourcePaths.has(pathCollisionKey(sourcePath));
    const filesystemConflict = sourcePathFilesystemConflict(projectRoot, sourcePath);
    if (inventoryConflict || filesystemConflict) {
      conflicts.push({
        kind: 'source_exists',
        archiveId: id,
        path: sourcePath,
        message: filesystemConflict ?? `Source path is already indexed: ${sourcePath}`,
      });
    }
  }
  for (const attachment of archive.manifest.attachments) {
    const id = attachment.id as string;
    if (existingAttachmentIds.has(id)) {
      conflicts.push({
        kind: 'attachment_exists',
        archiveId: id,
        message: `Attachment id already exists in this project: ${id}`,
      });
    }
  }
  for (const base of archive.manifest.bases) {
    const id = base.id as string;
    const name = base.name as string;
    if (existingBaseIds.has(id) || existingBaseNames.has(pathCollisionKey(name))) {
      conflicts.push({
        kind: 'base_name_exists',
        archiveId: id,
        message: existingBaseIds.has(id)
          ? `Base id already exists: ${id}`
          : `Base name already exists in this project: ${name}`,
      });
    }
  }
  for (const draft of archive.manifest.drafts) {
    const id = draft.id as string;
    if (existingDraftIds.has(id)) {
      conflicts.push({
        kind: 'note_id_exists',
        archiveId: id,
        message: `Draft id already exists in this project: ${id}`,
      });
    }
  }
  conflicts.sort(
    (left, right) =>
      stableStringCompare(left.kind, right.kind) ||
      stableStringCompare(left.archiveId ?? '', right.archiveId ?? '') ||
      stableStringCompare(left.path ?? '', right.path ?? ''),
  );
  const planIdentity = JSON.stringify({
    archiveSha256: archive.archiveSha256,
    projectRoot,
    conflicts: conflicts.map(({ kind, archiveId, path }) => ({ kind, archiveId, path })),
  });
  return Object.freeze({
    format: 'koryphaios-notes-vault',
    archiveVersion: archive.manifest.version,
    projectName: archive.manifest.project.name,
    archiveSha256: archive.archiveSha256,
    manifestSha256: archive.manifestSha256,
    projectRoot,
    notes: archive.manifest.notes.length,
    revisions: archive.manifest.revisions.length,
    attachments: archive.manifest.attachments.length,
    links: archive.manifest.links.length,
    bases: archive.manifest.bases.length,
    drafts: archive.manifest.drafts.length,
    noOpNotes: 0,
    conflicts,
    canRestore: conflicts.length === 0,
    mode: 'safe-merge',
    planToken: sha256(planIdentity),
    archive,
  });
}

async function ensureParsedArchive(
  input: VaultArchiveInput | ParsedVaultArchive,
  options: ParseVaultArchiveOptions,
): Promise<ParsedVaultArchive> {
  if (input instanceof ParsedVaultArchive) {
    validateExpectedArchiveSha256(input.archiveSha256, options.expectedArchiveSha256);
    return input;
  }
  return parseVaultArchive(input, options);
}

export async function previewVaultArchiveRestore(
  input: VaultArchiveInput | ParsedVaultArchive,
  options: PreviewVaultArchiveOptions,
): Promise<VaultArchiveRestorePlan> {
  const limits = resolveLimits(options.limits);
  const archive = await ensureParsedArchive(input, options);
  const projectRoot = normalizeProjectRoot(options.projectRoot);
  return buildRestorePlan(archive, projectRoot, options.inventory ?? {}, limits);
}

function validateCommitCounts(
  counts: VaultRestoreCommitCounts,
  plan: VaultArchiveRestorePlan,
): void {
  const expected: VaultRestoreCommitCounts = {
    restoredNotes: plan.notes - plan.noOpNotes,
    restoredRevisions: plan.revisions,
    restoredAttachments: plan.attachments,
    restoredLinks: plan.links,
    restoredBases: plan.bases,
    restoredDrafts: plan.drafts,
  };
  for (const key of Object.keys(expected) as Array<keyof VaultRestoreCommitCounts>) {
    if (!Number.isSafeInteger(counts[key]) || counts[key] !== expected[key]) {
      throw new ConflictError(
        'Vault restore adapter did not atomically commit the complete plan.',
        {
          field: key,
          expected: expected[key],
          actual: counts[key],
        },
      );
    }
  }
}

/** Restore is deliberately two-phase: integrity validation, then a fresh
 * project inventory check immediately before one adapter-owned transaction. */
export async function restoreVaultArchive(
  input: VaultArchiveInput | ParsedVaultArchive,
  options: RestoreVaultArchiveOptions,
): Promise<VaultArchiveRestoreResult> {
  const limits = resolveLimits(options.limits);
  const archive = await ensureParsedArchive(input, {
    limits,
    expectedArchiveSha256: options.expectedArchiveSha256,
  });
  const projectRoot = normalizeProjectRoot(options.projectRoot);
  const inventory = await options.adapter.inspectProject(projectRoot);
  const plan = buildRestorePlan(archive, projectRoot, inventory, limits);
  if (!plan.canRestore) {
    throw new ConflictError('Vault restore would overwrite existing project data.', {
      conflicts: plan.conflicts,
      archiveSha256: plan.archiveSha256,
    });
  }
  const counts = await options.adapter.commitNoOverwriteAtomically(plan);
  validateCommitCounts(counts, plan);
  const { archive: _archive, ...preview } = plan;
  return { ...preview, ...counts };
}
