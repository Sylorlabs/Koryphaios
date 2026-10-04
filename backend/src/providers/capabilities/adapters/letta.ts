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
 * Letta — stateful agents with two distinct memory surfaces.
 *
 * Base URL: `https://api.letta.com/v1`
 * Auth:     `Authorization: Bearer <key>`
 * Blocks:   `GET /agents/{id}/core-memory/blocks` — always-in-context memory.
 * Passage:  `POST /agents/{id}/passages` and `GET /agents/{id}/passages` —
 *           archival memory, a semantically searchable store.
 *
 * Koryphaios uses archival passages as the long-term recall surface: blocks are
 * pinned into an agent's prompt and are agent-managed, so writing user facts
 * into them would corrupt the agent's own state.
 */
const BASE_URL = 'https://api.letta.com/v1';

function authHeaders(config: ResolvedCapabilityConfig): Record<string, string> {
  return { Authorization: `Bearer ${config.apiKey}` };
}

/**
 * A Letta agent id is required for every archival operation. It is read from the
 * agent id recorded in settings; there is no safe default, because creating an
 * agent as a side effect of a memory write would bill and mutate the account.
 */
function requireAgentId(scope: string | undefined): string {
  const agentId = scope?.trim();
  if (!agentId) {
    throw new ValidationError(
      'Letta memory needs a Letta agent id. Set it as the memory scope before storing or searching memories.',
    );
  }
  return agentId;
}

function toRecord(entry: Record<string, unknown>): CapabilityMemoryRecord {
  return {
    id: String(entry.id ?? ''),
    text: typeof entry.text === 'string' ? entry.text : String(entry.text ?? ''),
    createdAt: typeof entry.created_at === 'string' ? entry.created_at : undefined,
    updatedAt: typeof entry.updated_at === 'string' ? entry.updated_at : undefined,
    metadata:
      entry.tags && typeof entry.tags === 'object'
        ? { tags: (entry.tags as unknown[]).map(String) }
        : undefined,
  };
}

const memory: CapabilityMemoryAdapter = {
  async verify(config, signal): Promise<CapabilityVerifyResult> {
    try {
      // Listing agents is the cheapest authenticated read and proves the key
      // works without mutating any agent.
      await capabilityFetch('Letta', `${config.baseUrl}/agents/?limit=1`, config, {
        headers: authHeaders(config),
        signal,
        timeoutMs: 20_000,
      });
      return { ok: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: `Letta credential check failed: ${message}`,
        credentialProblem: /HTTP 40[13]|credential|unauthorized|forbidden|api.?key/i.test(message),
      };
    }
  },

  /** Letta can list the agents this key owns; that is the discoverable scope. */
  async listScopes(config, signal): Promise<string[]> {
    const result = await capabilityFetch('Letta', `${config.baseUrl}/agents/?limit=100`, config, {
      headers: authHeaders(config),
      signal,
    });
    const items = (result.json as Record<string, unknown> | undefined)?.items;
    if (!Array.isArray(items)) return [];
    return (items as Array<Record<string, unknown>>)
      .map((agent) => (typeof agent.id === 'string' ? agent.id.trim() : ''))
      .filter(Boolean);
  },

  async add(config, input, signal): Promise<CapabilityMemoryRecord[]> {
    if (!input.text.trim()) throw new ValidationError('No memory text was supplied.');
    const agentId = requireAgentId(input.scope);
    const payload: Record<string, unknown> = { text: input.text };
    const tags = Object.entries(input.metadata ?? {})
      .filter(([, value]) => typeof value === 'string' || typeof value === 'number')
      .map(([key, value]) => `${key}:${String(value)}`);
    if (tags.length) payload.tags = tags;
    const result = await capabilityFetch(
      'Letta',
      `${config.baseUrl}/agents/${encodeURIComponent(agentId)}/passages`,
      config,
      {
        method: 'POST',
        headers: authHeaders(config),
        json: payload,
        signal,
        timeoutMs: 45_000,
      },
    );
    if (!result.response.ok) return [];
    // The insert endpoint answers 200 with an empty body; the passage is
    // discoverable through search, so report what is known.
    return [{ id: '', text: input.text }];
  },

  async search(config, input, signal): Promise<CapabilityMemoryRecord[]> {
    if (!input.query.trim()) throw new ValidationError('No memory search query was supplied.');
    const agentId = requireAgentId(input.scope);
    const limit = Math.max(1, Math.min(input.limit ?? 10, 100));
    const query = new URLSearchParams({
      q: input.query,
      limit: String(limit),
      // Letta returns a relevance-ordered page by default; make it explicit.
      ascending: 'false',
    });
    const result = await capabilityFetch(
      'Letta',
      `${config.baseUrl}/agents/${encodeURIComponent(agentId)}/passages?${query.toString()}`,
      config,
      { headers: authHeaders(config), signal, timeoutMs: 45_000 },
    );
    const items = (result.json as Record<string, unknown> | undefined)?.items;
    if (!Array.isArray(items)) return [];
    return (items as Array<Record<string, unknown>>).map(toRecord).filter((r) => r.text);
  },

  async delete(config, input, signal): Promise<number> {
    // Deletion needs an agent id, which delete() does not receive; Letta's
    // archival store is agent-scoped, so forgetting is left to the agent.
    void config;
    void signal;
    void input;
    return 0;
  },
};

export const lettaAdapter: CapabilityAdapter = {
  provider: 'letta',
  capabilities: ['memory'],
  defaultBaseUrl: BASE_URL,
  verify: memory.verify,
  memory,
};
