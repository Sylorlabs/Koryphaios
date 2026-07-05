// OpenAI provider — supports GPT-4.1, O3, O4-mini, Codex.
// Also used as base for Groq, OpenRouter, xAI (OpenAI-compatible endpoints).

import OpenAI, { AzureOpenAI } from 'openai';
import type { ProviderConfig, ProviderName, ModelDef } from '@koryphaios/shared';

import {
  type Provider,
  type ProviderEvent,
  type StreamRequest,
  type ProviderContentBlock,
  getModelsForProvider,
  resolveModel,
} from './types';
import { withRetry, withTimeoutSignal } from './utils';
import { createUsageInterceptingFetch } from '../credit-accountant';
import { providerLog } from '../logger';
import { applyModelsDevMetadata } from './models-dev';
import {
  enrichFromRemoteMetadata,
  isLikelyChatModelId,
  isModelListCacheFresh,
  mergeModelLists,
  modelFromRemoteId,
} from './model-list-cache';

export class OpenAIProvider implements Provider {
  protected _client: OpenAI | null = null;

  constructor(
    readonly config: ProviderConfig,
    readonly name: ProviderName = 'openai',
    private readonly baseUrl?: string,
  ) {}

  protected get client(): OpenAI {
    if (!this._client) {
      const apiKey = this.config.apiKey || this.config.authToken;
      this._client = new OpenAI({
        apiKey: apiKey || 'placeholder',
        baseURL: this.baseUrl ?? this.config.baseUrl,
        defaultHeaders: this.config.headers,
        fetch: createUsageInterceptingFetch(globalThis.fetch),
      });
    }
    return this._client;
  }

  isAvailable(): boolean {
    const available = !this.config.disabled && !!(this.config.apiKey || this.config.authToken);
    if (available && !isModelListCacheFresh(this.lastFetch)) {
      this.refreshModelsInBackground(this.getModelCatalogFallback());
    }
    return available;
  }

  /** Static catalog used until live discovery succeeds. Subclasses may override. */
  protected getModelCatalogFallback(): ModelDef[] {
    return getModelsForProvider(this.name);
  }

  /** Optional async prep (OAuth exchange, etc.) before hitting /models. */
  protected async prepareForModelDiscovery(): Promise<void> {}

  private cachedModels: ModelDef[] | null = null;
  private lastFetch = 0;
  private fetchInProgress = false;

  listModels(): ModelDef[] {
    const fallback = this.getModelCatalogFallback();
    if (!this.isAvailable()) return fallback;
    if (this.cachedModels && isModelListCacheFresh(this.lastFetch)) return this.cachedModels;
    this.refreshModelsInBackground(fallback);
    return this.cachedModels ?? fallback;
  }

  /**
   * Many OpenAI-compatible /models endpoints return capability metadata beyond
   * the bare id (OpenRouter: `context_length`; GitHub Copilot:
   * `capabilities.limits.max_context_window_tokens` / `max_output_tokens`,
   * `capabilities.supports.vision`; various gateways: `context_window`,
   * `display_name`). The SDK preserves those extra fields on the raw objects —
   * ingest them so the UI shows the provider's REAL numbers instead of the
   * hand-maintained catalog's.
   */
  protected enrichDiscoveredModel(raw: unknown, def: ModelDef): ModelDef {
    return enrichFromRemoteMetadata(raw, def);
  }

  private refreshModelsInBackground(fallback: ModelDef[]) {
    if (this.fetchInProgress) return;
    this.fetchInProgress = true;

    void (async () => {
      try {
        await this.prepareForModelDiscovery();
        const response = await withRetry(() => this.client.models.list());
        const discovered: ModelDef[] = [];
        for await (const model of response) {
          const id = model.id;
          if (!id || !isLikelyChatModelId(id, this.name)) continue;
          discovered.push(this.enrichDiscoveredModel(model, modelFromRemoteId(id, this.name, fallback)));
        }
        if (discovered.length > 0) {
          this.cachedModels = applyModelsDevMetadata(this.name, mergeModelLists(fallback, discovered));
          providerLog.debug(
            { provider: this.name, count: this.cachedModels.length },
            'Model list refreshed from provider API',
          );
        } else {
          this.cachedModels ??= fallback;
        }
        this.lastFetch = Date.now();
      } catch (err) {
        providerLog.debug(
          { provider: this.name, err: err instanceof Error ? err.message : String(err) },
          'Model list refresh failed; using catalog fallback',
        );
        this.cachedModels ??= fallback;
      } finally {
        this.fetchInProgress = false;
      }
    })();
  }

  async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    let messages = this.convertMessages(request);

    // Vision guard: if the model is KNOWN not to support images (live metadata
    // reported vision: false), replace image parts with a text note up front so
    // the request never 400s. Models with unknown metadata keep their images —
    // a rejection is caught below and retried once without them.
    if (messagesContainImages(messages)) {
      const liveDef =
        this.listModels().find(
          (m) => m.id === request.model || m.apiModelId === request.model,
        ) ?? resolveModel(request.model);
      const supportsVision = liveDef?.vision === true || liveDef?.supportsAttachments === true;
      if (liveDef?.vision === false && !supportsVision) {
        messages = stripImageParts(messages);
        providerLog.debug(
          { provider: this.name, model: request.model },
          'Model does not support images — attachments replaced with a text note',
        );
      }
    }

    const tools = request.tools?.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));

    // Check if the specific model supports reasoning — prefer live-discovered
    // defs (models.dev enrichment for zen/go, remote metadata elsewhere) over
    // the static catalog, which knows nothing about gateway models.
    const modelDef = resolveModel(request.model);
    const liveDef = this.listModels().find(
      (m) => m.id === request.model || m.apiModelId === request.model,
    );
    const canReason = liveDef?.canReason ?? modelDef?.canReason ?? false;
    let reasoningEffort = request.reasoningLevel?.toLowerCase();
    // Budget-token levels (Copilot claude-haiku-4.5 / gemini-2.5-pro declare
    // '0'|'1024'|'8192'|'24576') can't ride the OpenAI wire verbatim — map to
    // the nearest reasoning_effort instead of silently dropping the selection.
    if (reasoningEffort && /^\d+$/.test(reasoningEffort)) {
      const budget = Number(reasoningEffort);
      reasoningEffort =
        budget === 0 ? 'none' : budget <= 1024 ? 'low' : budget <= 8192 ? 'medium' : 'high';
    }
    // 'max' is offered per-model (e.g. Copilot's claude-opus-4.6) — the UI only
    // shows levels the model's own metadata/config declares, so passing it
    // through is safe; without it the selection was silently dropped.
    const supportedEfforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

    const params: OpenAI.ChatCompletionCreateParamsStreaming = {
      model: modelDef?.apiModelId ?? request.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(request.maxTokens && { max_completion_tokens: request.maxTokens }),
      ...(request.temperature !== undefined && { temperature: request.temperature }),
      ...(tools?.length && { tools }),
    };

    // Only send reasoning_effort if model + selected level supports it.
    if (canReason && reasoningEffort && supportedEfforts.includes(reasoningEffort)) {
      if (this.name === 'deepseek') {
        // DeepSeek 2026 (V4): uses "thinking" parameter object
        (params as any).thinking = { 
          type: reasoningEffort === 'none' ? 'disabled' : 'enabled' 
        };
        // Use reasoning_effort string directly (low, medium, high, max)
        if (reasoningEffort !== 'none') {
          (params as any).reasoning_effort = reasoningEffort === 'xhigh' ? 'max' : reasoningEffort;
        }
      } else {
        (params as any).reasoning_effort = reasoningEffort as any;
      }
    }

    try {
      // Apply 60-second hard timeout to prevent indefinite hangs
      const timeoutSignal = withTimeoutSignal(request.signal, 60_000);
      const createStream = () =>
        this.client.chat.completions.create(params, { signal: timeoutSignal });
      let stream: Awaited<ReturnType<typeof createStream>>;
      try {
        stream = await withRetry(createStream, {
          providerName: this.name,
          modelName: request.model,
        });
      } catch (err) {
        // Some models reject images only at request time (metadata absent or
        // wrong). Degrade gracefully: drop the images, note it, retry once.
        if (messagesContainImages(params.messages) && isVisionRejectionError(err)) {
          providerLog.warn(
            { provider: this.name, model: request.model },
            'Model rejected image input — retrying without attachments',
          );
          params.messages = stripImageParts(params.messages);
          stream = await withRetry(createStream, {
            providerName: this.name,
            modelName: request.model,
          });
        } else {
          throw err;
        }
      }

      const toolCallBuffers = new Map<number, { id: string; name: string; args: string }>();

      for await (const chunk of stream) {
        const choice = chunk.choices?.[0];
        if (!choice) {
          if (chunk.usage) {
            yield {
              type: 'usage_update',
              // prompt_tokens already includes cached tokens — omit tokensCache
              // so context occupancy isn't double counted downstream.
              tokensIn: chunk.usage.prompt_tokens,
              tokensOut: chunk.usage.completion_tokens,
            };
          }
          continue;
        }

        const delta = choice.delta;

        // Content streaming
        if (delta?.content) {
          yield { type: 'content_delta', content: delta.content };
        }

        // Reasoning content (O-series models)
        if ((delta as any)?.reasoning_content) {
          yield { type: 'thinking_delta', thinking: (delta as any).reasoning_content };
        }

        // Tool call streaming
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            if (!toolCallBuffers.has(idx)) {
              toolCallBuffers.set(idx, {
                id: tc.id ?? '',
                name: tc.function?.name ?? '',
                args: '',
              });
              yield {
                type: 'tool_use_start',
                toolCallId: tc.id,
                toolName: tc.function?.name,
              };
            }

            const buf = toolCallBuffers.get(idx)!;
            if (tc.id) buf.id = tc.id;
            if (tc.function?.name) buf.name = tc.function.name;
            if (tc.function?.arguments) {
              buf.args += tc.function.arguments;
              yield {
                type: 'tool_use_delta',
                toolCallId: buf.id,
                toolName: buf.name,
                toolInput: tc.function.arguments,
              };
            }
          }
        }

        // Completion
        if (choice.finish_reason) {
          yield* this.flushToolCalls(toolCallBuffers);
          yield {
            type: 'complete',
            finishReason: this.mapFinishReason(choice.finish_reason),
          };
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError' || err.name === 'AbortSignal') return;

      // Log full error details for debugging
      const errorDetail = {
        message: err.message ?? String(err),
        name: err.name,
        status: err.status,
        code: err.code,
        type: err.type,
      };
      providerLog.error(
        { errorDetail, model: request.model, provider: this.name },
        'OpenAI provider stream error',
      );

      yield { type: 'error', error: errorDetail.message };
    }
  }

  private *flushToolCalls(
    toolCallBuffers: Map<number, { id: string; name: string; args: string }>,
  ) {
    for (const [, buf] of toolCallBuffers) {
      yield {
        type: 'tool_use_stop',
        toolCallId: buf.id,
        toolName: buf.name,
        toolInput: buf.args,
      } as ProviderEvent;
    }
    toolCallBuffers.clear();
  }

  private mapFinishReason(reason: string): ProviderEvent['finishReason'] {
    switch (reason) {
      case 'stop':
        return 'stop';
      case 'length':
        return 'max_tokens';
      case 'tool_calls':
        return 'tool_use';
      default:
        return 'end_turn';
    }
  }

  protected convertMessages(request: StreamRequest): OpenAI.ChatCompletionMessageParam[] {
    const result: OpenAI.ChatCompletionMessageParam[] = [];

    if (request.systemPrompt) {
      result.push({ role: 'system', content: request.systemPrompt });
    }

    for (const msg of request.messages) {
      if (msg.role === 'system') continue;

      if (typeof msg.content === 'string') {
        if (msg.role === 'tool') {
          result.push({
            role: 'tool',
            tool_call_id: msg.tool_call_id ?? '',
            content: msg.content,
          });
        } else if (msg.role === 'assistant' && msg.tool_calls?.length) {
          result.push({
            role: 'assistant',
            content: msg.content || null,
            tool_calls: msg.tool_calls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.name, arguments: JSON.stringify(tc.input ?? {}) },
            })),
          });
        } else {
          result.push({ role: msg.role as any, content: msg.content });
        }
        continue;
      }

      const blocks = msg.content as ProviderContentBlock[];
      if (msg.role === 'assistant') {
        result.push(this.mapAssistantMessage(blocks));
      } else if (msg.role === 'user') {
        this.mapUserMessage(blocks, result);
      }
    }

    return result;
  }

  private mapAssistantMessage(
    blocks: ProviderContentBlock[],
  ): OpenAI.ChatCompletionAssistantMessageParam {
    const text = blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const toolCalls = blocks
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({
        id: b.toolCallId ?? '',
        type: 'function' as const,
        function: { name: b.toolName ?? '', arguments: JSON.stringify(b.toolInput ?? {}) },
      }));

    return {
      role: 'assistant',
      content: text || null,
      ...(toolCalls.length && { tool_calls: toolCalls }),
    };
  }

  private mapUserMessage(
    blocks: ProviderContentBlock[],
    result: OpenAI.ChatCompletionMessageParam[],
  ) {
    const toolResults = blocks.filter((b) => b.type === 'tool_result');
    if (toolResults.length) {
      for (const tr of toolResults) {
        result.push({
          role: 'tool',
          tool_call_id: tr.toolCallId ?? '',
          content: tr.toolOutput ?? '',
        });
      }
    } else {
      const content: OpenAI.ChatCompletionContentPart[] = blocks.map((b) => {
        if (b.type === 'image') {
          return {
            type: 'image_url',
            image_url: { url: `data:${b.imageMimeType};base64,${b.imageData}` },
          };
        }
        return { type: 'text', text: b.text ?? '' };
      });
      result.push({ role: 'user', content });
    }
  }
}

// ─── Vision fallback helpers ─────────────────────────────────────────────────

const IMAGE_OMITTED_NOTE =
  '[image attachment omitted — the selected model does not support image input]';

function messagesContainImages(messages: OpenAI.ChatCompletionMessageParam[]): boolean {
  return messages.some(
    (m) =>
      m.role === 'user' &&
      Array.isArray(m.content) &&
      m.content.some((part) => part.type === 'image_url'),
  );
}

function stripImageParts(
  messages: OpenAI.ChatCompletionMessageParam[],
): OpenAI.ChatCompletionMessageParam[] {
  return messages.map((m) => {
    if (m.role !== 'user' || !Array.isArray(m.content)) return m;
    if (!m.content.some((part) => part.type === 'image_url')) return m;
    const parts = m.content.map((part) =>
      part.type === 'image_url' ? ({ type: 'text', text: IMAGE_OMITTED_NOTE } as const) : part,
    );
    return { ...m, content: parts };
  });
}

function isVisionRejectionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /image|vision|multimodal|image_url/i.test(msg);
}

// ─── OpenAI-Compatible Provider Factories ───────────────────────────────────

export class GroqProvider extends OpenAIProvider {
  constructor(config: ProviderConfig) {
    super(config, 'groq', 'https://api.groq.com/openai/v1');
  }
}

export class OpenRouterProvider extends OpenAIProvider {
  constructor(config: ProviderConfig) {
    super(config, 'openrouter', 'https://openrouter.ai/api/v1');
  }
}

export class XAIProvider extends OpenAIProvider {
  constructor(config: ProviderConfig) {
    super(config, 'xai', 'https://api.x.ai/v1');
  }
}

// Azure OpenAI + Azure Cognitive Services. Unlike the OpenAI-compatible providers,
// Azure authenticates with an `api-key` header (not Bearer) and routes to
// `{endpoint}/openai/deployments/{deployment}/chat/completions?api-version=...`.
// The official AzureOpenAI client builds exactly that wire shape; the selected model
// id is used as the deployment name. All streaming/parsing logic is inherited.
const AZURE_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '2024-10-21';

export class AzureProvider extends OpenAIProvider {
  constructor(config: ProviderConfig, name: ProviderName = 'azure') {
    super(config, name, config.baseUrl);
  }

  protected override get client(): OpenAI {
    if (!this._client) {
      const endpoint = this.config.baseUrl;
      if (!endpoint) {
        throw new Error(
          `${this.name} requires an endpoint (base URL), e.g. https://YOUR_RESOURCE.openai.azure.com`,
        );
      }
      this._client = new AzureOpenAI({
        apiKey: this.config.apiKey || this.config.authToken || 'placeholder',
        endpoint,
        apiVersion: AZURE_API_VERSION,
        fetch: createUsageInterceptingFetch(globalThis.fetch),
      });
    }
    return this._client;
  }
}
