import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import {
  parseNoteProperties,
  type NoteProperty,
  type NotePropertyType,
  type NotePropertyWarning,
} from '@koryphaios/shared';
import { getDb } from '../db';
import { ConflictError, NotFoundError } from '../errors/types';
import { PROJECT_ROOT } from '../runtime/paths';

const PROJECTION_PAGE_SIZE = 250;
const PROPERTY_TYPES: readonly NotePropertyType[] = [
  'text',
  'number',
  'checkbox',
  'date',
  'datetime',
  'list',
  'tags',
];

interface StoredNoteRow {
  id: string;
  content: string;
  revision: number;
  format: 'markdown' | 'html';
  project_root: string | null;
}

interface ProjectionDocumentRow {
  note_id: string;
  project_root: string;
  projected_revision: number;
  status: 'valid' | 'invalid' | 'unsupported';
  issues_json: string;
}

interface StoredPropertyRow {
  key: string;
  type: NotePropertyType;
  value_json: string;
}

interface SchemaAggregateRow {
  normalized_key: string;
  display_name: string;
  type: NotePropertyType;
  usage_count: number;
}

interface StoredSchemaRow {
  normalized_key: string;
  display_name: string;
  kind: NotePropertyType;
  revision: number;
  usage_count: number;
  invalid_count: number;
  created_at: number;
}

export interface NotePropertyProjection {
  noteId: string;
  revision: number;
  status: 'valid' | 'invalid' | 'unsupported';
  properties: NoteProperty[];
  warnings: NotePropertyWarning[];
}

export interface PropertyProjectionRepairReport {
  scanned: number;
  repaired: number;
  invalid: number;
  unsupported: number;
}

export interface NotePropertySchemaSummary {
  key: string;
  displayName: string;
  kind: NotePropertyType;
  revision: number;
  usageCount: number;
  invalidCount: number;
  createdAt: Date;
  updatedAt: Date;
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

function noteScopeSql(projectRoot: string, alias = 'n'): { sql: string; values: string[] } {
  const root = normalizedProjectRoot(projectRoot);
  return includesLegacyProjectRows(root)
    ? { sql: `(${alias}.project_root = ? OR ${alias}.project_root IS NULL)`, values: [root] }
    : { sql: `${alias}.project_root = ?`, values: [root] };
}

function parseWarnings(value: string): NotePropertyWarning[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [{ message: 'Stored property diagnostics are invalid.' }];
    return parsed
      .filter(
        (item): item is { key?: string; message: string } =>
          !!item &&
          typeof item === 'object' &&
          typeof (item as { message?: unknown }).message === 'string' &&
          ((item as { key?: unknown }).key === undefined ||
            typeof (item as { key?: unknown }).key === 'string'),
      )
      .map((item) => ({ ...(item.key ? { key: item.key } : {}), message: item.message }));
  } catch {
    return [{ message: 'Stored property diagnostics are invalid.' }];
  }
}

function parsePropertyValue(row: StoredPropertyRow): NoteProperty | null {
  if (!PROPERTY_TYPES.includes(row.type)) return null;
  try {
    const value = JSON.parse(row.value_json) as unknown;
    if (
      (row.type === 'number' && typeof value === 'number' && Number.isFinite(value)) ||
      (row.type === 'checkbox' && typeof value === 'boolean') ||
      ((row.type === 'list' || row.type === 'tags') &&
        Array.isArray(value) &&
        value.every((item) => typeof item === 'string')) ||
      ((row.type === 'text' || row.type === 'date' || row.type === 'datetime') &&
        typeof value === 'string')
    ) {
      return { key: row.key, type: row.type, value } as NoteProperty;
    }
  } catch {
    // The projection is derived. A corrupt row is repaired by the caller.
  }
  return null;
}

function frontmatterSource(content: string): string {
  const match = /^(?:\uFEFF)?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  return match?.[0] ?? '';
}

function projectionStatus(
  content: string,
  parsed: ReturnType<typeof parseNoteProperties>,
): 'valid' | 'invalid' | 'unsupported' {
  if (
    (/^(?:\uFEFF)?---[ \t]*(?:\r?\n|$)/.test(content) && !parsed.hasFrontmatter) ||
    parsed.warnings.some((warning) => /missing a closing|malformed/i.test(warning.message))
  ) {
    return 'invalid';
  }
  return parsed.warnings.length > 0 ? 'unsupported' : 'valid';
}

function projectionWarnings(
  content: string,
  parsed: ReturnType<typeof parseNoteProperties>,
): NotePropertyWarning[] {
  if (
    /^(?:\uFEFF)?---[ \t]*(?:\r?\n|$)/.test(content) &&
    !parsed.hasFrontmatter &&
    parsed.warnings.length === 0
  ) {
    return [{ message: 'Frontmatter is not closed or cannot be projected safely.' }];
  }
  return parsed.warnings;
}

function storedNote(database: Database, noteId: string, projectRoot: string): StoredNoteRow | null {
  const scope = noteScopeSql(projectRoot);
  return database
    .query<StoredNoteRow, [string, string]>(
      `SELECT n.id, n.content, n.revision, n.format, n.project_root
       FROM notes AS n
       WHERE n.id = ? AND ${scope.sql}`,
    )
    .get(noteId, scope.values[0]!) as StoredNoteRow | null;
}

function writeProjection(database: Database, row: StoredNoteRow, projectRoot: string): void {
  const root = normalizedProjectRoot(projectRoot);
  const parsed =
    row.format === 'markdown'
      ? parseNoteProperties(row.content)
      : { properties: [], warnings: [], hasFrontmatter: false, body: row.content };
  const status = row.format === 'markdown' ? projectionStatus(row.content, parsed) : 'valid';
  const warnings = row.format === 'markdown' ? projectionWarnings(row.content, parsed) : [];
  const projectedProperties = status === 'invalid' ? [] : parsed.properties;

  database.query('DELETE FROM note_property_items WHERE note_id = ?').run(row.id);
  database.query('DELETE FROM note_properties WHERE note_id = ?').run(row.id);

  const insertProperty = database.prepare(`
    INSERT INTO note_properties (
      note_id, project_root, key, normalized_key, type, value_json,
      value_text, value_number, value_boolean, note_revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertItem = database.prepare(`
    INSERT INTO note_property_items (
      note_id, normalized_key, ordinal, project_root, value_text, normalized_text
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const property of projectedProperties) {
    const key = normalizedPropertyKey(property.key);
    const valueText =
      typeof property.value === 'string'
        ? property.type === 'datetime'
          ? new Date(property.value).toISOString().toLowerCase()
          : normalizedText(property.value)
        : null;
    const valueNumber = typeof property.value === 'number' ? property.value : null;
    const valueBoolean = typeof property.value === 'boolean' ? (property.value ? 1 : 0) : null;
    insertProperty.run(
      row.id,
      root,
      property.key,
      key,
      property.type,
      JSON.stringify(property.value),
      valueText,
      valueNumber,
      valueBoolean,
      row.revision,
    );
    if (Array.isArray(property.value)) {
      property.value.forEach((item, ordinal) => {
        insertItem.run(row.id, key, ordinal, root, item, normalizedText(item));
      });
    }
  }

  const frontmatterHash = createHash('sha256')
    .update(frontmatterSource(row.content), 'utf8')
    .digest('hex');
  database
    .query(
      `
      INSERT INTO note_property_documents (
        note_id, project_root, projected_revision, frontmatter_hash,
        status, issues_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(note_id) DO UPDATE SET
        project_root = excluded.project_root,
        projected_revision = excluded.projected_revision,
        frontmatter_hash = excluded.frontmatter_hash,
        status = excluded.status,
        issues_json = excluded.issues_json,
        updated_at = excluded.updated_at
    `,
    )
    .run(row.id, root, row.revision, frontmatterHash, status, JSON.stringify(warnings), Date.now());
}

function repairOneProjection(
  database: Database,
  noteId: string,
  projectRoot: string,
): NotePropertyProjection | null {
  const transaction = database.transaction(() => {
    const row = storedNote(database, noteId, projectRoot);
    if (!row) return null;
    const document = database
      .query<{ project_root: string; projected_revision: number }, [string]>(
        `SELECT project_root, projected_revision
         FROM note_property_documents WHERE note_id = ?`,
      )
      .get(noteId);
    if (document?.projected_revision !== row.revision || document.project_root !== projectRoot) {
      writeProjection(database, row, projectRoot);
    }

    const projected = database
      .query<ProjectionDocumentRow, [string]>(
        `SELECT note_id, project_root, projected_revision, status, issues_json
         FROM note_property_documents WHERE note_id = ?`,
      )
      .get(noteId);
    if (
      !projected ||
      projected.projected_revision !== row.revision ||
      projected.project_root !== projectRoot
    ) {
      throw new ConflictError('Note property projection changed while it was being repaired.', {
        noteId,
        noteRevision: row.revision,
        projectedRevision: projected?.projected_revision,
      });
    }
    const properties = database
      .query<StoredPropertyRow, [string]>(
        `SELECT key, type, value_json
         FROM note_properties
         WHERE note_id = ?
         ORDER BY rowid`,
      )
      .all(noteId)
      .map(parsePropertyValue)
      .filter((property): property is NoteProperty => property !== null);
    return {
      noteId: row.id,
      revision: row.revision,
      status: projected.status,
      properties,
      warnings: parseWarnings(projected.issues_json),
    } satisfies NotePropertyProjection;
  });
  return transaction();
}

/** Repair one note lazily. The note revision is re-read inside the same SQLite
 * transaction that replaces every derived property row and advances the
 * projection health marker. */
export function repairNotePropertyProjection(
  noteId: string,
  projectRoot = PROJECT_ROOT,
  database: Database = getDb(),
): NotePropertyProjection | null {
  return repairOneProjection(database, noteId, normalizedProjectRoot(projectRoot));
}

function rebuildPropertySchemas(database: Database, projectRoot: string): void {
  const root = normalizedProjectRoot(projectRoot);
  const aggregates = database
    .query<SchemaAggregateRow, [string]>(
      `SELECT p.normalized_key, MIN(p.key) AS display_name, p.type,
              COUNT(*) AS usage_count
       FROM note_properties AS p
       JOIN notes AS n ON n.id = p.note_id
       WHERE p.project_root = ? AND n.trashed_at IS NULL
         AND p.note_revision = n.revision
       GROUP BY p.normalized_key, p.type
       ORDER BY p.normalized_key, usage_count DESC, p.type ASC`,
    )
    .all(root);
  const existing = new Map(
    database
      .query<StoredSchemaRow, [string]>(
        `SELECT normalized_key, display_name, kind, revision, usage_count,
                invalid_count, created_at
         FROM note_property_schemas WHERE project_root = ?`,
      )
      .all(root)
      .map((row) => [row.normalized_key, row]),
  );
  const grouped = new Map<string, SchemaAggregateRow[]>();
  for (const aggregate of aggregates) {
    const rows = grouped.get(aggregate.normalized_key) ?? [];
    rows.push(aggregate);
    grouped.set(aggregate.normalized_key, rows);
  }

  const transaction = database.transaction(() => {
    database.query('DELETE FROM note_property_schemas WHERE project_root = ?').run(root);
    const insert = database.prepare(`
      INSERT INTO note_property_schemas (
        project_root, normalized_key, display_name, kind, revision,
        usage_count, invalid_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const now = Date.now();
    for (const [key, rows] of grouped) {
      rows.sort(
        (left, right) =>
          Number(right.usage_count) - Number(left.usage_count) ||
          left.type.localeCompare(right.type) ||
          left.display_name.localeCompare(right.display_name),
      );
      const selected = rows[0]!;
      const usageCount = rows.reduce((sum, row) => sum + Number(row.usage_count), 0);
      const invalidCount = usageCount - Number(selected.usage_count);
      const prior = existing.get(key);
      const changed =
        !prior ||
        prior.kind !== selected.type ||
        prior.display_name !== selected.display_name ||
        Number(prior.usage_count) !== usageCount ||
        Number(prior.invalid_count) !== invalidCount;
      insert.run(
        root,
        key,
        selected.display_name,
        selected.type,
        prior ? prior.revision + (changed ? 1 : 0) : 1,
        usageCount,
        invalidCount,
        prior?.created_at ?? now,
        now,
      );
    }
  });
  transaction();
}

function staleProjectionIds(database: Database, projectRoot: string): string[] {
  const scope = noteScopeSql(projectRoot);
  const root = normalizedProjectRoot(projectRoot);
  return database
    .query<{ id: string }, [string, string, number]>(
      `SELECT n.id
       FROM notes AS n
       LEFT JOIN note_property_documents AS d ON d.note_id = n.id
       WHERE ${scope.sql}
         AND (
           d.note_id IS NULL OR d.projected_revision <> n.revision
           OR d.project_root <> ?
         )
       ORDER BY n.id
       LIMIT ?`,
    )
    .all(scope.values[0]!, root, PROJECTION_PAGE_SIZE)
    .map((row) => row.id);
}

const repairFlights = new WeakMap<Database, Map<string, Promise<PropertyProjectionRepairReport>>>();

/** Bring every note in a project to the projected-revision invariant. Work is
 * paged and yields between pages, but no Base query is allowed to observe a
 * partial result: a final stale-row proof must pass. */
export async function repairProjectPropertyProjections(
  projectRoot = PROJECT_ROOT,
  database: Database = getDb(),
): Promise<PropertyProjectionRepairReport> {
  const root = normalizedProjectRoot(projectRoot);
  let databaseFlights = repairFlights.get(database);
  if (!databaseFlights) {
    databaseFlights = new Map();
    repairFlights.set(database, databaseFlights);
  }
  const active = databaseFlights.get(root);
  if (active) return active;

  const flight = (async () => {
    const repairAttempts = new Map<string, number>();
    const report: PropertyProjectionRepairReport = {
      scanned: 0,
      repaired: 0,
      invalid: 0,
      unsupported: 0,
    };
    for (;;) {
      const ids = staleProjectionIds(database, root);
      if (ids.length === 0) break;
      report.scanned += ids.length;
      for (const id of ids) {
        const attempts = (repairAttempts.get(id) ?? 0) + 1;
        repairAttempts.set(id, attempts);
        if (attempts > 3) {
          throw new ConflictError(
            'A note changed continuously while its properties were indexed. Retry the Base query.',
            { noteId: id },
          );
        }
        const projection = repairOneProjection(database, id, root);
        if (!projection) continue;
        report.repaired++;
        if (projection.status === 'invalid') report.invalid++;
        if (projection.status === 'unsupported') report.unsupported++;
      }
      await new Promise<void>((resolveYield) => setImmediate(resolveYield));
    }
    if (staleProjectionIds(database, root).length > 0) {
      throw new ConflictError(
        'Notes changed continuously while properties were indexed. Retry the Base query.',
      );
    }
    rebuildPropertySchemas(database, root);
    return report;
  })();
  databaseFlights.set(root, flight);
  try {
    return await flight;
  } finally {
    if (databaseFlights.get(root) === flight) databaseFlights.delete(root);
  }
}

export async function getNotePropertyProjection(
  noteId: string,
  projectRoot = PROJECT_ROOT,
  database: Database = getDb(),
): Promise<NotePropertyProjection> {
  const projection = repairNotePropertyProjection(noteId, projectRoot, database);
  if (!projection) throw new NotFoundError('Note', noteId);
  rebuildPropertySchemas(database, normalizedProjectRoot(projectRoot));
  return projection;
}

export async function listNotePropertySchemas(
  projectRoot = PROJECT_ROOT,
  database: Database = getDb(),
): Promise<NotePropertySchemaSummary[]> {
  const root = normalizedProjectRoot(projectRoot);
  await repairProjectPropertyProjections(root, database);
  return database
    .query<
      {
        normalized_key: string;
        display_name: string;
        kind: NotePropertyType;
        revision: number;
        usage_count: number;
        invalid_count: number;
        created_at: number;
        updated_at: number;
      },
      [string]
    >(
      `SELECT normalized_key, display_name, kind, revision, usage_count,
              invalid_count, created_at, updated_at
       FROM note_property_schemas
       WHERE project_root = ?
       ORDER BY display_name COLLATE NOCASE, normalized_key`,
    )
    .all(root)
    .map((row) => ({
      key: row.normalized_key,
      displayName: row.display_name,
      kind: row.kind,
      revision: row.revision,
      usageCount: Number(row.usage_count),
      invalidCount: Number(row.invalid_count),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    }));
}

export function assertProjectPropertyProjectionCurrent(
  projectRoot = PROJECT_ROOT,
  database: Database = getDb(),
): void {
  const stale = staleProjectionIds(database, normalizedProjectRoot(projectRoot));
  if (stale.length > 0) {
    throw new ConflictError('Note properties are still being indexed.', {
      staleNoteIds: stale.slice(0, 10),
      staleCountAtLeast: stale.length,
    });
  }
}
