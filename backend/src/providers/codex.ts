import type { ProviderConfig, ModelDef } from '@koryphaios/shared';
import { execFileSync, spawn, type ChildProcessByStdio } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { serverLog } from '../logger';
import { withRetry, withTimeoutSignal } from './utils';
import { detectCodexAuthToken, getKoryCodexHome, isCodexCLIAuthMarker, clearCachedToken } from './auth-utils';
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
            tokensIn: payload.response.usage.input_tokens,
            tokensOut: payload.response.usage.output_tokens,
            tokensCache: payload.response.usage.input_tokens_details?.cached_tokens,
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
      const freshToken = detectCodexAuthToken();
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
  id: string;
  userCode?: string;
  verificationUri?: string;
  expiresAt: number;
  intervalMs: number;
  status: 'starting' | 'pending' | 'connected' | 'error';
  error?: string;
  process: ChildProcessByStdio<null, Readable, Readable>;
  logPath: string;
};

const CODEX_DEVICE_URL = 'https://auth.openai.com/codex/device';
const CODEX_DEVICE_CODE_REGEX = /\b([A-Z0-9]{4,5}-[A-Z0-9]{4,6})\b/;
const CODEX_DEVICE_URL_REGEX = /https:\/\/auth\.openai\.com\/codex\/device\b/;
const ANSI_ESCAPE_REGEX = /\x1B\[[0-9;]*m/g;
const CODEX_DEVICE_EXPIRES_MS = 15 * 60_000;
const CODEX_DEVICE_INTERVAL_MS = 5_000;
const codexAuthSessions = new Map<string, CodexAuthSession>();

function summarizeCodexAuthLog(logPath: string): string | undefined {
  try {
    if (!existsSync(logPath)) return undefined;
    const raw = readFileSync(logPath, 'utf-8').replace(ANSI_ESCAPE_REGEX, '');
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) return undefined;
    return lines.slice(-8).join(' | ');
  } catch (error: any) {
    return `failed to read auth log: ${error?.message ?? String(error)}`;
  }
}

function describeCodexAuthSession(session: CodexAuthSession): Record<string, unknown> {
  return {
    provider: 'codex',
    sessionId: session.id,
    status: session.status,
    userCode: session.userCode,
    verificationUri: session.verificationUri,
    expiresAt: new Date(session.expiresAt).toISOString(),
    logPath: session.logPath,
    error: session.error,
    logTail: summarizeCodexAuthLog(session.logPath),
  };
}

function getReusableCodexAuthSession(): CodexAuthSession | null {
  const now = Date.now();
  for (const session of codexAuthSessions.values()) {
    if (
      session.expiresAt > now &&
      (session.status === 'starting' || session.status === 'pending') &&
      session.userCode &&
      session.verificationUri
    ) {
      return session;
    }
  }
  return null;
}

function cleanupCodexAuthSession(id: string): void {
  const session = codexAuthSessions.get(id);
  if (!session) return;
  codexAuthSessions.delete(id);
  if (!session.process.killed) {
    session.process.kill('SIGTERM');
  }
}

function scheduleCodexAuthSessionCleanup(id: string, delayMs = CODEX_DEVICE_EXPIRES_MS): void {
  setTimeout(() => {
    cleanupCodexAuthSession(id);
  }, delayMs).unref?.();
}

export function resetCodexDeviceAuthSessions(): void {
  for (const sessionId of [...codexAuthSessions.keys()]) {
    cleanupCodexAuthSession(sessionId);
  }
  serverLog.info({ provider: 'codex' }, 'Reset Codex device auth sessions');
}

/**
 * Delete device-auth log files older than 1 hour to prevent unbounded accumulation.
 */
function cleanStaleAuthLogs(logDir: string): void {
  const maxAgeMs = 60 * 60_000; // 1 hour
  const cutoff = Date.now() - maxAgeMs;
  try {
    for (const entry of readdirSync(logDir)) {
      if (!entry.startsWith('device-auth-') || !entry.endsWith('.log')) continue;
      const filePath = join(logDir, entry);
      try {
        if (statSync(filePath).mtimeMs < cutoff) {
          unlinkSync(filePath);
        }
      } catch {
        // Ignore individual file cleanup failures.
      }
    }
  } catch {
    // Directory may not exist yet or be unreadable — safe to ignore.
  }
}

export async function startCodexDeviceAuth(): Promise<CodexDeviceAuthStart> {
  return await new Promise((resolve, reject) => {
    const reusable = getReusableCodexAuthSession();
    if (reusable) {
      serverLog.info(
        {
          ...describeCodexAuthSession(reusable),
          expiresInSeconds: Math.max(1, Math.floor((reusable.expiresAt - Date.now()) / 1000)),
        },
        'Reusing pending Codex device auth session',
      );
      resolve({
        deviceAuthId: reusable.id,
        userCode: reusable.userCode!,
        verificationUri: reusable.verificationUri!,
        verificationUriComplete: reusable.verificationUri!,
        expiresIn: Math.max(1, Math.floor((reusable.expiresAt - Date.now()) / 1000)),
        interval: Math.floor(reusable.intervalMs / 1000),
      });
      return;
    }

    const codexHome = getKoryCodexHome();
    mkdirSync(codexHome, { recursive: true });
    const logDir = join(codexHome, 'log');
    mkdirSync(logDir, { recursive: true });
    cleanStaleAuthLogs(logDir);
    const sessionId = crypto.randomUUID();
    const logPath = join(logDir, `device-auth-${sessionId}.log`);
    serverLog.info(
      {
        provider: 'codex',
        sessionId,
        codexHome,
        logPath,
        command: 'codex login --device-auth',
      },
      'Starting Codex device auth session',
    );
    const proc = spawn('script', ['-q', '-f', logPath, '-c', 'codex login --device-auth'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
      },
    });

    const session: CodexAuthSession = {
      id: sessionId,
      expiresAt: Date.now() + CODEX_DEVICE_EXPIRES_MS,
      intervalMs: CODEX_DEVICE_INTERVAL_MS,
      status: 'starting',
      process: proc,
      logPath,
    };
    codexAuthSessions.set(sessionId, session);
    scheduleCodexAuthSessionCleanup(sessionId);

    let settled = false;

    const tryResolve = () => {
      if (settled || !session.userCode || !session.verificationUri) return;
      settled = true;
      session.status = 'pending';
      serverLog.info(
        {
          ...describeCodexAuthSession(session),
          expiresInSeconds: Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000)),
        },
        'Codex device auth code became available',
      );
      resolve({
        deviceAuthId: sessionId,
        userCode: session.userCode,
        verificationUri: session.verificationUri,
        verificationUriComplete: session.verificationUri,
        expiresIn: Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000)),
        interval: Math.floor(session.intervalMs / 1000),
      });
    };

    const ingest = (chunk: string) => {
      const cleaned = chunk.replace(ANSI_ESCAPE_REGEX, '');
      if (!session.verificationUri) {
        const urlMatch = cleaned.match(CODEX_DEVICE_URL_REGEX);
        if (urlMatch) {
          session.verificationUri = urlMatch[0];
          serverLog.debug(
            { provider: 'codex', sessionId: session.id, verificationUri: session.verificationUri },
            'Captured Codex verification URL',
          );
        }
      }
      if (!session.userCode) {
        const codeMatch = cleaned.match(CODEX_DEVICE_CODE_REGEX);
        if (codeMatch) {
          session.userCode = codeMatch[1];
          serverLog.debug(
            { provider: 'codex', sessionId: session.id, userCode: session.userCode },
            'Captured Codex device auth code',
          );
        }
      }
      tryResolve();
    };

    const pollLogForCode = () => {
      if (settled || session.status === 'error' || session.status === 'connected') return;
      try {
        if (existsSync(logPath)) {
          ingest(readFileSync(logPath, 'utf-8'));
        }
      } catch {
        // Ignore transient read errors while the file is being written.
      }
      if (!settled) {
        setTimeout(pollLogForCode, 100);
      }
    };
    pollLogForCode();

    proc.once('error', (error) => {
      session.status = 'error';
      session.error = error.message;
       serverLog.error(
        {
          ...describeCodexAuthSession(session),
          spawnError: error.message,
        },
        'Codex device auth process failed to start',
      );
      if (!settled) {
        settled = true;
        reject(new Error(`Failed to start Codex login: ${error.message}`));
      }
    });

    proc.once('exit', (code) => {
      if (detectCodexAuthToken()) {
        session.status = 'connected';
        serverLog.info(describeCodexAuthSession(session), 'Codex device auth process exited after credentials became available');
        return;
      }

      if (session.status !== 'connected') {
        session.status = 'error';
        session.error =
          code === 0
            ? 'Codex login ended before credentials became available'
            : `Codex login exited with code ${code}`;
      }

      serverLog.warn(
        {
          ...describeCodexAuthSession(session),
          exitCode: code,
        },
        'Codex device auth process exited before auth completed',
      );

      if (!settled) {
        settled = true;
        reject(new Error(session.error ?? 'Codex login exited before device auth was ready'));
      }
    });

    // Fallback timeout so the route returns a real error instead of hanging forever.
    setTimeout(() => {
      if (settled) return;
      session.status = 'error';
      session.error = 'Timed out waiting for Codex device-auth code';
      serverLog.error(describeCodexAuthSession(session), 'Timed out waiting for Codex device auth code');
      settled = true;
      reject(new Error(session.error));
    }, 10_000).unref?.();
  });
}

export async function pollCodexDeviceAuth(
  deviceAuthId: string,
  userCode: string,
): Promise<CodexDeviceAuthPoll> {
  const session = codexAuthSessions.get(deviceAuthId);
  if (!session) {
    serverLog.warn(
      { provider: 'codex', sessionId: deviceAuthId, userCode },
      'Codex auth poll received for unknown or expired session',
    );
    return {
      error: 'authorization_unknown',
      errorDescription: 'This Codex sign-in session expired. Start auth again.',
    };
  }

  if (session.userCode && session.userCode !== userCode) {
    serverLog.warn(
      {
        ...describeCodexAuthSession(session),
        providedUserCode: userCode,
      },
      'Codex auth poll received mismatched user code',
    );
    return {
      error: 'authorization_mismatch',
      errorDescription: 'The provided Codex sign-in code does not match the active login session.',
    };
  }

  const liveToken = detectCodexAuthToken();
  if (liveToken) {
    session.status = 'connected';
    serverLog.info(describeCodexAuthSession(session), 'Codex auth poll detected stored credentials');
    cleanupCodexAuthSession(deviceAuthId);
    return {
      accessToken: liveToken,
      tokenType: 'bearer',
    };
  }

  if (session.status === 'error') {
    serverLog.warn(describeCodexAuthSession(session), 'Codex auth poll observed failed auth session');
    cleanupCodexAuthSession(deviceAuthId);
    return {
      error: 'authorization_failed',
      errorDescription: session.error ?? 'Codex sign-in failed',
    };
  }

  return { error: 'authorization_pending' };
}
