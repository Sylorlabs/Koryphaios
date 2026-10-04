import { ValidationError } from '../../../errors/types';
import { capabilityFetch } from '../http';
import type {
  CapabilityAdapter,
  CapabilityEmbedRequest,
  CapabilityModelDef,
  CapabilityRerankRequest,
  CapabilityRerankResult,
  CapabilityVerifyResult,
  ResolvedCapabilityConfig,
} from '../types';

/**
 * Voyage AI — retrieval models (embeddings, rerankers, contextualized chunks).
 *
 * Base URL: `https://api.voyageai.com/v1`
 * Auth:     `Authorization: Bearer <key>`
 * Embed:    `POST /embeddings` → `{ data: [{ embedding, index }] }`
 * Rerank:   `POST /rerank`    → `{ data: [{ index, relevance_score }] }`
 *
 * Voyage adds no chat, image, or video endpoint, so this adapter covers
 * retrieval only. It is opt-in as the semantic-memory embedding provider.
 */
const BASE_URL = 'https://api.voyageai.com/v1';

const EMBEDDING_MODELS: CapabilityModelDef[] = [
  { id: 'voyage-3.5', label: 'Voyage 3.5', capability: 'embedding' },
  { id: 'voyage-3.5-lite', label: 'Voyage 3.5 Lite', capability: 'embedding' },
  { id: 'voyage-3-large', label: 'Voyage 3 Large', capability: 'embedding' },
  { id: 'voyage-code-3', label: 'Voyage Code 3', capability: 'embedding' },
];

const RERANK_MODELS: CapabilityModelDef[] = [
  { id: 'rerank-3', label: 'Rerank 3', capability: 'rerank' },
  { id: 'rerank-3-lite', label: 'Rerank 3 Lite', capability: 'rerank' },
  { id: 'rerank-2.5', label: 'Rerank 2.5', capability: 'rerank' },
  { id: 'rerank-2.5-lite', label: 'Rerank 2.5 Lite', capability: 'rerank' },
];

function authHeaders(config: ResolvedCapabilityConfig): Record<string, string> {
  return { Authorization: `Bearer ${config.apiKey}` };
}

export const voyageAiAdapter: CapabilityAdapter = {
  provider: 'voyageai',
  capabilities: ['embedding', 'rerank'],
  defaultBaseUrl: BASE_URL,

  async verify(config, signal): Promise<CapabilityVerifyResult> {
    try {
      // Embedding a single short string is the cheapest authenticated call.
      await capabilityFetch('Voyage AI', `${config.baseUrl}/embeddings`, config, {
        method: 'POST',
        headers: authHeaders(config),
        json: { input: ['kory'], model: 'voyage-3.5-lite', input_type: 'document' },
        signal,
        timeoutMs: 20_000,
      });
      return { ok: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: `Voyage AI credential check failed: ${message}`,
        credentialProblem: /HTTP 40[13]|credential|unauthorized|forbidden|api.?key/i.test(message),
      };
    }
  },

  listModels(_config, capability): Promise<CapabilityModelDef[]> {
    if (capability === 'embedding') return Promise.resolve(EMBEDDING_MODELS);
    if (capability === 'rerank') return Promise.resolve(RERANK_MODELS);
    return Promise.resolve([]);
  },

  async embed(request: CapabilityEmbedRequest): Promise<number[][]> {
    const { config, signal } = request;
    if (!request.inputs.length) throw new ValidationError('No text was supplied to embed.');
    if (request.inputs.some((input) => !input.trim())) {
      throw new ValidationError('Embedding input cannot contain empty text.');
    }
    const payload: Record<string, unknown> = {
      input: request.inputs,
      model: request.model,
    };
    // `input_type` materially changes retrieval quality, so it is forwarded
    // whenever the caller knows the role of the text.
    if (request.inputType) payload.input_type = request.inputType;
    if (typeof request.dimensions === 'number' && Number.isInteger(request.dimensions)) {
      payload.output_dimension = request.dimensions;
    }
    const result = await capabilityFetch('Voyage AI', `${config.baseUrl}/embeddings`, config, {
      method: 'POST',
      headers: authHeaders(config),
      json: payload,
      signal,
      timeoutMs: 60_000,
    });
    const data = (result.json as Record<string, unknown> | undefined)?.data;
    if (!Array.isArray(data) || data.length !== request.inputs.length) {
      throw new ValidationError(
        'Voyage AI returned a different number of embeddings than inputs supplied.',
      );
    }
    // Preserve the caller's input order: the API returns an explicit index and
    // is not contractually required to emit results in order.
    const ordered: Array<number[]> = new Array(request.inputs.length);
    for (const entry of data as Array<Record<string, unknown>>) {
      const position = Number(entry.index);
      const embedding = entry.embedding;
      if (!Number.isInteger(position) || !Array.isArray(embedding)) {
        throw new ValidationError('Voyage AI returned a malformed embedding entry.');
      }
      if (position < 0 || position >= ordered.length) continue;
      ordered[position] = embedding.map(Number);
    }
    if (ordered.some((vector) => !vector)) {
      throw new ValidationError('Voyage AI returned an incomplete embedding set.');
    }
    return ordered;
  },

  async rerank(request: CapabilityRerankRequest): Promise<CapabilityRerankResult[]> {
    const { config, signal } = request;
    if (!request.documents.length) {
      throw new ValidationError('No documents were supplied to rerank.');
    }
    const payload: Record<string, unknown> = {
      query: request.query,
      documents: request.documents,
      model: request.model,
    };
    if (typeof request.topK === 'number' && request.topK > 0) {
      payload.top_k = Math.min(request.topK, request.documents.length);
    }
    const result = await capabilityFetch('Voyage AI', `${config.baseUrl}/rerank`, config, {
      method: 'POST',
      headers: authHeaders(config),
      json: payload,
      signal,
      timeoutMs: 60_000,
    });
    const data = (result.json as Record<string, unknown> | undefined)?.data;
    if (!Array.isArray(data)) {
      throw new ValidationError('Voyage AI returned no reranking results.');
    }
    return (data as Array<Record<string, unknown>>)
      .map((entry) => ({
        index: Number(entry.index),
        relevanceScore: Number(entry.relevance_score),
      }))
      .filter(
        (entry) =>
          Number.isInteger(entry.index) &&
          entry.index >= 0 &&
          entry.index < request.documents.length &&
          Number.isFinite(entry.relevanceScore),
      )
      .sort((a, b) => b.relevanceScore - a.relevanceScore);
  },
};

export const VOYAGE_EMBEDDING_MODELS = EMBEDDING_MODELS;
export const VOYAGE_RERANK_MODELS = RERANK_MODELS;
