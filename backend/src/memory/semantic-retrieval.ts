import { createHash } from 'node:crypto';
import {
  configuredEmbeddingClient,
  cosineSimilarity,
  rerankWithVoyage,
  type EmbeddingClient,
} from './semantic-embeddings';

export interface MemorySearchDocument {
  id: string;
  content: string;
}
export interface MemorySearchHit {
  id: string;
  content: string;
  score: number;
  offset: number;
}
export interface MemorySearchResult {
  mode: 'semantic' | 'lexical';
  reason?: 'disabled' | 'unavailable';
  hits: MemorySearchHit[];
  /** Search is deliberately bounded; callers must not imply exhaustive coverage. */
  truncated: boolean;
}

const MAX_CHUNKS = 256;
const CHUNK_CHARS = 2000;
const MAX_CACHE = 2048;
const MAX_CACHE_COMPONENTS = 1_048_576;
let cachedComponents = 0;
const vectors = new Map<string, number[]>();
const hash = (s: string) => createHash('sha256').update(s).digest('hex');

/** Snapshot-based retrieval: edits and deletes take effect immediately; no stale index rows. */
export async function retrieveMemory(
  scope: string,
  documents: MemorySearchDocument[],
  query: string,
  options: {
    limit?: number;
    client?: EmbeddingClient | null;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<MemorySearchResult> {
  const limit = Number.isFinite(options.limit)
    ? Math.max(1, Math.min(51, Math.floor(options.limit!)))
    : 10;
  const chunks: MemorySearchHit[] = [];
  let truncated = false;
  outer: for (const doc of documents) {
    for (let offset = 0; offset < doc.content.length; offset += CHUNK_CHARS) {
      const content = doc.content.slice(offset, offset + CHUNK_CHARS);
      if (!content.trim()) continue;
      if (chunks.length === MAX_CHUNKS) {
        truncated = true;
        break outer;
      }
      chunks.push({ id: doc.id, content, offset, score: 0 });
    }
  }
  const lexical = (reason: 'disabled' | 'unavailable'): MemorySearchResult => {
    const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])];
    return {
      mode: 'lexical',
      reason,
      truncated,
      hits: chunks
        .map((chunk) => ({
          ...chunk,
          score:
            terms.reduce((n, t) => n + (chunk.content.toLowerCase().includes(t) ? 1 : 0), 0) /
            Math.max(1, terms.length),
        }))
        .filter((chunk) => chunk.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit),
    };
  };
  if (!query.trim() || !chunks.length) return { mode: 'lexical', hits: [], truncated };
  if (query.length > 16000) return lexical('unavailable');
  const controller = new AbortController();
  const cancel = () => controller.abort();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  options.signal?.addEventListener('abort', cancel, { once: true });
  try {
    if (options.signal?.aborted) return lexical('unavailable');
    const client = options.client === undefined ? configuredEmbeddingClient() : options.client;
    if (!client) return lexical('disabled');
    const timeoutMs = Number.isFinite(options.timeoutMs)
      ? Math.max(1, Math.min(15000, options.timeoutMs!))
      : Math.min(15000, client.timeoutMs);
    deadline = setTimeout(cancel, timeoutMs);
    // Scope and provider/model identity isolate cached representations; only hashes and vectors are retained.
    const prefix = hash(JSON.stringify([scope, client.identity]));
    const keys = chunks.map((chunk) => prefix + hash(chunk.content));
    const missing = new Map<string, string>();
    // Hold references for this request so another concurrent search cannot evict
    // a vector while this request is awaiting transport.
    const cached = new Map<string, number[]>();
    chunks.forEach((chunk, i) => {
      const vector = vectors.get(keys[i]);
      if (vector) cached.set(keys[i], vector);
      else missing.set(keys[i], chunk.content);
    });
    const entries = [...missing];
    // Stage all new vectors until the entire request validates successfully.
    const staged = new Map<string, number[]>();
    for (let i = 0; i < entries.length; i += 64) {
      const batch = entries.slice(i, i + 64);
      const generated = await client.embed(
        batch.map(([, content]) => content),
        { signal: controller.signal },
      );
      batch.forEach(([key], j) => staged.set(key, generated[j]));
    }
    const [queryVector] = await client.embed([query], { signal: controller.signal });
    const ranked = chunks
      .map((chunk, i) => ({
        ...chunk,
        score: cosineSimilarity(queryVector, staged.get(keys[i]) ?? cached.get(keys[i])!),
      }))
      .sort((a, b) => b.score - a.score);

    // Second pass over the strongest candidates. Cosine similarity alone
    // routinely misses exact-token matches, and reranking is the standard fix.
    // Reranking only the shortlist keeps the extra request small and bounded.
    const hits = await applyRerank(query, ranked, limit, options.signal);
    for (const [key, vector] of staged) {
      cachedComponents -= vectors.get(key)?.length ?? 0;
      vectors.set(key, vector);
      cachedComponents += vector.length;
      while (vectors.size > MAX_CACHE || cachedComponents > MAX_CACHE_COMPONENTS) {
        const oldest = vectors.keys().next().value!;
        cachedComponents -= vectors.get(oldest)!.length;
        vectors.delete(oldest);
      }
    }
    return { mode: 'semantic', hits, truncated };
  } catch {
    return lexical('unavailable');
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener('abort', cancel);
  }
}

/** How many candidates are worth a reranker round trip. */
const RERANK_SHORTLIST = 30;

/**
 * Reorder a semantic shortlist with Voyage when it is connected.
 *
 * Returns the original ordering unchanged when Voyage is not configured or the
 * rerank call fails: reranking is an improvement, never a precondition for
 * recall.
 */
async function applyRerank(
  query: string,
  ranked: MemorySearchHit[],
  limit: number,
  signal: AbortSignal | undefined,
): Promise<MemorySearchHit[]> {
  const shortlist = ranked.slice(0, Math.max(RERANK_SHORTLIST, limit));
  const rest = ranked.slice(shortlist.length);
  if (!shortlist.length) return [];
  const reranked = await rerankWithVoyage(
    query,
    shortlist.map((hit) => hit.content),
    { limit, signal },
  );
  if (!reranked?.length) return ranked.slice(0, limit);
  const scores = new Map(reranked.map((entry) => [entry.index, entry.relevanceScore]));
  const reordered = [...shortlist.map((hit, index) => ({ hit, index }))]
    .filter(({ index }) => scores.has(index))
    .sort((a, b) => scores.get(b.index)! - scores.get(a.index)!)
    .map(({ hit }) => hit);
  return [...reordered, ...rest].slice(0, limit);
}
