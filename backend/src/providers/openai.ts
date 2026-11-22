// OpenAI provider — supports GPT-4.1, O3, O4-mini, Codex.
// Also used as base for Groq, OpenRouter, xAI (OpenAI-compatible endpoints).

import OpenAI, { AzureOpenAI } from 'openai';
import { userConfirmedImageInput } from './attachment-admission';
import type {
  ModelParameterKey,
  ProviderConfig,
  ProviderName,
  ModelDef,
} from '@koryphaios/shared';
import { sanitizeModelParameterValues } from '@koryphaios/shared';

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
import {
  enrichFromRemoteMetadata,
  isLikelyChatModelId,
  isModelListCacheFresh,
  mergeModelLists,
  modelFromRemoteId,
} from './model-list-cache';
import {
  providerStreamFailure,
  safeProviderDiagnostic,
  safeProviderFailureMessage,
} from './provider-diagnostics';
import { withOpenRouterAttribution } from './api-endpoints';
import {
  canonicalizeProviderTools,
  derivePromptCacheLane,
  deriveProviderPromptCacheKey,
  observePromptCacheDispatch,
  resolvePromptCacheSegments,
} from './prompt-cache';
import { promptCacheMaintenance } from './cache-maintenance';
import { promptCacheDiagnostics } from './cache-fabric';
import { resolvePricing } from '../pricing';
import {
  foldVendorSpeedTiers,
  resolveSpeedVariant,
  SPEED_TIER_PRIORITY_OPENAI,
} from './speed-tiers';
import { normalizeToolArguments } from './tool-arguments';

const ALL_MODEL_PARAMETER_KEYS: ReadonlySet<ModelParameterKey> = new Set([
  'temperature',
  'top_p',
  'top_k',
  'min_p',
  'top_a',
  'frequency_penalty',
  'presence_penalty',
  'repetition_penalty',
  'seed',
  'max_tokens',
  'verbosity',
]);
const GWARDEN_FORWARDED_PARAMETERS: ReadonlySet<ModelParameterKey> = new Set(['max_tokens']);

export class OpenAIProvider implements Provider {
  readonly imageInputTransport = 'native' as const;
  protected _client: OpenAI | null = null;

  constructor(
    readonly config: ProviderConfig,
    readonly name: ProviderName = 'openai',
    protected readonly baseUrl?: string,
  ) {}

  protected get client(): OpenAI {
    if (!this._client) {
      const apiKey = this.config.apiKey || this.config.authToken;
      const defaultHeaders: Record<string, string | null> = {
        ...(this.name === 'openrouter' ? withOpenRouterAttribution() : {}),
        ...(this.config.headers ?? {}),
      };
      // The OpenAI SDK requires a constructor key and otherwise turns the
      // placeholder into a real Authorization header. Keyless local/custom
      // endpoints must receive no fabricated credential at all.
      if (!apiKey && this.config.custom) defaultHeaders.Authorization = null;
      this._client = new OpenAI({
        apiKey: apiKey || 'placeholder',
        // Selected provider config owns auth/account scope, never SDK env defaults.
        organization: null,
        project: null,
        baseURL: this.baseUrl ?? this.config.baseUrl,
        defaultHeaders,
        fetch: createUsageInterceptingFetch(this.requestFetch()),
        timeout: 1_800_000,
      });
    }
    return this._client;
  }

  protected requestFetch(): typeof fetch {
    return globalThis.fetch;
  }

  protected modelDiscoveryAuthenticationAction(): string {
    return 'Reconnect the provider and retry model discovery.';
  }

  isAvailable(): boolean {
    const available =
      !this.config.disabled &&
      !!(
        this.config.apiKey ||
        this.config.authToken ||
        (this.config.custom && (this.baseUrl || this.config.baseUrl))
      );
    if (available && !isModelListCacheFresh(this.lastFetch)) {
      this.refreshModelsInBackground(this.getModelCatalogFallback());
    }
    return available;
  }

  /** Discovery has no bundled fallback: a picker entry needs provider proof. */
  protected getModelCatalogFallback(): ModelDef[] {
    return [];
  }

  /** Optional async prep (OAuth exchange, etc.) before hitting /models. */
  protected async prepareForModelDiscovery(): Promise<void> {}

  private cachedModels: ModelDef[] | null = null;
  private lastFetch = 0;
  private refreshInProgress: Promise<void> | null = null;
  private modelCatalogAuthoritative = false;
  private modelDiscoveryError: string | undefined;
  private modelDiscoveryHttpStatus: number | undefined;

  refreshModels(forceRefresh = false): Promise<void> {
    if (!forceRefresh) return Promise.resolve();
    // Keep the last provider-reported catalog visible while a manual refresh
    // is in flight. A transient /models failure must not make the selected
    // model lose its trusted context or reasoning controls.
    this.lastFetch = 0;
    return this.refreshModelsInBackground(this.getModelCatalogFallback());
  }

  listModels(): ModelDef[] {
    const fallback = this.getModelCatalogFallback();
    if (!this.isAvailable()) return [];
    if (this.cachedModels && isModelListCacheFresh(this.lastFetch)) return this.cachedModels;
    void this.refreshModelsInBackground(fallback);
    return this.cachedModels ?? [];
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
    const enriched = enrichFromRemoteMetadata(raw, def);
    // Reflection's Chat Completions contract accepts text only.
    return this.name === 'beam'
      ? { ...enriched, vision: false, supportsAttachments: false }
      : enriched;
  }

  private getModelIdFromRemote(raw: unknown): string | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const model = raw as Record<string, unknown>;
    const candidates = [model.id, model.name, model.model];
    for (const candidate of candidates) {
      if (typeof candidate === 'string') {
        const value = candidate.trim();
        if (value) return value;
      }
    }
    return undefined;
  }

  /** Whether a catalog row is a chat model. Protected so a gateway whose
   *  catalog mixes chat with image, video, audio or embedding rows can
   *  exclude them instead of offering a model that cannot answer a message. */
  protected isChatModelCandidate(raw: unknown, id: string): boolean {
    if (!isLikelyChatModelId(id, this.name)) return false;
    if (this.name !== 'cohere') return true;

    if (!raw || typeof raw !== 'object') return true;
    const model = raw as Record<string, unknown>;
    const rawEndpoints = model.endpoints;
    if (!rawEndpoints) return true;
    if (Array.isArray(rawEndpoints)) {
      return (rawEndpoints as unknown[]).some(
        (endpoint) => typeof endpoint === 'string' && endpoint.toLowerCase().includes('chat'),
      );
    }
    if (typeof rawEndpoints === 'string') {
      return rawEndpoints.toLowerCase().includes('chat');
    }
    const endpointContainer = rawEndpoints as { value?: unknown };
    const valueEndpoints = endpointContainer.value;
    if (Array.isArray(valueEndpoints)) {
      return (valueEndpoints as unknown[]).some(
        (endpoint: unknown) =>
          typeof endpoint === 'string' && endpoint.toLowerCase().includes('chat'),
      );
    }
    return true;
  }

  private refreshModelsInBackground(fallback: ModelDef[]): Promise<void> {
    if (this.refreshInProgress) return this.refreshInProgress;

    this.refreshInProgress = (async () => {
      try {
        await this.prepareForModelDiscovery();
        // Kick models.dev refresh early so enrichment has data by the time
        // discovery completes (non-blocking, idempotent within TTL).
        refreshModelsDevCache();
        const response = await withRetry(() => this.client.models.list());
        const discovered: ModelDef[] = [];
        for await (const model of response) {
          const id = this.getModelIdFromRemote(model);
          if (!id || !this.isChatModelCandidate(model, id)) continue;
          discovered.push(
            this.enrichDiscoveredModel(model, modelFromRemoteId(id, this.name, fallback)),
          );
        }
        // Fold vendor-confirmed same-model speed variants (MiniMax
        // `-highspeed`, MiMo `-ultraspeed`) so every OpenAIProvider-based
        // catalog exposes them as `speedTiers` on the base model instead of
        // look-alike entries. OpenAI's own catalog all supports the `priority`
        // service tier, so those models carry it as a tier too.
        const speedFolded = foldVendorSpeedTiers(
          applyModelsDevMetadata(
            this.name,
            mergeModelLists(fallback, discovered),
            modelsDevKeysFor(this.name, this.config.kind),
          ),
        );
        this.cachedModels =
          this.name === 'openai'
            ? speedFolded.map((m) => ({ ...m, speedTiers: [SPEED_TIER_PRIORITY_OPENAI] }))
            : speedFolded;
        this.modelCatalogAuthoritative = true;
        this.modelDiscoveryError = undefined;
        this.modelDiscoveryHttpStatus = undefined;
        providerLog.debug(
          { provider: this.name, count: this.cachedModels.length },
          'Model list refreshed from provider API',
        );
        this.lastFetch = Date.now();
      } catch (err) {
        // Cache failures for the normal discovery TTL too. Otherwise every
        // status render triggers another failing /models request. A previous
        // successful catalog remains available when this was a refresh.
        this.lastFetch = Date.now();
        const errorStatus =
          err && typeof err === 'object' && 'status' in err && typeof err.status === 'number'
            ? err.status
            : undefined;
        const diagnostic = safeProviderDiagnostic(this.name, 'http', err, {
          ...(errorStatus !== undefined ? { status: errorStatus } : {}),
        });
        this.modelDiscoveryHttpStatus = diagnostic.status;
        this.modelDiscoveryError = safeProviderFailureMessage(this.name, diagnostic, {
          authenticationAction: this.modelDiscoveryAuthenticationAction(),
        });
        providerLog.debug(
          { provider: this.name, diagnostic },
          'Model list refresh failed; keeping the last provider catalog',
        );
      } finally {
        this.refreshInProgress = null;
      }
    })();

    return this.refreshInProgress;
  }

  isModelCatalogAuthoritative(): boolean {
    // Built-in OpenAI-family adapters may intentionally merge a provider
    // response with a small compatibility fallback. Custom endpoints have no
    // such entitlement fallback, so their successful response is authoritative.
    return this.config.custom === true && this.modelCatalogAuthoritative;
  }

  /** OpenAI-compatible bodies take every tunable key; gwarden rejects extra
   * parameters outright, so only `max_tokens` may ever reach it. */
  forwardedModelParameters(): ReadonlySet<ModelParameterKey> {
    return this.name === 'gwarden' ? GWARDEN_FORWARDED_PARAMETERS : ALL_MODEL_PARAMETER_KEYS;
  }

  getModelDiscoveryError(): string | undefined {
    return this.modelDiscoveryError;
  }

  getModelDiscoveryHttpStatus(): number | undefined {
    return this.modelDiscoveryHttpStatus;
  }

  /**
   * Apply this provider's reasoning control to a request under construction.
   *
   * Gate conditions (`canReason` plus a level this model actually declares) are
   * resolved by the caller so every provider gates on the same evidence.
   * Subclasses whose reasoning control is a different shape than OpenAI's
   * `reasoning_effort` string override this instead of adding a branch to the
   * shared request builder.
   */
  protected applyReasoningControls(
    params: Record<string, unknown>,
    options: {
      canReason: boolean;
      effort: string | undefined;
      supported: ReadonlySet<string>;
      modelDef?: ModelDef;
      /** The model this request targets, even when live discovery has not run.
       *  Providers whose reasoning control comes from a committed static catalog
       *  must not silently drop the selection just because the async model
       *  list has not arrived yet. */
      requestModel: string;
    },
  ): void {
    const { canReason, effort, supported } = options;
    if (!canReason || !effort || !supported.has(effort)) return;
    if (this.name === 'deepseek') {
      // DeepSeek 2026 (V4): uses "thinking" parameter object
      params.thinking = { type: effort === 'none' ? 'disabled' : 'enabled' };
      // Use reasoning_effort string directly (low, medium, high, max)
      if (effort !== 'none') params.reasoning_effort = effort === 'xhigh' ? 'max' : effort;
    } else if (this.name === 'zai' || this.name === 'moonshot') {
      // GLM / Kimi K2.5: only a round-level thinking toggle exists — no
      // effort tiers ("none" = disabled, anything else = enabled).
      params.thinking = { type: effort === 'none' ? 'disabled' : 'enabled' };
    } else if (this.name === 'togetherai') {
      // Qwen 3.5 thinking is on by default; "none" turns it off. Together
      // reads the flag both top-level and via chat_template_kwargs.
      if (effort === 'none') {
        params.enable_thinking = false;
        params.chat_template_kwargs = { enable_thinking: false };
      }
    } else {
      params.reasoning_effort = effort;
    }
  }

  async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    // Reflection requires the original reasoning on every assistant turn.
    // Never fabricate it for imported history or a reasoning-less upstream turn.
    if (
      this.name === 'beam' &&
      request.messages.some((msg) => msg.role === 'assistant' && !msg.reasoningContent?.trim())
    ) {
      yield {
        type: 'error',
        error:
          'Reflection AI requires the original reasoning for every prior assistant message. This history is missing reasoning; start a new chat or retry the affected turn.',
      };
      return;
    }
    let messages = this.convertMessages(request);
    const userConfirmedImages = userConfirmedImageInput(this, request);

    // Vision guard: if the model is KNOWN not to support images (live metadata
    // reported vision: false), replace image parts with a text note up front so
    // the request never 400s. Models with unknown metadata keep their images —
    // a rejection is caught below and retried once without them.
    if (messagesContainImages(messages)) {
      const liveDef =
        this.listModels().find((m) => m.id === request.model || m.apiModelId === request.model) ??
        resolveModel(request.model);
      const supportsVision = liveDef?.vision === true || liveDef?.supportsAttachments === true;
      // Gwarden's gateway cannot process image parts at all, so always strip them
      // for that provider regardless of the model's reported vision capability.
      const forceStrip = this.name === 'gwarden';
      if ((liveDef?.vision === false || forceStrip) && !userConfirmedImages) {
        messages = stripImageParts(messages);
        providerLog.debug(
          { provider: this.name, model: request.model },
          'This model may not support image input — attachments replaced with a text note',
        );
      }
    }

    const canonicalTools = canonicalizeProviderTools(request.tools);
    // OpenAI-compatible custom gateways can expose the same cached-token usage
    // fields as OpenAI/OpenRouter. Track their Kory lane outcomes, but keep
    // provider-specific request controls below gated to the providers that
    // explicitly support them so arbitrary compatible endpoints never receive
    // prompt_cache_key, prompt_cache_options, or session_id by accident.
    const tracksPromptCache =
      this.name === 'openai' ||
      this.name === 'openrouter' ||
      (this.config.custom === true && (this.config.kind ?? 'openai') === 'openai');
    const cacheRoutingContext = {
      provider: String(this.name),
      custom: this.config.custom === true,
      reasoningScopeOverride: request.cacheReasoningScopeOverride,
    };
    const cacheLane = tracksPromptCache
      ? derivePromptCacheLane(request, canonicalTools, cacheRoutingContext)
      : undefined;
    let cacheDiagnostic: ReturnType<typeof observePromptCacheDispatch> | undefined;
    const tools = canonicalTools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters:
          this.name === 'xai' ? sanitizeToolParametersForXAI(t.inputSchema) : t.inputSchema,
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
    // through is safe; without it the selection was silently dropped. The same
    // applies to any tier a provider reports that this list has never seen:
    // accept the model's own live-reported levels verbatim so new provider
    // tiers keep working instead of being silently dropped.
    const supportedEfforts = new Set([
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      ...(liveDef?.reasoningLevels ?? []).map((level) => level.toLowerCase()),
    ]);

    // Composer "Model settings" overrides — sanitized against the model's own
    // declared parameter list AND this adapter's forwarding set (gwarden only
    // takes max_tokens) so a key that never reaches the wire is never sent.
    const forwarded = this.forwardedModelParameters();
    const modelParams = sanitizeModelParameterValues(
      liveDef?.parameters?.filter((def) => forwarded.has(def.key)),
      request.modelParameters,
    );
    const paramMaxTokens =
      typeof modelParams.max_tokens === 'number' ? modelParams.max_tokens : undefined;
    const effectiveMaxTokens = paramMaxTokens ?? request.maxTokens;
    const effectiveTemperature =
      typeof modelParams.temperature === 'number'
        ? modelParams.temperature
        : request.temperature;

    const params: OpenAI.ChatCompletionCreateParamsStreaming & {
      service_tier?: string;
      thinking?: { type: string };
      reasoning_effort?: string;
      include_reasoning?: boolean;
      enable_thinking?: boolean;
      chat_template_kwargs?: { enable_thinking?: boolean };
      prompt_cache_key?: string;
      prompt_cache_options?: { mode: 'implicit'; ttl: '30m' };
      session_id?: string;
    } = {
      model:
        resolveSpeedVariant(liveDef, request.speedTier, request.reasoningLevel) ??
        modelDef?.apiModelId ??
        request.model,
      messages: this.name === 'openrouter' ? markOpenRouterTailCacheBreakpoint(messages) : messages,
      stream: true,
      // Gwarden's gateway rejects `stream_options` (and only accepts the
      // legacy `max_tokens` field), so never send them for that provider.
      ...(this.name !== 'gwarden' && { stream_options: { include_usage: true } }),
      // Gwarden rejects extra parameters; send only the core request fields.
      ...(this.name === 'gwarden'
        ? { max_tokens: effectiveMaxTokens && effectiveMaxTokens > 0 ? effectiveMaxTokens : 4096 }
        : effectiveMaxTokens
          ? { max_completion_tokens: effectiveMaxTokens }
          : {}),
      ...(effectiveTemperature !== undefined && { temperature: effectiveTemperature }),
      ...Object.fromEntries(
        Object.entries(modelParams).filter(
          ([key]) => key !== 'max_tokens' && key !== 'temperature',
        ),
      ),
      ...(tools?.length && { tools }),
    };

    if (tracksPromptCache) {
      cacheDiagnostic = observePromptCacheDispatch(request, canonicalTools, cacheRoutingContext);
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
    }

    if (this.name === 'openai') {
      if (tools.length > 0 && request.allowedToolNames) {
        const declaredNames = new Set(canonicalTools.map((tool) => tool.name));
        const allowedNames = [...new Set(request.allowedToolNames)]
          .filter((name) => declaredNames.has(name))
          .sort();
        // Current Chat Completions supports a dynamic allowed_tools choice.
        // Keep the full declaration byte-stable for caching and vary only this
        // small eligibility control; the host still enforces the same set.
        (params as unknown as Record<string, unknown>).tool_choice =
          allowedNames.length > 0
            ? {
                type: 'allowed_tools',
                allowed_tools: {
                  mode: 'auto',
                  tools: allowedNames.map((name) => ({
                    type: 'function',
                    function: { name },
                  })),
                },
              }
            : 'none';
      }
      params.prompt_cache_key = deriveProviderPromptCacheKey(
        request,
        canonicalTools,
        cacheRoutingContext,
      );
      const apiModel = modelDef?.apiModelId ?? request.model;
      if (/^gpt-5\.6(?:-|$)/i.test(apiModel)) {
        params.prompt_cache_options = { mode: 'implicit', ttl: '30m' };
      }
    }

    if (this.name === 'openrouter') {
      // OpenRouter uses session_id as the sticky-routing key. Use Kory's
      // workspace-scoped provider cache route so sibling tabs with an
      // identical stable prefix land back on the upstream that owns the warm
      // cache, while different workspaces/models/reasoning lanes stay isolated.
      params.session_id =
        deriveProviderPromptCacheKey(request, canonicalTools, cacheRoutingContext) ??
        (request.sessionId ? `kory-${request.sessionId}` : undefined);
    }

    // This is deliberately API Priority, not Codex Fast mode. Fast is a
    // ChatGPT-credit feature; API projects use the documented `priority`
    // service tier when the customer has enabled it for their project.
    if (this.name === 'openai' && request.speedTier === 'priority') {
      (params as unknown as Record<string, unknown>).service_tier = 'priority';
    }

    // Gwarden rejects reasoning controls; never send them for that provider.
    if (this.name !== 'gwarden') {
    // Only send reasoning_effort if model + selected level supports it.
    this.applyReasoningControls(params as unknown as Record<string, unknown>, {
      canReason,
      effort: reasoningEffort,
      supported: this.name === 'beam' ? new Set(liveDef?.reasoningLevels ?? []) : supportedEfforts,
      modelDef: liveDef,
      requestModel: modelDef?.apiModelId ?? request.model,
    });
    }

    try {
      // Apply 60-second hard timeout to prevent indefinite hangs
      // Match the global task timeout (30 min) instead of a 60s hard cap so
      // long reasoning/model generations are not aborted mid-stream. The global
      // task timeout in manager.ts still bounds the overall run.
      const timeoutSignal = withTimeoutSignal(request.signal, 1_800_000);
      const createStream = () =>
        this.client.chat.completions.create(params, { signal: timeoutSignal });
      let stream: Awaited<ReturnType<typeof createStream>>;
      try {
        stream = await withRetry(createStream, {
          providerName: this.name,
          modelName: request.model,
        });
      } catch (err) {
        // A vision rejection is about the attachment, not about a parameter Kory
        // added: the degrade ladder below must not retry it, or a confirmed-image
        // failure would be repeated once per optional parameter.
        const visionRejection = isVisionRejectionError(err);
        // Some models reject images only at request time (metadata absent or
        // wrong). Degrade gracefully: drop the images, note it, retry once.
        if (!userConfirmedImages && messagesContainImages(params.messages) && visionRejection) {
          providerLog.warn(
            { provider: this.name, model: request.model },
            'Model rejected image input — retrying without attachments',
          );
          params.messages = stripImageParts(params.messages);
          stream = await withRetry(createStream, {
            providerName: this.name,
            modelName: request.model,
          });
        } else if (hasReasoningParams(params) && isParameterRejectionError(err)) {
          // Some OpenAI-compatible providers/models reject reasoning controls
          // outright (e.g. a model whose metadata flipped `canReason` on after
          // a background refresh — the request worked before the refresh and
          // 400s after). Degrade gracefully: drop the reasoning parameters and
          // retry once rather than failing the turn.
          providerLog.warn(
            { provider: this.name, model: request.model },
            'Model rejected reasoning parameters — retrying without them',
          );
          stripReasoningParams(params);
          stream = await withRetry(createStream, {
            providerName: this.name,
            modelName: request.model,
          });
        } else if (
          !visionRejection &&
          isParameterRejectionError(err) &&
          (params as unknown as Record<string, unknown>).stream_options !== undefined
        ) {
          // A gateway fronting an upstream that rejects `stream_options` fails the
          // whole turn even though only usage accounting is affected. Drop it and
          // retry once: token counts fall back to the estimate, the answer still
          // streams.
          providerLog.warn(
            { provider: this.name, model: request.model },
            'Provider rejected stream_options — retrying without usage streaming',
          );
          delete (params as unknown as Record<string, unknown>).stream_options;
          stream = await withRetry(createStream, {
            providerName: this.name,
            modelName: request.model,
          });
        } else if (
          !visionRejection &&
          isParameterRejectionError(err) &&
          typeof (params as unknown as Record<string, unknown>).max_completion_tokens === 'number'
        ) {
          // Older OpenAI-compatible proxies only accept the legacy field name.
          providerLog.warn(
            { provider: this.name, model: request.model },
            'Provider rejected max_completion_tokens — retrying with max_tokens',
          );
          const mutableParams = params as unknown as Record<string, unknown>;
          const limit = mutableParams.max_completion_tokens;
          delete mutableParams.max_completion_tokens;
          mutableParams.max_tokens = limit;
          stream = await withRetry(createStream, {
            providerName: this.name,
            modelName: request.model,
          });
        } else {
          throw err;
        }
      }

      const toolCallBuffers = new Map<
        number,
        { id: string; name: string; args: string; started: boolean; sent: number }
      >();
      let lastToolIndex: number | undefined;
      let observedPromptTokens: number | undefined;
      let observedCacheReadTokens = 0;
      let observedCacheWriteTokens = 0;

      let sawFinishReason = false;

      // Gwarden's gateway does not reliably stream: a request with stream:true
      // comes back as a single JSON completion (or an empty stream). Treat a
      // non-iterable completion as a one-shot response so the turn still gets
      // its content instead of an empty reply.
      const streamIterable = stream as unknown as {
        [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
      };
      if (typeof streamIterable?.[Symbol.asyncIterator] !== 'function') {
        const completion = stream as unknown as {
          choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const msgContent = completion.choices?.[0]?.message?.content;
        const text =
          typeof msgContent === 'string'
            ? msgContent
            : Array.isArray(msgContent)
              ? msgContent.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('')
              : '';
        if (text) yield { type: 'content_delta', content: text };
        yield { type: 'complete', finishReason: 'stop' };
        return;
      }

      for await (const chunk of stream) {
        // A gateway can answer 200 OK and then send an error frame instead of
        // deltas. Reading only `choices` left the loop with nothing to consume,
        // so the turn ended without a completion and looked like a stall.
        // Gwarden (and some other gateways) carry the error text under a
        // top-level `message` or inside the first choice's delta instead of an
        // `error` field, so check those too.
        const chunkRecord = chunk as {
          error?: unknown;
          message?: unknown;
          choices?: Array<{ delta?: { content?: string } }>;
        };
        let streamError: unknown = chunkRecord.error;
        if (!streamError && typeof chunkRecord.message === 'string' && /error/i.test(chunkRecord.message)) {
          streamError = chunkRecord.message;
        }
        const firstDeltaContent = chunkRecord.choices?.[0]?.delta?.content;
        if (
          !streamError &&
          typeof firstDeltaContent === 'string' &&
          /^Error:/i.test(firstDeltaContent.trim())
        ) {
          streamError = firstDeltaContent;
        }
        if (streamError) {
          const failure = providerStreamFailure(this.name, 'stream', streamError);
          providerLog.error(
            { ...failure.diagnostic, model: request.model },
            'Provider sent an in-stream error',
          );
          yield failure.event;
          return;
        }
        const choice = chunk.choices?.[0];

        // Usage is NOT always on a trailing usage-only chunk. Some providers
        // (Cline among them) attach `usage` to the same chunk that carries
        // `finish_reason`, so gating this on an empty `choices` array silently
        // drops the turn's token counts and breaks the context meter and
        // billing. Read usage whenever it is present, independently of choices.
        if (chunk.usage) {
          const rawUsage = chunk.usage as unknown as {
            prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
            input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
            completion_tokens_details?: { reasoning_tokens?: number };
          };
          const details = rawUsage.prompt_tokens_details ?? rawUsage.input_tokens_details;
          observedPromptTokens = chunk.usage.prompt_tokens;
          observedCacheReadTokens = details?.cached_tokens ?? 0;
          observedCacheWriteTokens = details?.cache_write_tokens ?? 0;
          const cacheOutcome = cacheDiagnostic
            ? promptCacheDiagnostics.recordProviderOutcome(cacheDiagnostic, {
                inputTokens: chunk.usage.prompt_tokens,
                cacheReadTokens: observedCacheReadTokens,
                cacheWriteTokens: observedCacheWriteTokens,
              })
            : undefined;
          yield {
            type: 'usage_update',
            ...(() => {
              const reportedCost = (chunk.usage as { cost?: unknown })?.cost;
              return typeof reportedCost === 'number' &&
                Number.isFinite(reportedCost) &&
                reportedCost >= 0
                ? { reportedCostUsd: reportedCost }
                : {};
            })(),
            // prompt_tokens already includes cached tokens — omit tokensCache
            // so context occupancy isn't double counted downstream.
            tokensIn: chunk.usage.prompt_tokens,
            tokensOut: chunk.usage.completion_tokens,
            tokensCacheRead: details?.cached_tokens,
            tokensCacheWrite: details?.cache_write_tokens,
            // Providers that bill/stream reasoning separately report it here
            // (Cline's completion_tokens_details.reasoning_tokens).
            ...(rawUsage.completion_tokens_details?.reasoning_tokens !== undefined && {
              thinkingTokens: rawUsage.completion_tokens_details.reasoning_tokens,
            }),
            cacheExpectedWarm: cacheOutcome?.expectedWarm,
            cacheUnexpectedMiss: cacheOutcome?.unexpectedMiss,
            cacheLaneKind: cacheDiagnostic?.laneKind,
          };
        }

        if (!choice) continue;

        const delta = choice.delta;

        // Content streaming. Some OpenAI-compatible gateways (Gwarden among
        // them) ship the answer under a legacy `text` field or a non-streaming
        // `message.content` shape instead of `delta.content`, so fall back to
        // those before declaring the turn empty.
        let contentCandidate = delta?.content;
        // (debug removed)
        if (Array.isArray(contentCandidate)) {
          contentCandidate = contentCandidate
            .map((part) =>
              typeof part === 'string' ? part : (part as { text?: string })?.text ?? '',
            )
            .join('');
        }
        if (contentCandidate) {
          yield { type: 'content_delta', content: contentCandidate as string };
        }

        // Reasoning content. OpenAI-family providers stream it as
        // `reasoning_content`; OpenAI-compatible gateways that follow the
        // OpenRouter shape use plain `reasoning` (Cline documents `reasoning`
        // plus `reasoning_details` for encrypted reasoning blocks).
        const reasoningContent =
          (delta as { reasoning_content?: string; reasoning?: string } | undefined)
            ?.reasoning_content ?? (delta as { reasoning?: string } | undefined)?.reasoning;
        if (reasoningContent) {
          yield { type: 'thinking_delta', thinking: reasoningContent };
        }

        // Tool call streaming. Gateways differ in ways the SDK type does not
        // describe, so the buffer is normalized instead of trusted:
        //   - `index` may be omitted on continuation chunks (every later chunk
        //     would open a second, id-less buffer and its arguments are lost);
        //   - a proxy that stitches two upstream turns may reuse an index for a
        //     different call id, so deltas arrived for an id that never started;
        //   - arguments may arrive before the id/name they belong to.
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = typeof tc.index === 'number' ? tc.index : (lastToolIndex ?? 0);
            lastToolIndex = idx;
            let buf = toolCallBuffers.get(idx);
            if (!buf) {
              buf = { id: '', name: '', args: '', started: false, sent: 0 };
              toolCallBuffers.set(idx, buf);
            }

            if (tc.id && buf.id && tc.id !== buf.id && buf.started) {
              // Different call on a reused index: close the running one first so
              // its arguments are not silently replaced by the next call's.
              yield {
                type: 'tool_use_stop',
                toolCallId: buf.id,
                toolName: buf.name,
                toolInput: serializeToolArguments(buf.args),
              } as ProviderEvent;
              buf = { id: tc.id, name: tc.function?.name ?? '', args: '', started: false, sent: 0 };
              toolCallBuffers.set(idx, buf);
            }

            if (tc.id) buf.id = tc.id;
            if (tc.function?.name) buf.name = tc.function.name;
            if (tc.function?.arguments) buf.args += tc.function.arguments;
            if (!buf.started && buf.id && buf.name) {
              buf.started = true;
              yield { type: 'tool_use_start', toolCallId: buf.id, toolName: buf.name };
            }
            // `sent` records how much of the buffer the runtime already has, so
            // arguments that arrived before the call was announced still stream.
            if (buf.started && buf.args.length > buf.sent) {
              const nextArgs = buf.args.slice(buf.sent);
              buf.sent = buf.args.length;
              yield {
                type: 'tool_use_delta',
                toolCallId: buf.id,
                toolName: buf.name,
                toolInput: nextArgs,
              };
            }
          }
        }

        // Completion. A provider may repeat `finish_reason` on more than one
        // trailing chunk; emitting more than one completion ends the turn twice.
        if (choice.finish_reason && !sawFinishReason) {
          sawFinishReason = true;
          yield* this.flushToolCalls(toolCallBuffers);
          yield {
            type: 'complete',
            finishReason: this.mapFinishReason(choice.finish_reason),
          };
        }
      }

      // Some OpenAI compatible gateways close a clean stream without a final
      // finish_reason. Close complete tool calls so the turn runtime does not
      // retain them as pending forever.
      if (!sawFinishReason && toolCallBuffers.size > 0) {
        yield* this.flushToolCalls(toolCallBuffers);
        yield { type: 'complete', finishReason: 'tool_use' };
      }

      const apiModel = modelDef?.apiModelId ?? request.model;
      if (
        this.name === 'openai' &&
        /^gpt-5\.6(?:-|$)/i.test(apiModel) &&
        request.promptCache &&
        cacheLane &&
        cacheDiagnostic
      ) {
        const pricing = resolvePricing(this.name, request.model);
        const stableTokens =
          request.promptCache.estimatedStableTokens +
          Math.ceil(Buffer.byteLength(JSON.stringify(canonicalTools), 'utf8') / 4);
        const refreshInputTokens = Math.max(stableTokens, observedPromptTokens ?? stableTokens);
        const refreshCachedTokens = Math.min(
          refreshInputTokens,
          Math.max(stableTokens, observedCacheReadTokens + observedCacheWriteTokens),
        );
        const maintenanceParams = {
          model: params.model,
          // Keep the complete successful lane hot. Replaying only the system
          // prefix leaves long conversation history cold after an idle gap.
          messages: params.messages,
          stream: false,
          max_completion_tokens: 1,
          ...(tools.length > 0 ? { tools } : {}),
          ...((params as unknown as Record<string, unknown>).tool_choice !== undefined
            ? { tool_choice: (params as unknown as Record<string, unknown>).tool_choice }
            : {}),
          prompt_cache_key: params.prompt_cache_key,
          prompt_cache_options: params.prompt_cache_options,
        } as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming;
        promptCacheMaintenance.observe({
          provider: this.name,
          sessionId: request.sessionId,
          routingKey: cacheLane.routingKey,
          slotKey: cacheLane.slotKey,
          stableTokens,
          refreshInputTokens,
          refreshCachedTokens,
          ttlMs: 30 * 60_000,
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
                this.client.chat.completions.create(maintenanceParams, {
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
          'OpenAI provider stream timed out',
        );
        yield { ...failure.event, errorTransient: true };
        return;
      }
      if (err instanceof Error && (err.name === 'AbortError' || err.name === 'AbortSignal')) return;

      const failure = providerStreamFailure(this.name, 'sdk', err);
      providerLog.error(
        {
          ...failure.diagnostic,
          model: request.model,
          rawMessage: err instanceof Error ? err.message.slice(0, 800) : String(err).slice(0, 800),
        },
        'OpenAI provider stream error',
      );
      yield failure.event;
    }
  }

  private *flushToolCalls(
    toolCallBuffers: Map<
      number,
      { id: string; name: string; args: string; started: boolean; sent: number }
    >,
  ) {
    for (const [, buf] of toolCallBuffers) {
      if (!buf.started || !buf.id || !buf.name) continue;
      yield {
        type: 'tool_use_stop',
        toolCallId: buf.id,
        toolName: buf.name,
        toolInput: serializeToolArguments(buf.args),
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
      const cacheSegments = resolvePromptCacheSegments(request);
      const model = resolveModel(request.model)?.apiModelId ?? request.model;
      if (this.name === 'openai' && /^gpt-5\.6(?:-|$)/i.test(model) && cacheSegments.valid) {
        result.push({
          role: 'system',
          content: [
            {
              type: 'text',
              text: cacheSegments.stable,
              prompt_cache_breakpoint: { mode: 'explicit' },
            },
          ],
        } as unknown as OpenAI.ChatCompletionSystemMessageParam);
        if (cacheSegments.dynamic) {
          result.push({ role: 'system', content: cacheSegments.dynamic });
        }
      } else {
        result.push({ role: 'system', content: request.systemPrompt });
      }
    }

    for (const msg of request.messages) {
      if (msg.role === 'system') continue;
      const reasoning =
        this.name === 'beam' && msg.role === 'assistant'
          ? { reasoning_content: msg.reasoningContent }
          : {};

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
            ...reasoning,
            content: msg.content || null,
            tool_calls: msg.tool_calls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.name, arguments: JSON.stringify(tc.input ?? {}) },
            })),
          });
        } else if (msg.role === 'user') {
          result.push({ role: 'user', content: msg.content });
        } else {
          result.push({ role: 'assistant', content: msg.content, ...reasoning });
        }
        continue;
      }

      const blocks = msg.content as ProviderContentBlock[];
      if (msg.role === 'assistant') {
        result.push({ ...this.mapAssistantMessage(blocks), ...reasoning });
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

/**
 * OpenRouter forwards cache_control breakpoints to providers that support
 * explicit prompt caching. Put the breakpoint on the latest textual message
 * so the reusable conversation tail can advance every turn while the opening
 * system/tool prefix remains byte-stable.
 */
function markOpenRouterTailCacheBreakpoint(
  messages: OpenAI.ChatCompletionMessageParam[],
): OpenAI.ChatCompletionMessageParam[] {
  const next = [...messages];
  for (let index = next.length - 1; index >= 0; index--) {
    const message = next[index] as unknown as Record<string, unknown>;
    const content = message.content;
    if (typeof content === 'string' && content.length > 0) {
      next[index] = {
        ...message,
        content: [
          {
            type: 'text',
            text: content,
            cache_control: { type: 'ephemeral' },
          },
        ],
      } as unknown as OpenAI.ChatCompletionMessageParam;
      return next;
    }
    if (!Array.isArray(content)) continue;
    for (let partIndex = content.length - 1; partIndex >= 0; partIndex--) {
      const part = content[partIndex];
      if (!part || typeof part !== 'object' || (part as Record<string, unknown>).type !== 'text') {
        continue;
      }
      const parts = [...content];
      parts[partIndex] = {
        ...(part as Record<string, unknown>),
        cache_control: { type: 'ephemeral' },
      };
      next[index] = {
        ...message,
        content: parts,
      } as unknown as OpenAI.ChatCompletionMessageParam;
      return next;
    }
  }
  return next;
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

/**
 * Hand the runtime a JSON object even when the upstream truncated or mangled the
 * streamed arguments. The tool's own schema validation stays authoritative; this
 * only stops a malformed payload from aborting the whole turn.
 */
function serializeToolArguments(raw: string): string {
  const normalized = normalizeToolArguments(raw);
  if (!normalized.recovered) {
    providerLog.warn(
      { bytes: raw.length },
      'Provider streamed unusable tool arguments — sending an empty object',
    );
  }
  return JSON.stringify(normalized.input);
}

/** Extract an HTTP status from an OpenAI SDK `APIError`-shaped rejection. */
function rejectionStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const record = err as Record<string, unknown>;
  const nested =
    record.error && typeof record.error === 'object'
      ? (record.error as Record<string, unknown>)
      : undefined;
  const status = record.status ?? record.statusCode ?? nested?.status;
  return typeof status === 'number' && Number.isFinite(status) ? status : undefined;
}

/**
 * True when the provider rejected the request because a request parameter was
 * not accepted (400/422, or an explicit unsupported-parameter message). Used
 * to trigger the graceful degrade-and-retry path for reasoning controls.
 */
export function isParameterRejectionError(err: unknown): boolean {
  const status = rejectionStatus(err);
  if (status === 400 || status === 422) return true;
  const msg = err instanceof Error ? err.message : String(err);
  if (/Error:\s*The request is invalid\.?\s*Please check the parameters/i.test(msg)) return true;
  return /reasoning[_ ]?effort|include[_ ]reasoning|unsupported[_ ](?:parameter|value|field)|unexpected[_ ](?:keyword|argument)|extra[_ ](?:inputs|fields)|unknown[_ ](?:parameter|field|argument)|unrecognized[_ ](?:parameter|argument|keyword)|not (?:a )?supported (?:parameter|argument|for this model)/i.test(
    msg,
  );
}

const REASONING_PARAM_KEYS = [
  'reasoning_effort',
  'include_reasoning',
  'thinking',
  'enable_thinking',
  'chat_template_kwargs',
] as const;

function hasReasoningParams(params: unknown): boolean {
  const record = params as Record<string, unknown>;
  return REASONING_PARAM_KEYS.some((key) => record[key] !== undefined);
}

function stripReasoningParams(params: unknown): void {
  const record = params as Record<string, unknown>;
  for (const key of REASONING_PARAM_KEYS) delete record[key];
}

/**
 * xAI rejects a tool whose root schema carries `oneOf`/`anyOf` unless every
 * branch is itself `type: object` ("tool parameter root must be an object
 * type (root schema is an anyOf/oneOf union with a non-object branch)").
 * Branches like `{ required: [...] }` trip it. Strip the root union — the
 * constraint stays enforced server-side — so any present or future tool
 * survives xAI validation.
 */
export function sanitizeToolParametersForXAI(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'object', properties: {} };
  }
  const {
    oneOf: _oneOf,
    anyOf: _anyOf,
    ...rest
  } = schema as Record<string, unknown> & {
    oneOf?: unknown;
    anyOf?: unknown;
  };
  void _oneOf;
  void _anyOf;
  return { type: 'object', ...rest };
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

/**
 * Vyce AI documents the standard OpenAI SDK contract at https://vyceai.com/v1.
 * Keep a named adapter so its endpoint cannot drift into a similarly named
 * gateway, while retaining the shared message, tool, usage, and retry logic.
 */
export class VyceAIProvider extends OpenAIProvider {
  constructor(config: ProviderConfig) {
    super(config, 'vyceai', 'https://vyceai.com/v1');
  }
}

// Respan — OpenAI-compatible AI gateway (https://api.respan.ai). One Respan
// key routes to many upstream models; base URL carries /v1 so /models and
// /chat/completions both resolve to the OpenAI-shaped endpoints.
export class RespanProvider extends OpenAIProvider {
  constructor(config: ProviderConfig) {
    super(config, 'respan', 'https://api.respan.ai/api/v1');
  }
}

// UnoRouter — open-source OpenAI-compatible gateway (one key, 200+ models).
// Standard Bearer auth, no app-attribution headers. The /v1/models catalog
// carries context_length / max_output_tokens, ingested by the base class.
export class UnoRouterProvider extends OpenAIProvider {
  constructor(config: ProviderConfig) {
    super(config, 'unorouter', 'https://api.unorouter.com/v1');
  }
}

// Experiential Labs — open-source AI gateway (one key, hosted/BYOK/local models).
// Standard Bearer auth, no app-attribution headers.
//
// Discovery is two-step because the authenticated OpenAI-shaped
// `GET /v1/models` returns bare slugs only ("the models this key can call").
// The rich capability catalog lives at the public `GET /api/models`
// (display name, context window, modalities, per-deployment reasoning tiers
// and nano-USD pricing), which the provider publishes for exactly this use.
// Slugs from /v1/models gate availability; /api/models supplies the numbers.
const EXPERIENTIAL_CATALOG_URL = 'https://api.experientiallabs.ai/api/models';
const EXPERIENTIAL_CATALOG_PAGE_LIMIT = 1000;
const EXPERIENTIAL_CATALOG_TIMEOUT_MS = 15_000;

/** Canonical reasoning-effort ladder used to order provider-reported tiers. */
const EXPERIENTIAL_EFFORT_LADDER = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'ultra',
  'max',
];

interface ExperientialCatalogDeployment {
  billing_source?: unknown;
  pricing_source?: unknown;
  input_nano_usd_per_million?: unknown;
  cached_input_nano_usd_per_million?: unknown;
  output_nano_usd_per_million?: unknown;
  capabilities?: {
    supports_reasoning?: unknown;
    supported_reasoning_efforts?: unknown;
    maximum_output_tokens?: unknown;
  };
}

interface ExperientialCatalogRow {
  model?: {
    slug?: unknown;
    display_name?: unknown;
    context_window?: unknown;
    max_output_tokens?: unknown;
    input_modalities?: unknown;
    supported_params?: { reasoning?: unknown };
  };
  providers?: ExperientialCatalogDeployment[];
}

/** nano-USD per million tokens → USD per million tokens. */
function experientialNanoToUsdPerMillion(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return value / 1_000_000_000;
}

export class ExperientialLabsProvider extends OpenAIProvider {
  constructor(config: ProviderConfig) {
    super(config, 'experientiallabs', 'https://api.experientiallabs.ai/v1');
  }

  override isAvailable(): boolean {
    // Endpoint-authenticated like the other gateways. Discovery is owned
    // below; the base implementation would kick its own bare-slug refresh.
    return !this.config.disabled && !!(this.config.apiKey || this.config.authToken);
  }

  private explabsModels: ModelDef[] | null = null;
  private explabsFetchedAt = 0;
  private explabsRefresh: Promise<void> | null = null;

  override refreshModels(forceRefresh = false): Promise<void> {
    if (!forceRefresh) return Promise.resolve();
    this.explabsModels = null;
    this.explabsFetchedAt = 0;
    return this.refreshExplabsCatalog();
  }

  override listModels(): ModelDef[] {
    if (!this.isAvailable()) return [];
    if (this.explabsModels && isModelListCacheFresh(this.explabsFetchedAt))
      return this.explabsModels;
    void this.refreshExplabsCatalog();
    return this.explabsModels ?? [];
  }

  private refreshExplabsCatalog(): Promise<void> {
    if (this.explabsRefresh) return this.explabsRefresh;
    this.explabsRefresh = (async () => {
      try {
        const token = this.config.apiKey || this.config.authToken;
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'User-Agent': 'Koryphaios/1.0',
        };
        if (token) headers.Authorization = `Bearer ${token}`;
        const timed = { signal: AbortSignal.timeout(EXPERIENTIAL_CATALOG_TIMEOUT_MS) };
        // 1. Slugs this key can actually call (authenticated, OpenAI-shaped).
        const slugsRes = await fetch(`${this.baseUrl ?? this.config.baseUrl}/models`, {
          headers,
          ...timed,
        });
        if (!slugsRes.ok) throw new Error(`Experiential Labs models ${slugsRes.status}`);
        const slugsJson = (await slugsRes.json()) as { data?: unknown };
        const rawById = new Map<string, unknown>();
        if (Array.isArray(slugsJson.data)) {
          for (const entry of slugsJson.data) {
            if (!entry || typeof entry !== 'object') continue;
            const id = (entry as Record<string, unknown>).id;
            if (typeof id === 'string' && id.trim() && !rawById.has(id.trim())) {
              rawById.set(id.trim(), entry);
            }
          }
        }
        // 2. Rich public catalog (the key also adds org custom/local rows).
        // Catalog reads are public and keyless; a credential the gateway
        // rejects must not take the capability metadata down with it, so a
        // 401/403 falls back to the keyless public rows.
        const rows = new Map<string, ExperientialCatalogRow>();
        const publicHeaders: Record<string, string> = {
          'Content-Type': 'application/json',
          'User-Agent': 'Koryphaios/1.0',
        };
        let offset = 0;
        for (;;) {
          let catRes = await fetch(
            `${EXPERIENTIAL_CATALOG_URL}?limit=${EXPERIENTIAL_CATALOG_PAGE_LIMIT}&offset=${offset}`,
            { headers, ...timed },
          );
          if ((catRes.status === 401 || catRes.status === 403) && token) {
            catRes = await fetch(
              `${EXPERIENTIAL_CATALOG_URL}?limit=${EXPERIENTIAL_CATALOG_PAGE_LIMIT}&offset=${offset}`,
              { headers: publicHeaders, ...timed },
            );
          }
          if (!catRes.ok) throw new Error(`Experiential Labs catalog ${catRes.status}`);
          const catJson = (await catRes.json()) as {
            models?: ExperientialCatalogRow[];
            total?: unknown;
          };
          const page = Array.isArray(catJson.models) ? catJson.models : [];
          for (const row of page) {
            const slug = row?.model?.slug;
            if (typeof slug === 'string' && slug && !rows.has(slug)) rows.set(slug, row);
          }
          offset += page.length;
          if (page.length < EXPERIENTIAL_CATALOG_PAGE_LIMIT) break;
          if (typeof catJson.total === 'number' && offset >= catJson.total) break;
        }
        const defs: ModelDef[] = [];
        for (const slug of rawById.keys()) {
          if (!isLikelyChatModelId(slug, this.name)) continue;
          defs.push(this.explabsModelDef(slug, rawById.get(slug), rows.get(slug)));
        }
        if (defs.length > 0) {
          this.explabsModels = foldVendorSpeedTiers(defs);
          providerLog.debug(
            { provider: this.name, count: defs.length },
            'Model list refreshed from Experiential Labs catalog',
          );
        }
        this.explabsFetchedAt = Date.now();
      } catch (err) {
        // Cache failures for the normal discovery TTL too. Otherwise every
        // status render triggers another failing catalog request.
        this.explabsFetchedAt = Date.now();
        providerLog.debug(
          { provider: this.name, err: err instanceof Error ? err.message : String(err) },
          'Experiential Labs catalog refresh failed; leaving catalog empty rather than exposing a fallback list',
        );
      } finally {
        this.explabsRefresh = null;
      }
    })();
    return this.explabsRefresh;
  }

  private explabsModelDef(
    slug: string,
    raw: unknown,
    row: ExperientialCatalogRow | undefined,
  ): ModelDef {
    // Standard OpenAI-style fields first (harmless when the gateway sends
    // bare slugs), then the provider's own rich catalog row.
    let def = this.enrichDiscoveredModel(
      raw ?? { id: slug },
      modelFromRemoteId(slug, this.name, []),
    );
    if (!row?.model) return def;
    const m = row.model;
    const ctx =
      typeof m.context_window === 'number' && m.context_window > 0 ? m.context_window : undefined;
    const deps = Array.isArray(row.providers) ? row.providers : [];
    const depMaxOut = (d: ExperientialCatalogDeployment): number | undefined => {
      const v = d?.capabilities?.maximum_output_tokens;
      return typeof v === 'number' && v > 0 ? v : undefined;
    };
    const maxOut =
      typeof m.max_output_tokens === 'number' && m.max_output_tokens > 0
        ? m.max_output_tokens
        : deps.map(depMaxOut).find((v) => v !== undefined);
    const modalities = Array.isArray(m.input_modalities)
      ? m.input_modalities.map((modality) => String(modality).toLowerCase())
      : [];
    const vision = modalities.includes('image');
    const canReason =
      m.supported_params?.reasoning === true ||
      deps.some((d) => d?.capabilities?.supports_reasoning === true);
    const efforts = new Set<string>();
    for (const d of deps) {
      const list = d?.capabilities?.supported_reasoning_efforts;
      if (!Array.isArray(list)) continue;
      for (const effort of list) {
        if (typeof effort === 'string' && effort.trim()) efforts.add(effort.trim().toLowerCase());
      }
    }
    // Accept every effort tier the provider reports, even ones this codebase
    // has never seen. Known tiers sort along the canonical ladder; anything
    // new appends in provider-reported order so the picker stays adaptable.
    const known = [...efforts].filter((effort) => EXPERIENTIAL_EFFORT_LADDER.includes(effort));
    const novel = [...efforts].filter((effort) => !EXPERIENTIAL_EFFORT_LADDER.includes(effort));
    const reasoningLevels = [
      ...known.sort(
        (a, b) => EXPERIENTIAL_EFFORT_LADDER.indexOf(a) - EXPERIENTIAL_EFFORT_LADDER.indexOf(b),
      ),
      ...novel.sort(),
    ];
    // Pricing is display-only metadata. Estimated rows are never billed, so
    // only real (non-estimate) deployments feed cost attribution. Prefer the
    // platform-funded lane, which is priced from the public catalog.
    const priced = deps.filter(
      (d) =>
        d?.pricing_source !== 'estimate' &&
        (d?.input_nano_usd_per_million !== undefined ||
          d?.output_nano_usd_per_million !== undefined),
    );
    const pick = priced.find((d) => d?.billing_source === 'host_managed') ?? priced[0];
    const inPerM = experientialNanoToUsdPerMillion(pick?.input_nano_usd_per_million);
    const outPerM = experientialNanoToUsdPerMillion(pick?.output_nano_usd_per_million);
    const cachePerM = experientialNanoToUsdPerMillion(pick?.cached_input_nano_usd_per_million);
    const name =
      typeof m.display_name === 'string' && m.display_name.trim()
        ? m.display_name.trim()
        : undefined;
    return {
      ...def,
      ...(name ? { name } : {}),
      ...(ctx !== undefined ? { contextWindow: ctx, contextVerified: true } : {}),
      ...(maxOut !== undefined ? { maxOutputTokens: maxOut } : {}),
      ...(canReason ? { canReason: true } : {}),
      ...(reasoningLevels.length > 0 ? { reasoningLevels } : {}),
      ...(vision ? { vision, supportsAttachments: true } : {}),
      ...(inPerM !== undefined ? { costPerMInputTokens: inPerM } : {}),
      ...(outPerM !== undefined ? { costPerMOutputTokens: outPerM } : {}),
      ...(cachePerM !== undefined ? { costPerMInputCached: cachePerM } : {}),
    };
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

  override isAvailable(): boolean {
    const hasApiKey = !!this.config.apiKey?.trim();
    const hasAuthToken = !!this.config.authToken?.trim();
    return (
      !this.config.disabled &&
      !!this.config.baseUrl?.trim() &&
      !!this.config.deployment?.trim() &&
      hasApiKey !== hasAuthToken
    );
  }

  /**
   * Azure's `/openai/models` response contains base model ids, while inference
   * routes by the deployment name chosen by the Azure resource owner. Never
   * expose the base-model list as runnable deployment ids. The only selectable
   * entry is the deployment the user explicitly configured.
   */
  override listModels(): ModelDef[] {
    const deployment = this.config.deployment?.trim();
    if (!this.isAvailable() || !deployment) return [];
    return [
      {
        id: deployment,
        apiModelId: deployment,
        name: `Azure deployment: ${deployment}`,
        provider: this.name,
        contextWindow: 0,
        maxOutputTokens: 0,
        contextVerified: false,
        isGeneric: true,
        supportsStreaming: true,
      },
    ];
  }

  override refreshModels(): Promise<void> {
    // There is no data-plane API that maps base models to the user's chosen
    // deployment names. Keep the explicit deployment as the source of truth.
    return Promise.resolve();
  }

  getModelDiscoveryError(): string | undefined {
    if (this.config.apiKey?.trim() && this.config.authToken?.trim()) {
      return 'Azure authentication is ambiguous. Configure either an API key or a Microsoft Entra bearer token, not both.';
    }
    return this.config.deployment?.trim()
      ? 'Azure deployment name is user-configured; model family and limits remain unknown until Azure returns runtime metadata.'
      : 'Azure requires an explicit deployment name. A base model id is not a deployment.';
  }

  protected override get client(): OpenAI {
    if (!this._client) {
      const endpoint = this.config.baseUrl;
      if (!endpoint) {
        throw new Error(
          `${this.name} requires an endpoint (base URL), e.g. https://YOUR_RESOURCE.openai.azure.com`,
        );
      }
      const apiKey = this.config.apiKey?.trim();
      const authToken = this.config.authToken?.trim();
      if (apiKey && authToken) {
        throw new Error(
          `${this.name} accepts either an Azure API key or a Microsoft Entra bearer token, not both`,
        );
      }
      this._client = new AzureOpenAI({
        organization: null,
        project: null,
        // AzureOpenAI sends `api-key` only for apiKey. Microsoft Entra tokens
        // must use azureADTokenProvider so the SDK emits `Authorization:
        // Bearer ...`; treating a bearer token as apiKey silently produces the
        // wrong wire contract.
        ...(authToken
          ? { azureADTokenProvider: async () => authToken }
          : { apiKey: apiKey || 'placeholder' }),
        endpoint,
        apiVersion: AZURE_API_VERSION,
        fetch: createUsageInterceptingFetch(globalThis.fetch),
      });
    }
    return this._client;
  }
}
