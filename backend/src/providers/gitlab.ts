// GitLab Duo provider — GitLab's hosted AI assistant, over the Duo REST API.
//
// This is not OpenAI-compatible. The real contract is:
//
//   POST {instance}/api/v4/chat/completions
//   Auth: Authorization: Bearer <PAT with `api` or `ai_features` scope>
//   Body: { content (max 1000 chars), additional_context?: [{category, id, content}],
//           referer_url?, client_subscription_id?, with_clean_history? }
//   Success: HTTP 201 whose body is a bare JSON string — one answer, no SSE.
//
// Ref: https://docs.gitlab.com/api/chat/
//
// Two consequences shape this adapter:
//
//   * `content` is the "question sent to Chat" and is capped at 1000 chars.
//     The system prompt, prior turns, and tool traffic therefore travel in
//     `additional_context` (600k chars per item) rather than being concatenated
//     into the question, which is what silently overran the limit before.
//   * The endpoint chooses the backend model and GitLab publishes no catalog
//     for it, so the model list is a single server-selected entry rather than a
//     guessed table of GitLab's internal models.
//
// Access is instance-gated: gitlab.com serves this to GitLab team members only
// and self-managed instances need the `access_rest_chat` feature flag, so a 404
// means "not enabled / not entitled", never "wrong URL".

import type { ProviderConfig, ModelDef } from '@koryphaios/shared';
import {
  type Provider,
  type ProviderEvent,
  type ProviderToolDef,
  type ProviderMessage,
  type StreamRequest,
  createGenericModel,
} from './types';
import { withTimeoutSignal } from './utils';
import { providerDefaultBaseUrl } from './constants';
import { providerLog } from '../logger';
import { safeUpstreamDetail } from './provider-diagnostics';
import { buildToolProtocol, parseTextToolCall } from './text-tool-protocol';

/** gitlab.com by default; a self-managed instance supplies its own base URL. */
export const GITLAB_DUO_BASE_URL = providerDefaultBaseUrl('gitlab') ?? 'https://gitlab.com/api/v4';

/** Documented `content` ceiling. Longer questions are split, never dropped. */
const CONTENT_MAX_CHARS = 1000;
/** Documented `additional_context[].id` ceiling. */
const CONTEXT_ID_MAX_CHARS = 255;
/** Documented per-item `additional_context[].content` ceiling. */
const CONTEXT_CONTENT_MAX_CHARS = 600_000;

const TURN_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 15_000;

const DUO_MODEL_ID = 'duo';

/**
 * GitLab routes Duo chat to a backend model it picks per request and exposes
 * no catalog endpoint for it, so the model list holds exactly that one
 * server-selected target.
 */
function duoModel(): ModelDef {
  const model = createGenericModel(DUO_MODEL_ID, 'gitlab');
  model.name = 'GitLab Duo';
  // Neither value is reported by the API. Keep a conservative estimate so the
  // context meter never claims more room than the instance actually grants.
  model.contextWindow = 32_000;
  model.maxOutputTokens = 4_096;
  // The endpoint answers in a single non-streamed body.
  model.supportsStreaming = false;
  return model;
}

function gitlabToken(config: ProviderConfig): string | undefined {
  return config.apiKey || config.authToken;
}

/** The Duo chat path, and the API root every accepted base URL is reduced to. */
const CHAT_PATH = '/chat/completions';
const API_ROOT = '/api/v4';

/**
 * Reduce whatever the user pasted to the instance's API root.
 *
 * GitLab is reachable at gitlab.com, at a bare self-managed host, under a
 * relative URL root (`https://example.com/gitlab`), and with or without the
 * `/api/v4` suffix — and a pasted value may even be the full chat endpoint.
 * All of those have to land on the same root, or the request 404s for a reason
 * that looks exactly like "this account has no Duo access".
 */
export function normalizeGitLabBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(
      'GitLab instance URL must be an absolute http(s) URL, e.g. https://gitlab.example.com',
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('GitLab instance URL must use http or https');
  }

  // A pasted endpoint loses its own path segments; the API root is rebuilt below.
  let path = url.pathname.replace(/\/+$/, '');
  if (path.endsWith(API_ROOT + CHAT_PATH)) {
    path = path.slice(0, -CHAT_PATH.length);
  }
  if (!path.endsWith(API_ROOT)) path = `${path}${API_ROOT}`;
  return `${url.origin}${path}`;
}

function gitlabBase(config: ProviderConfig): string {
  const configured = config.baseUrl?.trim();
  if (!configured) return GITLAB_DUO_BASE_URL;
  try {
    return normalizeGitLabBaseUrl(configured);
  } catch {
    // A malformed stored value must not turn every turn into a hard crash.
    providerLog.warn({ baseUrl: configured }, 'Falling back to the default GitLab instance');
    return GITLAB_DUO_BASE_URL;
  }
}

interface DuoContextItem {
  category: string;
  id: string;
  content: string;
}

function clamp(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * GitLab Duo takes one question plus supporting context, not a message array.
 * `content` stays the current user turn; everything the model needs to interpret
 * it — system instructions, earlier turns, tool traffic — becomes
 * `additional_context`, which is where the 600k-per-item budget actually lives.
 */
function buildDuoPayload(
  systemPrompt: string,
  messages: ProviderMessage[],
  toolProtocol: string | undefined,
  cleanHistory: boolean,
): { content: string; additional_context: DuoContextItem[]; with_clean_history: boolean } {
  // The current question is the last user turn. Every other turn — including
  // tool results, which the text protocol depends on — becomes context.
  const turns = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role !== 'system');
  const lastUser = turns.findLast(({ message }) => message.role === 'user');
  const question = lastUser ? messageText(lastUser.message) : '';

  const context: DuoContextItem[] = turns
    .filter(({ message, index }) => index !== lastUser?.index)
    .map(({ message, index }) => ({
      category: 'file',
      id: clamp(`${message.role}-turn-${index + 1}`, CONTEXT_ID_MAX_CHARS),
      content: clamp(messageText(message), CONTEXT_CONTENT_MAX_CHARS),
    }))
    .filter((item) => item.content.length > 0);

  if (systemPrompt?.trim()) {
    context.unshift({
      category: 'file',
      id: 'koryphaios-system-instructions',
      content: clamp(systemPrompt.trim(), CONTEXT_CONTENT_MAX_CHARS),
    });
  }
  if (toolProtocol) {
    context.push({
      category: 'file',
      id: 'koryphaios-tool-protocol',
      content: clamp(toolProtocol, CONTEXT_CONTENT_MAX_CHARS),
    });
  }

  // An over-long question keeps its full text in context so the 1000-char
  // `content` slice is a head summary rather than silent data loss.
  const content = clamp(question, CONTENT_MAX_CHARS);
  if (question.length > CONTENT_MAX_CHARS) {
    context.push({
      category: 'file',
      id: 'current-question-full-text',
      content: clamp(question, CONTEXT_CONTENT_MAX_CHARS),
    });
  }

  return { content, additional_context: context, with_clean_history: cleanHistory };
}

function messageText(message: ProviderMessage): string {
  if (typeof message.content === 'string') return message.content.trim();
  const parts = message.content
    .filter((block) => (block.type === 'text' || block.type === 'tool_result') && block.text)
    .map((block) => block.text as string);
  const images = message.content.filter((block) => block.type === 'image').length;
  if (images > 0) {
    // Duo's chat endpoint is text-only. Say so instead of dropping the
    // attachment without a trace.
    parts.push(
      `[${images} image attachment${images === 1 ? '' : 's'} omitted — GitLab Duo chat does not accept image input]`,
    );
  }
  return parts.join('\n').trim();
}

/** Duo answers with a bare JSON string; older docs also showed a `{ content }` wrapper. */
function extractAnswer(data: unknown): string {
  if (typeof data === 'string') return data.trim();
  if (data && typeof data === 'object') {
    const content = (data as Record<string, unknown>).content;
    if (typeof content === 'string') return content.trim();
  }
  return '';
}

function duoHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 'Koryphaios/1.0',
  };
}

/** Turn an HTTP failure into an actionable, non-bloated message. */
function httpErrorMessage(status: number, detail: string): { error: string; transient: boolean } {
  const suffix = detail ? ` GitLab said: ${detail}` : '';
  switch (status) {
    case 400:
      return {
        error: `GitLab Duo rejected the request body (HTTP 400).${suffix}`,
        transient: false,
      };
    case 401:
      return {
        error:
          'GitLab rejected this personal access token (HTTP 401). Create a PAT with the `api` or `ai_features` scope and reconnect.',
        transient: false,
      };
    case 403:
      return {
        error:
          'This GitLab token is not allowed to call the Duo Chat API (HTTP 403). It needs the `api` or `ai_features` scope — `read_api` is not sufficient.',
        transient: false,
      };
    case 404:
      return {
        error:
          'GitLab Duo chat is not available to this token on this instance (HTTP 404). On gitlab.com the REST chat endpoint is limited to GitLab team members; on self-managed it requires the access_rest_chat feature flag and a seat with Duo access.',
        transient: false,
      };
    case 429:
      return {
        error: `GitLab Duo rate limited this request (HTTP 429).${suffix}`,
        transient: true,
      };
    default:
      return {
        error: `GitLab Duo HTTP ${status}${suffix}`,
        transient: status >= 500,
      };
  }
}

export class GitLabProvider implements Provider {
  readonly name = 'gitlab' as const;

  constructor(readonly config: ProviderConfig) {}

  isAvailable(): boolean {
    return !this.config.disabled && !!gitlabToken(this.config);
  }

  listModels(): ModelDef[] {
    return [duoModel()];
  }

  getModelDiscoveryError(): string {
    return 'GitLab chooses the Duo model server-side per request and publishes no models API, so the catalog holds the single server-selected Duo target.';
  }

  async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    const token = gitlabToken(this.config);
    if (!token) {
      yield {
        type: 'error',
        error: 'GitLab Duo requires a personal access token with the `api` or `ai_features` scope.',
      };
      return;
    }

    const tools: ProviderToolDef[] = request.tools ?? [];
    const toolProtocol = tools.length > 0 ? buildToolProtocol(tools) : undefined;
    const payload = buildDuoPayload(
      request.systemPrompt,
      request.messages,
      toolProtocol,
      request.forceFreshConversation === true,
    );

    let response: Response;
    try {
      response = await fetch(`${gitlabBase(this.config)}${CHAT_PATH}`, {
        method: 'POST',
        headers: duoHeaders(token),
        body: JSON.stringify(payload),
        signal: withTimeoutSignal(request.signal, TURN_TIMEOUT_MS),
      });
    } catch (error: unknown) {
      yield {
        type: 'error',
        error: `GitLab Duo request failed: ${safeUpstreamDetail(error) || 'network error'}`,
        errorTransient: true,
      };
      return;
    }

    if (!response.ok) {
      const detail = safeUpstreamDetail(await response.text().catch(() => ''));
      const mapped = httpErrorMessage(response.status, detail);
      yield { type: 'error', error: mapped.error, errorTransient: mapped.transient };
      return;
    }

    const data: unknown = await response.json().catch(() => null);
    const answer = extractAnswer(data);
    if (!answer) {
      yield {
        type: 'error',
        error: 'GitLab Duo returned an empty answer',
        errorTransient: true,
      };
      return;
    }

    if (tools.length === 0) {
      yield { type: 'content_delta', content: answer };
      yield { type: 'complete', finishReason: 'stop' };
      return;
    }

    // A text-protocol call must not leak into the transcript as chat text.
    const call = parseTextToolCall(answer, tools);
    if (!call) {
      yield { type: 'content_delta', content: answer };
      yield { type: 'complete', finishReason: 'stop' };
      return;
    }
    const toolCallId = `gitlab-duo-tool-${Math.random().toString(36).slice(2, 10)}`;
    const toolInput = JSON.stringify(call.args);
    yield { type: 'tool_use_start', toolCallId, toolName: call.name };
    yield { type: 'tool_use_delta', toolCallId, toolName: call.name, toolInput };
    yield { type: 'tool_use_stop', toolCallId, toolName: call.name, toolInput };
    yield { type: 'complete', finishReason: 'tool_use' };
  }
}

/**
 * Prove real Duo access. There is no catalog or identity endpoint that also
 * proves Duo entitlement, so verification asks the chat endpoint itself with a
 * one-word question and a clean history, then reports exactly what came back.
 */
export async function verifyGitLabDuoAccess(
  config: ProviderConfig,
): Promise<{ success: boolean; error?: string }> {
  const token = gitlabToken(config);
  if (!token) {
    return {
      success: false,
      error: 'GitLab Duo requires a personal access token with the `api` or `ai_features` scope.',
    };
  }
  try {
    const response = await fetch(`${gitlabBase(config)}${CHAT_PATH}`, {
      method: 'POST',
      headers: duoHeaders(token),
      body: JSON.stringify({ content: 'ping', with_clean_history: true }),
      signal: withTimeoutSignal(undefined, PROBE_TIMEOUT_MS),
    });
    if (response.ok) return { success: true };
    const detail = safeUpstreamDetail(await response.text().catch(() => ''));
    providerLog.debug({ status: response.status, detail }, 'GitLab Duo access probe rejected');
    return { success: false, error: httpErrorMessage(response.status, detail).error };
  } catch (error: unknown) {
    return {
      success: false,
      error: `GitLab Duo verification failed: ${safeUpstreamDetail(error) || 'network error'}`,
    };
  }
}
