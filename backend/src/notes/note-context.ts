import type { Database } from 'bun:sqlite';
import { getDb } from '../db';
import {
  isCurrentNoteSemanticHit,
  searchNoteSemanticIndex,
  type NoteSemanticIndexStatus,
} from './note-semantic-index';
import { resolveProjectIdentity } from '../runtime/request-project';
import { PROJECT_ROOT } from '../runtime/paths';

/** Fixed work envelopes are not caller-configurable. No indexing, sync, or writes occur here. */
export const NOTE_CONTEXT_LIMITS = Object.freeze({
  candidates: 64,
  lexicalCandidates: 24,
  seeds: 8,
  visited: 48,
  edges: 96,
  fanout: 12,
  candidateChars: 8000,
  outputChars: 65536,
  semanticTimeoutMs: 1500,
});

export interface NoteContextInput {
  query: string;
  seedIds?: string[];
  limit?: number;
  maxHops?: number;
  maxChars?: number;
  excerptChars?: number;
  semantic?: boolean;
}
interface Options {
  database?: Database;
  signal?: AbortSignal;
}
interface Snapshot {
  id: string;
  title: string;
  revision: number;
  content: string;
  contentLength: number;
  windowStart: number;
  windowTruncated: boolean;
  projectRoot: string | null;
}
export interface NoteContextPathStep {
  fromId: string;
  toId: string;
  direction: 'outgoing' | 'incoming';
  kind: string;
  type?: string;
  status?: 'accepted';
  provenance: string;
  fromRevision: number;
  toRevision: number;
  relationshipRevision?: number;
  sourceRevision?: number;
  targetRevision?: number;
  stale: boolean;
  evidence?: string;
}
interface Candidate {
  note: Snapshot;
  score: number;
  sources: Array<'explicit' | 'lexical' | 'semantic' | 'graph'>;
  seedId: string;
  path: NoteContextPathStep[];
}
export interface NoteContextResult {
  query: string;
  /** Examined connections, including claims between independently selected seeds. */
  connections: NoteContextPathStep[];
  results: Array<{
    id: string;
    revision: number;
    title: string;
    excerpt: string;
    truncated: boolean;
    score: number;
    sources: Candidate['sources'];
    seedId: string;
    path: NoteContextPathStep[];
    explanation: string;
  }>;
  conflicts: Array<{
    noteId: string;
    reason: 'revision_changed' | 'unavailable' | 'stale_relationship';
    relatedNoteId?: string;
    expectedRevision: number;
    currentRevision?: number;
  }>;
  retrieval: {
    semantic: 'used' | 'disabled' | 'permission_denied' | 'unavailable';
    index: 'stored_snapshot' | 'persistent_semantic';
    coverage?: NoteSemanticIndexStatus;
    exhaustive: false;
  };
  truncation: { truncated: boolean; reasons: string[] };
  budget: {
    limits: typeof NOTE_CONTEXT_LIMITS & {
      limit: number;
      maxHops: number;
      maxChars: number;
      excerptChars: number;
    };
    used: {
      candidates: number;
      seeds: number;
      visited: number;
      edges: number;
      excerptChars: number;
      outputChars: number;
    };
  };
}

function integer(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function validate(input: NoteContextInput) {
  if (
    !input ||
    typeof input.query !== 'string' ||
    !input.query.trim() ||
    input.query.length > 2000
  ) {
    throw new Error('query must contain 1–2000 characters');
  }
  if (
    input.seedIds !== undefined &&
    (!Array.isArray(input.seedIds) ||
      input.seedIds.length > 8 ||
      input.seedIds.some((id) => typeof id !== 'string' || !id.trim() || id.length > 2048))
  ) {
    throw new Error('seedIds must contain at most 8 nonempty note IDs (max 2048 characters each)');
  }
  if (input.semantic !== undefined && typeof input.semantic !== 'boolean')
    throw new Error('semantic must be a boolean');
  return {
    query: input.query.trim(),
    seedIds: [...new Set(input.seedIds ?? [])],
    limit: integer(input.limit, 6, 1, 12, 'limit'),
    maxHops: integer(input.maxHops, 1, 0, 2, 'maxHops'),
    maxChars: integer(input.maxChars, 6000, 256, 16000, 'maxChars'),
    excerptChars: integer(input.excerptChars, 1000, 128, 2000, 'excerptChars'),
    semantic: input.semantic !== false,
  };
}

function assertActive(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('Note context retrieval canceled');
}

/** Apply both stored scope and encoded project-document identity, including legacy rows. */
function visible(note: Snapshot, root: string): boolean {
  if (note.id.startsWith('project-document:')) {
    try {
      const identity: unknown = JSON.parse(
        Buffer.from(note.id.slice(17), 'base64url').toString('utf8'),
      );
      if (
        !Array.isArray(identity) ||
        typeof identity[0] !== 'string' ||
        resolveProjectIdentity(identity[0]) !== root
      )
        return false;
    } catch {
      return false;
    }
  }
  return resolveProjectIdentity(note.projectRoot || PROJECT_ROOT) === root;
}

function scope(root: string, alias = 'n'): string {
  return root === resolveProjectIdentity(PROJECT_ROOT)
    ? `(${alias}.project_root = ? OR ${alias}.project_root IS NULL)`
    : `${alias}.project_root = ?`;
}

function readSnapshots(
  database: Database,
  ids: string[],
  root: string,
  anchor: string,
): Snapshot[] {
  if (!ids.length) return [];
  // Search the body in SQLite, but transfer only one bounded query-centered window per note.
  const rows = database
    .query<Snapshot, any[]>(
      `
    SELECT n.id, substr(n.title, 1, 300) AS title, n.revision, n.project_root AS projectRoot,
      length(n.content) AS contentLength,
      max(0, instr(lower(n.content), ?) - 1 - 1000) AS windowStart,
      substr(n.content, max(1, instr(lower(n.content), ?) - 1000), ?) AS content
    FROM notes n WHERE n.id IN (${ids.map(() => '?').join(',')})
      AND n.trashed_at IS NULL AND ${scope(root)}
  `,
    )
    .all(anchor, anchor, NOTE_CONTEXT_LIMITS.candidateChars, ...ids, root);
  return rows
    .filter((row) => visible(row, root))
    .map((row) => ({
      ...row,
      // SQLite substr counts Unicode code points; the public character budgets use
      // JavaScript UTF-16 units, so astral characters must not double the work cap.
      windowTruncated:
        row.windowStart > 0 ||
        row.contentLength > Array.from(row.content).length ||
        row.content.length > NOTE_CONTEXT_LIMITS.candidateChars,
      content: row.content.slice(0, NOTE_CONTEXT_LIMITS.candidateChars),
    }));
}

function lexicalIds(database: Database, query: string, root: string): string[] {
  const tokens = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
  if (!tokens.length) return [];
  try {
    const statement = database.query<{ id: string }, any[]>(`
      SELECT n.id FROM notes_fts JOIN notes n ON n.id = notes_fts.note_id
      WHERE notes_fts MATCH ? AND n.trashed_at IS NULL AND ${scope(root)}
      ORDER BY bm25(notes_fts), n.id LIMIT ?
    `);
    const limit = NOTE_CONTEXT_LIMITS.lexicalCandidates + 1;
    const expressions = tokens.map((token) => `${token}*`);
    const exact = statement.all(expressions.join(' '), root, limit).map((row) => row.id);
    if (exact.length >= limit || tokens.length === 1) return exact;
    // Agents ask natural-language questions, not necessarily Boolean keyword
    // queries. Preserve all-term matches first, then broaden without requiring
    // every filler word ("how should we implement") to appear in a source note.
    const stopWords = new Set([
      'a',
      'an',
      'and',
      'are',
      'as',
      'at',
      'be',
      'by',
      'can',
      'do',
      'for',
      'from',
      'how',
      'i',
      'in',
      'is',
      'it',
      'of',
      'on',
      'or',
      'our',
      'should',
      'that',
      'the',
      'this',
      'to',
      'was',
      'we',
      'what',
      'when',
      'where',
      'which',
      'with',
    ]);
    const meaningful = tokens.filter((token) => !stopWords.has(token));
    const broad = statement
      .all(
        (meaningful.length ? meaningful : tokens).map((token) => `${token}*`).join(' OR '),
        root,
        limit,
      )
      .map((row) => row.id);
    return [...new Set([...exact, ...broad])].slice(0, limit);
  } catch {
    // Pre-FTS databases retain read-only search. Escape LIKE wildcards supplied by the caller.
    const term = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
    return database
      .query<{ id: string }, any[]>(
        `
      SELECT n.id FROM notes n WHERE n.trashed_at IS NULL AND ${scope(root)}
        AND (n.title LIKE ? ESCAPE '\\' OR n.content LIKE ? ESCAPE '\\' OR n.tags LIKE ? ESCAPE '\\')
      ORDER BY n.updated_at DESC, n.id LIMIT ?
    `,
      )
      .all(root, term, term, term, NOTE_CONTEXT_LIMITS.lexicalCandidates + 1)
      .map((row) => row.id);
  }
}

function excerpt(
  note: Snapshot,
  query: string,
  limit: number,
): { text: string; truncated: boolean } {
  const lower = note.content.toLowerCase();
  let at = lower.indexOf(query.toLowerCase());
  if (at < 0) {
    const terms = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    at = terms.map((term) => lower.indexOf(term)).find((index) => index >= 0) ?? 0;
  }
  const start = Math.max(0, at - Math.floor(limit / 3));
  const text = note.content.slice(start, start + limit);
  return {
    text,
    truncated: note.windowTruncated || start > 0 || text.length < note.content.length,
  };
}

/** Retrieve evidence, not instructions: note text is untrusted content, never an authorization source. */
export async function retrieveNoteContext(
  input: NoteContextInput,
  projectRoot: string,
  options: Options = {},
): Promise<NoteContextResult> {
  const settings = validate(input);
  if (typeof projectRoot !== 'string' || !projectRoot.trim())
    throw new Error('A host-owned project root is required');
  const root = resolveProjectIdentity(projectRoot);
  const database = options.database ?? getDb();
  assertActive(options.signal);
  const reasons = new Set<string>();
  const anchor =
    settings.query.toLowerCase().match(/[\p{L}\p{N}]+/u)?.[0] ?? settings.query.toLowerCase();
  const lexical = lexicalIds(database, settings.query, root);
  if (lexical.length > NOTE_CONTEXT_LIMITS.lexicalCandidates) reasons.add('lexical_candidates');
  const ids = [
    ...new Set([...settings.seedIds, ...lexical.slice(0, NOTE_CONTEXT_LIMITS.lexicalCandidates)]),
  ];
  if (ids.length > NOTE_CONTEXT_LIMITS.candidates) reasons.add('candidates');
  const snapshots = readSnapshots(
    database,
    ids.slice(0, NOTE_CONTEXT_LIMITS.candidates),
    root,
    anchor,
  );
  if (snapshots.some((note) => note.windowTruncated)) reasons.add('candidate_windows');
  const ranked = new Map<string, Candidate>();
  const byId = new Map(snapshots.map((note) => [note.id, note]));
  const add = (id: string, source: Candidate['sources'][number], score: number) => {
    const note = byId.get(id);
    if (!note) return;
    const current = ranked.get(id);
    if (current) {
      current.score += score;
      if (!current.sources.includes(source)) current.sources.push(source);
    } else ranked.set(id, { note, score, sources: [source], seedId: id, path: [] });
  };
  settings.seedIds.forEach((id, index) => add(id, 'explicit', 4 + 1 / (index + 1)));
  lexical
    .slice(0, NOTE_CONTEXT_LIMITS.lexicalCandidates)
    .forEach((id, index) => add(id, 'lexical', 1 / (1 + index / 8)));

  let semantic: NoteContextResult['retrieval']['semantic'] = 'disabled';
  let coverage: NoteSemanticIndexStatus | undefined;
  if (settings.semantic) {
    const retrieval = await searchNoteSemanticIndex(root, settings.query, {
      database,
      signal: options.signal,
      limit: 24,
      timeoutMs: NOTE_CONTEXT_LIMITS.semanticTimeoutMs,
    });
    assertActive(options.signal);
    semantic = retrieval.mode;
    coverage = retrieval.status;
    if (coverage.mode === 'partial') reasons.add('semantic_index_partial');
    if (
      coverage.search &&
      !coverage.search.exhaustive &&
      retrieval.mode !== 'disabled' &&
      retrieval.mode !== 'permission_denied'
    ) {
      reasons.add(`semantic_${coverage.search.reason}`);
    }
    const semanticNotes = readSnapshots(
      database,
      retrieval.hits.map((hit) => hit.id),
      root,
      anchor,
    );
    for (const note of semanticNotes) {
      if (!byId.has(note.id)) {
        byId.set(note.id, note);
        snapshots.push(note);
      }
    }
    retrieval.hits.forEach((hit, index) => {
      if (
        byId.get(hit.id)?.revision === hit.revision &&
        isCurrentNoteSemanticHit(root, hit, { database })
      )
        add(hit.id, 'semantic', 1 / (1 + index / 8));
    });
  }

  // Revalidate after the only asynchronous boundary. All expansion/assembly below runs in
  // one synchronous read transaction, so excerpts and path endpoint revisions agree.
  return database.transaction(() => {
    assertActive(options.signal);
    const conflicts: NoteContextResult['conflicts'] = [];
    const current = new Map(
      readSnapshots(database, [...ranked.keys()], root, anchor).map((note) => [note.id, note]),
    );
    for (const [id, candidate] of ranked) {
      const note = current.get(id);
      if (
        !note ||
        note.revision !== candidate.note.revision ||
        note.content !== candidate.note.content ||
        note.title !== candidate.note.title
      ) {
        conflicts.push({
          noteId: id,
          reason: note ? 'revision_changed' : 'unavailable',
          expectedRevision: candidate.note.revision,
          ...(note ? { currentRevision: note.revision } : {}),
        });
        ranked.delete(id);
      } else candidate.note = note;
    }
    const sorted = [...ranked.values()].sort(
      (a, b) => b.score - a.score || a.note.id.localeCompare(b.note.id),
    );
    if (sorted.length > NOTE_CONTEXT_LIMITS.seeds) reasons.add('seeds');
    const seeds = sorted.slice(0, NOTE_CONTEXT_LIMITS.seeds);
    const candidates = new Map(seeds.map((candidate) => [candidate.note.id, candidate]));
    const connections: NoteContextPathStep[] = [];
    const edgeCount = expandGraph(
      database,
      candidates,
      seeds,
      root,
      anchor,
      settings.maxHops,
      reasons,
      conflicts,
      connections,
    );
    const results: NoteContextResult['results'] = [];
    let usedChars = 0;
    const ordered = [...candidates.values()].sort(
      (a, b) => b.score - a.score || a.note.id.localeCompare(b.note.id),
    );
    // Reserve one result for linked evidence when lexical matches would
    // otherwise consume every slot. Prefer a recorded counterpoint/replacement
    // over another generic neighbor; this is discovery diversity, not truth.
    if (settings.limit > 1 && ordered.length > settings.limit) {
      const linked = ordered.filter((candidate) => candidate.path.length > 0);
      const priority =
        linked.find((candidate) =>
          candidate.path.some((step) => step.type === 'contradicts' || step.type === 'supersedes'),
        ) ?? linked[0];
      if (priority && ordered.indexOf(priority) >= settings.limit) {
        ordered.splice(ordered.indexOf(priority), 1);
        ordered.splice(settings.limit - 1, 0, priority);
      }
    }
    for (const candidate of ordered) {
      if (results.length >= settings.limit) {
        reasons.add('result_limit');
        break;
      }
      const remaining = settings.maxChars - usedChars;
      if (remaining <= 0) {
        reasons.add('excerpt_budget');
        break;
      }
      const selected = excerpt(
        candidate.note,
        settings.query,
        Math.min(settings.excerptChars, remaining),
      );
      usedChars += selected.text.length;
      if (selected.truncated) reasons.add('excerpts');
      results.push({
        id: candidate.note.id,
        revision: candidate.note.revision,
        title: candidate.note.title,
        excerpt: selected.text,
        truncated: selected.truncated,
        score: Math.round(candidate.score * 10000) / 10000,
        sources: candidate.sources,
        seedId: candidate.seedId,
        path: candidate.path,
        explanation: candidate.path.length
          ? `${candidate.path.length}-hop graph neighbor of ${candidate.seedId}; accepted relationship labels: ${candidate.path.map((step) => step.type ?? 'document reference').join(' → ')}. Labels describe recorded claims, not independently verified facts; relationship evidence is not proof of agreement.${candidate.path.some((step) => step.stale) ? ' Stale relationship evidence: review changed endpoint revisions before relying on it.' : ''}`
          : `Seed selected by ${candidate.sources.join(' + ')} relevance.`,
      });
    }
    const result: NoteContextResult = {
      query: settings.query,
      connections,
      results,
      conflicts,
      retrieval: {
        semantic,
        index: semantic === 'used' ? 'persistent_semantic' : 'stored_snapshot',
        exhaustive: false,
        ...(coverage ? { coverage } : {}),
      },
      truncation: { truncated: reasons.size > 0, reasons: [...reasons] },
      budget: {
        limits: {
          ...NOTE_CONTEXT_LIMITS,
          limit: settings.limit,
          maxHops: settings.maxHops,
          maxChars: settings.maxChars,
          excerptChars: settings.excerptChars,
        },
        used: {
          candidates: snapshots.length,
          seeds: seeds.length,
          visited: candidates.size,
          edges: edgeCount,
          excerptChars: usedChars,
          outputChars: 0,
        },
      },
    };
    // Bound even unusually long stored IDs/path metadata. Excerpt budget is separate from JSON overhead.
    while (
      JSON.stringify(result).length > NOTE_CONTEXT_LIMITS.outputChars - 16 &&
      result.connections.length
    ) {
      result.connections.pop();
      if (!result.truncation.reasons.includes('output_budget'))
        result.truncation.reasons.push('output_budget');
      result.truncation.truncated = true;
    }
    while (
      JSON.stringify(result).length > NOTE_CONTEXT_LIMITS.outputChars - 16 &&
      result.results.length
    ) {
      result.budget.used.excerptChars -= result.results.pop()!.excerpt.length;
      if (!result.truncation.reasons.includes('output_budget'))
        result.truncation.reasons.push('output_budget');
      result.truncation.truncated = true;
    }
    while (
      JSON.stringify(result).length > NOTE_CONTEXT_LIMITS.outputChars - 16 &&
      result.conflicts.length
    ) {
      result.conflicts.pop();
      if (!result.truncation.reasons.includes('output_budget'))
        result.truncation.reasons.push('output_budget');
      result.truncation.truncated = true;
    }
    // Fixed point includes the digit width of outputChars itself.
    for (let i = 0; i < 4; i++) result.budget.used.outputChars = JSON.stringify(result).length;
    return result;
  })();
}

function expandGraph(
  database: Database,
  candidates: Map<string, Candidate>,
  seeds: Candidate[],
  root: string,
  anchor: string,
  maxHops: number,
  reasons: Set<string>,
  conflicts: NoteContextResult['conflicts'],
  connections: NoteContextPathStep[],
): number {
  interface Edge {
    fromId: string;
    toId: string;
    kind: string;
    type: string | null;
    status: 'accepted' | null;
    provenance: string;
    evidence: string;
    weight: number;
    relationshipRevision: number | null;
    sourceRevision: number | null;
    targetRevision: number | null;
    fromRevision: number;
    toRevision: number;
  }
  // Legacy fixtures/databases lack lifecycle columns; those associations are related_to only.
  const typed = database
    .query<{ name: string }, []>('PRAGMA table_info(note_relationships)')
    .all()
    .some((column) => column.name === 'status');
  let examined = 0;
  const seenEdges = new Set<string>();
  const queue = [...seeds];
  for (let index = 0; index < queue.length; index++) {
    const source = queue[index];
    if (source.path.length >= maxHops) continue;
    if (examined >= NOTE_CONTEXT_LIMITS.edges) {
      reasons.add('edges');
      break;
    }
    if (candidates.size >= NOTE_CONTEXT_LIMITS.visited) {
      reasons.add('visited');
      break;
    }
    const incident: Edge[] = [];
    // Each indexed direction has its own LIMIT; a high-degree node cannot materialize
    // an entire graph in memory. Both endpoints are scope/trash-filtered in SQL.
    for (const table of ['note_relationships', 'note_links'] as const) {
      const association = table === 'note_relationships';
      for (const column of ['from_note_id', 'to_note_id']) {
        const rows = database
          .query<Edge, any[]>(
            `
          SELECT e.from_note_id AS fromId, e.to_note_id AS toId,
            '${association ? 'association' : 'document_link'}' AS kind,
            ${association ? (typed ? 'e.type' : "'related_to'") : 'NULL'} AS type,
            ${association ? "'accepted'" : 'NULL'} AS status,
            ${association ? 'e.provenance' : "'document'"} AS provenance,
            ${association ? 'substr(e.evidence, 1, 300)' : "''"} AS evidence,
            ${association ? 'e.weight' : '1'} AS weight,
            ${association ? 'e.revision' : 'NULL'} AS relationshipRevision,
            ${association ? 'e.source_revision' : 'NULL'} AS sourceRevision,
            ${association ? 'e.target_revision' : 'NULL'} AS targetRevision,
            f.revision AS fromRevision, t.revision AS toRevision
          FROM ${table} e JOIN notes f ON f.id = e.from_note_id JOIN notes t ON t.id = e.to_note_id
          WHERE e.${column} = ? AND f.trashed_at IS NULL AND t.trashed_at IS NULL
            AND ${scope(root, 'f')} AND ${scope(root, 't')}
            ${association ? `AND e.project_root = ? ${typed ? "AND e.status = 'accepted'" : ''}` : ''}
          ORDER BY ${association ? 'e.weight DESC,' : ''} e.from_note_id, e.to_note_id LIMIT ?
        `,
          )
          .all(
            source.note.id,
            root,
            root,
            ...(association ? [root] : []),
            NOTE_CONTEXT_LIMITS.fanout + 1,
          );
        if (rows.length > NOTE_CONTEXT_LIMITS.fanout) reasons.add('fanout');
        incident.push(...rows);
      }
    }
    incident.sort(
      (a, b) =>
        a.kind.localeCompare(b.kind) ||
        b.weight - a.weight ||
        a.fromId.localeCompare(b.fromId) ||
        a.toId.localeCompare(b.toId),
    );
    const unique = [
      ...new Map(
        incident.map((edge) => [`${edge.kind}:${edge.fromId}:${edge.toId}`, edge]),
      ).values(),
    ];
    if (unique.length > NOTE_CONTEXT_LIMITS.fanout) reasons.add('fanout');
    for (const edge of unique.slice(0, NOTE_CONTEXT_LIMITS.fanout)) {
      const key = `${edge.kind}:${edge.fromId}:${edge.toId}`;
      if (seenEdges.has(key)) continue;
      if (examined >= NOTE_CONTEXT_LIMITS.edges) {
        reasons.add('edges');
        break;
      }
      seenEdges.add(key);
      examined++;
      const id = edge.fromId === source.note.id ? edge.toId : edge.fromId;
      const existing = candidates.get(id);
      if (!existing && candidates.size >= NOTE_CONTEXT_LIMITS.visited) {
        reasons.add('visited');
        break;
      }
      const note = existing?.note ?? readSnapshots(database, [id], root, anchor)[0];
      if (!note) continue; // Includes defense against malformed/foreign encoded document IDs.
      const stale =
        edge.relationshipRevision !== null &&
        (edge.sourceRevision !== edge.fromRevision || edge.targetRevision !== edge.toRevision);
      if (stale) {
        for (const [noteId, relatedNoteId, expectedRevision, currentRevision] of [
          [edge.fromId, edge.toId, edge.sourceRevision, edge.fromRevision],
          [edge.toId, edge.fromId, edge.targetRevision, edge.toRevision],
        ] as const) {
          if (expectedRevision !== null && expectedRevision !== currentRevision) {
            conflicts.push({
              noteId,
              relatedNoteId,
              reason: 'stale_relationship',
              expectedRevision,
              currentRevision,
            });
          }
        }
      }
      const step: NoteContextPathStep = {
        fromId: edge.fromId,
        toId: edge.toId,
        direction: edge.fromId === source.note.id ? 'outgoing' : 'incoming',
        kind: edge.kind,
        ...(edge.type ? { type: edge.type, status: 'accepted' as const } : {}),
        provenance: edge.provenance,
        fromRevision: edge.fromRevision,
        toRevision: edge.toRevision,
        stale,
        ...(edge.relationshipRevision !== null
          ? {
              relationshipRevision: edge.relationshipRevision,
              sourceRevision: edge.sourceRevision!,
              targetRevision: edge.targetRevision!,
            }
          : {}),
        ...(edge.evidence ? { evidence: edge.evidence } : {}),
      };
      connections.push(step);
      if (existing) continue;
      const degreePenalty =
        1 / Math.sqrt(Math.max(1, Math.min(unique.length, NOTE_CONTEXT_LIMITS.fanout)));
      const candidate: Candidate = {
        note,
        seedId: source.seedId,
        score:
          source.score *
          0.72 *
          degreePenalty *
          Math.max(0.1, Math.min(1, edge.weight)) *
          (stale ? 0.5 : 1),
        sources: ['graph'],
        path: [...source.path, step],
      };
      candidates.set(id, candidate);
      queue.push(candidate);
    }
  }
  return examined;
}
