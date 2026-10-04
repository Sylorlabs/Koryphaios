// Transport layer for wire adapters: implements the Provider interface over
// plain fetch, framing the dialect's stream (JSONL or SSE) and translating
// adapter chunks into canonical ProviderEvents. Event emission mirrors
// OpenAIProvider exactly (tool_use_start/delta/stop, usage_update, complete)
// so the session manager cannot tell an adapter provider apart.

import type { ProviderConfig, ModelDef } from '@koryphaios/shared';
import {
  createGenericModel,
  type Provider,
  type ProviderEvent,
  type StreamRequest,
} from '../types';
import { isModelListCacheFresh } from '../model-list-cache';
import { imageAttachmentTransportError } from '../attachment-admission';
import { isTransientStreamErrorText } from '../provider-diagnostics';
import { applyModelsDevMetadata, modelsDevKeysFor } from '../models-dev';
import type {
  WireAdapter,
  WireAdapterChatRequest,
  WireAdapterRequestContext,
  WireAdapterStreamChunk,
} from './types';

const REQUEST_TIMEOUT_MS = 60_000;

function canonicalRequest(request: StreamRequest): WireAdapterChatRequest {
  return {
    model: request.model,
    systemPrompt: request.systemPrompt ?? '',
    messages: request.messages,
    ...(request.tools?.length && { tools: request.tools }),
    ...(request.maxTokens !== undefined && { maxTokens: request.maxTokens }),
    ...(request.temperature !== undefined && { temperature: request.temperature }),
  };
}

/** Split an SSE or JSONL body into JSON objects. */
async function* iterateStreamObjects(
  body: ReadableStream<Uint8Array>,
  format: 'jsonl' | 'sse',
): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        let line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
        buffer = buffer.slice(newlineIndex + 1);
        if (format === 'sse') {
          if (!line.startsWith('data:')) {
            newlineIndex = buffer.indexOf('\n');
            continue;
          }
          line = line.slice(5).trim();
        }
        if (line && line !== '[DONE]') {
          try {
            yield JSON.parse(line) as unknown;
          } catch {
            // Skip malformed lines rather than killing the stream.
          }
        }
        newlineIndex = buffer.indexOf('\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

interface ToolBuffer {
  id: string;
  name: string;
  args: string;
  started: boolean;
}

export class WireAdapterProvider implements Provider {
  readonly name: ProviderConfig['name'];
  readonly config: ProviderConfig;
  private cachedModels: ModelDef[] | null = null;
  private lastFetch = 0;
  private discoveryError: string | undefined;

  constructor(
    config: ProviderConfig,
    private readonly adapter: WireAdapter,
  ) {
    this.name = config.name;
    this.config = config;
  }

  get imageInputTransport(): 'native' | 'none' {
    return this.adapter.imageInputTransport ?? 'none';
  }

  private requestContext(): WireAdapterRequestContext {
    const credential = this.config.apiKey?.trim() || this.config.authToken?.trim() || undefined;
    return {
      config: this.config,
      baseUrl: (this.config.baseUrl ?? '').replace(/\/+$/, ''),
      ...(credential && { credential }),
      ...(this.config.headers && { extraHeaders: this.config.headers }),
    };
  }

  isAvailable(): boolean {
    if (this.config.disabled) return false;
    if (!this.config.baseUrl) return false;
    return true;
  }

  listModels(): ModelDef[] {
    if (!isModelListCacheFresh(this.lastFetch)) {
      void this.refreshModelsInBackground();
    }
    return this.cachedModels ?? this.declaredModels();
  }

  async refreshModels(_forceRefresh = false): Promise<void> {
    return this.refreshModelsInBackground();
  }

  getModelDiscoveryError(): string | undefined {
    return this.discoveryError;
  }

  private declaredModels(): ModelDef[] {
    return (this.config.models ?? []).map((id) => {
      const model = createGenericModel(id, this.name);
      model.apiModelId = id;
      return model;
    });
  }

  private async refreshModelsInBackground(): Promise<void> {
    const path = this.adapter.catalogPaths[0];
    if (!path) return;
    const ctx = this.requestContext();
    try {
      const headers: Record<string, string> = { Accept: 'application/json', ...ctx.extraHeaders };
      if (ctx.credential) headers.Authorization = `Bearer ${ctx.credential}`;
      const response = await fetch(`${ctx.baseUrl}${path}`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        this.discoveryError = `Catalog request failed (HTTP ${response.status}).`;
        this.lastFetch = Date.now();
        return;
      }
      const payload = (await response.json()) as unknown;
      const models = (payload as Record<string, unknown>).models;
      if (!Array.isArray(models)) {
        this.discoveryError = 'Catalog payload was not a model list.';
        this.lastFetch = Date.now();
        return;
      }
      const ids: string[] = [];
      for (const entry of models) {
        const name =
          typeof entry === 'string'
            ? entry
            : ((entry as Record<string, unknown> | null)?.name ??
              (entry as Record<string, unknown> | null)?.id);
        if (typeof name === 'string' && name.trim()) ids.push(name.trim());
      }
      if (ids.length === 0) {
        this.discoveryError = 'Catalog contained no model ids.';
        this.lastFetch = Date.now();
        return;
      }
      this.discoveryError = undefined;
      this.lastFetch = Date.now();
      this.cachedModels = applyModelsDevMetadata(
        this.name,
        ids.map((id) => {
          const model = createGenericModel(id, this.name);
          model.apiModelId = id;
          return model;
        }),
        modelsDevKeysFor(this.name, this.config.kind),
      );
    } catch (error: unknown) {
      this.discoveryError =
        error instanceof Error ? error.message : 'Model discovery request failed.';
      this.lastFetch = Date.now();
    }
  }

  async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    if (!this.isAvailable()) {
      yield { type: 'error', error: 'This custom provider is disabled or has no endpoint.' };
      return;
    }

    const imageError = imageAttachmentTransportError(this, request.messages);
    if (imageError) {
      yield { type: 'error', error: imageError, errorTransient: false };
      return;
    }

    const ctx = this.requestContext();
    const toolBuffers: ToolBuffer[] = [];
    let finishReason: ProviderEvent['finishReason'];

    try {
      const wireRequest = this.adapter.buildChatRequest(canonicalRequest(request), ctx);
      const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const signal = request.signal
        ? AbortSignal.any([request.signal, timeoutSignal])
        : timeoutSignal;
      const response = await fetch(`${ctx.baseUrl}${wireRequest.path}`, {
        method: 'POST',
        headers: wireRequest.headers,
        body: JSON.stringify(wireRequest.body),
        signal,
      });

      if (!response.ok || !response.body) {
        const detail = (await response.text().catch(() => '')).slice(0, 400);
        // A 2xx with no body is a server-side hiccup; anything else reports its
        // own status. Flagged from the status so retries do not depend on the
        // detail text being present.
        const emptySuccessBody = response.ok && !response.body;
        yield {
          type: 'error',
          error: emptySuccessBody
            ? `${this.adapter.label} returned an empty response body.`
            : response.status === 401 || response.status === 403
              ? `The endpoint rejected this provider's credentials (HTTP ${response.status}).${detail ? ` ${detail}` : ''}`
              : `${this.adapter.label} request failed (HTTP ${response.status}).${detail ? ` ${detail}` : ''}`,
          errorTransient: emptySuccessBody || response.status === 408 || response.status >= 500,
        };
        return;
      }

      for await (const raw of iterateStreamObjects(response.body, this.adapter.streamFormat)) {
        const chunk = this.adapter.parseEvent(raw);
        if (!chunk) continue;

        if (chunk.contentDelta) yield { type: 'content_delta', content: chunk.contentDelta };
        if (chunk.thinkingDelta) yield { type: 'thinking_delta', thinking: chunk.thinkingDelta };
        if (chunk.toolCall) yield* this.ingestToolCall(toolBuffers, chunk.toolCall);
        if (chunk.usage) {
          yield {
            type: 'usage_update',
            tokensIn: chunk.usage.tokensIn,
            tokensOut: chunk.usage.tokensOut,
            tokensCacheRead: chunk.usage.tokensCacheRead,
            tokensCacheWrite: chunk.usage.tokensCacheWrite,
          };
        }
        if (chunk.finishReason) finishReason = chunk.finishReason;
      }

      yield* flushToolBuffers(toolBuffers);
      yield { type: 'complete', finishReason: finishReason ?? 'end_turn' };
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') return;
      if (error instanceof Error && error.name === 'TimeoutError') {
        yield {
          type: 'error',
          error: `Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s — the endpoint did not respond.`,
          errorTransient: true,
        };
        return;
      }
      // Mid-stream transport death: the label is ours, the cause is the
      // endpoint's, so classify from the raw error instead of guessing.
      const transient = isTransientStreamErrorText(error);
      yield {
        type: 'error',
        error: `${this.adapter.label} request failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        errorTransient: transient,
      };
    }
  }

  private *ingestToolCall(
    buffers: ToolBuffer[],
    call: NonNullable<WireAdapterStreamChunk['toolCall']>,
  ): Generator<ProviderEvent> {
    let buffer = (call.id && buffers.find((entry) => entry.id === call.id)) || undefined;

    if (!buffer) {
      buffer = {
        id: call.id ?? `call_${buffers.length}`,
        name: call.name ?? '',
        args: '',
        started: false,
      };
      buffers.push(buffer);
    }

    if (!buffer.started) {
      buffer.started = true;
      if (call.name) buffer.name = call.name;
      yield { type: 'tool_use_start', toolCallId: buffer.id, toolName: buffer.name };
    } else if (call.name && !buffer.name) {
      buffer.name = call.name;
    }

    if (call.argsDelta) {
      buffer.args += call.argsDelta;
      yield {
        type: 'tool_use_delta',
        toolCallId: buffer.id,
        toolName: buffer.name,
        toolInput: call.argsDelta,
      };
    }
    if (call.argsObject) {
      const serialized = JSON.stringify(call.argsObject);
      buffer.args = serialized;
      yield {
        type: 'tool_use_delta',
        toolCallId: buffer.id,
        toolName: buffer.name,
        toolInput: serialized,
      };
    }
  }
}

function* flushToolBuffers(buffers: ToolBuffer[]): Generator<ProviderEvent> {
  for (const buffer of buffers) {
    if (!buffer.started) continue;
    yield {
      type: 'tool_use_stop',
      toolCallId: buffer.id,
      toolName: buffer.name,
      toolInput: buffer.args,
    };
  }
  buffers.length = 0;
}
