// Anthropic Claude provider — supports Claude 3.5/3.7/4 Sonnet, Opus, Haiku.
// Uses extended thinking for reasoning models. Never restricts output quality.
// Supports both API key and Claude Code OAuth token (Pro/Max subscription).

import Anthropic from '@anthropic-ai/sdk';
import type { ProviderConfig, ModelDef, ProviderName } from '@koryphaios/shared';
import {
  type Provider,
  type ProviderEvent,
  type StreamRequest,
  type ProviderContentBlock,
  resolveModel,
} from './types';
import { withRetry, withTimeoutSignal } from './utils';
import { createUsageInterceptingFetch } from '../credit-accountant';
import { providerLog } from '../logger';
import { applyModelsDevMetadata, refreshModelsDevCache, modelsDevKeysFor } from './models-dev';
import { isModelListCacheFresh, mergeModelLists, modelFromRemoteId } from './model-list-cache';
import { providerStreamFailure } from './provider-diagnostics';
import {
  canonicalizeProviderTools,
  derivePromptCacheLane,
  observePromptCacheDispatch,
  resolvePromptCacheSegments,
} from './prompt-cache';
import { promptCacheDiagnostics, selectAdaptiveCacheTtl } from './cache-fabric';
import { promptCacheMaintenance } from './cache-maintenance';
import { resolvePricing } from '../pricing';

export class AnthropicProvider implements Provider {
  readonly name: ProviderName;
  protected _client: Anthropic | null = null;

  constructor(
    readonly config: ProviderConfig,
    name: ProviderName = 'anthropic',
  ) {
    this.name = name;
  }

  protected get client(): Anthropic {
    if (!this._client) {
      this._client = this.makeClient();
    }
    return this._client;
  }

  /** Build the underlying client. Overridden by BedrockProvider to use AnthropicBedrock (SigV4). */
  protected makeClient(): Anthropic {
    const hasCredential = !!(this.config.apiKey || this.config.authToken);
    const defaultHeaders: Record<string, string | null> = { ...(this.config.headers ?? {}) };
    if (!hasCredential && this.config.custom) {
      defaultHeaders['x-api-key'] = null;
      defaultHeaders.Authorization = null;
    }
    return new Anthropic({
      // An Anthropic auth token is a Bearer credential. Supplying the custom
      // keyless placeholder alongside it makes the SDK prefer x-api-key and
      // turns a successful Bearer catalog probe into a runtime 401.
      apiKey:
        this.config.apiKey ||
        (!this.config.authToken && this.config.custom ? 'placeholder' : undefined),
      authToken: this.config.authToken,
      baseURL: this.config.baseUrl || undefined,
      defaultHeaders,
      fetch: createUsageInterceptingFetch(globalThis.fetch),
    });
  }

  isAvailable(): boolean {
    const available =
      !this.config.disabled &&
      !!(
        this.config.apiKey ||
        this.config.authToken ||
        (this.config.custom && this.config.baseUrl)
      );
    if (available && !isModelListCacheFresh(this.lastFetch)) {
      this.refreshModelsInBackground([]);
    }
    return available;
  }

  private cachedModels: ModelDef[] | null = null;
  private lastFetch = 0;
  private refreshInProgress: Promise<void> | null = null;

  listModels(): ModelDef[] {
    const fallback: ModelDef[] = [];
    if (!this.isAvailable()) return [];
    if (this.cachedModels && isModelListCacheFresh(this.lastFetch)) return this.cachedModels;
    this.refreshModelsInBackground(fallback);
    return this.cachedModels ?? [];
  }

  refreshModels(forceRefresh = false): Promise<void> {
    if (this.refreshInProgress) return this.refreshInProgress;
    if (!forceRefresh && this.cachedModels && isModelListCacheFresh(this.lastFetch)) {
      return Promise.resolve();
    }
    if (forceRefresh) {
      this.cachedModels = null;
      this.lastFetch = 0;
    }

    this.refreshInProgress = (async () => {
      try {
        // Kick models.dev refresh early so enrichment has data by the time
        // discovery completes (non-blocking, idempotent within TTL).
        refreshModelsDevCache();
        const response = await withRetry(() => this.client.models.list());
        const discovered: ModelDef[] = [];
        for (const model of response.data) {
          const id = model.id;
          if (!id) continue;
          discovered.push(modelFromRemoteId(id, this.name, []));
        }
        if (discovered.length > 0) {
          this.cachedModels = applyModelsDevMetadata(
            this.name,
            mergeModelLists([], discovered),
            modelsDevKeysFor(this.name, this.config.kind),
          );
          providerLog.debug(
            { provider: this.name, count: this.cachedModels.length },
            'Model list refreshed from provider API',
          );
        }
        this.lastFetch = Date.now();
      } catch (err) {
        this.lastFetch = Date.now();
        providerLog.debug(
          { provider: this.name, err: err instanceof Error ? err.message : String(err) },
          'Model list refresh failed; leaving catalog empty rather than exposing a fallback list',
        );
      } finally {
        this.refreshInProgress = null;
      }
    })();
    return this.refreshInProgress;
  }

  private refreshModelsInBackground(_fallback: ModelDef[]) {
    void this.refreshModels(false);
  }

  async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    let messages = this.convertMessages(request.messages);

    // Vision guard: all Claude models accept images, but this provider also
    // serves Anthropic-COMPATIBLE gateway models (e.g. OpenCode Go MiniMax/Qwen)
    // that may not. When the model is explicitly known to lack vision, swap
    // image blocks for a text note so the request doesn't 400.
    const requestDef =
      this.listModels().find((m) => m.id === request.model || m.apiModelId === request.model) ??
      resolveModel(request.model);
    if (requestDef?.vision === false && requestDef.supportsAttachments !== true) {
      messages = messages.map((m) => {
        if (!Array.isArray(m.content)) return m;
        return {
          ...m,
          content: m.content.map((b) =>
            b.type === 'image'
              ? {
                  type: 'text' as const,
                  text: '[image attachment omitted — this model may not support image input]',
                }
              : b,
          ),
        };
      });
    }

    const nativePromptCaching =
      !this.config.custom && (this.name === 'anthropic' || this.name === 'bedrock');
    const cacheSegments = resolvePromptCacheSegments(request);
    const canonicalTools = canonicalizeProviderTools(request.tools);
    const cacheRoutingContext = {
      provider: String(this.name),
      custom: this.config.custom === true,
      reasoningScopeOverride: request.cacheReasoningScopeOverride,
    };
    const cacheLane = nativePromptCaching
      ? derivePromptCacheLane(request, canonicalTools, cacheRoutingContext)
      : undefined;
    const cacheDiagnostic = nativePromptCaching
      ? observePromptCacheDispatch(request, canonicalTools, cacheRoutingContext)
      : undefined;
    if (cacheDiagnostic) {
      providerLog.debug(
        {
          provider: this.name,
          model: request.model,
          cacheState: cacheDiagnostic.state,
          cacheLane: cacheDiagnostic.laneKey,
          cacheLaneKind: cacheDiagnostic.laneKind,
          cacheBreakReasons: cacheDiagnostic.reasons,
        },
        'Prompt cache lane dispatch',
      );
    }
    const adaptiveCacheTtl =
      this.name === 'anthropic' ? selectAdaptiveCacheTtl(cacheDiagnostic) : '5m';
    const cacheControl =
      adaptiveCacheTtl === '1h'
        ? ({ type: 'ephemeral' as const, ttl: '1h' as const } as const)
        : ({ type: 'ephemeral' as const } as const);
    const tools = canonicalTools.map((t, index, all) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      ...(nativePromptCaching && index === all.length - 1 ? { cache_control: cacheControl } : {}),
    }));

    const system =
      nativePromptCaching && cacheSegments.valid
        ? [
            {
              type: 'text' as const,
              text: cacheSegments.stable,
              cache_control: cacheControl,
            },
            ...(cacheSegments.dynamic
              ? [{ type: 'text' as const, text: cacheSegments.dynamic }]
              : []),
          ]
        : request.systemPrompt;

    const params: Anthropic.MessageCreateParamsStreaming = {
      // Use the catalog's apiModelId (dated Anthropic id, or the Bedrock model id) when known.
      model: resolveModel(request.model)?.apiModelId ?? request.model,
      max_tokens: request.maxTokens ?? 16_384,
      system: system as Anthropic.MessageCreateParamsStreaming['system'],
      messages,
      stream: true,
      ...(tools?.length && { tools }),
    };
    if (this.name === 'anthropic' && tools.length > 0 && request.allowedToolNames?.length === 0) {
      // Cache prewarm must carry the exact same declared tool prefix as a real
      // turn, but it must never invite a tool call. Anthropic supports an
      // explicit none choice, which preserves declarations while preventing
      // tool selection on the wire.
      params.tool_choice = { type: 'none' };
    }
    if (nativePromptCaching && this.name === 'anthropic') {
      // Automatic caching advances a rolling conversation breakpoint while
      // the explicit system marker preserves the cross-task workspace layer.
      // The older installed SDK does not type the current top-level control.
      (params as unknown as Record<string, unknown>).cache_control = cacheControl;
    }

    // Extended thinking: Opus 4.6 & Sonnet 4.6 use adaptive + output_config.effort (Anthropic API);
    // Haiku 4.5 and others use thinking.type "enabled" + budget_tokens.
    const isOpus46 = /^claude-opus-4-6/i.test(request.model || '');
    const isSonnet46 = /^claude-sonnet-4-6/i.test(request.model || '');
    const isHaiku45 = /^claude-haiku-4-5/i.test(request.model || '');

    if (request.reasoningLevel !== undefined && request.reasoningLevel !== '') {
      const level = String(request.reasoningLevel).toLowerCase().trim();
      const outputTokens = request.maxTokens ?? 16_384;

      if (isOpus46 || isSonnet46) {
        // API: output_config.effort (low|medium|high|max), thinking.type "adaptive". Max is Opus 4.6 only.
        // Pass provider-reported tiers through verbatim instead of coercing
        // unknown values to medium, so new provider tiers keep working.
        const effort = level || 'medium';
        if (effort === 'max' && isSonnet46) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK types lag behind API; output_config not yet typed
          (params as unknown as Record<string, unknown>).output_config = { effort: 'high' };
        } else {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK types lag behind API; output_config not yet typed
          (params as unknown as Record<string, unknown>).output_config = { effort };
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK types lag behind API; thinking not yet typed
        (params as unknown as Record<string, unknown>).thinking = { type: 'adaptive' };
      } else if (isHaiku45) {
        // Haiku 4.5: extended thinking with budget_tokens (same API as other Claude 4).
        const budget =
          level === '0' || level === 'off' ? 0 : Math.max(0, parseInt(level, 10) || 8192);
        if (budget > 0) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK types lag behind API; thinking not yet typed
          (params as unknown as Record<string, unknown>).thinking = {
            type: 'enabled',
            budget_tokens: budget,
          };
          params.max_tokens = budget + outputTokens;
        }
      } else {
        // Other Anthropic (Sonnet 4.5, 4, 3.7, etc.): thinking on/off with budget.
        let thinkingBudget = 8192;
        if (level === 'off' || level === 'none' || level === '0') {
          thinkingBudget = 0;
        } else if (level === 'on') {
          thinkingBudget = 8192;
        } else if (level === 'low') {
          thinkingBudget = 4096;
        } else if (level === 'medium') {
          thinkingBudget = 8192;
        } else if (level === 'high' || level === 'max' || level === 'xhigh') {
          thinkingBudget = 32768;
        } else if (!isNaN(Number(level))) {
          thinkingBudget = Number(level);
        }
        if (thinkingBudget > 0) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK types lag behind API; thinking not yet typed
          (params as unknown as Record<string, unknown>).thinking = {
            type: 'enabled',
            budget_tokens: thinkingBudget,
          };
          params.max_tokens = thinkingBudget + outputTokens;
        }
      }
    }

    try {
      // Apply 60-second hard timeout to prevent indefinite hangs
      const timeoutSignal = withTimeoutSignal(request.signal, 60_000);
      const stream = await withRetry(
        () =>
          this.client.messages.stream(params, {
            signal: timeoutSignal,
          }),
        { providerName: this.name, modelName: request.model },
      );

      let currentToolCallId = '';
      let currentToolName = '';
      let toolInputBuffer = '';
      let observedInputTokens: number | undefined;
      let observedCacheReadTokens = 0;
      let observedCacheWriteTokens = 0;

      for await (const event of stream) {
        switch (event.type) {
          case 'content_block_start': {
            const block = event.content_block;
            if (block.type === 'tool_use') {
              currentToolCallId = block.id;
              currentToolName = block.name;
              toolInputBuffer = '';
              yield {
                type: 'tool_use_start',
                toolCallId: block.id,
                toolName: block.name,
              };
            } else if (block.type === 'thinking') {
              yield { type: 'thinking_delta', thinking: block.thinking };
            }
            break;
          }

          case 'content_block_delta': {
            const delta = event.delta;
            if (delta.type === 'text_delta') {
              yield { type: 'content_delta', content: delta.text };
            } else if (delta.type === 'thinking_delta') {
              yield { type: 'thinking_delta', thinking: delta.thinking };
            } else if (delta.type === 'input_json_delta') {
              toolInputBuffer += delta.partial_json;
              yield {
                type: 'tool_use_delta',
                toolCallId: currentToolCallId,
                toolName: currentToolName,
                toolInput: delta.partial_json,
              };
            }
            break;
          }

          case 'content_block_stop': {
            if (currentToolCallId) {
              yield {
                type: 'tool_use_stop',
                toolCallId: currentToolCallId,
                toolName: currentToolName,
                toolInput: toolInputBuffer,
              };
              currentToolCallId = '';
              currentToolName = '';
              toolInputBuffer = '';
            }
            break;
          }

          case 'message_delta': {
            // SDK types event.usage for message_delta
            const usage = (event as unknown as Record<string, unknown>).usage as
              { output_tokens?: number } | undefined;
            yield {
              type: 'usage_update',
              tokensOut: usage?.output_tokens,
            };
            yield {
              type: 'complete',
              finishReason: event.delta.stop_reason === 'tool_use' ? 'tool_use' : 'end_turn',
            };
            break;
          }

          case 'message_start': {
            const usage = event.message.usage;
            const cacheRead =
              ((usage as unknown as Record<string, unknown>).cache_read_input_tokens as
                number | undefined) ?? 0;
            const cacheWrite =
              ((usage as unknown as Record<string, unknown>).cache_creation_input_tokens as
                number | undefined) ?? 0;
            observedInputTokens = usage.input_tokens;
            observedCacheReadTokens = cacheRead;
            observedCacheWriteTokens = cacheWrite;
            const cacheOutcome = cacheDiagnostic
              ? promptCacheDiagnostics.recordProviderOutcome(cacheDiagnostic, {
                  inputTokens: usage.input_tokens + cacheRead + cacheWrite,
                  cacheReadTokens: cacheRead,
                  cacheWriteTokens: cacheWrite,
                })
              : undefined;
            yield {
              type: 'usage_update',
              tokensIn: usage.input_tokens,
              tokensOut: usage.output_tokens,
              // Anthropic's input_tokens EXCLUDES cached prompt tokens — report
              // cache reads + writes separately so context occupancy is real.
              tokensCache: cacheRead + cacheWrite,
              tokensCacheRead: cacheRead,
              tokensCacheWrite: cacheWrite,
              cacheExpectedWarm: cacheOutcome?.expectedWarm,
              cacheUnexpectedMiss: cacheOutcome?.unexpectedMiss,
              cacheLaneKind: cacheDiagnostic?.laneKind,
            };
            break;
          }
        }
      }

      if (
        this.name === 'anthropic' &&
        cacheSegments.valid &&
        request.promptCache &&
        cacheLane &&
        cacheDiagnostic
      ) {
        const pricing = resolvePricing(this.name, request.model);
        const stableTokens =
          request.promptCache.estimatedStableTokens +
          Math.ceil(Buffer.byteLength(JSON.stringify(canonicalTools), 'utf8') / 4);
        const refreshInputTokens =
          observedInputTokens === undefined
            ? stableTokens
            : observedInputTokens + observedCacheReadTokens + observedCacheWriteTokens;
        const refreshCachedTokens = Math.min(
          refreshInputTokens,
          Math.max(stableTokens, observedCacheReadTokens + observedCacheWriteTokens),
        );
        const maintenanceParams: Anthropic.MessageCreateParamsNonStreaming = {
          model: params.model,
          max_tokens: 1,
          system: params.system,
          // Replay the exact successful lane request so the rolling
          // conversation breakpoint stays warm too, not only the immutable
          // system/tool prefix. The generated answer is capped and discarded.
          messages: params.messages,
          ...(tools.length > 0 ? { tools } : {}),
          ...(params.tool_choice ? { tool_choice: params.tool_choice } : {}),
        };
        const requestCacheControl = (params as unknown as Record<string, unknown>).cache_control;
        if (requestCacheControl !== undefined) {
          (maintenanceParams as unknown as Record<string, unknown>).cache_control =
            requestCacheControl;
        }
        promptCacheMaintenance.observe({
          provider: this.name,
          sessionId: request.sessionId,
          routingKey: cacheLane.routingKey,
          slotKey: cacheLane.slotKey,
          stableTokens,
          refreshInputTokens,
          refreshCachedTokens,
          ttlMs: adaptiveCacheTtl === '1h' ? 60 * 60_000 : 5 * 60_000,
          diagnostic: cacheDiagnostic,
          mode: request.promptCacheKeepaliveMode,
          pricing: pricing
            ? {
                freshInputPerMillion: pricing.inPerM,
                cacheReadPerMillion: pricing.cacheReadPerM,
                cacheWritePerMillion: pricing.cacheWritePerM,
              }
            : null,
          refresh: async () => {
            await withRetry(
              () =>
                this.client.messages.create(maintenanceParams, {
                  signal: withTimeoutSignal(undefined, 20_000),
                }),
              { providerName: this.name, modelName: request.model },
            );
          },
        });
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        const failure = providerStreamFailure(this.name, 'sdk', err, {
          message: `Request timed out after 60s — provider ${this.name} did not respond. Try again or switch model/provider.`,
        });
        providerLog.error(
          { ...failure.diagnostic, model: request.model },
          'Anthropic provider stream timed out',
        );
        // A timed-out attempt is worth repeating: the same turn usually succeeds
        // once the provider's own queue drains.
        yield { ...failure.event, errorTransient: true };
        return;
      }
      if (err instanceof Error && err.name === 'AbortError') return;

      const failure = providerStreamFailure(this.name, 'sdk', err);
      providerLog.error(
        { ...failure.diagnostic, model: request.model },
        'Anthropic provider stream error',
      );
      yield failure.event;
    }
  }

  private convertMessages(messages: StreamRequest['messages']): Anthropic.MessageParam[] {
    return messages
      .filter((m) => m.role !== 'system')
      .map((m) => {
        if (typeof m.content === 'string') {
          if (m.role === 'tool') {
            return {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: m.tool_call_id ?? '',
                  content: m.content,
                  is_error: false,
                },
              ],
            } as Anthropic.MessageParam;
          }
          if (m.role === 'assistant' && m.tool_calls?.length) {
            const blocks: Anthropic.ContentBlockParam[] = [];
            if (m.content) blocks.push({ type: 'text', text: m.content });
            for (const tc of m.tool_calls) {
              blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input ?? {} });
            }
            return { role: 'assistant', content: blocks } as Anthropic.MessageParam;
          }
          return { role: m.role as 'user' | 'assistant', content: m.content };
        }

        const blocks = m.content as ProviderContentBlock[];
        const anthropicContent: Anthropic.ContentBlockParam[] = blocks.map((b) => {
          if (b.type === 'text') {
            return { type: 'text', text: b.text ?? '' };
          }
          if (b.type === 'tool_use') {
            return {
              type: 'tool_use',
              id: b.toolCallId ?? '',
              name: b.toolName ?? '',
              input: b.toolInput ?? {},
            };
          }
          if (b.type === 'tool_result') {
            return {
              type: 'tool_result',
              tool_use_id: b.toolCallId ?? '',
              content: b.toolOutput ?? '',
              is_error: b.isError ?? false,
            };
          }
          if (b.type === 'image') {
            return {
              type: 'image',
              source: {
                type: 'base64',
                media_type: (b.imageMimeType ?? 'image/png') as
                  'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
                data: b.imageData ?? '',
              },
            };
          }
          return { type: 'text', text: '' };
        });

        return { role: m.role as 'user' | 'assistant', content: anthropicContent };
      });
  }
}
