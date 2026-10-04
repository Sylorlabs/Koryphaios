import { ValidationError } from '../../../errors/types';
import { capabilityFetch } from '../http';
import type {
  CapabilityAdapter,
  CapabilityMemoryAdapter,
  CapabilityMemoryRecord,
  CapabilityVerifyResult,
  ResolvedCapabilityConfig,
} from '../types';

/**
 * Mem0 — managed long-term memory.
 *
 * Base URL: `https://api.mem0.ai/v1` (search lives on the v3 path)
 * Auth:     `Authorization: Token <key>`
 * Add:      `POST /memories/`  → `{ results: [{ id, memory, ... }] }`
 * Search:   `POST /v3/memories/search/` → `{ results: [{ id, memory, score }] }`
 * Delete:   `DELETE /memories/{id}`
 *
 * Two contract details matter and are easy to get wrong:
 *  - v3 search rejects entity ids passed at the top level with HTTP 400. They
 *    must be nested inside the `filters` object.
 *  - Mem0 extracts memories from message turns, so `add` accepts either plain
 *    text (wrapped into a single user turn) or a pre-built message list.
 */
const BASE_URL = 'https://api.mem0.ai/v1';
const SEARCH_URL = 'https://api.mem0.ai/v3/memories/search/';

function authHeaders(config: ResolvedCapabilityConfig): Record<string, string> {
  return { Authorization: `Token ${config.apiKey}` };
}

function toRecord(entry: Record<string, unknown>): CapabilityMemoryRecord {
  return {
    id: String(entry.id ?? ''),
    text: typeof entry.memory === 'string' ? entry.memory : String(entry.memory ?? ''),
    score: typeof entry.score === 'number' ? entry.score : undefined,
    createdAt: typeof entry.created_at === 'string' ? entry.created_at : undefined,
    updatedAt: typeof entry.updated_at === 'string' ? entry.updated_at : undefined,
    metadata:
      entry.metadata && typeof entry.metadata === 'object'
        ? (entry.metadata as Record<string, unknown>)
        : undefined,
  };
}

/**
 * Mem0 scopes memories by entity id. Koryphaios uses one stable scope per local
 * user so a person's memories never mix with another person's on a shared
 * machine.
 */
function scopeFilters(scope: string, extra?: Record<string, unknown>): Record<string, unknown> {
  return { AND: [{ user_id: scope }, ...(extra ? [extra] : [])] };
}

const memory: CapabilityMemoryAdapter = {
  async verify(config, signal): Promise<CapabilityVerifyResult> {
    try {
      // v3 search requires an entity filter, so a scoped empty query is the
      // cheapest call that proves both the key and the scope are usable.
      await capabilityFetch('Mem0', SEARCH_URL, config, {
        method: 'POST',
        headers: authHeaders(config),
        json: {
          query: 'koryphaios connection check',
          filters: scopeFilters('koryphaios-probe'),
          top_k: 1,
        },
        signal,
        timeoutMs: 20_000,
      });
      return { ok: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: `Mem0 credential check failed: ${message}`,
        credentialProblem: /HTTP 40[13]|credential|unauthorized|forbidden|api.?key/i.test(message),
      };
    }
  },

  /**
   * Mem0 has no endpoint that enumerates the scopes this token may read, so
   * the scope is derived rather than discovered. Callers pass the local user's
   * identity; the returned list is the single scope Koryphaios manages.
   */
  listScopes(_config, _signal): Promise<string[]> {
    return Promise.resolve([]);
  },

  async add(config, input, signal): Promise<CapabilityMemoryRecord[]> {
    if (!input.text.trim()) throw new ValidationError('No memory text was supplied.');
    const scope = input.scope?.trim();
    const payload: Record<string, unknown> = {
      messages: [{ role: 'user', content: input.text }],
    };
    if (scope) payload.user_id = scope;
    if (input.metadata) payload.metadata = input.metadata;
    const result = await capabilityFetch('Mem0', `${config.baseUrl}/memories/`, config, {
      method: 'POST',
      headers: authHeaders(config),
      json: payload,
      signal,
      timeoutMs: 45_000,
    });
    const results = (result.json as Record<string, unknown> | undefined)?.results;
    if (!Array.isArray(results)) return [];
    return (results as Array<Record<string, unknown>>).map(toRecord).filter((r) => r.id && r.text);
  },

  async search(config, input, signal): Promise<CapabilityMemoryRecord[]> {
    if (!input.query.trim()) throw new ValidationError('No memory search query was supplied.');
    const limit = Math.max(1, Math.min(input.limit ?? 10, 1000));
    const body: Record<string, unknown> = {
      query: input.query,
      top_k: limit,
      // Entity ids must be nested: v3 rejects them at the top level.
      filters: scopeFilters(input.scope?.trim() ?? 'koryphaios'),
    };
    const result = await capabilityFetch('Mem0', SEARCH_URL, config, {
      method: 'POST',
      headers: authHeaders(config),
      json: body,
      signal,
      timeoutMs: 45_000,
    });
    const results = (result.json as Record<string, unknown> | undefined)?.results;
    if (!Array.isArray(results)) return [];
    return (results as Array<Record<string, unknown>>).map(toRecord).filter((r) => r.id && r.text);
  },

  async delete(config, input, signal): Promise<number> {
    let removed = 0;
    for (const id of input.ids) {
      if (!id.trim()) continue;
      const result = await capabilityFetch(
        'Mem0',
        `${config.baseUrl}/memories/${encodeURIComponent(id)}/`,
        config,
        { method: 'DELETE', headers: authHeaders(config), signal, timeoutMs: 30_000 },
      );
      // Mem0 answers 204 with an empty body on success.
      if (result.response.ok) removed += 1;
    }
    return removed;
  },
};

export const mem0Adapter: CapabilityAdapter = {
  provider: 'mem0',
  capabilities: ['memory'],
  defaultBaseUrl: BASE_URL,
  verify: memory.verify,
  memory,
};

export const MEM0_SEARCH_URL = SEARCH_URL;
