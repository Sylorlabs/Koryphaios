import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { getDb } from '../db';
import {
  configuredEmbeddingClient,
  cosineSimilarity,
  validateVector,
  type EmbeddingClient,
} from '../memory/semantic-embeddings';
import { resolveProjectIdentity } from '../runtime/request-project';
import { PROJECT_ROOT } from '../runtime/paths';
import { checkNoteToolPermission, loadNotesSettings } from './notes-settings';
import { readNoteBody } from './note-document';

/** One bounded representation per note. Coverage counts notes, not complete document chunks. */
export const NOTE_SEMANTIC_REPRESENTATION_CHARS = 8000;
/** Hard per-request limits; persistent rebuilds still reach the entire corpus by ID cursor. */
export const NOTE_SEMANTIC_SEARCH_MAX_VECTORS = 512;
const SEARCH_PAGE_SIZE = 32;
const MAX_VECTOR_JSON_CHARS = 512 * 1024;
const cooperate = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
export const NOTE_SEMANTIC_INDEX_DDL = `
CREATE TABLE IF NOT EXISTS note_semantic_index_state (
 project_root TEXT PRIMARY KEY, provider_identity TEXT NOT NULL, cursor TEXT NOT NULL DEFAULT '',
 opted_in_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS note_semantic_vectors (
 project_root TEXT NOT NULL, note_id TEXT NOT NULL, provider_identity TEXT NOT NULL,
 revision INTEGER NOT NULL, content_hash TEXT NOT NULL, vector_json TEXT NOT NULL, indexed_at INTEGER NOT NULL,
 PRIMARY KEY(project_root,note_id), FOREIGN KEY(note_id) REFERENCES notes(id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS idx_note_semantic_vectors_provider ON note_semantic_vectors(project_root,provider_identity);`;

interface Options {
  database?: Database;
  signal?: AbortSignal;
  client?: EmbeddingClient | null;
}
interface Note {
  id: string;
  title: string;
  content: string;
  revision: number;
  projectRoot: string | null;
}
interface Vector {
  provider_identity: string;
  revision: number;
  content_hash: string;
  vector_json: string;
}
interface State {
  provider_identity: string;
  cursor: string;
}
export interface NoteSemanticIndexStatus {
  available: boolean;
  enabled: boolean;
  mode: 'disabled' | 'permission_denied' | 'unavailable' | 'not_opted_in' | 'partial' | 'ready';
  eligibleNotes: number;
  indexedNotes: number;
  staleNotes: number;
  coverage: number;
  cursor: string;
  providerIdentity: string | null;
  representationChars: number;
  /** Counts are a scoped-row revision inventory, not a full-content/vector integrity audit. */
  coverageBasis: 'revision_metadata';
  countsAvailable: boolean;
  /** Search diagnostics also travel with coverage through retrieval callers. */
  search?: {
    exhaustive: boolean;
    scannedVectors: number;
    maxVectors: number;
    reason:
      'complete' | 'vector_limit' | 'vector_size_limit' | 'timeout' | 'canceled' | 'unavailable';
  };
}
function project(projectRoot: string) {
  if (typeof projectRoot !== 'string' || !projectRoot.trim())
    throw new Error('A host-owned project root is required');
  return resolveProjectIdentity(projectRoot);
}
function allowed(root: string) {
  return (
    loadNotesSettings(root).enabled &&
    ['read_note', 'search_notes', 'retrieve_note_context'].every((name) => {
      const permission = checkNoteToolPermission(name, root);
      return permission.allowed && !permission.requiresApproval;
    })
  );
}
function clientFor(options: Options): EmbeddingClient | null {
  return options.client === undefined ? configuredEmbeddingClient() : options.client;
}
function scope(root: string) {
  return root === resolveProjectIdentity(PROJECT_ROOT)
    ? '(project_root = ? OR project_root IS NULL)'
    : 'project_root = ?';
}
function visible(note: Note, root: string) {
  if (resolveProjectIdentity(note.projectRoot || PROJECT_ROOT) !== root) return false;
  if (!note.id.startsWith('project-document:')) return true;
  try {
    const identity = JSON.parse(Buffer.from(note.id.slice(17), 'base64url').toString('utf8'));
    return (
      Array.isArray(identity) &&
      typeof identity[0] === 'string' &&
      resolveProjectIdentity(identity[0]) === root
    );
  } catch {
    return false;
  }
}
function current(database: Database, root: string, id: string): Note | undefined {
  const row = database
    .query<Note, [string, string]>(
      `SELECT id,title,content,revision,project_root AS projectRoot FROM notes WHERE id=? AND trashed_at IS NULL AND ${scope(root)}`,
    )
    .get(id, root);
  // The vector/hash always describes the resolved body, never the (possibly
  // empty) stored column.
  return row && visible(row, root) ? { ...row, content: readNoteBody(row) } : undefined;
}
function hash(note: Note) {
  return createHash('sha256')
    .update(JSON.stringify([note.title, note.content]))
    .digest('hex');
}
function state(database: Database, root: string) {
  return database
    .query<State, [string]>(
      'SELECT provider_identity,cursor FROM note_semantic_index_state WHERE project_root=?',
    )
    .get(root);
}
function vector(database: Database, root: string, id: string) {
  return database
    .query<Vector, [string, string]>(
      'SELECT provider_identity,revision,content_hash,vector_json FROM note_semantic_vectors WHERE project_root=? AND note_id=?',
    )
    .get(root, id);
}
function valid(row: Vector | null, note: Note, identity: string): row is Vector {
  if (
    !row ||
    row.provider_identity !== identity ||
    row.revision !== note.revision ||
    row.content_hash !== hash(note)
  )
    return false;
  try {
    validateVector(JSON.parse(row.vector_json));
    return true;
  } catch {
    return false;
  }
}

/** No transport and no writes: can safely be called by status UI or retrieval. */
export function getNoteSemanticIndexStatus(
  projectRoot: string,
  options: Options = {},
): NoteSemanticIndexStatus {
  const root = project(projectRoot),
    database = options.database ?? getDb();
  const status: NoteSemanticIndexStatus = {
    available: false,
    enabled: false,
    mode: 'unavailable',
    eligibleNotes: 0,
    indexedNotes: 0,
    staleNotes: 0,
    coverage: 0,
    cursor: '',
    providerIdentity: null,
    representationChars: NOTE_SEMANTIC_REPRESENTATION_CHARS,
    coverageBasis: 'revision_metadata',
    countsAvailable: false,
  };
  // Gate before touching the corpus, including metadata. A denied/disabled status is not
  // an empty-corpus claim: countsAvailable stays false and coverage stays zero.
  if (!allowed(root)) {
    status.mode = 'permission_denied';
    return status;
  }
  let client: EmbeddingClient | null;
  try {
    client = clientFor(options);
  } catch {
    return status;
  }
  status.providerIdentity = client?.identity ?? null;
  if (!client) {
    status.mode = 'disabled';
    return status;
  }
  try {
    const saved = state(database, root);
    status.available = true;
    status.cursor = saved?.cursor ?? '';
    status.enabled = saved?.provider_identity === client.identity;
    if (!status.enabled) {
      status.mode = 'not_opted_in';
      return status;
    }
    // One metadata-only aggregate, not N+1 body hashes/vector parses. The inventory counts
    // scoped, nontrashed rows; encoded-ID visibility and content integrity are checked only
    // for actual evidence/export. `ready` means revision coverage, never an integrity audit.
    const counts = database
      .query<
        {
          eligible: number;
          indexed: number;
          stale: number;
        },
        [string, string, string, string]
      >(
        `
      SELECT COUNT(*) AS eligible,
        COALESCE(SUM(v.provider_identity = ? AND v.revision = n.revision), 0) AS indexed,
        COALESCE(SUM(v.note_id IS NOT NULL AND
          (v.provider_identity != ? OR v.revision != n.revision)), 0) AS stale
      FROM notes n LEFT JOIN note_semantic_vectors v ON v.project_root = ? AND v.note_id = n.id
      WHERE n.trashed_at IS NULL AND ${scope(root).replaceAll('project_root', 'n.project_root')}
    `,
      )
      .get(client.identity, client.identity, root, root)!;
    status.eligibleNotes = counts.eligible;
    status.indexedNotes = counts.indexed;
    status.staleNotes = counts.stale;
    status.countsAvailable = true;
    status.coverage = counts.eligible ? counts.indexed / counts.eligible : 1;
    status.mode = counts.indexed === counts.eligible ? 'ready' : 'partial';
  } catch {
    status.available = false;
    status.mode = 'unavailable';
  }
  return status;
}

/** Explicit user opt-in only; repeated bounded pages resume by durable note ID, not recency. */
export async function rebuildNoteSemanticIndex(
  projectRoot: string,
  input: { optIn: true; limit?: number; reset?: boolean },
  options: Options = {},
) {
  const root = project(projectRoot),
    database = options.database ?? getDb();
  if (input?.optIn !== true) throw new Error('Explicit semantic indexing opt-in is required');
  const limit = input.limit ?? 32;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128)
    throw new Error('limit must be an integer from 1 to 128');
  if (input.reset !== undefined && typeof input.reset !== 'boolean')
    throw new Error('reset must be a boolean');
  let processed = 0,
    indexed = 0,
    skipped = 0,
    canceled = !!options.signal?.aborted,
    hasMore = false;
  const result = () => ({
    status: getNoteSemanticIndexStatus(root, options),
    processed,
    indexed,
    skipped,
    canceled,
    hasMore,
  });
  let client: EmbeddingClient | null;
  try {
    client = clientFor(options);
  } catch {
    return result();
  }
  if (!client || !allowed(root) || canceled) return result();
  let saved: State | null;
  try {
    saved = state(database, root);
  } catch {
    return result();
  }
  const cursor = input.reset || saved?.provider_identity !== client.identity ? '' : saved.cursor;
  const now = Date.now();
  database
    .query(
      `INSERT INTO note_semantic_index_state VALUES(?,?,?,?,?) ON CONFLICT(project_root) DO UPDATE SET provider_identity=excluded.provider_identity,cursor=excluded.cursor,opted_in_at=excluded.opted_in_at,updated_at=excluded.updated_at`,
    )
    .run(root, client.identity, cursor, now, now);
  // Do not sweep the corpus here: even limit:1 must bound mutation work. Stale entries are
  // replaced within the ID page; deleted notes normally cascade. Read paths reject leftovers.
  // Fetch IDs only: a page never holds 128 unbounded note bodies in memory.
  const page = database
    .query<{ id: string }, [string, string, number]>(
      `SELECT id FROM notes WHERE trashed_at IS NULL AND ${scope(root)} AND id > ? ORDER BY id LIMIT ?`,
    )
    .all(root, cursor, limit + 1);
  hasMore = page.length > limit;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  const deadline = Date.now() + 15000;
  const timer = setTimeout(cancel, 15000);
  const stillAllowed = () =>
    !controller.signal.aborted &&
    Date.now() < deadline &&
    allowed(root) &&
    clientFor(options)?.identity === client!.identity &&
    state(database, root)?.provider_identity === client!.identity;
  try {
    for (const candidate of page.slice(0, limit)) {
      await cooperate();
      if (Date.now() >= deadline) cancel();
      if (!stillAllowed()) {
        canceled = controller.signal.aborted;
        hasMore = true;
        break;
      }
      const note = current(database, root, candidate.id);
      if (note && !valid(vector(database, root, note.id), note, client.identity)) {
        const contentHash = hash(note);
        const text = `${note.title}\n\n${note.content}`.slice(
          0,
          NOTE_SEMANTIC_REPRESENTATION_CHARS,
        );
        if (text.trim()) {
          // Resolve visibility/revision immediately before export, and recheck after transport.
          if (!stillAllowed()) {
            canceled = controller.signal.aborted || Date.now() >= deadline;
            hasMore = true;
            break;
          }
          const [embedding] = await client.embed([text], { signal: controller.signal });
          const after = current(database, root, note.id);
          if (!stillAllowed()) {
            canceled = controller.signal.aborted || Date.now() >= deadline;
            hasMore = true;
            break;
          }
          if (after && after.revision === note.revision && hash(after) === contentHash) {
            validateVector(embedding);
            database
              .query(
                `INSERT INTO note_semantic_vectors VALUES(?,?,?,?,?,?,?) ON CONFLICT(project_root,note_id) DO UPDATE SET provider_identity=excluded.provider_identity,revision=excluded.revision,content_hash=excluded.content_hash,vector_json=excluded.vector_json,indexed_at=excluded.indexed_at`,
              )
              .run(
                root,
                note.id,
                client.identity,
                note.revision,
                contentHash,
                JSON.stringify(embedding),
                Date.now(),
              );
            indexed++;
          } else skipped++;
        } else skipped++;
      } else skipped++;
      processed++;
      database
        .query(
          'UPDATE note_semantic_index_state SET cursor=?,updated_at=? WHERE project_root=? AND provider_identity=?',
        )
        .run(candidate.id, Date.now(), root, client.identity);
    }
    if (!hasMore && processed === Math.min(page.length, limit))
      database
        .query(
          "UPDATE note_semantic_index_state SET cursor='',updated_at=? WHERE project_root=? AND provider_identity=?",
        )
        .run(Date.now(), root, client.identity);
  } catch {
    canceled = controller.signal.aborted;
    hasMore = true;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
  }
  return result();
}

/** Revalidate semantic evidence at a caller's own async-to-snapshot boundary. */
export function isCurrentNoteSemanticHit(
  projectRoot: string,
  hit: { id: string; revision: number; contentHash: string },
  options: Pick<Options, 'database'> = {},
): boolean {
  const root = project(projectRoot);
  const note = current(options.database ?? getDb(), root, hit.id);
  return !!note && note.revision === hit.revision && hash(note) === hit.contentHash;
}

export async function searchNoteSemanticIndex(
  projectRoot: string,
  query: string,
  options: Options & { limit?: number; timeoutMs?: number; maxVectors?: number } = {},
) {
  const root = project(projectRoot),
    database = options.database ?? getDb();
  const boundedInteger = (value: number | undefined, fallback: number, maximum: number) =>
    Number.isFinite(value) ? Math.max(1, Math.min(maximum, Math.floor(value!))) : fallback;
  const maxVectors = boundedInteger(
    options.maxVectors,
    NOTE_SEMANTIC_SEARCH_MAX_VECTORS,
    NOTE_SEMANTIC_SEARCH_MAX_VECTORS,
  );
  const deadline = Date.now() + boundedInteger(options.timeoutMs, 1500, 15000);
  const status = getNoteSemanticIndexStatus(root, options);
  const diagnostics: NonNullable<NoteSemanticIndexStatus['search']> = {
    exhaustive: false,
    scannedVectors: 0,
    maxVectors,
    reason: 'unavailable',
  };
  status.search = diagnostics;
  const hits: Array<{ id: string; revision: number; contentHash: string; score: number }> = [];
  const result = (mode: 'used' | 'disabled' | 'permission_denied' | 'unavailable') => ({
    mode,
    status,
    hits,
    exhaustive: diagnostics.exhaustive,
    truncated: !diagnostics.exhaustive,
  });
  if (status.mode === 'permission_denied') return result('permission_denied');
  if (status.mode === 'disabled' || status.mode === 'not_opted_in') return result('disabled');
  if (!status.enabled || !status.available || !status.indexedNotes || options.signal?.aborted) {
    if (options.signal?.aborted) diagnostics.reason = 'canceled';
    return result('unavailable');
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, Math.max(1, deadline - Date.now()));
  const interrupted = () => {
    if (options.signal?.aborted) diagnostics.reason = 'canceled';
    else if (Date.now() >= deadline || controller.signal.aborted) diagnostics.reason = 'timeout';
    else return false;
    controller.abort();
    return true;
  };
  try {
    const client = clientFor(options)!;
    const stillAllowed = () =>
      !interrupted() &&
      allowed(root) &&
      clientFor(options)?.identity === client.identity &&
      state(database, root)?.provider_identity === client.identity;
    if (!stillAllowed()) return result('unavailable');
    // Only the query is exported. Search never repairs/indexes document content implicitly.
    const [queryVector] = await client.embed([query], { signal: controller.signal });
    if (!stillAllowed()) return result('unavailable');
    const limit = boundedInteger(options.limit, 24, 64);
    const ranked: typeof hits = [];
    let cursor = '';
    let more = true;
    let oversized = false;
    // Seek the scoped PRIMARY KEY directly. Do not filter stale/foreign/deleted entries in SQL:
    // each visited vector must consume the cap, even when it cannot be candidate evidence.
    const pageQuery = database.query<
      Vector & { note_id: string },
      [number, string, string, number]
    >(`
      SELECT note_id,provider_identity,revision,content_hash,substr(vector_json,1,?) AS vector_json
      FROM note_semantic_vectors WHERE project_root=? AND note_id>? ORDER BY note_id LIMIT ?
    `);
    while (more && diagnostics.scannedVectors < maxVectors) {
      await cooperate();
      if (!stillAllowed()) return result('unavailable');
      const pageSize = Math.min(SEARCH_PAGE_SIZE, maxVectors - diagnostics.scannedVectors);
      const page = pageQuery.all(MAX_VECTOR_JSON_CHARS + 1, root, cursor, pageSize);
      more = page.length === pageSize;
      for (const row of page) {
        if (interrupted()) return result('unavailable');
        diagnostics.scannedVectors++;
        cursor = row.note_id;
        if (row.provider_identity !== client.identity) continue;
        if (row.vector_json.length > MAX_VECTOR_JSON_CHARS) {
          oversized = true;
          continue;
        }
        try {
          const score = cosineSimilarity(queryVector, JSON.parse(row.vector_json));
          if (score > 0)
            ranked.push({
              id: row.note_id,
              revision: row.revision,
              contentHash: row.content_hash,
              score,
            });
        } catch {
          // Corrupt/different-dimension vectors are never evidence. Status is metadata only.
        }
      }
    }
    // A one-ID lookahead distinguishes an exactly-full final page without reading another vector.
    const capped =
      more &&
      !!database
        .query<{ note_id: string }, [string, string]>(
          'SELECT note_id FROM note_semantic_vectors WHERE project_root=? AND note_id>? ORDER BY note_id LIMIT 1',
        )
        .get(root, cursor);
    ranked.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    // Full-body hash validation is reserved for actual ranked candidates, at most maxVectors.
    // Cooperate between bodies; no stale/foreign/trashed candidate can survive current().
    for (const candidate of ranked) {
      await cooperate();
      if (!stillAllowed()) {
        hits.length = 0;
        return result('unavailable');
      }
      if (isCurrentNoteSemanticHit(root, candidate, { database })) hits.push(candidate);
      if (hits.length === limit) break;
    }
    // Earlier candidates may have changed while later ones yielded. Final bounded synchronous
    // snapshot validation has no async boundary before publication (callers recheck after awaits).
    if (!stillAllowed()) {
      hits.length = 0;
      return result('unavailable');
    }
    for (let i = hits.length - 1; i >= 0; i--) {
      if (interrupted()) {
        hits.length = 0;
        return result('unavailable');
      }
      if (!isCurrentNoteSemanticHit(root, hits[i], { database })) hits.splice(i, 1);
    }
    if (!stillAllowed()) {
      hits.length = 0;
      return result('unavailable');
    }
    diagnostics.exhaustive = !capped && !oversized;
    diagnostics.reason = capped ? 'vector_limit' : oversized ? 'vector_size_limit' : 'complete';
    return result('used');
  } catch {
    interrupted();
    hits.length = 0;
    return result('unavailable');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
  }
}
