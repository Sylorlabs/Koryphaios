import { createHash } from 'node:crypto';
import { requireCapabilityConfig } from '../providers/capability-service';

/** Opt-in OpenAI-compatible embeddings. No endpoint, model, or credential is inferred. */
export interface EmbeddingConfig {
  endpoint: string;
  model: string;
  apiKey: string;
  dimensions: number;
  timeoutMs?: number;
}

export const MAX_EMBEDDING_RESPONSE_BYTES = 8 * 1024 * 1024;

export type EmbeddingTransport = (url: string, init: RequestInit) => Promise<Response>;

export class EmbeddingError extends Error {
  constructor(
    public readonly code: 'configuration' | 'input' | 'transport' | 'response' | 'aborted',
  ) {
    super(`Embedding ${code} error`);
    this.name = 'EmbeddingError';
  }
}

export function validateVector(value: unknown, dimensions?: number): number[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 16384 ||
    (dimensions !== undefined && value.length !== dimensions) ||
    value.some((v) => typeof v !== 'number' || !Number.isFinite(v))
  ) {
    throw new EmbeddingError('response');
  }
  // Scale first to avoid overflow even for otherwise finite provider values.
  const scale = Math.max(...value.map(Math.abs));
  if (!scale) throw new EmbeddingError('response');
  return value as number[];
}

export function cosineSimilarity(a: number[], b: number[]): number {
  validateVector(a);
  validateVector(b, a.length);
  const sa = Math.max(...a.map(Math.abs));
  const sb = Math.max(...b.map(Math.abs));
  let dot = 0,
    aa = 0,
    bb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] / sa,
      y = b[i] / sb;
    dot += x * y;
    aa += x * x;
    bb += y * y;
  }
  return Math.max(-1, Math.min(1, dot / Math.sqrt(aa * bb)));
}

function validateConfig(config: EmbeddingConfig): void {
  try {
    const url = new URL(config.endpoint);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !config.model.trim() ||
      !config.apiKey.trim() ||
      /[\r\n]/.test(config.apiKey) ||
      !Number.isInteger(config.dimensions) ||
      config.dimensions < 1 ||
      config.dimensions > 16384 ||
      (config.timeoutMs !== undefined &&
        (!Number.isFinite(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 120000))
    ) {
      throw new Error();
    }
  } catch {
    throw new EmbeddingError('configuration');
  }
}

/** Reuses an existing environment credential only when explicitly named by the operator. */
export function embeddingConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): EmbeddingConfig | null {
  if (env.KORY_EMBEDDINGS_ENABLED !== '1') return null;
  const credentialVariable = env.KORY_EMBEDDING_API_KEY_ENV;
  const config: EmbeddingConfig = {
    endpoint: env.KORY_EMBEDDING_ENDPOINT ?? '',
    model: env.KORY_EMBEDDING_MODEL ?? '',
    apiKey: env.KORY_EMBEDDING_API_KEY || (credentialVariable ? env[credentialVariable] : '') || '',
    dimensions: Number(env.KORY_EMBEDDING_DIMENSIONS),
    timeoutMs: env.KORY_EMBEDDING_TIMEOUT_MS ? Number(env.KORY_EMBEDDING_TIMEOUT_MS) : 15000,
  };
  validateConfig(config);
  return config;
}

export class EmbeddingClient {
  readonly identity: string;
  readonly timeoutMs: number;
  private readonly config: EmbeddingConfig;
  constructor(
    config: EmbeddingConfig,
    private readonly transport: EmbeddingTransport = (url, init) => fetch(url, init),
  ) {
    validateConfig(config);
    this.config = { ...config };
    this.identity = createHash('sha256')
      .update(JSON.stringify([config.endpoint, config.model, config.dimensions, config.apiKey]))
      .digest('hex');
    this.timeoutMs = config.timeoutMs ?? 15000;
  }

  async embed(inputs: string[], options: { signal?: AbortSignal } = {}): Promise<number[][]> {
    if (options.signal?.aborted) throw new EmbeddingError('aborted');
    if (
      !inputs.length ||
      inputs.length > 64 ||
      inputs.some((s) => typeof s !== 'string' || !s.trim() || s.length > 16000)
    ) {
      throw new EmbeddingError('input');
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let cancel: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      cancel = () => {
        controller.abort();
        reject(new EmbeddingError('aborted'));
      };
      options.signal?.addEventListener('abort', cancel, { once: true });
    });
    try {
      // Race also bounds transports that ignore AbortSignal, including response-body reads.
      return await Promise.race([
        (async () => {
          const response = await this.transport(this.config.endpoint, {
            method: 'POST',
            redirect: 'error',
            signal: controller.signal,
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${this.config.apiKey}`,
            },
            body: JSON.stringify({
              model: this.config.model,
              input: inputs,
              encoding_format: 'float',
            }),
          });
          if (!response.ok) {
            void response.body?.cancel().catch(() => {});
            throw new EmbeddingError('transport');
          }
          if (controller.signal.aborted) {
            void response.body?.cancel().catch(() => {});
            throw new EmbeddingError('aborted');
          }
          if (
            !response.body ||
            Number(response.headers.get('content-length')) > MAX_EMBEDDING_RESPONSE_BYTES
          ) {
            void response.body?.cancel().catch(() => {});
            throw new EmbeddingError('response');
          }
          reader = response.body.getReader();
          const decoder = new TextDecoder();
          let bytes = 0,
            json = '';
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > MAX_EMBEDDING_RESPONSE_BYTES) throw new EmbeddingError('response');
            json += decoder.decode(chunk.value, { stream: true });
          }
          json += decoder.decode();
          const body = JSON.parse(json) as { data?: Array<{ index: number; embedding: unknown }> };
          if (!Array.isArray(body.data) || body.data.length !== inputs.length)
            throw new EmbeddingError('response');
          const vectors = new Array<number[]>(inputs.length);
          for (const row of body.data) {
            if (
              !row ||
              !Number.isInteger(row.index) ||
              row.index < 0 ||
              row.index >= inputs.length ||
              vectors[row.index]
            )
              throw new EmbeddingError('response');
            vectors[row.index] = validateVector(row.embedding, this.config.dimensions);
          }
          return vectors;
        })(),
        aborted,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new EmbeddingError('transport'));
          }, this.timeoutMs);
        }),
      ]);
    } catch (error) {
      // Never surface provider response bodies, URLs, input text, or transport errors containing keys.
      throw error instanceof EmbeddingError ? error : new EmbeddingError('transport');
    } finally {
      clearTimeout(timer);
      if (cancel) options.signal?.removeEventListener('abort', cancel);
      void reader?.cancel().catch(() => {});
    }
  }
}

export function configuredEmbeddingClient(): EmbeddingClient | null {
  const config = embeddingConfigFromEnv();
  if (config) return new EmbeddingClient(config);
  return voyageEmbeddingClient();
}

/**
 * Whether the operator explicitly chose Voyage for semantic embeddings.
 *
 * A connected Voyage credential is deliberately NOT enough. Semantic retrieval
 * feeds memory documents, note content, and user queries to the embedding
 * provider, so auto-selecting a paid third-party service merely because a key
 * exists would silently move content off the machine and start billing. The
 * choice has to be stated, exactly as the `KORY_EMBEDDINGS_ENABLED` gate
 * already requires for the generic endpoint.
 */
function voyageEmbeddingsOptedIn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.KORY_EMBEDDINGS_PROVIDER?.trim().toLowerCase() === 'voyageai';
}

// ─── Voyage AI (capability adapter) ────────────────────────────────────────

/**
 * Voyage AI can back semantic retrieval without pointing at a raw endpoint: the
 * credential lives in the provider registry, so enabling
 * `KORY_EMBEDDINGS_PROVIDER=voyageai` is enough.
 *
 * Both gates are required — the opt-in flag and a connected provider — because
 * every call sends user content to Voyage. With neither satisfied this returns
 * `null` and callers fall back to lexical search exactly as before.
 */
export function voyageEmbeddingClient(): EmbeddingClient | null {
  if (!voyageEmbeddingsOptedIn()) return null;
  const resolved = tryResolveCapabilityEmbedding('voyageai');
  return resolved ? new EmbeddingClient(resolved.config, resolved.transport) : null;
}

/** Model Voyage uses when the user has not chosen one. */
const VOYAGE_DEFAULT_MODEL = 'voyage-3.5-lite';
/** 1024 is a dimension every current Voyage embedding model can produce. */
const VOYAGE_DEFAULT_DIMENSIONS = 1024;

function tryResolveCapabilityEmbedding(
  provider: string,
): { config: EmbeddingConfig; transport: EmbeddingTransport } | null {
  try {
    const { adapter, config } = requireCapabilityConfig(provider);
    if (!adapter.embed) return null;
    const embeddingConfig: EmbeddingConfig = {
      // The endpoint is validated by `EmbeddingConfig`, so point it at the
      // adapter's embeddings path rather than its base URL.
      endpoint: `${config.baseUrl}/embeddings`,
      model: VOYAGE_DEFAULT_MODEL,
      apiKey: config.apiKey,
      dimensions: VOYAGE_DEFAULT_DIMENSIONS,
      timeoutMs: 30_000,
    };
    return {
      config: embeddingConfig,
      // The generic OpenAI-shaped transport works: Voyage's /embeddings takes
      // `input` and returns `data[].embedding`, and sending an unused
      // `encoding_format` is ignored.
      transport: (url, init) =>
        adapter.embed!({
          config,
          model: embeddingConfig.model,
          inputs: readInputs(init),
          inputType: 'document',
          signal: init?.signal ?? AbortSignal.timeout(embeddingConfig.timeoutMs!),
        }).then((vectors) => jsonResponse(vectors)),
    };
  } catch {
    return null;
  }
}

function readInputs(init: RequestInit | undefined): string[] {
  if (typeof init?.body !== 'string') return [];
  try {
    const parsed = JSON.parse(init.body) as { input?: unknown };
    return Array.isArray(parsed.input)
      ? parsed.input.filter((v): v is string => typeof v === 'string')
      : [];
  } catch {
    return [];
  }
}

function jsonResponse(vectors: number[][]): Response {
  return new Response(
    JSON.stringify({
      data: vectors.map((embedding, index) => ({ index, embedding })),
    }),
    { headers: { 'content-type': 'application/json' } },
  );
}

/**
 * Rerank candidate chunks with Voyage when it is configured.
 *
 * Semantic retrieval by cosine similarity alone routinely misses lexical
 * matches, and a reranker is the standard second pass over the top candidates.
 * Returns `null` when Voyage is not connected so callers keep the unreranked
 * ordering rather than failing the request.
 */
export async function rerankWithVoyage(
  query: string,
  documents: string[],
  options: { limit?: number; signal?: AbortSignal } = {},
): Promise<Array<{ index: number; relevanceScore: number }> | null> {
  if (!query.trim() || !documents.length) return null;
  try {
    const { adapter, config } = requireCapabilityConfig('voyageai');
    if (!adapter.rerank) return null;
    return await adapter.rerank({
      config,
      model: 'rerank-3',
      query,
      documents,
      topK: options.limit,
      signal: options.signal ?? AbortSignal.timeout(30_000),
    });
  } catch {
    return null;
  }
}
