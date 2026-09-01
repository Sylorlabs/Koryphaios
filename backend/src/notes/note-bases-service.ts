import type { Database } from 'bun:sqlite';
import { nanoid } from 'nanoid';
import { resolve } from 'node:path';
import {
  NOTE_PROPERTY_TYPES,
  type NotePropertyType,
  type NotePropertyValue,
} from '@koryphaios/shared';
import { getDb } from '../db';
import { ConflictError, DuplicateError, NotFoundError, ValidationError } from '../errors/types';
import { PROJECT_ROOT } from '../runtime/paths';
import { getLocalNotesPrincipalId } from './notes-principal';
import {
  assertProjectPropertyProjectionCurrent,
  repairProjectPropertyProjections,
} from './note-properties-service';

const MAX_BASES_PER_PROJECT = 500;
const MAX_DEFINITION_BYTES = 64 * 1024;
const MAX_BASE_NAME_LENGTH = 120;
const MAX_PROPERTY_KEY_LENGTH = 80;
const MAX_FILTER_DEPTH = 3;
const MAX_FILTER_PREDICATES = 24;
const MAX_SORTS = 3;
const MAX_VIEW_FIELDS = 20;
const MAX_PAGE_SIZE = 250;
const MAX_OFFSET = 100_000;

export const NOTE_BASE_SYSTEM_FIELDS = [
  'title',
  'folder',
  'tags',
  'pinned',
  'context',
  'created',
  'updated',
  'format',
] as const;

export type NoteBaseSystemField = (typeof NOTE_BASE_SYSTEM_FIELDS)[number];

export type NoteBaseField =
  | { source: 'system'; field: NoteBaseSystemField }
  | { source: 'property'; key: string; type: NotePropertyType };

export const NOTE_BASE_FILTER_OPERATORS = [
  'eq',
  'neq',
  'contains',
  'not_contains',
  'starts_with',
  'gt',
  'gte',
  'lt',
  'lte',
  'is_empty',
  'is_not_empty',
] as const;

export type NoteBaseFilterOperator = (typeof NOTE_BASE_FILTER_OPERATORS)[number];

export type NoteBaseFilter =
  | {
      kind: 'predicate';
      field: NoteBaseField;
      operator: NoteBaseFilterOperator;
      value?: NotePropertyValue;
    }
  | {
      kind: 'group';
      operator: 'and' | 'or';
      filters: NoteBaseFilter[];
    };

export interface NoteBaseSort {
  field: NoteBaseField;
  direction: 'asc' | 'desc';
}

export interface NoteBaseView {
  kind: 'table' | 'list' | 'card';
  fields: NoteBaseField[];
}

export interface NoteBaseDefinition {
  version: 1;
  filter?: NoteBaseFilter;
  sort: NoteBaseSort[];
  groupBy?: NoteBaseField;
  view: NoteBaseView;
}

export interface NoteBase {
  id: string;
  name: string;
  definition: NoteBaseDefinition;
  revision: number;
  trashedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface NoteBaseRevision {
  baseId: string;
  revision: number;
  operation: 'create' | 'update' | 'trash' | 'restore';
  name: string;
  definition: NoteBaseDefinition;
  trashedAt?: Date;
  baseCreatedAt: Date;
  baseUpdatedAt: Date;
  createdAt: Date;
}

export interface NoteBaseQueryRow {
  id: string;
  title: string;
  folderPath: string;
  tags: string[];
  pinned: boolean;
  includeInContext: boolean;
  format: 'markdown' | 'html';
  createdAt: Date;
  updatedAt: Date;
  properties: Record<string, NotePropertyValue>;
  groupValue?: string | number | boolean | null;
}

export interface NoteBaseQueryResult {
  rows: NoteBaseQueryRow[];
  limit: number;
  offset: number;
  hasMore: boolean;
  invalidDocumentCount: number;
}

interface StoredBaseRow {
  id: string;
  name: string;
  definition: string;
  revision: number;
  trashed_at: number | null;
  created_at: number;
  updated_at: number;
}

interface StoredBaseRevisionRow {
  base_id: string;
  revision: number;
  operation: 'create' | 'update' | 'trash' | 'restore';
  name: string;
  definition: string;
  trashed_at: number | null;
  base_created_at: number;
  base_updated_at: number;
  created_at: number;
}

interface QueryNoteRow {
  id: string;
  title: string;
  folder_path: string;
  tags: string;
  pinned: number;
  include_in_context: number;
  format: string;
  created_at: number;
  updated_at: number;
  __group: string | number | null;
}

interface QueryPropertyRow {
  note_id: string;
  normalized_key: string;
  value_json: string;
}

type SqlBinding = string | number | bigint | boolean | null | Uint8Array;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizedProjectRoot(projectRoot: string): string {
  return resolve(projectRoot);
}

function includesLegacyProjectRows(projectRoot: string): boolean {
  return normalizedProjectRoot(projectRoot) === resolve(PROJECT_ROOT);
}

function normalizedPropertyKey(key: string): string {
  return key.normalize('NFKC').toLowerCase();
}

function normalizedText(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function validDateTime(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function canonicalDateTime(value: string): string {
  return new Date(value).toISOString().toLowerCase();
}

function safeJsonBytes(value: unknown): number {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new ValidationError('Base definition must be finite JSON data');
  }
  if (serialized === undefined) throw new ValidationError('Base definition is required');
  return Buffer.byteLength(serialized, 'utf8');
}

function validateName(value: unknown): string {
  if (typeof value !== 'string') throw new ValidationError('Base name must be text');
  const name = value.trim();
  if (!name) throw new ValidationError('Base name cannot be empty');
  if (name.length > MAX_BASE_NAME_LENGTH || /\p{Cc}/u.test(name)) {
    throw new ValidationError(
      `Base name cannot exceed ${MAX_BASE_NAME_LENGTH} characters or contain controls`,
    );
  }
  return name;
}

function validateField(value: unknown): NoteBaseField {
  if (!isRecord(value)) throw new ValidationError('Base field must be an object');
  if (value.source === 'system') {
    if (
      typeof value.field !== 'string' ||
      !NOTE_BASE_SYSTEM_FIELDS.includes(value.field as NoteBaseSystemField)
    ) {
      throw new ValidationError('Base field uses an unknown system field');
    }
    return { source: 'system', field: value.field as NoteBaseSystemField };
  }
  if (value.source !== 'property') throw new ValidationError('Base field source is invalid');
  if (
    typeof value.key !== 'string' ||
    !value.key.trim() ||
    value.key.length > MAX_PROPERTY_KEY_LENGTH ||
    /[\r\n\0]/.test(value.key)
  ) {
    throw new ValidationError('Base property key is invalid');
  }
  if (
    typeof value.type !== 'string' ||
    !NOTE_PROPERTY_TYPES.includes(value.type as NotePropertyType)
  ) {
    throw new ValidationError('Base property type is invalid');
  }
  return {
    source: 'property',
    key: value.key.trim(),
    type: value.type as NotePropertyType,
  };
}

function fieldType(field: NoteBaseField): NotePropertyType {
  if (field.source === 'property') return field.type;
  switch (field.field) {
    case 'tags':
      return 'tags';
    case 'pinned':
    case 'context':
      return 'checkbox';
    case 'created':
    case 'updated':
      return 'datetime';
    default:
      return 'text';
  }
}

function validatePredicateValue(
  field: NoteBaseField,
  operator: NoteBaseFilterOperator,
  value: unknown,
): NotePropertyValue | undefined {
  if (operator === 'is_empty' || operator === 'is_not_empty') {
    if (value !== undefined) throw new ValidationError(`${operator} does not accept a value`);
    return undefined;
  }
  const type = fieldType(field);
  if (type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new ValidationError('Numeric Base predicate requires a finite number');
    }
  } else if (type === 'checkbox') {
    if (typeof value !== 'boolean') {
      throw new ValidationError('Checkbox Base predicate requires a boolean');
    }
  } else if (type === 'list' || type === 'tags') {
    if (typeof value !== 'string' || value.length > 2_048) {
      throw new ValidationError('List Base predicate requires one bounded text value');
    }
  } else if (typeof value !== 'string' || value.length > 2_048) {
    throw new ValidationError('Text Base predicate requires one bounded text value');
  }

  if (type === 'date' && !validDate(value as string)) {
    throw new ValidationError('Date Base predicate requires a valid YYYY-MM-DD value');
  }
  if (type === 'datetime' && !validDateTime(value as string)) {
    throw new ValidationError('Date-time Base predicate requires a valid ISO value with timezone');
  }

  const comparison = ['gt', 'gte', 'lt', 'lte'].includes(operator);
  if (comparison && !['number', 'date', 'datetime'].includes(type)) {
    throw new ValidationError(`${operator} is only valid for number or date properties`);
  }
  if (['contains', 'not_contains'].includes(operator) && type === 'number') {
    throw new ValidationError(`${operator} is not valid for number properties`);
  }
  if (type === 'checkbox' && !['eq', 'neq', 'is_empty', 'is_not_empty'].includes(operator)) {
    throw new ValidationError(`Checkbox properties do not support ${operator}`);
  }
  if (operator === 'starts_with' && !['text', 'date', 'datetime'].includes(type)) {
    throw new ValidationError('starts_with is only valid for text or date properties');
  }
  if (
    (type === 'date' || type === 'datetime') &&
    !['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'is_empty', 'is_not_empty'].includes(operator)
  ) {
    throw new ValidationError(`Date properties do not support ${operator}`);
  }
  if ((type === 'list' || type === 'tags') && !['contains', 'not_contains'].includes(operator)) {
    throw new ValidationError('List properties support contains, not_contains, and empty checks');
  }
  return value as NotePropertyValue;
}

function validateFilter(
  value: unknown,
  depth: number,
  budget: { predicates: number },
): NoteBaseFilter {
  if (!isRecord(value)) throw new ValidationError('Base filter must be an object');
  if (depth > MAX_FILTER_DEPTH) {
    throw new ValidationError(`Base filters cannot exceed depth ${MAX_FILTER_DEPTH}`);
  }
  if (value.kind === 'group') {
    if (value.operator !== 'and' && value.operator !== 'or') {
      throw new ValidationError('Base filter group operator must be and or or');
    }
    if (!Array.isArray(value.filters) || value.filters.length === 0) {
      throw new ValidationError('Base filter group cannot be empty');
    }
    return {
      kind: 'group',
      operator: value.operator,
      filters: value.filters.map((child) => validateFilter(child, depth + 1, budget)),
    };
  }
  if (value.kind !== 'predicate') throw new ValidationError('Base filter kind is invalid');
  budget.predicates++;
  if (budget.predicates > MAX_FILTER_PREDICATES) {
    throw new ValidationError(`A Base can contain at most ${MAX_FILTER_PREDICATES} predicates`);
  }
  const field = validateField(value.field);
  if (
    typeof value.operator !== 'string' ||
    !NOTE_BASE_FILTER_OPERATORS.includes(value.operator as NoteBaseFilterOperator)
  ) {
    throw new ValidationError('Base predicate operator is invalid');
  }
  const operator = value.operator as NoteBaseFilterOperator;
  const predicateValue = validatePredicateValue(field, operator, value.value);
  return {
    kind: 'predicate',
    field,
    operator,
    ...(predicateValue !== undefined ? { value: predicateValue } : {}),
  };
}

/** Validate and clone an untrusted saved-view definition. The query compiler
 * only accepts this returned discriminated union; no user string is ever used
 * as a SQL identifier or SQL fragment. */
export function validateNoteBaseDefinition(value: unknown): NoteBaseDefinition {
  if (safeJsonBytes(value) > MAX_DEFINITION_BYTES) {
    throw new ValidationError(`Base definition cannot exceed ${MAX_DEFINITION_BYTES} bytes`);
  }
  if (!isRecord(value) || value.version !== 1) {
    throw new ValidationError('Base definition version must be 1');
  }
  const filter = value.filter ? validateFilter(value.filter, 1, { predicates: 0 }) : undefined;
  if (!Array.isArray(value.sort) || value.sort.length > MAX_SORTS) {
    throw new ValidationError(`A Base can have at most ${MAX_SORTS} sort fields`);
  }
  const sort = value.sort.map((entry): NoteBaseSort => {
    if (!isRecord(entry) || (entry.direction !== 'asc' && entry.direction !== 'desc')) {
      throw new ValidationError('Base sort is invalid');
    }
    const field = validateField(entry.field);
    if (fieldType(field) === 'list' || fieldType(field) === 'tags') {
      throw new ValidationError('List properties cannot be used as Base sort fields');
    }
    return { field, direction: entry.direction };
  });
  const groupBy = value.groupBy ? validateField(value.groupBy) : undefined;
  if (groupBy && (fieldType(groupBy) === 'list' || fieldType(groupBy) === 'tags')) {
    throw new ValidationError('List properties cannot be used as Base group fields');
  }
  if (!isRecord(value.view) || !['table', 'list', 'card'].includes(String(value.view.kind))) {
    throw new ValidationError('Base view kind must be table, list, or card');
  }
  if (
    !Array.isArray(value.view.fields) ||
    value.view.fields.length === 0 ||
    value.view.fields.length > MAX_VIEW_FIELDS
  ) {
    throw new ValidationError(`A Base view must contain 1-${MAX_VIEW_FIELDS} fields`);
  }
  const definition: NoteBaseDefinition = {
    version: 1,
    ...(filter ? { filter } : {}),
    sort,
    ...(groupBy ? { groupBy } : {}),
    view: {
      kind: value.view.kind as NoteBaseView['kind'],
      fields: value.view.fields.map(validateField),
    },
  };
  // Check the normalized clone too; this catches a future validator change
  // that accidentally admits an over-budget expansion.
  if (safeJsonBytes(definition) > MAX_DEFINITION_BYTES) {
    throw new ValidationError(`Base definition cannot exceed ${MAX_DEFINITION_BYTES} bytes`);
  }
  return definition;
}

function baseFromRow(row: StoredBaseRow): NoteBase {
  const definition = validateNoteBaseDefinition(JSON.parse(row.definition) as unknown);
  return {
    id: row.id,
    name: row.name,
    definition,
    revision: row.revision,
    ...(row.trashed_at !== null ? { trashedAt: new Date(row.trashed_at) } : {}),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function revisionFromRow(row: StoredBaseRevisionRow): NoteBaseRevision {
  return {
    baseId: row.base_id,
    revision: row.revision,
    operation: row.operation,
    name: row.name,
    definition: validateNoteBaseDefinition(JSON.parse(row.definition) as unknown),
    ...(row.trashed_at !== null ? { trashedAt: new Date(row.trashed_at) } : {}),
    baseCreatedAt: new Date(row.base_created_at),
    baseUpdatedAt: new Date(row.base_updated_at),
    createdAt: new Date(row.created_at),
  };
}

function snapshotBase(
  database: Database,
  baseId: string,
  operation: NoteBaseRevision['operation'],
): void {
  database
    .query(
      `
      INSERT INTO note_base_revisions (
        base_id, revision, project_root, operation, name, definition,
        trashed_at, base_created_at, base_updated_at, created_at
      )
      SELECT id, revision, project_root, ?, name, definition,
             trashed_at, created_at, updated_at, ?
      FROM note_bases WHERE id = ?
    `,
    )
    .run(operation, Date.now(), baseId);
}

function storedBase(
  database: Database,
  baseId: string,
  projectRoot: string,
  includeTrashed: boolean,
): StoredBaseRow | null {
  const principalId = getLocalNotesPrincipalId(database);
  return database
    .query<StoredBaseRow, [string, string, string]>(
      `SELECT id, name, definition, revision, trashed_at, created_at, updated_at
       FROM note_bases
       WHERE id = ? AND principal_id = ? AND project_root = ?
         ${includeTrashed ? '' : 'AND trashed_at IS NULL'}`,
    )
    .get(baseId, principalId, normalizedProjectRoot(projectRoot)) as StoredBaseRow | null;
}

export function listNoteBases(
  projectRoot = PROJECT_ROOT,
  options: { includeTrashed?: boolean } = {},
  database: Database = getDb(),
): NoteBase[] {
  const principalId = getLocalNotesPrincipalId(database);
  return database
    .query<StoredBaseRow, [string, string]>(
      `SELECT id, name, definition, revision, trashed_at, created_at, updated_at
       FROM note_bases
       WHERE principal_id = ? AND project_root = ?
         ${options.includeTrashed ? '' : 'AND trashed_at IS NULL'}
       ORDER BY name COLLATE NOCASE, id`,
    )
    .all(principalId, normalizedProjectRoot(projectRoot))
    .map(baseFromRow);
}

export function getNoteBase(
  baseId: string,
  projectRoot = PROJECT_ROOT,
  options: { includeTrashed?: boolean } = {},
  database: Database = getDb(),
): NoteBase | null {
  const row = storedBase(database, baseId, projectRoot, Boolean(options.includeTrashed));
  return row ? baseFromRow(row) : null;
}

export function createNoteBase(
  input: { name: string; definition: unknown },
  projectRoot = PROJECT_ROOT,
  database: Database = getDb(),
): NoteBase {
  const root = normalizedProjectRoot(projectRoot);
  const principalId = getLocalNotesPrincipalId(database);
  const name = validateName(input.name);
  const definition = validateNoteBaseDefinition(input.definition);
  const existing = database
    .query<{ id: string }, [string, string, string]>(
      `SELECT id FROM note_bases
       WHERE principal_id = ? AND project_root = ? AND lower(name) = lower(?)
       LIMIT 1`,
    )
    .get(principalId, root, name);
  if (existing) throw new DuplicateError('Note Base', 'name', name);
  const count = Number(
    database
      .query<{ count: number }, [string, string]>(
        `SELECT COUNT(*) AS count FROM note_bases
         WHERE principal_id = ? AND project_root = ?`,
      )
      .get(principalId, root)?.count ?? 0,
  );
  if (count >= MAX_BASES_PER_PROJECT) {
    throw new ValidationError(`A project can contain at most ${MAX_BASES_PER_PROJECT} Bases`);
  }
  const id = nanoid();
  const now = Date.now();
  const transaction = database.transaction(() => {
    database
      .query(
        `
        INSERT INTO note_bases (
          id, principal_id, project_root, name, definition, revision,
          trashed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, NULL, ?, ?)
      `,
      )
      .run(id, principalId, root, name, JSON.stringify(definition), now, now);
    snapshotBase(database, id, 'create');
  });
  transaction();
  return baseFromRow(storedBase(database, id, root, false)!);
}

export function updateNoteBase(
  baseId: string,
  input: { expectedRevision: number; name?: string; definition?: unknown },
  projectRoot = PROJECT_ROOT,
  database: Database = getDb(),
): NoteBase {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
    throw new ValidationError('expectedRevision must be a positive integer');
  }
  const root = normalizedProjectRoot(projectRoot);
  const principalId = getLocalNotesPrincipalId(database);
  const current = storedBase(database, baseId, root, false);
  if (!current) throw new NotFoundError('Note Base', baseId);
  if (current.revision !== input.expectedRevision) {
    throw new ConflictError('This Base changed after it was opened.', {
      expectedRevision: input.expectedRevision,
      currentRevision: current.revision,
    });
  }
  const name = input.name === undefined ? current.name : validateName(input.name);
  const definition =
    input.definition === undefined
      ? validateNoteBaseDefinition(JSON.parse(current.definition) as unknown)
      : validateNoteBaseDefinition(input.definition);
  const duplicate = database
    .query<{ id: string }, [string, string, string, string]>(
      `SELECT id FROM note_bases
       WHERE principal_id = ? AND project_root = ? AND lower(name) = lower(?) AND id <> ?
       LIMIT 1`,
    )
    .get(principalId, root, name, baseId);
  if (duplicate) throw new DuplicateError('Note Base', 'name', name);
  const now = Date.now();
  const transaction = database.transaction(() => {
    const changed = database
      .query(
        `
        UPDATE note_bases
        SET name = ?, definition = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND principal_id = ? AND project_root = ?
          AND revision = ? AND trashed_at IS NULL
      `,
      )
      .run(
        name,
        JSON.stringify(definition),
        now,
        baseId,
        principalId,
        root,
        input.expectedRevision,
      );
    if (changed.changes !== 1) {
      throw new ConflictError('This Base changed while it was being saved.');
    }
    snapshotBase(database, baseId, 'update');
  });
  transaction();
  return baseFromRow(storedBase(database, baseId, root, false)!);
}

function changeBaseTrashState(
  baseId: string,
  expectedRevision: number,
  restoring: boolean,
  projectRoot: string,
  database: Database,
): NoteBase {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new ValidationError('expectedRevision must be a positive integer');
  }
  const root = normalizedProjectRoot(projectRoot);
  const principalId = getLocalNotesPrincipalId(database);
  const current = storedBase(database, baseId, root, true);
  if (!current) throw new NotFoundError('Note Base', baseId);
  if (current.revision !== expectedRevision) {
    throw new ConflictError('This Base changed after it was opened.', {
      expectedRevision,
      currentRevision: current.revision,
    });
  }
  if (restoring ? current.trashed_at === null : current.trashed_at !== null) {
    throw new ConflictError(
      restoring ? 'This Base is not in Trash.' : 'This Base is already in Trash.',
    );
  }
  const now = Date.now();
  const transaction = database.transaction(() => {
    const changed = database
      .query(
        `
        UPDATE note_bases
        SET trashed_at = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND principal_id = ? AND project_root = ? AND revision = ?
          AND ${restoring ? 'trashed_at IS NOT NULL' : 'trashed_at IS NULL'}
      `,
      )
      .run(restoring ? null : now, now, baseId, principalId, root, expectedRevision);
    if (changed.changes !== 1) {
      throw new ConflictError('This Base changed while its Trash state was updated.');
    }
    snapshotBase(database, baseId, restoring ? 'restore' : 'trash');
  });
  transaction();
  return baseFromRow(storedBase(database, baseId, root, true)!);
}

export function trashNoteBase(
  baseId: string,
  expectedRevision: number,
  projectRoot = PROJECT_ROOT,
  database: Database = getDb(),
): NoteBase {
  return changeBaseTrashState(baseId, expectedRevision, false, projectRoot, database);
}

export function restoreNoteBase(
  baseId: string,
  expectedRevision: number,
  projectRoot = PROJECT_ROOT,
  database: Database = getDb(),
): NoteBase {
  return changeBaseTrashState(baseId, expectedRevision, true, projectRoot, database);
}

export function listNoteBaseRevisions(
  baseId: string,
  projectRoot = PROJECT_ROOT,
  database: Database = getDb(),
): NoteBaseRevision[] {
  const root = normalizedProjectRoot(projectRoot);
  if (!storedBase(database, baseId, root, true)) throw new NotFoundError('Note Base', baseId);
  return database
    .query<StoredBaseRevisionRow, [string, string]>(
      `SELECT base_id, revision, operation, name, definition, trashed_at,
              base_created_at, base_updated_at, created_at
       FROM note_base_revisions
       WHERE base_id = ? AND project_root = ?
       ORDER BY revision DESC`,
    )
    .all(baseId, root)
    .map(revisionFromRow);
}

function fixedSystemExpression(field: NoteBaseSystemField): string {
  switch (field) {
    case 'title':
      return 'n.title';
    case 'folder':
      return 'n.folder_path';
    case 'tags':
      return 'n.tags';
    case 'pinned':
      return 'n.pinned';
    case 'context':
      return 'n.include_in_context';
    case 'created':
      return 'n.created_at';
    case 'updated':
      return 'n.updated_at';
    case 'format':
      return 'n.format';
  }
}

function scalarPropertyColumn(type: NotePropertyType): string {
  switch (type) {
    case 'number':
      return 'p.value_number';
    case 'checkbox':
      return 'p.value_boolean';
    default:
      return 'p.value_text';
  }
}

function scalarFieldExpression(
  field: NoteBaseField,
  projectRoot: string,
): { sql: string; values: SqlBinding[] } {
  if (field.source === 'system') return { sql: fixedSystemExpression(field.field), values: [] };
  return {
    sql: `(SELECT ${scalarPropertyColumn(field.type)}
           FROM note_properties AS p
           WHERE p.note_id = n.id AND p.project_root = ?
             AND p.normalized_key = ? AND p.type = ?
             AND p.note_revision = n.revision
           LIMIT 1)`,
    values: [projectRoot, normalizedPropertyKey(field.key), field.type],
  };
}

function systemPredicateSql(
  field: NoteBaseSystemField,
  operator: NoteBaseFilterOperator,
  value: NotePropertyValue | undefined,
): { sql: string; values: SqlBinding[] } {
  if (field === 'tags') {
    const exists = `EXISTS (
      SELECT 1 FROM json_each(n.tags) AS tag
      WHERE lower(CAST(tag.value AS TEXT)) = ?
        AND CAST(tag.value AS TEXT) NOT LIKE 'koryphaios-memory-import:%'
    )`;
    if (operator === 'is_empty' || operator === 'is_not_empty') {
      const any = `EXISTS (
        SELECT 1 FROM json_each(n.tags) AS tag
        WHERE CAST(tag.value AS TEXT) NOT LIKE 'koryphaios-memory-import:%'
      )`;
      return { sql: operator === 'is_empty' ? `NOT ${any}` : any, values: [] };
    }
    return {
      sql: operator === 'not_contains' ? `NOT ${exists}` : exists,
      values: [normalizedText(String(value))],
    };
  }
  const expression = fixedSystemExpression(field);
  if (operator === 'is_empty') {
    return { sql: `(${expression} IS NULL OR CAST(${expression} AS TEXT) = '')`, values: [] };
  }
  if (operator === 'is_not_empty') {
    return { sql: `(${expression} IS NOT NULL AND CAST(${expression} AS TEXT) <> '')`, values: [] };
  }
  let bound: SqlBinding = value as SqlBinding;
  if (field === 'created' || field === 'updated') {
    const epoch = Date.parse(String(value));
    if (!Number.isFinite(epoch)) throw new ValidationError('Base date predicate is invalid');
    bound = Math.floor(epoch / 1_000);
  } else if (typeof value === 'string') {
    bound = normalizedText(value);
  } else if (typeof value === 'boolean') {
    bound = value ? 1 : 0;
  }
  const comparable =
    typeof bound === 'string' && !['format'].includes(field) ? `lower(${expression})` : expression;
  switch (operator) {
    case 'eq':
      return { sql: `${comparable} = ?`, values: [bound] };
    case 'neq':
      return { sql: `${comparable} IS NOT NULL AND ${comparable} <> ?`, values: [bound] };
    case 'contains':
      return { sql: `instr(lower(${expression}), ?) > 0`, values: [String(bound)] };
    case 'not_contains':
      return { sql: `instr(lower(${expression}), ?) = 0`, values: [String(bound)] };
    case 'starts_with':
      return {
        sql: `substr(lower(${expression}), 1, length(?)) = ?`,
        values: [String(bound), String(bound)],
      };
    case 'gt':
      return { sql: `${expression} > ?`, values: [bound] };
    case 'gte':
      return { sql: `${expression} >= ?`, values: [bound] };
    case 'lt':
      return { sql: `${expression} < ?`, values: [bound] };
    case 'lte':
      return { sql: `${expression} <= ?`, values: [bound] };
    default:
      throw new ValidationError(`Operator ${operator} is not valid for ${field}`);
  }
}

function propertyPredicateSql(
  field: Extract<NoteBaseField, { source: 'property' }>,
  operator: NoteBaseFilterOperator,
  value: NotePropertyValue | undefined,
  projectRoot: string,
): { sql: string; values: SqlBinding[] } {
  const key = normalizedPropertyKey(field.key);
  const base = `p.note_id = n.id AND p.project_root = ?
    AND p.normalized_key = ? AND p.type = ? AND p.note_revision = n.revision`;
  const baseValues: SqlBinding[] = [projectRoot, key, field.type];
  if (field.type === 'list' || field.type === 'tags') {
    const itemExists = `EXISTS (
      SELECT 1
      FROM note_property_items AS i
      JOIN note_properties AS p
        ON p.note_id = i.note_id AND p.normalized_key = i.normalized_key
      WHERE ${base} AND i.normalized_text = ?
    )`;
    const values = [...baseValues, normalizedText(String(value))];
    if (operator === 'contains') return { sql: itemExists, values };
    const propertyExists = `EXISTS (SELECT 1 FROM note_properties AS p WHERE ${base})`;
    if (operator === 'not_contains') {
      // Missing values do not satisfy a negative predicate. Users can express
      // that explicitly with is_empty instead of a surprising fail-open match.
      return {
        sql: `(${propertyExists} AND NOT ${itemExists})`,
        values: [...baseValues, ...values],
      };
    }
    const itemPresent = `EXISTS (
      SELECT 1
      FROM note_property_items AS i
      JOIN note_properties AS p
        ON p.note_id = i.note_id AND p.normalized_key = i.normalized_key
      WHERE ${base}
    )`;
    return {
      sql: operator === 'is_empty' ? `NOT ${itemPresent}` : itemPresent,
      values: baseValues,
    };
  }
  const column = scalarPropertyColumn(field.type);
  if (operator === 'is_empty' || operator === 'is_not_empty') {
    const present = `EXISTS (
      SELECT 1 FROM note_properties AS p
      WHERE ${base}
        ${field.type === 'text' ? `AND ${column} <> ''` : ''}
    )`;
    return { sql: operator === 'is_empty' ? `NOT ${present}` : present, values: baseValues };
  }
  let bound: SqlBinding = value as SqlBinding;
  if (typeof value === 'string') {
    bound = field.type === 'datetime' ? canonicalDateTime(value) : normalizedText(value);
  } else if (typeof value === 'boolean') bound = value ? 1 : 0;
  let comparison: string;
  switch (operator) {
    case 'eq':
      comparison = `${column} = ?`;
      break;
    case 'neq':
      comparison = `${column} <> ?`;
      break;
    case 'contains':
      comparison = `instr(${column}, ?) > 0`;
      break;
    case 'not_contains':
      comparison = `instr(${column}, ?) = 0`;
      break;
    case 'starts_with':
      comparison = `substr(${column}, 1, length(?)) = ?`;
      return {
        sql: `EXISTS (SELECT 1 FROM note_properties AS p WHERE ${base} AND ${comparison})`,
        values: [...baseValues, String(bound), String(bound)],
      };
    case 'gt':
      comparison = `${column} > ?`;
      break;
    case 'gte':
      comparison = `${column} >= ?`;
      break;
    case 'lt':
      comparison = `${column} < ?`;
      break;
    case 'lte':
      comparison = `${column} <= ?`;
      break;
    default:
      throw new ValidationError(`Operator ${operator} is invalid`);
  }
  return {
    sql: `EXISTS (SELECT 1 FROM note_properties AS p WHERE ${base} AND ${comparison})`,
    values: [...baseValues, bound],
  };
}

function compileFilter(
  filter: NoteBaseFilter,
  projectRoot: string,
): { sql: string; values: SqlBinding[] } {
  if (filter.kind === 'predicate') {
    return filter.field.source === 'system'
      ? systemPredicateSql(filter.field.field, filter.operator, filter.value)
      : propertyPredicateSql(filter.field, filter.operator, filter.value, projectRoot);
  }
  const compiled = filter.filters.map((child) => compileFilter(child, projectRoot));
  return {
    sql: `(${compiled.map((child) => child.sql).join(filter.operator === 'and' ? ' AND ' : ' OR ')})`,
    values: compiled.flatMap((child) => child.values),
  };
}

function publicTags(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(
          (tag): tag is string =>
            typeof tag === 'string' && !tag.startsWith('koryphaios-memory-import:'),
        )
      : [];
  } catch {
    return [];
  }
}

function propertyKeysForOutput(definition: NoteBaseDefinition): string[] {
  const keys = new Set<string>();
  for (const field of definition.view.fields) {
    if (field.source === 'property') keys.add(normalizedPropertyKey(field.key));
  }
  if (definition.groupBy?.source === 'property') {
    keys.add(normalizedPropertyKey(definition.groupBy.key));
  }
  return [...keys].sort();
}

function executeBaseQuery(
  definition: NoteBaseDefinition,
  options: { limit?: number; offset?: number },
  projectRoot: string,
  database: Database,
): NoteBaseQueryResult {
  const root = normalizedProjectRoot(projectRoot);
  assertProjectPropertyProjectionCurrent(root, database);
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(options.limit ?? 100)));
  const offset = Math.min(MAX_OFFSET, Math.max(0, Math.trunc(options.offset ?? 0)));

  const selectExpressions: string[] = [];
  const selectValues: SqlBinding[] = [];
  if (definition.groupBy) {
    const group = scalarFieldExpression(definition.groupBy, root);
    selectExpressions.push(`${group.sql} AS __group`);
    selectValues.push(...group.values);
  } else {
    selectExpressions.push('NULL AS __group');
  }
  definition.sort.forEach((sort, index) => {
    const compiled = scalarFieldExpression(sort.field, root);
    selectExpressions.push(`${compiled.sql} AS __sort${index}`);
    selectValues.push(...compiled.values);
  });

  const where: string[] = ['n.trashed_at IS NULL'];
  const whereValues: SqlBinding[] = [];
  if (includesLegacyProjectRows(root)) {
    where.push('(n.project_root = ? OR n.project_root IS NULL)');
  } else {
    where.push('n.project_root = ?');
  }
  whereValues.push(root);
  if (definition.filter) {
    const filter = compileFilter(definition.filter, root);
    where.push(filter.sql);
    whereValues.push(...filter.values);
  }

  const ordering: string[] = [];
  if (definition.groupBy) ordering.push('(__group IS NULL) ASC', '__group ASC');
  definition.sort.forEach((sort, index) => {
    ordering.push(`(__sort${index} IS NULL) ASC`, `__sort${index} ${sort.direction.toUpperCase()}`);
  });
  ordering.push('n.id ASC');
  const sql = `
    SELECT n.id, n.title, n.folder_path, n.tags, n.pinned,
           n.include_in_context, n.format, n.created_at, n.updated_at,
           ${selectExpressions.join(', ')}
    FROM notes AS n
    WHERE ${where.join(' AND ')}
    ORDER BY ${ordering.join(', ')}
    LIMIT ? OFFSET ?
  `;
  const rawRows = database
    .query(sql)
    .all(...selectValues, ...whereValues, limit + 1, offset) as QueryNoteRow[];
  const hasMore = rawRows.length > limit;
  const pageRows = rawRows.slice(0, limit);

  const valuesByNote = new Map<string, Record<string, NotePropertyValue>>();
  const propertyKeys = propertyKeysForOutput(definition);
  if (pageRows.length > 0 && propertyKeys.length > 0) {
    const notePlaceholders = pageRows.map(() => '?').join(',');
    const keyPlaceholders = propertyKeys.map(() => '?').join(',');
    const propertyRows = database
      .query(
        `SELECT note_id, normalized_key, value_json
         FROM note_properties
         WHERE project_root = ?
           AND note_id IN (${notePlaceholders})
           AND normalized_key IN (${keyPlaceholders})
         ORDER BY note_id, normalized_key`,
      )
      .all(root, ...pageRows.map((row) => row.id), ...propertyKeys) as QueryPropertyRow[];
    for (const property of propertyRows) {
      try {
        const value = JSON.parse(property.value_json) as NotePropertyValue;
        const values = valuesByNote.get(property.note_id) ?? {};
        values[property.normalized_key] = value;
        valuesByNote.set(property.note_id, values);
      } catch {
        // Derived corruption is surfaced through the invariant on the next
        // repair. Never invent a cell value in this response.
      }
    }
  }

  const invalidDocumentCount = Number(
    database
      .query<{ count: number }, [string]>(
        `SELECT COUNT(*) AS count
         FROM note_property_documents AS d
         JOIN notes AS n ON n.id = d.note_id
         WHERE d.project_root = ? AND n.trashed_at IS NULL AND d.status <> 'valid'`,
      )
      .get(root)?.count ?? 0,
  );
  return {
    rows: pageRows.map((row) => ({
      id: row.id,
      title: row.title,
      folderPath: row.folder_path,
      tags: publicTags(row.tags),
      pinned: Boolean(row.pinned),
      includeInContext: Boolean(row.include_in_context),
      format: row.format === 'html' ? 'html' : 'markdown',
      createdAt: new Date(row.created_at * 1_000),
      updatedAt: new Date(row.updated_at * 1_000),
      properties: valuesByNote.get(row.id) ?? {},
      ...(definition.groupBy ? { groupValue: row.__group } : {}),
    })),
    limit,
    offset,
    hasMore,
    invalidDocumentCount,
  };
}

export async function previewNoteBase(
  definitionInput: unknown,
  options: { limit?: number; offset?: number } = {},
  projectRoot = PROJECT_ROOT,
  database: Database = getDb(),
): Promise<NoteBaseQueryResult> {
  const definition = validateNoteBaseDefinition(definitionInput);
  await repairProjectPropertyProjections(projectRoot, database);
  return executeBaseQuery(definition, options, projectRoot, database);
}

export async function queryNoteBase(
  baseId: string,
  options: { limit?: number; offset?: number } = {},
  projectRoot = PROJECT_ROOT,
  database: Database = getDb(),
): Promise<NoteBaseQueryResult> {
  const base = getNoteBase(baseId, projectRoot, {}, database);
  if (!base) throw new NotFoundError('Note Base', baseId);
  await repairProjectPropertyProjections(projectRoot, database);
  return executeBaseQuery(base.definition, options, projectRoot, database);
}
