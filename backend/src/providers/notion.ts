// Notion provider — Notion Agent APIs authenticated with a Personal Access
// Token (PAT, `ntn_…`). Notion exposes AI through Custom Agents, not raw
// models, so the "model" from Koryphaios's perspective maps to a Notion
// agent ID discovered live from the server.
//
// API reference: https://developers.notion.com/reference/notion-agent-apis
// Discovery: POST /agents/query                       → accessible Custom Agents
// Chat:      POST /sessions {agent_id|session_id, message}
//            (Accept: text/event-stream streams the turn; a JSON body means
//             the server declined to stream and the adapter falls back to
//             GET /sessions/{id} polling + POST /sessions/{id}/events/query)
// Auth:      Authorization: Bearer <PAT>, Notion-Version: 2026-03-11

import type { ProviderConfig, ProviderName, ModelDef } from '@koryphaios/shared';
import type {
  Provider,
  ProviderEvent,
  StreamRequest,
  ProviderMessage,
  ProviderToolDef,
} from './types';
import { createGenericModel } from './types';
import { withTimeoutSignal } from './utils';
import { providerLog } from '../logger';
import { safeUpstreamDetail } from './provider-diagnostics';
import { buildToolProtocol, parseTextToolCall } from './text-tool-protocol';

export const NOTION_BASE_URL = 'https://api.notion.com/v1';
export const NOTION_API_VERSION = '2026-03-11';

const CATALOG_TTL_MS = 5 * 60_000;
const DISCOVERY_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
const SSE_IDLE_TIMEOUT_MS = 120_000;
const POLL_TOTAL_TIMEOUT_MS = 300_000;
const POLL_INTERVAL_MS = 2_000;
const MAX_CATALOG_PAGES = 5;

interface NotionAgentRecord {
  id?: string;
  name?: string;
  description?: string;
  agent_type?: string;
  status?: string;
}

interface NotionSessionRecord {
  id?: string;
  status?: string;
  error?: { code?: string; message?: string } | null;
}

interface NotionSessionEventRecord {
  type?: string;
  content?: Array<{ type?: string; text?: string }>;
}

function notionHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Notion-Version': NOTION_API_VERSION,
    'Content-Type': 'application/json',
    'User-Agent': 'Koryphaios/1.0',
    ...extra,
  };
}

function eventText(event: NotionSessionEventRecord): string {
  if (!Array.isArray(event.content)) return '';
  return event.content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text!)
    .join('');
}

export class NotionProvider implements Provider {
  readonly imageInputTransport = 'none' as const;
  readonly name: ProviderName = 'notion';
  readonly supportsFreshConversation = true;
  readonly config: ProviderConfig;

  private catalog: ModelDef[] = [];
  private catalogAt = 0;
  private catalogRequest: Promise<void> | null = null;
  private catalogError: string | undefined;

  /**
   * Maps a Koryphaios sessionId to the server-assigned Notion session id so
   * follow-ups continue the same Notion conversation instead of starting a
   * new one per turn.
   */
  private readonly korySessionToNotionSession = new Map<string, string>();

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  private get apiKey(): string | undefined {
    return this.config.apiKey;
  }

  private get baseUrl(): string {
    return (this.config.baseUrl || NOTION_BASE_URL).replace(/\/+$/, '');
  }

  isAvailable(): boolean {
    return !this.config.disabled && !!this.apiKey;
  }

  // ─── Agent (model) discovery — requested from the Notion server ─────────────

  listModels(): ModelDef[] {
    if (!this.isAvailable()) return [];
    if (Date.now() - this.catalogAt > CATALOG_TTL_MS) {
      void this.refreshModels(true);
    }
    return this.catalog;
  }

  refreshModels(forceRefresh = false): Promise<void> {
    if (!forceRefresh || !this.isAvailable()) return Promise.resolve();
    if (this.catalogRequest) return this.catalogRequest;
    this.catalogRequest = this.fetchAgentCatalog().finally(() => {
      this.catalogRequest = null;
    });
    return this.catalogRequest;
  }

  getModelDiscoveryError(): string | undefined {
    return this.catalogError;
  }

  private async fetchAgentCatalog(): Promise<void> {
    if (!this.apiKey) {
      this.catalogError = 'Notion requires a Personal Access Token (PAT)';
      return;
    }
    try {
      const agents: NotionAgentRecord[] = [];
      let startCursor: string | undefined;
      let pageCount = 0;

      while (pageCount < MAX_CATALOG_PAGES) {
        pageCount++;
        const body: Record<string, unknown> = {
          filter: { property: 'agent_type', string: { equals: 'custom_agent' } },
          sorts: [{ property: 'created_time', direction: 'descending' }],
          page_size: 100,
        };
        if (startCursor) body.start_cursor = startCursor;
        const response = await fetch(`${this.baseUrl}/agents/query`, {
          method: 'POST',
          headers: notionHeaders(this.apiKey),
          body: JSON.stringify(body),
          signal: withTimeoutSignal(undefined, DISCOVERY_TIMEOUT_MS),
        });
        if (!response.ok) {
          const detail = (await response.text().catch(() => '')).slice(0, 240);
          this.catalogError = `Notion agents catalog HTTP ${response.status}${detail ? `: ${detail}` : ''}`;
          providerLog.warn(
            { provider: 'notion', status: response.status },
            'Notion agent catalog request failed',
          );
          return;
        }
        const json = (await response.json()) as {
          results?: NotionAgentRecord[];
          has_more?: boolean;
          next_cursor?: string | null;
        };
        if (Array.isArray(json.results)) agents.push(...json.results);
        if (!json.has_more || !json.next_cursor) break;
        startCursor = json.next_cursor;
      }

      if (agents.length === 0) {
        this.catalogError = 'Notion returned no accessible Custom Agents for this token';
        return;
      }

      const models = agents
        .filter((agent) => typeof agent.id === 'string' && agent.id)
        .map((agent) => {
          const m = createGenericModel(agent.id!, 'notion');
          m.name = agent.name?.trim() ? agent.name.trim() : agent.id!;
          if (agent.description?.trim()) m.name = `${m.name} — ${agent.description.trim()}`;
          m.apiModelId = agent.id!;
          // Notion runs the agent with its own model routing ("auto"); the
          // context window is not reported by the API, so keep a conservative
          // unverified estimate.
          m.contextWindow = 128_000;
          m.tier = 'flagship';
          m.supportsStreaming = true;
          return m;
        });

      if (models.length === 0) {
        this.catalogError = 'Notion returned agents without usable IDs';
        return;
      }

      this.catalog = models;
      this.catalogAt = Date.now();
      this.catalogError = undefined;
      providerLog.debug(
        { provider: 'notion', count: models.length },
        'Notion agent catalog refreshed',
      );
    } catch (error: unknown) {
      this.catalogError = error instanceof Error ? error.message : String(error);
      providerLog.debug(
        { provider: 'notion', error: this.catalogError },
        'Notion agent catalog discovery failed',
      );
    }
  }

  // ─── Streaming chat ─────────────────────────────────────────────────────────

  async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    const agentId = request.model;
    if (!agentId) {
      yield { type: 'error', error: 'No Notion Custom Agent (model) selected' };
      return;
    }
    if (!this.apiKey) {
      yield { type: 'error', error: 'Notion Personal Access Token is not configured' };
      return;
    }

    const tools: ProviderToolDef[] = request.tools ?? [];
    const toolProtocol = tools.length > 0 ? buildToolProtocol(tools) : undefined;
    const message = flattenMessages(request.systemPrompt, request.messages, toolProtocol);

    // Regeneration must not append the replayed prompt to Notion's old
    // server-side session. The flattened request is the complete fresh context.
    if (request.forceFreshConversation && request.sessionId) {
      this.korySessionToNotionSession.delete(request.sessionId);
    }

    // Continue the server-side conversation only when Notion itself issued
    // the session id; a foreign id would 404, in which case we restart fresh.
    let notionSessionId = request.sessionId
      ? this.korySessionToNotionSession.get(request.sessionId)
      : undefined;

    let response: Response;
    try {
      response = await this.postSession(request, agentId, notionSessionId, message);
      if (!response.ok && notionSessionId && (response.status === 404 || response.status === 400)) {
        // Stale/expired session reference — drop it and start a new one.
        if (request.sessionId) this.korySessionToNotionSession.delete(request.sessionId);
        notionSessionId = undefined;
        response = await this.postSession(request, agentId, undefined, message);
      }
    } catch (error: unknown) {
      yield {
        type: 'error',
        error: `Notion request failed: ${safeUpstreamDetail(error) || 'network error'}`,
      };
      return;
    }

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      yield {
        type: 'error',
        error: `Notion HTTP ${response.status}: ${safeUpstreamDetail(errBody.slice(0, 500)) || 'upstream error'}`,
      };
      return;
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream') && response.body) {
      yield* this.consumeSessionStream(request, response, tools);
      return;
    }

    // Non-streaming fallback: the server answered with a JSON session record.
    yield* this.pollSessionToCompletion(request, response, tools);
  }

  private async postSession(
    request: StreamRequest,
    agentId: string,
    notionSessionId: string | undefined,
    message: string,
  ): Promise<Response> {
    const body: Record<string, unknown> = { message };
    if (notionSessionId) body.session_id = notionSessionId;
    else body.agent_id = agentId;
    return fetch(`${this.baseUrl}/sessions`, {
      method: 'POST',
      headers: notionHeaders(this.apiKey!, { Accept: 'text/event-stream' }),
      body: JSON.stringify(body),
      signal: withTimeoutSignal(request.signal, SSE_IDLE_TIMEOUT_MS),
    });
  }

  /** Consume the SSE turn stream emitted by POST /sessions. */
  private async *consumeSessionStream(
    request: StreamRequest,
    response: Response,
    tools: ProviderToolDef[],
  ): AsyncGenerator<ProviderEvent> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let completed = false;
    let failed: string | undefined;
    let hasText = false;
    let toolModeText = '';

    const rememberSession = (id: unknown) => {
      if (typeof id === 'string' && id && request.sessionId) {
        this.korySessionToNotionSession.set(request.sessionId, id);
      }
    };

    const handlePayload = function* (payload: string): Generator<ProviderEvent> {
      if (payload === '[DONE]') {
        completed = true;
        return;
      }
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        return;
      }
      const type = typeof data.type === 'string' ? data.type : '';
      const status = typeof data.status === 'string' ? data.status : '';

      rememberSession(data.session_id ?? data.id);

      if (type === 'error' || data.error) {
        const err = data.error as { message?: string } | string | undefined;
        failed =
          (typeof err === 'string' ? err : err?.message) ||
          (typeof data.message === 'string' ? data.message : '') ||
          'Notion session error';
        return;
      }
      if (status === 'failed') {
        const err = data.error as { message?: string } | undefined;
        failed = err?.message || 'Notion session failed';
        return;
      }
      if (status === 'completed' || type === 'session.completed' || type === 'completed') {
        completed = true;
        return;
      }

      const text =
        (type === 'agent.message' ? eventText(data as NotionSessionEventRecord) : '') ||
        (typeof data.delta === 'string' ? data.delta : '') ||
        (typeof data.text === 'string' ? data.text : '');
      if (text) {
        hasText = true;
        if (tools.length > 0) {
          // Tool mode: buffer the FULL text so a tool-call object is never
          // leaked to the feed as chat content.
          toolModeText += text;
        } else {
          yield { type: 'content_delta', content: text };
        }
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += done ? decoder.decode() + '\n' : decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          for (const evt of handlePayload(trimmed.slice(5).trimStart())) yield evt;
          if (failed) break;
        }
        if (failed || done) break;
      }

      if (failed) {
        yield { type: 'error', error: `Notion session failed: ${safeUpstreamDetail(failed)}` };
        return;
      }

      const finish = function* (): Generator<ProviderEvent> {
        if (!hasText) {
          yield {
            type: 'error',
            error: 'Notion returned no response text',
            errorTransient: true,
          };
          return;
        }
        if (tools.length === 0) {
          yield { type: 'complete', finishReason: 'stop' };
          return;
        }
        const call = parseTextToolCall(toolModeText, tools);
        if (call) {
          const toolCallId = `notion-tool-${Math.random().toString(36).slice(2, 10)}`;
          const inputJson = JSON.stringify(call.args);
          yield { type: 'tool_use_start', toolCallId, toolName: call.name };
          yield { type: 'tool_use_delta', toolCallId, toolName: call.name, toolInput: inputJson };
          yield { type: 'tool_use_stop', toolCallId, toolName: call.name, toolInput: inputJson };
          yield { type: 'complete', finishReason: 'tool_use' };
        } else if (toolModeText) {
          yield { type: 'content_delta', content: toolModeText };
          yield { type: 'complete', finishReason: 'stop' };
        } else {
          yield { type: 'complete', finishReason: 'stop' };
        }
        toolModeText = '';
      };

      if (!completed && !hasText) {
        yield {
          type: 'error',
          error: 'Notion stream ended before completion',
          errorTransient: true,
        };
        return;
      }
      yield* finish();
    } catch (error: unknown) {
      yield {
        type: 'error',
        error: `Notion stream failed: ${safeUpstreamDetail(error) || 'response transport error'}`,
        errorTransient: true,
      };
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  /**
   * Fallback when Notion declines SSE: poll GET /sessions/{id} until the turn
   * leaves queued/in_progress, then read agent.message events via
   * POST /sessions/{id}/events/query.
   */
  private async *pollSessionToCompletion(
    request: StreamRequest,
    response: Response,
    tools: ProviderToolDef[],
  ): AsyncGenerator<ProviderEvent> {
    let session: NotionSessionRecord;
    try {
      session = (await response.json()) as NotionSessionRecord;
    } catch {
      yield { type: 'error', error: 'Notion returned an unreadable session response' };
      return;
    }
    const sessionId = session.id;
    if (!sessionId) {
      yield { type: 'error', error: 'Notion session response is missing an id' };
      return;
    }
    if (request.sessionId) this.korySessionToNotionSession.set(request.sessionId, sessionId);

    const deadline = Date.now() + POLL_TOTAL_TIMEOUT_MS;
    let status = session.status ?? 'queued';
    let lastError = session.error?.message;
    while ((status === 'queued' || status === 'in_progress') && Date.now() < deadline) {
      if (request.signal?.aborted) {
        yield { type: 'error', error: 'Notion session polling was aborted' };
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      let pollResponse: Response;
      try {
        pollResponse = await fetch(`${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}`, {
          method: 'GET',
          headers: notionHeaders(this.apiKey!),
          signal: withTimeoutSignal(request.signal, REQUEST_TIMEOUT_MS),
        });
      } catch (error: unknown) {
        yield {
          type: 'error',
          error: `Notion session polling failed: ${safeUpstreamDetail(error) || 'network error'}`,
        };
        return;
      }
      if (!pollResponse.ok) {
        yield {
          type: 'error',
          error: `Notion session poll HTTP ${pollResponse.status}`,
        };
        return;
      }
      const record = (await pollResponse.json()) as NotionSessionRecord;
      if (record.status) status = record.status;
      if (record.error?.message) lastError = record.error.message;
    }

    if (status === 'queued' || status === 'in_progress') {
      yield {
        type: 'error',
        error: 'Notion session timed out before the agent finished the turn',
        errorTransient: true,
      };
      return;
    }
    if (status === 'failed' || status === 'cancelled' || lastError) {
      yield {
        type: 'error',
        error: `Notion session failed: ${safeUpstreamDetail(lastError || status)}`,
      };
      return;
    }

    // Collect every agent.message event, oldest first, across pages.
    let cursor: string | undefined;
    const messages: string[] = [];
    for (let page = 0; page < MAX_CATALOG_PAGES; page++) {
      const body: Record<string, unknown> = {
        filter: { property: 'type', event_type: { equals: 'agent.message' } },
        sorts: [{ property: 'sequence', direction: 'ascending' }],
        page_size: 100,
      };
      if (cursor) body.start_cursor = cursor;
      const eventsResponse = await fetch(
        `${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}/events/query`,
        {
          method: 'POST',
          headers: notionHeaders(this.apiKey!),
          body: JSON.stringify(body),
          signal: withTimeoutSignal(request.signal, REQUEST_TIMEOUT_MS),
        },
      ).catch(() => undefined);
      if (!eventsResponse || !eventsResponse.ok) {
        yield {
          type: 'error',
          error: `Notion session events HTTP ${eventsResponse?.status ?? 'request failed'}`,
        };
        return;
      }
      const json = (await eventsResponse.json()) as {
        results?: NotionSessionEventRecord[];
        has_more?: boolean;
        next_cursor?: string | null;
      };
      for (const event of json.results ?? []) {
        const text = eventText(event);
        if (text) messages.push(text);
      }
      if (!json.has_more || !json.next_cursor) break;
      cursor = json.next_cursor;
    }

    const fullText = messages.join('\n\n');
    if (!fullText) {
      yield {
        type: 'error',
        error: 'Notion session completed without any agent message',
        errorTransient: true,
      };
      return;
    }

    if (tools.length > 0) {
      const call = parseTextToolCall(fullText, tools);
      if (call) {
        const toolCallId = `notion-tool-${Math.random().toString(36).slice(2, 10)}`;
        const inputJson = JSON.stringify(call.args);
        yield { type: 'tool_use_start', toolCallId, toolName: call.name };
        yield { type: 'tool_use_delta', toolCallId, toolName: call.name, toolInput: inputJson };
        yield { type: 'tool_use_stop', toolCallId, toolName: call.name, toolInput: inputJson };
        yield { type: 'complete', finishReason: 'tool_use' };
        return;
      }
    }
    yield { type: 'content_delta', content: fullText };
    yield { type: 'complete', finishReason: 'stop' };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Flatten Koryphaios messages into a single prompt for Notion's session API. */
function flattenMessages(
  systemPrompt: string,
  messages: ProviderMessage[],
  toolProtocol?: string,
): string {
  if (messages.length === 1 && !systemPrompt && !toolProtocol && messages[0].role === 'user') {
    const c = messages[0].content;
    return typeof c === 'string'
      ? c
      : c
          .filter((b) => b.type === 'text' && b.text)
          .map((b) => b.text!)
          .join('\n');
  }

  const parts: string[] = [];
  if (systemPrompt) {
    parts.push(`[System Instructions]: ${systemPrompt}`);
  }
  for (const msg of messages) {
    if (msg.role === 'tool') {
      const text =
        typeof msg.content === 'string'
          ? msg.content
          : msg.content
              .filter((b) => (b.type === 'text' || b.type === 'tool_result') && b.text)
              .map((b) => b.text!)
              .join('\n');
      parts.push(`[Tool Result]: ${text}`);
      continue;
    }
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      const calls = msg.content.filter((b) => b.type === 'tool_use' && b.toolName);
      if (calls.length > 0) {
        parts.push(
          `Assistant: [called ${calls
            .map(
              (b) => `${b.toolName}(${JSON.stringify(b.toolInput ?? {})}) #${b.toolCallId ?? ''}`,
            )
            .join('; ')}]`,
        );
        continue;
      }
    }
    const text =
      typeof msg.content === 'string'
        ? msg.content
        : msg.content
            .filter((b) => b.type === 'text' && b.text)
            .map((b) => b.text!)
            .join('\n');
    if (!text) continue;
    const label =
      msg.role === 'user'
        ? 'User'
        : msg.role === 'assistant'
          ? 'Assistant'
          : msg.role.toUpperCase();
    parts.push(`${label}: ${text}`);
  }
  // The protocol is appended LAST so it is the most recent instruction the
  // agent sees, mirroring the adapter's recency lever.
  if (toolProtocol) {
    parts.push(toolProtocol);
  }
  return parts.join('\n\n');
}
