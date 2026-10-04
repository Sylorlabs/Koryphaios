// Chatbase provider — proprietary agent-based API (not OpenAI-compatible).
//
// Chatbase exposes AI agents, not raw models. Each agent has its own system
// prompt, knowledge base, and configuration. The "model" from Koryphaios's
// perspective maps to a Chatbase agent ID.
//
// API reference: https://www.chatbase.co/api/v2
// Chat:  POST /agents/{agentId}/chat  { message, stream, conversationId, userId }
// List:  GET  /agents                  → { data: [{ id, name, model, temperature, … }] }

import type { ProviderConfig, ProviderName, ModelDef, ModelTier } from '@koryphaios/shared';
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
import {
  buildToolProtocol,
  parseTextToolCall,
  type ParsedTextToolCall,
} from './text-tool-protocol';

export const CHATBASE_BASE_URL = 'https://www.chatbase.co/api/v2';

/**
 * Submit a Kory tool result back into a Chatbase conversation so the agent can
 * continue after a native AI-SDK tool call (POST /agents/{id}/tool-result).
 * Returns an HTTP status, or -1 on network/timing failure. Used by callers
 * orchestrating the round-trip; the stream parser itself never does I/O.
 */
export async function submitChatbaseToolResult(
  baseUrl: string | undefined,
  agentId: string,
  apiKey: string | undefined,
  conversationId: string | undefined,
  toolCallId: string,
  output: unknown,
): Promise<number> {
  const root = (baseUrl || CHATBASE_BASE_URL).replace(/\/+$/, '');
  const url = `${root}/agents/${encodeURIComponent(agentId)}/conversations/${encodeURIComponent(
    conversationId ?? '',
  )}/tool-result`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const body = JSON.stringify({ toolCallId, output });
  const signal = withTimeoutSignal(undefined, DISCOVERY_TIMEOUT_MS);
  try {
    const response = await fetch(url, { method: 'POST', headers, body, signal });
    return response.status;
  } catch {
    return -1;
  }
}

const CATALOG_TTL_MS = 5 * 60_000;
const DISCOVERY_TIMEOUT_MS = 10_000;
const STREAM_TIMEOUT_MS = 120_000;

interface ChatbaseAgentApiRecord {
  id: string;
  name?: string;
  model?: string;
  temperature?: number;
  instructions?: string;
  description?: string;
}

/** Infer model capabilities based on the underlying model reported by Chatbase. */
function inferAgentCapabilities(underlyingModel = ''): {
  canReason: boolean;
  tier: ModelTier;
  contextWindow: number;
} {
  const lower = underlyingModel.toLowerCase();
  const isReasoning =
    lower.includes('o1') ||
    lower.includes('o3') ||
    lower.includes('o4') ||
    lower.includes('reason') ||
    lower.includes('think') ||
    lower.includes('r1');

  let tier: ModelTier = 'flagship';
  if (isReasoning) {
    tier = 'reasoning';
  } else if (
    lower.includes('mini') ||
    lower.includes('flash') ||
    lower.includes('haiku') ||
    lower.includes('small')
  ) {
    tier = 'fast';
  }

  let contextWindow = 128_000;
  if (lower.includes('gemini')) contextWindow = 1_000_000;
  else if (lower.includes('claude-3') || lower.includes('claude-4')) contextWindow = 200_000;
  else if (
    lower.includes('gpt-4') ||
    lower.includes('gpt-5') ||
    lower.includes('o1') ||
    lower.includes('o3')
  )
    contextWindow = 128_000;

  return { canReason: isReasoning, tier, contextWindow };
}

export class ChatbaseProvider implements Provider {
  readonly imageInputTransport = 'none' as const;
  readonly name: ProviderName = 'chatbase';
  readonly config: ProviderConfig;

  private catalog: ModelDef[] = [];
  private catalogAt = 0;
  private catalogRequest: Promise<void> | null = null;
  private catalogError: string | undefined;

  /**
   * Maps Koryphaios sessionId to the server-assigned Chatbase conversationId.
   * Chatbase generates its own conversation IDs — passing an arbitrary foreign ID
   * causes CHAT_CONVERSATION_MISMATCH (HTTP 403). We only pass conversationId once
   * Chatbase has returned one.
   */
  private readonly sessionConversations = new Map<string, string>();

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  // ─── Auth ───────────────────────────────────────────────────────────────────

  private get apiKey(): string | undefined {
    return this.config.apiKey;
  }

  private get baseUrl(): string {
    return (this.config.baseUrl || CHATBASE_BASE_URL).replace(/\/+$/, '');
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'Koryphaios/1.0',
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  // ─── Provider interface ─────────────────────────────────────────────────────

  isAvailable(): boolean {
    return !this.config.disabled && !!this.apiKey;
  }

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

  // ─── Agent (model) discovery ────────────────────────────────────────────────

  private async fetchAgentCatalog(): Promise<void> {
    if (!this.apiKey) {
      this.catalogError = 'Chatbase requires an API key';
      return;
    }
    try {
      const allAgents: ChatbaseAgentApiRecord[] = [];
      let nextUrl: string | null = `${this.baseUrl}/agents?limit=100`;
      let pageCount = 0;

      while (nextUrl && pageCount < 5) {
        pageCount++;
        const response = await fetch(nextUrl, {
          method: 'GET',
          headers: this.authHeaders(),
          signal: withTimeoutSignal(undefined, DISCOVERY_TIMEOUT_MS),
        });
        if (!response.ok) {
          // If ?limit=100 is rejected with 400/404, fallback to bare /agents
          if (pageCount === 1 && nextUrl.includes('?limit=')) {
            nextUrl = `${this.baseUrl}/agents`;
            continue;
          }
          const body = (await response.text().catch(() => '')).slice(0, 240);
          this.catalogError = `Chatbase agents catalog HTTP ${response.status}${body ? `: ${body}` : ''}`;
          providerLog.warn(
            { provider: 'chatbase', status: response.status },
            'Chatbase agent catalog request failed',
          );
          break;
        }

        const json = (await response.json()) as any;
        const pageAgents: ChatbaseAgentApiRecord[] = Array.isArray(json)
          ? json
          : Array.isArray(json.data)
            ? json.data
            : Array.isArray(json.agents)
              ? json.agents
              : Array.isArray(json.chatbots)
                ? json.chatbots
                : [];

        allAgents.push(...pageAgents);

        // Chatbase API v2 pagination: { pagination: { cursor, hasMore, total } },
        // with `cursor` echoed back as the `cursor` query parameter. Older/legacy
        // shapes (`pagination.next`, top-level `next_cursor`) are kept as fallbacks.
        const specCursor = json.pagination?.cursor;
        if (typeof specCursor === 'string' && specCursor) {
          nextUrl = `${this.baseUrl}/agents?limit=100&cursor=${encodeURIComponent(specCursor)}`;
        } else if (json.pagination?.next && typeof json.pagination.next === 'string') {
          nextUrl = json.pagination.next.startsWith('http')
            ? json.pagination.next
            : `${this.baseUrl}${json.pagination.next.startsWith('/') ? '' : '/'}${json.pagination.next}`;
        } else if (json.next_cursor || json.cursor) {
          const cursor = json.next_cursor || json.cursor;
          nextUrl = `${this.baseUrl}/agents?limit=100&cursor=${encodeURIComponent(cursor)}`;
        } else {
          nextUrl = null;
        }
      }

      if (allAgents.length === 0) {
        this.catalogError = 'Chatbase returned no agents for this API key';
        return;
      }

      const models: ModelDef[] = allAgents.map((agent) => {
        const caps = inferAgentCapabilities(agent.model);
        const m = createGenericModel(agent.id, 'chatbase');
        m.name = agent.name
          ? agent.model
            ? `${agent.name} (${agent.model})`
            : agent.name
          : agent.id;
        m.apiModelId = agent.id;
        m.canReason = caps.canReason;
        m.tier = caps.tier;
        m.contextWindow = caps.contextWindow;
        m.contextVerified = true;
        m.supportsStreaming = true;
        return m;
      });

      this.catalog = models;
      this.catalogAt = Date.now();
      this.catalogError = undefined;
      providerLog.debug(
        { provider: 'chatbase', count: models.length },
        'Chatbase agent catalog refreshed',
      );
    } catch (error: unknown) {
      this.catalogError = error instanceof Error ? error.message : String(error);
      providerLog.debug(
        { provider: 'chatbase', error: this.catalogError },
        'Chatbase agent catalog discovery failed',
      );
    }
  }

  // ─── Streaming ──────────────────────────────────────────────────────────────

  async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    const agentId = request.model;
    if (!agentId) {
      yield { type: 'error', error: 'No Chatbase agent (model) selected' };
      return;
    }
    if (!this.apiKey) {
      yield { type: 'error', error: 'Chatbase API key is not configured' };
      return;
    }

    const tools: ProviderToolDef[] = request.tools ?? [];
    const toolProtocol = tools.length > 0 ? buildToolProtocol(tools) : undefined;
    const message = flattenMessages(request.systemPrompt, request.messages, toolProtocol);
    const chatUrl = `${this.baseUrl}/agents/${encodeURIComponent(agentId)}/chat`;

    // Only pass a conversationId if it was previously issued by Chatbase for this session.
    let knownChatbaseConvId = request.sessionId
      ? this.sessionConversations.get(request.sessionId)
      : undefined;

    const payloadObj: Record<string, unknown> = {
      message,
      stream: true,
    };
    if (knownChatbaseConvId) {
      payloadObj.conversationId = knownChatbaseConvId;
    }

    let response: Response;
    const signal = withTimeoutSignal(request.signal, STREAM_TIMEOUT_MS);

    try {
      response = await fetch(chatUrl, {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify(payloadObj),
        signal,
      });

      // If Chatbase rejects with CHAT_CONVERSATION_MISMATCH (e.g. expired conversation),
      // clear the cached conversationId and retry immediately as a new conversation.
      if (
        !response.ok &&
        knownChatbaseConvId &&
        (response.status === 403 || response.status === 404)
      ) {
        const errText = await response.text().catch(() => '');
        if (errText.includes('CONVERSATION_MISMATCH') || errText.includes('not found')) {
          if (request.sessionId) {
            this.sessionConversations.delete(request.sessionId);
          }
          delete payloadObj.conversationId;
          response = await fetch(chatUrl, {
            method: 'POST',
            headers: this.authHeaders(),
            body: JSON.stringify(payloadObj),
            signal,
          });
        } else {
          yield {
            type: 'error',
            error: `Chatbase HTTP ${response.status}: ${errText.slice(0, 500)}`,
          };
          return;
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      yield { type: 'error', error: `Chatbase request failed: ${msg}` };
      return;
    }

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      yield {
        type: 'error',
        error: `Chatbase HTTP ${response.status}: ${errBody.slice(0, 500)}`,
      };
      return;
    }

    if (!response.body) {
      yield {
        type: 'error',
        error: 'Chatbase returned an empty response body',
        errorTransient: true,
      };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finishSeen = false;
    let hasText = false;
    const nativeToolEvents: ProviderEvent[] = [];
    let toolModeText = '';

    /** Emit parsed tool_use events, or fall back to plain chat content. */
    const flushToolMode = function* (): Generator<ProviderEvent> {
      if (nativeToolEvents.length > 0) {
        yield* nativeToolEvents;
        yield { type: 'complete', finishReason: 'tool_use' };
        return;
      }
      if (!hasText) {
        yield {
          type: 'error',
          error: 'Chatbase returned no response text or tool call',
          errorTransient: true,
        };
        return;
      }
      if (tools.length === 0) {
        yield { type: 'complete', finishReason: 'stop' };
        return;
      }
      const call = parseChatbaseToolCall(toolModeText, tools);
      if (call) {
        const toolCallId = `chatbase-tool-${Math.random().toString(36).slice(2, 10)}`;
        const inputJson = JSON.stringify(call.args);
        yield { type: 'tool_use_start', toolCallId, toolName: call.name };
        yield { type: 'tool_use_delta', toolCallId, toolName: call.name, toolInput: inputJson };
        yield { type: 'tool_use_stop', toolCallId, toolName: call.name, toolInput: inputJson };
        yield { type: 'complete', finishReason: 'tool_use' };
      } else if (toolModeText) {
        // Plain chat answer (or malformed protocol output) — surface as-is.
        yield { type: 'content_delta', content: toolModeText };
        yield { type: 'complete', finishReason: 'stop' };
      } else {
        yield { type: 'complete', finishReason: 'stop' };
      }
      toolModeText = '';
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        // Process the final buffered line even when EOF lacks a newline.
        buffer += done ? decoder.decode() + '\n' : decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;

          const payload = trimmed.slice(5).trimStart(); // SSE allows optional whitespace
          if (payload === '[DONE]') {
            yield* flushToolMode();
            return;
          }

          try {
            const data = JSON.parse(payload) as {
              text?: string;
              type?: string;
              thinking?: string;
              thought?: string;
              reasoning?: string;
              reasoning_content?: string;
              conversationId?: string;
              /** AI-SDK style event payload: `delta` is a plain string on text-delta events. */
              delta?:
                | string
                | {
                    content?: string;
                    reasoning_content?: string;
                    thought?: string;
                  };
              messageMetadata?: {
                conversationId?: string;
                usage?: {
                  credits?: number;
                  prompt_tokens?: number;
                  completion_tokens?: number;
                };
              };
              metadata?: {
                conversationId?: string;
                finishReason?: string;
                usage?: {
                  credits?: number;
                  prompt_tokens?: number;
                  completion_tokens?: number;
                };
              };
              /** AI-SDK native tool-call events. */
              toolCallId?: string;
              toolName?: string;
              input?: unknown;
              inputTextDelta?: string;
              output?: unknown;
              errorText?: string;
              choices?: Array<{
                delta?: {
                  content?: string;
                  reasoning_content?: string;
                  thought?: string;
                };
              }>;
              finishReason?: string;
              finish_reason?: string;
              usage?: {
                credits?: number;
                prompt_tokens?: number;
                completion_tokens?: number;
                total_tokens?: number;
              };
            };

            // Fail before emitting content or dispatching buffered tools. A
            // finish event must not override its explicit error reason.
            const finishReason =
              data.finishReason || data.finish_reason || data.metadata?.finishReason;
            if (data.type === 'error' || finishReason === 'error') {
              const detail =
                typeof data.errorText === 'string' ? safeUpstreamDetail(data.errorText) : '';
              yield {
                type: 'error',
                error: `Chatbase stream failed: ${detail || 'upstream generation error'}`,
              };
              return;
            }

            // Store conversationId if Chatbase returned one (AI-SDK nests it
            // in messageMetadata on the finish event).
            const returnedConvId =
              data.conversationId ||
              data.metadata?.conversationId ||
              data.messageMetadata?.conversationId;
            if (returnedConvId && request.sessionId) {
              this.sessionConversations.set(request.sessionId, returnedConvId);
            }

            // 1. Check for thinking / reasoning deltas
            const thinkingDelta =
              (data.type === 'thinking' ? data.text : undefined) ||
              data.thinking ||
              data.thought ||
              data.reasoning ||
              data.reasoning_content ||
              (typeof data.delta === 'object' && data.delta !== null
                ? data.delta.reasoning_content || data.delta.thought
                : undefined) ||
              data.choices?.[0]?.delta?.reasoning_content ||
              data.choices?.[0]?.delta?.thought;

            if (thinkingDelta) {
              yield { type: 'thinking_delta', thinking: thinkingDelta };
            }

            // 2. Check for content deltas — Chatbase's live API streams
            // AI-SDK-style `{ "type": "text-delta", "delta": "…" }` events
            // where `delta` is a plain string; OpenAI-style shapes remain as
            // compatibility fallbacks.
            const contentDelta =
              data.type === 'text-delta' && typeof data.delta === 'string'
                ? data.delta
                : (data.type !== 'thinking' ? data.text : undefined) ||
                  (typeof data.delta === 'object' && data.delta !== null
                    ? data.delta.content
                    : undefined) ||
                  data.choices?.[0]?.delta?.content;

            if (contentDelta) {
              hasText = true;
              if (tools.length > 0) {
                // Tool mode: buffer the FULL text so a tool-call object is
                // never leaked to the feed as chat content. Thinking still
                // streams live above.
                toolModeText += contentDelta;
              } else {
                yield { type: 'content_delta', content: contentDelta };
              }
            }

            // 2b. AI-SDK native tool-call events. `tool-input-available` fires
            // when the agent's tool input is fully captured; `tool-output-available`
            // fires after a tool result is submitted back through
            // POST /agents/{id}/tool-result.
            if (data.type === 'tool-input-available') {
              const toolCallId = data.toolCallId || '';
              const toolName = data.toolName || '';
              let inputText = '';
              if (data.input !== undefined && data.input !== null) {
                inputText =
                  typeof data.input === 'string' ? data.input : JSON.stringify(data.input);
              } else if (typeof data.inputTextDelta === 'string') {
                inputText = data.inputTextDelta;
              }
              if (toolName) {
                const known = tools.find((t) => t.name === toolName);
                if (known) {
                  // Wait for stream success before handing actions to Kory.
                  nativeToolEvents.push({ type: 'tool_use_start', toolCallId, toolName });
                  if (inputText) {
                    nativeToolEvents.push({
                      type: 'tool_use_delta',
                      toolCallId,
                      toolName,
                      toolInput: inputText,
                    });
                  }
                  nativeToolEvents.push({
                    type: 'tool_use_stop',
                    toolCallId,
                    toolName,
                    toolInput: inputText,
                  });
                  continue;
                }
              }
            }

            // 3. Check for usage updates
            const usageObj = data.usage || data.metadata?.usage || data.messageMetadata?.usage;
            if (usageObj) {
              const tokensIn = usageObj.prompt_tokens ?? 0;
              const tokensOut = usageObj.completion_tokens ?? 0;
              if (tokensIn > 0 || tokensOut > 0) {
                yield {
                  type: 'usage_update',
                  tokensIn,
                  tokensOut,
                  usagePrecision: 'provider-reported',
                };
              }
            }

            // 4. Check for finish events — AI-SDK style ends with
            // `{ "type": "finish", "finishReason": "stop", "messageMetadata": … }`.
            if (data.type === 'finish' || finishReason) finishSeen = true;

            // 5. AI-SDK `message-metadata` event on completion may carry the
            // conversation id — capture it for follow-ups.
            if (data.type === 'message-metadata') {
              const metaConvId =
                data.messageMetadata?.conversationId ||
                (data.metadata as { conversationId?: string } | undefined)?.conversationId ||
                (typeof data.conversationId === 'string' ? data.conversationId : undefined);
              if (metaConvId && request.sessionId) {
                this.sessionConversations.set(request.sessionId, metaConvId);
              }
            }
          } catch {
            // Non-JSON SSE line; skip safely
            providerLog.debug({ provider: 'chatbase', payload }, 'Skipped unparseable SSE line');
          }
        }
        if (done) break;
      }
      if (finishSeen) {
        yield* flushToolMode();
      } else {
        yield {
          type: 'error',
          error: 'Chatbase stream ended before completion',
          errorTransient: true,
        };
      }
    } catch (error: unknown) {
      yield {
        type: 'error',
        error: `Chatbase stream failed: ${safeUpstreamDetail(error) || 'response transport error'}`,
        errorTransient: true,
      };
    } finally {
      // Stop network consumption on errors, DONE, and consumer cancellation.
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

// ─── Text-protocol tool calling ───────────────────────────────────────────────
//
// Chatbase's chat API has no native function-calling contract, so agentic tool
// use is negotiated in-band via the shared text protocol (see
// text-tool-protocol.ts): the flattened prompt carries a tool manifest plus a
// strict reply protocol, and the adapter parses the agent's COMPLETE text for
// a tool-call object before surfacing anything.

export { buildToolProtocol, TOOL_CALL_OPEN, TOOL_CALL_CLOSE } from './text-tool-protocol';

export function parseChatbaseToolCall(
  text: string,
  knownTools: ProviderToolDef[],
): ParsedTextToolCall | null {
  return parseTextToolCall(text, knownTools);
}

/** Render assistant tool calls / tool results into the flattened transcript. */
function renderToolMessage(msg: ProviderMessage): string | null {
  if (msg.role === 'tool') {
    const text =
      typeof msg.content === 'string'
        ? msg.content
        : msg.content
            .filter((b) => (b.type === 'text' || b.type === 'tool_result') && b.text)
            .map((b) => b.text!)
            .join('\n');
    return `[Tool Result]: ${text}`;
  }
  if (msg.role === 'assistant' && Array.isArray(msg.content)) {
    const calls = msg.content.filter((b) => b.type === 'tool_use' && b.toolName);
    if (calls.length === 0) return null;
    return `Assistant: [called ${calls
      .map((b) => `${b.toolName}(${JSON.stringify(b.toolInput ?? {})}) #${b.toolCallId ?? ''}`)
      .join('; ')}]`;
  }
  return null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Flatten Koryphaios messages into a single prompt for Chatbase's API. */
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
    if (msg.role === 'tool' || (msg.role === 'assistant' && Array.isArray(msg.content))) {
      const rendered = renderToolMessage(msg);
      if (rendered) parts.push(rendered);
      continue;
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
  // agent sees. Chatbase gives every message the user/owner role — there is no
  // true system message — so recency is the strongest lever we have against the
  // agent's own persona instructions overriding the tool loop.
  if (toolProtocol) {
    parts.push(toolProtocol);
  }
  return parts.join('\n\n');
}
