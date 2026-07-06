import type { ProviderConfig, ModelDef } from '@koryphaios/shared';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { serverLog } from '../logger';
import { withRetry, withTimeoutSignal } from './utils';
import { detectCodexAuthToken, refreshCodexAuthToken, CODEX_OAUTH_CLIENT_ID, getKoryCodexHome, isCodexCLIAuthMarker, clearCachedToken } from './auth-utils';
import {
  type Provider,
  type ProviderContentBlock,
  type ProviderEvent,
  type ProviderMessage,
  type ProviderToolDef,
  type StreamRequest,
  getModelsForProvider,
  resolveModel,
} from './types';

const CODEX_BACKEND_BASE_URL = 'https://chatgpt.com/backend-api/codex';
// Fallback used only when the local `codex` binary can't be probed for its real version.
// The backend gates newer models (e.g. gpt-5.5) behind a minimal_client_version check, so
// a stale pin here silently hides new models from listModels() — see getCodexClientVersion().
const CODEX_CLIENT_VERSION_FALLBACK = '0.120.0';
const CODEX_STREAM_TIMEOUT_MS = 300_000;
const CODEX_MODELS_CACHE_MS = 5 * 60_000;
const CODEX_CLIENT_VERSION_CACHE_MS = 60 * 60_000;

let cachedClientVersion: string | null = null;
let cachedClientVersionAt = 0;

/** Read the installed `codex` CLI's real version so model-list requests aren't gated
 *  behind a stale pinned client_version. Cached for an hour; falls back to a fixed
 *  version string if the binary isn't found (e.g. token-only setups). */
function getCodexClientVersion(): string {
  if (cachedClientVersion && Date.now() - cachedClientVersionAt < CODEX_CLIENT_VERSION_CACHE_MS) {
    return cachedClientVersion;
  }
  try {
    const out = execFileSync('codex', ['--version'], { encoding: 'utf-8', timeout: 5_000 }).trim();
    const match = out.match(/(\d+\.\d+\.\d+)/);
    cachedClientVersion = match ? match[1] : CODEX_CLIENT_VERSION_FALLBACK;
  } catch {
    cachedClientVersion = CODEX_CLIENT_VERSION_FALLBACK;
  }
  cachedClientVersionAt = Date.now();
  return cachedClientVersion;
}

type CodexModelRecord = {
  slug?: string;
  display_name?: string;
  context_window?: number;
  supported_reasoning_levels?: Array<{ effort?: string } | string>;
  input_modalities?: string[];
  additional_speed_tiers?: string[];
  priority?: number;
  visibility?: string;
};

type CodexModelsResponse = {
  models?: CodexModelRecord[];
};

type CodexResponseStreamEvent =
  | {
      type: 'response.output_text.delta';
      delta?: string;
    }
  | {
      type: 'response.reasoning_text.delta' | 'response.reasoning_summary_text.delta';
      delta?: string;
    }
  | {
      type: 'response.function_call_arguments.delta';
      delta?: string;
      item_id?: string;
      output_index?: number;
    }
  | {
      type: 'response.output_item.added' | 'response.output_item.done';
      item?: {
        id?: string;
        type?: string;
        call_id?: string;
        name?: string;
        arguments?: string;
      };
    }
  | {
      type: 'response.completed';
      response?: {
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          input_tokens_details?: { cached_tokens?: number };
        };
      };
    }
  | {
      type: 'response.failed' | 'response.incomplete' | 'error';
      error?: { message?: string } | string;
      response?: {
        error?: { message?: string } | string;
        incomplete_details?: { reason?: string };
      };
      message?: string;
    }
  | {
      type: string;
      [key: string]: unknown;
    };

export class CodexProvider implements Provider {
  readonly name = 'codex' as const;
  private cachedModels: ModelDef[] | null = null;
  private cachedModelsAt = 0;
  private fetchInProgress = false;

  constructor(readonly config: ProviderConfig) {}

  isAvailable(): boolean {
    return !this.config.disabled && !!this.resolveAuthToken();
  }

  listModels(): ModelDef[] {
    const fallback = getModelsForProvider('codex');
    if (!this.isAvailable()) return fallback;

    if (this.cachedModels && Date.now() - this.cachedModelsAt < CODEX_MODELS_CACHE_MS) {
      return this.cachedModels;
    }

    this.refreshModelsInBackground(fallback);
    return this.cachedModels ?? fallback;
  }

  private refreshModelsInBackground(fallback: ModelDef[]): void {
    if (this.fetchInProgress || !this.resolveAuthToken()) return;
    this.fetchInProgress = true;

    this.fetchRemoteModels(fallback)
      .then((models) => {
        this.cachedModels = models;
        this.cachedModelsAt = Date.now();
      })
      .catch((error) => {
        serverLog.warn(
          { provider: 'codex', error: error?.message ?? String(error) },
          'Failed to refresh Codex models from ChatGPT backend',
        );
        this.cachedModels ??= fallback;
      })
      .finally(() => {
        this.fetchInProgress = false;
      });
  }

  private async fetchRemoteModels(fallback: ModelDef[]): Promise<ModelDef[]> {
    const response = await withRetry(async () => {
      const res = await fetch(this.modelsUrl(), {
        headers: this.authHeaders({ Accept: 'application/json' }),
      });
      if (!res.ok) {
        throw await codexHttpError(res, 'Failed to load Codex models');
      }
      return res;
    });

    const body = (await response.json()) as CodexModelsResponse;
    const remote = Array.isArray(body.models) ? body.models : [];
    const discovered = remote
      .filter((item) => item.slug && (!item.visibility || item.visibility === 'list'))
      .map((item) => this.mapModel(item, fallback))
      .filter((item): item is ModelDef => !!item);

    return dedupeModels(discovered.length > 0 ? discovered : fallback);
  }

  async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    let response: Response | Error = await this.fetchWith401Recovery(request);

    if (response instanceof Error) {
      yield { type: 'error', error: response.message };
      return;
    }

    if (!response.body) {
      yield { type: 'error', error: 'Codex returned no response body' };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (!raw || raw === '[DONE]') continue;

          let event: CodexResponseStreamEvent;
          try {
            event = JSON.parse(raw) as CodexResponseStreamEvent;
          } catch {
            continue;
          }

          yield* this.mapStreamEvent(event);
        }
      }
    } catch (error: any) {
      if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return;
      yield { type: 'error', error: error?.message ?? String(error) };
      return;
    } finally {
      reader.releaseLock();
    }
  }

  private *mapStreamEvent(event: CodexResponseStreamEvent): Generator<ProviderEvent> {
    switch (event.type) {
      case 'response.output_text.delta': {
        const payload = event as Extract<CodexResponseStreamEvent, { type: 'response.output_text.delta' }>;
        if (payload.delta) {
          yield { type: 'content_delta', content: payload.delta };
        }
        return;
      }
      case 'response.reasoning_text.delta':
      case 'response.reasoning_summary_text.delta': {
        const payload = event as Extract<
          CodexResponseStreamEvent,
          { type: 'response.reasoning_text.delta' | 'response.reasoning_summary_text.delta' }
        >;
        if (payload.delta) {
          yield { type: 'thinking_delta', thinking: payload.delta };
        }
        return;
      }
      case 'response.output_item.added': {
        const payload = event as {
          item?: { id?: string; type?: string; call_id?: string; name?: string };
        };
        if (payload.item?.type === 'function_call') {
          yield {
            type: 'tool_use_start',
            toolCallId: payload.item.call_id ?? payload.item.id,
            toolName: payload.item.name,
          };
        }
        return;
      }
      case 'response.function_call_arguments.delta': {
        const payload = event as Extract<
          CodexResponseStreamEvent,
          { type: 'response.function_call_arguments.delta' }
        >;
        if (payload.delta) {
          yield {
            type: 'tool_use_delta',
            toolCallId: typeof payload.item_id === 'string' ? payload.item_id : undefined,
            toolInput: payload.delta,
          };
        }
        return;
      }
      case 'response.output_item.done': {
        const payload = event as {
          item?: {
            id?: string;
            type?: string;
            call_id?: string;
            name?: string;
            arguments?: string;
          };
        };
        if (payload.item?.type === 'function_call') {
          yield {
            type: 'tool_use_stop',
            toolCallId: payload.item.call_id ?? payload.item.id,
            toolName: payload.item.name,
            toolInput: payload.item.arguments,
          };
        }
        return;
      }
      case 'response.completed': {
        const payload = event as Extract<CodexResponseStreamEvent, { type: 'response.completed' }>;
        if (payload.response?.usage) {
          yield {
            type: 'usage_update',
            // OpenAI-style usage: input_tokens already INCLUDES cached tokens,
            // so tokensCache is deliberately omitted (it would double count).
            tokensIn: payload.response.usage.input_tokens,
            tokensOut: payload.response.usage.output_tokens,
          };
        }
        yield { type: 'complete', finishReason: 'end_turn' };
        return;
      }
      case 'response.failed':
      case 'response.incomplete':
      case 'error':
        yield {
          type: 'error',
          error: extractCodexStreamError(event),
        };
        return;
      default:
        return;
    }
  }

  private mapModel(item: CodexModelRecord, fallback: ModelDef[]): ModelDef | null {
    const id = item.slug?.trim();
    if (!id) return null;

    const existing =
      fallback.find((model) => model.id === id || model.apiModelId === id) ?? resolveModel(id);
    const reasoningLevels = Array.isArray(item.supported_reasoning_levels)
      ? item.supported_reasoning_levels
          .map((level) => (typeof level === 'string' ? level : level?.effort))
          .filter((level): level is string => !!level)
      : [];
    const modalities = Array.isArray(item.input_modalities) ? item.input_modalities : [];
    const speedTiers = Array.isArray(item.additional_speed_tiers)
      ? item.additional_speed_tiers
      : [];

    return {
      id,
      name: item.display_name?.trim() || existing?.name || id,
      provider: 'codex',
      apiModelId: id,
      contextWindow:
        typeof item.context_window === 'number' && item.context_window >= 1024
          ? item.context_window
          : (existing?.contextWindow ?? 0),
      contextVerified: typeof item.context_window === 'number' && item.context_window >= 1024,
      maxOutputTokens: existing?.maxOutputTokens ?? 32_768,
      costPerMInputTokens: existing?.costPerMInputTokens ?? 0,
      costPerMOutputTokens: existing?.costPerMOutputTokens ?? 0,
      canReason: reasoningLevels.length > 0 || existing?.canReason === true,
      reasoningLevels: reasoningLevels.length > 0 ? reasoningLevels : existing?.reasoningLevels,
      supportsAttachments: modalities.includes('image') || existing?.supportsAttachments === true,
      supportsStreaming: existing?.supportsStreaming ?? true,
      tier:
        existing?.tier ??
        (speedTiers.includes('fast')
          ? 'fast'
          : item.priority != null && item.priority <= 3
            ? 'flagship'
            : undefined),
    };
  }

  private modelsUrl(): string {
    return `${CODEX_BACKEND_BASE_URL}/models?client_version=${encodeURIComponent(getCodexClientVersion())}`;
  }

  private resolveAuthToken(): string | null {
    const authToken = this.config.authToken?.trim();
    if (!authToken) return null;
    if (isCodexCLIAuthMarker(authToken)) {
      return detectCodexAuthToken();
    }
    return authToken;
  }

  private authHeaders(extra?: Record<string, string>): HeadersInit {
    const authToken = this.resolveAuthToken();
    if (!authToken) {
      throw new Error('Codex auth token not found. Sign in with Codex again.');
    }
    return {
      Authorization: `Bearer ${authToken}`,
      ...extra,
    };
  }

  /**
   * Attempt the fetch with retry. If we get a 401, invalidate the cached token,
   * re-read auth.json, and retry once with the fresh token before surfacing
   * a "session expired" error.
   */
  private async fetchWith401Recovery(request: StreamRequest): Promise<Response | Error> {
    const allowedReasoningLevels = this.listModels().find(
      (m) => m.id === request.model || m.apiModelId === request.model,
    )?.reasoningLevels;

    const attempt = async (): Promise<Response | Error> => {
      try {
        return await withRetry(
          async () => {
            const res = await fetch(`${CODEX_BACKEND_BASE_URL}/responses`, {
              method: 'POST',
              headers: this.authHeaders({
                Accept: 'text/event-stream',
                'Content-Type': 'application/json',
              }),
              body: JSON.stringify(buildResponsesRequest(request, allowedReasoningLevels)),
              signal: withTimeoutSignal(request.signal, CODEX_STREAM_TIMEOUT_MS),
            });

            if (!res.ok) {
              throw await codexHttpError(res, 'Codex request failed');
            }
            return res;
          },
          { providerName: 'codex', modelName: request.model },
        );
      } catch (error) {
        return error instanceof Error ? error : new Error(String(error));
      }
    };

    let result = await attempt();

    // If 401, try to recover by re-reading auth.json
    if (result instanceof Error && (result as Error & { status?: number }).status === 401) {
      serverLog.info({ provider: 'codex' }, 'Received 401 from Codex — attempting token recovery');
      clearCachedToken('codex-cli-auth');
      // Re-read stored tokens first; if still rejected, refresh natively via
      // auth.openai.com (no codex binary involved).
      const freshToken = detectCodexAuthToken() ?? (await refreshCodexAuthToken());
      if (freshToken) {
        serverLog.info({ provider: 'codex' }, 'Recovered fresh Codex auth token — retrying request');
        result = await attempt();
      } else {
        return new Error(
          'Codex session expired. Please sign in with Codex again to continue.',
        );
      }
    }

    return result;
  }
}

function buildResponsesRequest(
  request: StreamRequest,
  allowedReasoningLevels?: string[],
): Record<string, unknown> {
  return {
    model: request.model,
    instructions: request.systemPrompt || '',
    input: request.messages.flatMap(convertMessageToCodexInput),
    tools: (request.tools ?? []).map(convertToolToCodexTool),
    tool_choice: 'auto',
    parallel_tool_calls: true,
    reasoning: buildReasoning(request.reasoningLevel, allowedReasoningLevels),
    store: false,
    stream: true,
    include: [],
  };
}

function convertToolToCodexTool(tool: ProviderToolDef): Record<string, unknown> {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  };
}

function convertMessageToCodexInput(message: ProviderMessage): Array<Record<string, unknown>> {
  if (message.role === 'tool') {
    return [
      {
        type: 'function_call_output',
        call_id: message.tool_call_id ?? '',
        output: flattenMessageText(message.content),
      },
    ];
  }

  // --- Assistant messages: content blocks use output_text/refusal types ---
  if (message.role === 'assistant') {
    const text = flattenMessageText(message.content);
    const content: Array<Record<string, unknown>> = text
      ? [{ type: 'output_text', text }]
      : [];
    if (content.length === 0) return [];
    return [
      {
        type: 'message',
        role: 'assistant',
        content,
      },
    ];
  }

  // --- User / system messages: use plain string content (not array of blocks) ---
  // The Codex Responses API now rejects content blocks with type "input_text";
  // only "output_text" and "refusal" are accepted. Instead, use the EasyInputMessage
  // format where content is a simple string for user/system roles.
  const text = flattenMessageText(message.content);
  if (!text.trim()) return [];
  return [
    {
      type: 'message',
      role: message.role,
      content: text,
    },
  ];
}

function convertContentBlocks(
  content: string | ProviderContentBlock[],
): Array<Record<string, unknown>> {
  // NOTE: This function is kept for potential image-handling use but the
  // Codex Responses API now rejects content blocks with type "input_text".
  // Only "output_text" / "refusal" are valid content block types.
  // New code should use convertMessageToCodexInput which handles this correctly.
  if (typeof content === 'string') {
    const text = content.trim();
    return text ? [{ type: 'output_text', text }] : [];
  }

  const blocks: Array<Record<string, unknown>> = [];
  for (const block of content) {
    if (block.type === 'text' && block.text) {
      blocks.push({ type: 'output_text', text: block.text });
      continue;
    }

    if (block.type === 'image' && block.imageData) {
      const mimeType = block.imageMimeType || 'image/png';
      blocks.push({
        type: 'input_image',
        image_url: `data:${mimeType};base64,${block.imageData}`,
      });
    }
  }

  return blocks;
}

function flattenMessageText(content: string | ProviderContentBlock[]): string {
  if (typeof content === 'string') return content;
  const parts = content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string);
  // The Codex Responses API only accepts plain-string user content here, so
  // images can't be forwarded — say so instead of silently dropping them.
  const imageCount = content.filter((block) => block.type === 'image').length;
  if (imageCount > 0) {
    parts.push(
      `[${imageCount} image attachment${imageCount === 1 ? '' : 's'} omitted — the Codex harness is text-only]`,
    );
  }
  return parts.join('\n');
}

// Used only when the model's real supported_reasoning_levels aren't known (e.g. a bare
// alias with no cached listModels() entry yet) — otherwise the live per-model list rules.
const CODEX_REASONING_LEVELS_FALLBACK = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];

function buildReasoning(
  reasoningLevel: string | undefined,
  allowedLevels?: string[],
): { effort?: string } | undefined {
  if (!reasoningLevel) return undefined;
  const normalized = reasoningLevel.toLowerCase();
  const allowed =
    allowedLevels && allowedLevels.length > 0 ? allowedLevels : CODEX_REASONING_LEVELS_FALLBACK;
  if (!allowed.includes(normalized)) {
    return undefined;
  }
  return { effort: normalized };
}

function extractCodexStreamError(event: CodexResponseStreamEvent): string {
  if (typeof (event as { message?: unknown }).message === 'string') {
    return (event as { message: string }).message;
  }

  if (typeof (event as { error?: unknown }).error === 'string') {
    return (event as { error: string }).error;
  }

  const nestedError = (event as { error?: { message?: string } }).error;
  if (nestedError && typeof nestedError === 'object' && typeof nestedError.message === 'string') {
    return nestedError.message;
  }

  const responseError = (event as { response?: { error?: { message?: string } | string } }).response
    ?.error;
  if (typeof responseError === 'string') return responseError;
  if (
    responseError &&
    typeof responseError === 'object' &&
    typeof responseError.message === 'string'
  ) {
    return responseError.message;
  }

  const incompleteReason = (event as { response?: { incomplete_details?: { reason?: string } } })
    .response?.incomplete_details?.reason;
  if (incompleteReason) return incompleteReason;

  return 'Unknown Codex error';
}

async function codexHttpError(response: Response, prefix: string): Promise<Error> {
  const text = (await response.text()).slice(0, 500);
  const error = new Error(`${prefix}: HTTP ${response.status}${text ? ` - ${text}` : ''}`);
  (error as Error & { status?: number }).status = response.status;
  return error;
}

function dedupeModels(models: ModelDef[]): ModelDef[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}

export interface CodexDeviceAuthStart {
  deviceAuthId: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}

export interface CodexDeviceAuthPoll {
  accessToken?: string;
  refreshToken?: string;
  tokenType?: string;
  error?: string;
  errorDescription?: string;
}

type CodexAuthSession = {
  id: string; // device_auth_id from auth.openai.com
  userCode: string;
  expiresAt: number;
  intervalMs: number;
};

// Native ChatGPT/Codex device-auth — the SAME endpoints `codex login
// --device-auth` uses (verified live), spoken directly: no codex binary, no
// terminal scraping. The user enters the code at CODEX_DEVICE_URL; we poll
// until tokens arrive, then persist them in Koryphaios's codex-home.
const CODEX_DEVICE_URL = 'https://auth.openai.com/codex/device';
const CODEX_DEVICEAUTH_BASE = 'https://auth.openai.com/api/accounts/deviceauth';
const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CODEX_DEVICE_EXPIRES_MS = 15 * 60_000;
const CODEX_DEVICE_INTERVAL_MS = 5_000;
const codexAuthSessions = new Map<string, CodexAuthSession>();

export function resetCodexDeviceAuthSessions(): void {
  codexAuthSessions.clear();
  serverLog.info({ provider: 'codex' }, 'Reset Codex device auth sessions');
}

function persistCodexTokens(tokens: {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  account_id?: string;
}): void {
  const home = getKoryCodexHome();
  mkdirSync(home, { recursive: true });
  const authPath = join(home, 'auth.json');
  let existing: Record<string, unknown> = {};
  try {
    if (existsSync(authPath)) existing = JSON.parse(readFileSync(authPath, 'utf-8'));
  } catch { /* rewrite from scratch */ }
  const prevTokens = (existing.tokens as Record<string, unknown> | undefined) ?? {};
  const merged = {
    ...existing,
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: (existing.OPENAI_API_KEY as string | null | undefined) ?? null,
    tokens: {
      ...prevTokens,
      ...(tokens.id_token ? { id_token: tokens.id_token } : {}),
      ...(tokens.access_token ? { access_token: tokens.access_token } : {}),
      ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
      ...(tokens.account_id ? { account_id: tokens.account_id } : {}),
    },
    last_refresh: new Date().toISOString(),
  };
  const { writeFileSync } = require('node:fs') as typeof import('node:fs');
  writeFileSync(authPath, JSON.stringify(merged, null, 2), 'utf-8');
  clearCachedToken('codex-cli-auth');
}

export async function startCodexDeviceAuth(): Promise<CodexDeviceAuthStart> {
  // Reuse a still-valid pending session so refresh-spamming the UI doesn't
  // mint a new code every time.
  const now = Date.now();
  for (const session of codexAuthSessions.values()) {
    if (session.expiresAt > now) {
      return {
        deviceAuthId: session.id,
        userCode: session.userCode,
        verificationUri: CODEX_DEVICE_URL,
        verificationUriComplete: CODEX_DEVICE_URL,
        expiresIn: Math.max(1, Math.floor((session.expiresAt - now) / 1000)),
        interval: Math.floor(session.intervalMs / 1000),
      };
    }
  }

  const res = await fetch(`${CODEX_DEVICEAUTH_BASE}/usercode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CODEX_OAUTH_CLIENT_ID }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`Codex device auth start failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as {
    device_auth_id?: string;
    user_code?: string;
    interval?: string | number;
    expires_at?: string;
  };
  if (!data.device_auth_id || !data.user_code) {
    throw new Error('Codex device auth start returned no code');
  }
  const expiresAt = data.expires_at ? Date.parse(data.expires_at) : now + CODEX_DEVICE_EXPIRES_MS;
  const intervalMs = Math.max(2, Number(data.interval) || 5) * 1000;
  const session: CodexAuthSession = {
    id: data.device_auth_id,
    userCode: data.user_code,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : now + CODEX_DEVICE_EXPIRES_MS,
    intervalMs,
  };
  codexAuthSessions.set(session.id, session);
  setTimeout(() => codexAuthSessions.delete(session.id), CODEX_DEVICE_EXPIRES_MS).unref?.();
  serverLog.info(
    { provider: 'codex', sessionId: session.id, userCode: session.userCode },
    'Started native Codex device auth',
  );
  return {
    deviceAuthId: session.id,
    userCode: session.userCode,
    verificationUri: CODEX_DEVICE_URL,
    verificationUriComplete: CODEX_DEVICE_URL,
    expiresIn: Math.max(1, Math.floor((session.expiresAt - now) / 1000)),
    interval: Math.floor(intervalMs / 1000),
  };
}

export async function pollCodexDeviceAuth(
  deviceAuthId: string,
  userCode: string,
): Promise<CodexDeviceAuthPoll> {
  try {
    const res = await fetch(`${CODEX_DEVICEAUTH_BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_auth_id: deviceAuthId,
        user_code: userCode,
        client_id: CODEX_OAUTH_CLIENT_ID,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const err = data.error as { code?: string; message?: string } | undefined;
    if (err?.code === 'deviceauth_authorization_pending') {
      return { error: 'authorization_pending' };
    }

    // Success can carry the tokens directly or an authorization_code to
    // exchange at /oauth/token — handle both shapes.
    const tokens =
      (data.tokens as Record<string, string> | undefined) ??
      (typeof data.access_token === 'string' ? (data as Record<string, string>) : undefined);
    if (tokens?.access_token) {
      persistCodexTokens(tokens);
      codexAuthSessions.delete(deviceAuthId);
      serverLog.info({ provider: 'codex' }, 'Native Codex device auth completed');
      return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, tokenType: 'bearer' };
    }
    const authCode = data.authorization_code as string | undefined;
    if (authCode) {
      const ex = await fetch(CODEX_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: authCode,
          client_id: CODEX_OAUTH_CLIENT_ID,
          redirect_uri: 'https://auth.openai.com/deviceauth/callback',
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const exData = (await ex.json().catch(() => ({}))) as Record<string, string>;
      if (exData.access_token) {
        persistCodexTokens(exData);
        codexAuthSessions.delete(deviceAuthId);
        serverLog.info({ provider: 'codex' }, 'Native Codex device auth completed (code exchange)');
        return { accessToken: exData.access_token, refreshToken: exData.refresh_token, tokenType: 'bearer' };
      }
      serverLog.warn({ provider: 'codex', keys: Object.keys(exData) }, 'Codex token exchange returned no token');
    }

    if (err) {
      codexAuthSessions.delete(deviceAuthId);
      return { error: err.code ?? 'authorization_failed', errorDescription: err.message };
    }
    serverLog.warn(
      { provider: 'codex', keys: Object.keys(data) },
      'Codex device auth poll returned unrecognized payload',
    );
    return { error: 'authorization_pending' };
  } catch (error: unknown) {
    return {
      error: 'authorization_error',
      errorDescription: error instanceof Error ? error.message : String(error),
    };
  }
}
