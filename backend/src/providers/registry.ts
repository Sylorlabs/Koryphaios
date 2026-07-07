// Clean Provider Registry - Only real providers with proper circuit breaker

import type {
  ProviderAuthMode,
  ProviderConfig,
  ProviderName,
  KoryphaiosConfig,
} from '@koryphaios/shared';
import { providerLog } from '../logger';
import {
  buildAuthHeaders,
  getVerifyUrl,
  maskApiKey,
  GEMINI_V1BETA_BASE,
  GEMINI_V1_BASE,
  PROVIDER_BASE_URLS,
} from './api-endpoints';
import { AnthropicProvider } from './anthropic';
import {
  OpenAIProvider,
  GroqProvider,
  OpenRouterProvider,
  XAIProvider,
  AzureProvider,
} from './openai';
import { OpenCodeGoProvider } from './opencodego';

import { GoogleProvider } from './google';
import { CopilotProvider, exchangeGitHubTokenForCopilotAsync } from './copilot';
import { CodexProvider } from './codex';
import { ClaudeCodeProvider } from './claude-code';
import { GrokBuildProvider } from './grok-build';
import { AntigravityProvider } from './antigravity';
import { CursorProvider } from './cursor';
import { DevinProvider } from './devin';
import { ClineProvider } from './cline';
import { JulesProvider } from './jules';
import { BedrockProvider } from './bedrock';
import { GitLabProvider } from './gitlab';
import { SapAiProvider } from './sapai';
import { CustomProvider } from './custom';
import {
  detectCodexAuthToken,
  isCodexCLIAuthMarker,
  detectClaudeCodeLogin,
  detectGrokCLILogin,
  detectAntigravityCLILogin,
  detectCursorCLILogin,
  detectDevinCLILogin,
  detectClineCLILogin,
} from './auth-utils';
import { cliAutoEnableCreds } from './cli-detection';
import { getProviderDisplay } from './provider-display';
import { KimiCodeProvider } from './kimicode';
import { resolveKimiCodeAccessToken } from './kimicode-auth';
import { secureDecrypt, isUsingSecureEncryption } from '../security';
import {
  resolveModel,
  getModelsForProvider,
  isLegacyModel,
  registerLiveModelResolver,
  type StreamRequest,
  type ProviderEvent,
  type Provider,
} from './types';
import { withRetry } from './utils';
import { recordUsage as creditRecordUsage } from '../credit-accountant';
import {
  ENV_API_KEY_MAP,
  ENV_URL_MAP,
  ENV_AUTH_TOKEN_MAP,
  OPENCODE_DEFAULT_BASE_URL,
  LLAMACPP_DEFAULT,
  LMSTUDIO_DEFAULT,
  BASE_URL_PLACEHOLDERS,
  PROVIDER_AUTH_MODE,
} from './constants';

const CODEX_MODELS_URL = 'https://chatgpt.com/backend-api/codex/models?client_version=0.120.0';

// Circuit breaker states
interface CircuitState {
  failures: number;
  lastFailure: number;
  isOpen: boolean;
}

const CIRCUIT_THRESHOLD = 5;
const CIRCUIT_TIMEOUT = 60_000; // 1 minute

class ProviderRegistry {
  private providers = new Map<ProviderName, Provider>();
  private providerConfigs = new Map<ProviderName, ProviderConfig>();
  private circuitStates = new Map<ProviderName, CircuitState>();
  /** IDs of user-defined custom providers (e.g. "custom:my-llm"). */
  private customProviderIds = new Set<ProviderName>();

  constructor(private config?: KoryphaiosConfig) {
    this.initializeAll();
    // Let resolveTrustedContextWindow consult live-discovered model defs
    // (context windows the provider API / CLI reported itself).
    registerLiveModelResolver((modelId, provider) => {
      const p = this.providers.get(provider);
      if (!p) return undefined;
      try {
        return p
          .listModels()
          .find(
            (m) => m.id === modelId || m.apiModelId === modelId || m.realModelId === modelId,
          );
      } catch {
        return undefined;
      }
    });
  }

  private getVisibleProviderNames(): ProviderName[] {
    return [...(Object.keys(PROVIDER_AUTH_MODE) as ProviderName[]), ...this.customProviderIds];
  }

  /** Auth mode for a provider, defaulting to api_key for user-defined custom providers. */
  private authModeFor(name: ProviderName): ProviderAuthMode {
    return PROVIDER_AUTH_MODE[name] ?? 'api_key';
  }

  /** Get all current provider configurations. */
  getConfigs(): Record<string, ProviderConfig> {
    const configs: Record<string, ProviderConfig> = {};
    for (const [name, config] of this.providerConfigs) {
      configs[name] = config;
    }
    return configs;
  }

  /** Get a specific provider by name. */
  get(name: ProviderName): Provider | undefined {
    return this.providers.get(name);
  }

  /** Get all available (authenticated) providers. */
  getAvailable(): Provider[] {
    return [...this.providers.values()].filter((p) => p.isAvailable());
  }

  /** Check if circuit breaker is open for a provider */
  private isCircuitOpen(name: ProviderName): boolean {
    const state = this.circuitStates.get(name);
    if (!state) return false;

    if (state.isOpen) {
      // Check if we should close it
      if (Date.now() - state.lastFailure > CIRCUIT_TIMEOUT) {
        state.isOpen = false;
        state.failures = 0;
        return false;
      }
      return true;
    }
    return false;
  }

  /** Record a failure for circuit breaker */
  private recordFailure(name: ProviderName): void {
    let state = this.circuitStates.get(name);
    if (!state) {
      state = { failures: 0, lastFailure: 0, isOpen: false };
      this.circuitStates.set(name, state);
    }

    state.failures++;
    state.lastFailure = Date.now();

    if (state.failures >= CIRCUIT_THRESHOLD) {
      state.isOpen = true;
      providerLog.warn({ provider: name, failures: state.failures }, 'Circuit breaker opened');
    }
  }

  /** Record a success for circuit breaker */
  private recordSuccess(name: ProviderName): void {
    const state = this.circuitStates.get(name);
    if (state) {
      state.failures = 0;
      state.isOpen = false;
    }
  }

  /** Get provider status only for providers the user has authenticated. No hardcoded list. */
  getStatus(): Array<{
    name: ProviderName;
    enabled: boolean;
    authenticated: boolean;
    models: string[];
    allAvailableModels: ReturnType<Provider['listModels']>;
    selectedModels: string[];
    hideModelSelector: boolean;
    authMode: ProviderAuthMode;
    supportsApiKey: boolean;
    supportsAuthToken: boolean;
    requiresBaseUrl: boolean;
    circuitOpen: boolean;
    error?: string;
    extraAuthModes?: Array<{ id: string; label: string; description?: string }>;
    /** Placeholder for base URL input; backend is single source of truth so UI does not hardcode endpoints. */
    baseUrlPlaceholder?: string;
    /** True for user-defined custom providers. */
    custom?: boolean;
    /** Display label for custom providers. */
    label?: string;
    iconPath?: string;
    deployment?: 'cloud' | 'local' | 'hybrid';
    description?: string;
  }> {
    const names = this.getVisibleProviderNames();
    const result: Array<{
      name: ProviderName;
      enabled: boolean;
      authenticated: boolean;
      models: string[];
      allAvailableModels: ReturnType<Provider['listModels']>;
      selectedModels: string[];
      hideModelSelector: boolean;
      authMode: ProviderAuthMode;
      supportsApiKey: boolean;
      supportsAuthToken: boolean;
      requiresBaseUrl: boolean;
      circuitOpen: boolean;
      error?: string;
      extraAuthModes?: Array<{ id: string; label: string; description?: string }>;
      baseUrlPlaceholder?: string;
      custom?: boolean;
      label?: string;
      iconPath?: string;
      deployment?: 'cloud' | 'local' | 'hybrid';
      description?: string;
    }> = [];

    for (const name of names) {
      const provider = this.providers.get(name);
      const config = this.providerConfigs.get(name);
      const isCustom = this.customProviderIds.has(name) || !!config?.custom;
      const authMode = this.authModeFor(name);
      const circuitOpen = this.isCircuitOpen(name);

      const isProviderAvailable = provider?.isAvailable() ?? false;
      const isEnabled = config ? !config.disabled : false;
      let allModels = [] as ReturnType<Provider['listModels']>;
      if (isEnabled) {
        allModels = provider?.listModels() ?? getModelsForProvider(name);
      }

      const selectedModels = config?.selectedModels ?? [];
      const hideModelSelector = config?.hideModelSelector ?? false;

      const enabledModels =
        selectedModels.length > 0
          ? allModels.filter((model) => selectedModels.includes(model.id)).map((model) => model.id)
          : allModels.map((model) => model.id);

      const requiresBaseUrl =
        isCustom ||
        authMode === 'base_url_only' ||
        name === 'azure' ||
        name === 'azurecognitive' ||
        name === 'sapai' ||
        name === 'zai';
      const baseUrlPlaceholder: string | undefined = requiresBaseUrl
        ? (BASE_URL_PLACEHOLDERS[name] ??
          OPENCODE_DEFAULT_BASE_URL[name] ??
          (name === 'ollama'
            ? 'http://localhost:11434'
            : name === 'llamacpp'
              ? LLAMACPP_DEFAULT
              : name === 'lmstudio'
                ? LMSTUDIO_DEFAULT
                : isCustom
                  ? config?.baseUrl || 'https://your-endpoint.example/v1'
                  : undefined))
        : undefined;

      const display = getProviderDisplay(name);

      result.push({
        name,
        enabled: isEnabled,
        authenticated: isProviderAvailable,
        models: enabledModels,
        allAvailableModels: allModels,
        selectedModels,
        hideModelSelector,
        authMode,
        supportsApiKey: isCustom || authMode === 'api_key' || authMode === 'api_key_or_auth',
        supportsAuthToken: authMode === 'auth_only' || authMode === 'api_key_or_auth',
        requiresBaseUrl,
        circuitOpen,
        ...(isCustom && { custom: true, label: config?.label ?? String(name) }),
        ...(display?.label && !isCustom && { label: display.label }),
        ...(display?.iconPath && { iconPath: display.iconPath }),
        ...(display?.deployment && { deployment: display.deployment }),
        ...(display?.description && { description: display.description }),
        ...(baseUrlPlaceholder && { baseUrlPlaceholder }),
      });
    }

    return result;
  }

  /** All provider types that can be added (for "Add provider" UI). Not filtered by auth. */
  getAvailableProviderTypes(): Array<{ name: ProviderName; authMode: ProviderAuthMode }> {
    return this.getVisibleProviderNames().map((name) => ({
      name,
      authMode: this.authModeFor(name),
    }));
  }

  /** Register (or update) a user-defined custom provider. Caller persists via getConfigs(). */
  registerCustomProvider(def: {
    id: ProviderName;
    label: string;
    kind?: 'openai' | 'anthropic' | 'gemini';
    baseUrl: string;
    apiKey?: string;
    authToken?: string;
    headers?: Record<string, string>;
    models?: string[];
  }): { success: boolean; error?: string } {
    if (!def.baseUrl?.trim())
      return { success: false, error: 'Custom provider requires a base URL' };
    const providerConfig: ProviderConfig = {
      name: def.id,
      custom: true,
      kind: def.kind ?? 'openai',
      label: def.label,
      baseUrl: def.baseUrl.trim(),
      apiKey: def.apiKey?.trim() || undefined,
      authToken: def.authToken?.trim() || undefined,
      headers: def.headers,
      models: def.models,
      selectedModels: def.models ?? [],
      hideModelSelector: false,
      disabled: false,
    };
    this.providerConfigs.set(def.id, providerConfig);
    this.customProviderIds.add(def.id);
    const provider = this.createProvider(def.id, providerConfig);
    if (!provider) {
      this.customProviderIds.delete(def.id);
      this.providerConfigs.delete(def.id);
      return { success: false, error: 'Failed to initialize custom provider' };
    }
    this.providers.set(def.id, provider);
    this.circuitStates.delete(def.id);
    providerLog.info({ provider: def.id, kind: providerConfig.kind }, 'Custom provider registered');
    return { success: true };
  }

  /** Remove a user-defined custom provider. */
  removeCustomProvider(id: ProviderName): void {
    this.providers.delete(id);
    this.providerConfigs.delete(id);
    this.customProviderIds.delete(id);
    this.circuitStates.delete(id);
    providerLog.info({ provider: id }, 'Custom provider removed');
  }

  /** Find the best available provider for a given model ID. */
  findProviderForModel(modelId: string): Provider | undefined {
    for (const provider of this.getAvailable()) {
      if (this.isCircuitOpen(provider.name)) continue;

      const config = this.providerConfigs.get(provider.name);
      const selected = config?.selectedModels ?? [];

      if (selected.length > 0 && !selected.includes(modelId)) {
        continue;
      }

      if (provider.listModels().some((m) => m.id === modelId)) {
        return provider;
      }
    }
    return undefined;
  }

  /** Resolve the provider that should handle a model. */
  resolveProvider(modelId: string, preferredProvider?: ProviderName): Provider | undefined {
    const modelDef = resolveModel(modelId);

    if (modelDef) {
      const catalogProvider = this.providers.get(modelDef.provider);
      if (catalogProvider?.isAvailable() && !this.isCircuitOpen(catalogProvider.name))
        return catalogProvider;
      // Catalog provider missing or unavailable: try user's preferred provider if it can serve this model, then any available provider.
      if (preferredProvider) {
        const preferred = this.providers.get(preferredProvider);
        if (
          preferred?.isAvailable() &&
          !this.isCircuitOpen(preferredProvider) &&
          preferred.listModels().some((m) => m.id === modelId)
        )
          return preferred;
      }
      return this.findProviderForModel(modelId);
    }

    if (preferredProvider) {
      const preferred = this.providers.get(preferredProvider);
      if (preferred?.isAvailable() && !this.isCircuitOpen(preferredProvider)) return preferred;
    }
    return this.findProviderForModel(modelId);
  }

  /** Return the first available provider and one of its non-legacy models for "auto" fallback. */
  getFirstAvailableRouting(): { model: string; provider: ProviderName } | undefined {
    for (const provider of this.getAvailable()) {
      if (provider.name === 'vertexai' || this.isCircuitOpen(provider.name)) continue;
      const models = provider.listModels().filter((m) => !isLegacyModel(m));
      const first = models[0];
      if (first) return { model: first.id, provider: provider.name as ProviderName };
    }
    return undefined;
  }

  /** Execute a stream request with automatic retries and circuit breaker. */
  async *executeWithRetry(
    request: StreamRequest,
    preferredProvider?: ProviderName,
    fallbackChain: string[] = [],
  ): AsyncGenerator<ProviderEvent> {
    const chain = [request.model, ...fallbackChain];

    for (let i = 0; i < chain.length; i++) {
      const currentModel = chain[i];
      const provider = this.resolveProvider(currentModel, i === 0 ? preferredProvider : undefined);

      if (!provider) {
        if (i === chain.length - 1) {
          yield { type: 'error', error: `No available provider for model: ${currentModel}` };
          return;
        }
        providerLog.warn({ model: currentModel }, 'No provider available, trying fallback');
        continue;
      }

      // Check circuit breaker
      if (this.isCircuitOpen(provider.name)) {
        providerLog.warn({ provider: provider.name }, 'Circuit breaker open, skipping');
        if (i === chain.length - 1) {
          yield { type: 'error', error: `Provider ${provider.name} circuit breaker open` };
          return;
        }
        continue;
      }

      try {
        let hasContent = false;
        let accTokensIn = 0;
        let accTokensOut = 0;
        const stream = provider.streamResponse({ ...request, model: currentModel });

        for await (const event of stream) {
          if (this.isContentEvent(event)) hasContent = true;
          if (event.type === 'usage_update') {
            if (typeof event.tokensIn === 'number') accTokensIn = event.tokensIn;
            if (typeof event.tokensOut === 'number') accTokensOut = event.tokensOut;
          }
          yield event;
        }

        if (hasContent) {
          if (accTokensIn > 0 || accTokensOut > 0) {
            creditRecordUsage(currentModel, provider.name, accTokensIn, accTokensOut);
          }
          this.recordSuccess(provider.name);
          return;
        }

        providerLog.warn(
          { model: currentModel, provider: provider.name },
          'Empty response, trying fallback',
        );
        this.recordFailure(provider.name);
      } catch (err: any) {
        providerLog.error(
          { model: currentModel, provider: provider.name, error: err.message },
          'Provider error',
        );
        this.recordFailure(provider.name);

        if (i === chain.length - 1) {
          yield { type: 'error', error: err.message || 'Unknown error' };
          return;
        }
        providerLog.info('Trying next model in fallback chain');
      }
    }
  }

  private isContentEvent(event: ProviderEvent): boolean {
    return (
      event.type === 'content_delta' ||
      event.type === 'thinking_delta' ||
      event.type === 'tool_use_start'
    );
  }

  /** Validate provider credentials. */
  async verifyConnection(
    name: ProviderName,
    credentials?: { apiKey?: string; authToken?: string; baseUrl?: string },
  ): Promise<{ success: boolean; error?: string }> {
    const existing = this.providerConfigs.get(name);
    const apiKey = credentials?.apiKey ?? existing?.apiKey;
    const authToken = credentials?.authToken ?? existing?.authToken;
    const baseUrl = credentials?.baseUrl ?? existing?.baseUrl;
    const shouldMutateStoredState =
      credentials == null ||
      ((credentials.apiKey ?? undefined) === (existing?.apiKey ?? undefined) &&
        (credentials.authToken ?? undefined) === (existing?.authToken ?? undefined) &&
        (credentials.baseUrl ?? undefined) === (existing?.baseUrl ?? undefined));

    try {
      switch (name) {
        case 'claude': {
          // Claude Code subscription is verified by confirming the official CLI is
          // logged in. We never validate a raw token against the API — the CLI owns
          // auth and runs every request, keeping us compliant with Anthropic's terms.
          if (detectClaudeCodeLogin()) return { success: true };
          return {
            success: false,
            error:
              'Claude Code is not logged in. Run "claude login" in your terminal to connect your Claude subscription.',
          };
        }
        case 'grok': {
          if (detectGrokCLILogin()) return { success: true };
          return {
            success: false,
            error: 'Grok Build CLI is not logged in. Install the grok CLI and run "grok login".',
          };
        }
        case 'antigravity': {
          if (detectAntigravityCLILogin()) return { success: true };
          return {
            success: false,
            error: 'Antigravity CLI is not logged in. Install agy and run "agy login".',
          };
        }
        case 'cursor': {
          // Subscription CLI harness — no API key; the logged-in cursor-agent
          // binary authenticates itself.
          if (detectCursorCLILogin()) return { success: true };
          return {
            success: false,
            error: 'Cursor CLI is not logged in. Install cursor-agent and run "cursor-agent login".',
          };
        }
        case 'devin': {
          if (detectDevinCLILogin()) return { success: true };
          return {
            success: false,
            error: 'Devin CLI is not logged in. Install devin and run "devin auth login".',
          };
        }
        case 'cline': {
          if (detectClineCLILogin()) return { success: true };
          return {
            success: false,
            error: 'Cline CLI is not signed in. Install cline and run "cline auth --provider <p> --apikey <k>".',
          };
        }
        case 'anthropic': {
          if (!apiKey && !authToken)
            return { success: false, error: 'Missing apiKey or authToken' };
          const { headers } = buildAuthHeaders(name, { apiKey, authToken });
          const url =
            getVerifyUrl(name, undefined, { apiKey, authToken }) ||
            `${PROVIDER_BASE_URLS.anthropic}/models`;
          const res = await this.verifyHttpWithStatus(url, { method: 'GET', headers });
          if (res.success) return { success: true };
          if (res.status === 401 && shouldMutateStoredState) {
            this.markKeyInvalid(name, res.error ?? 'Unauthorized');
            const config = this.providerConfigs.get(name);
            if (config) {
              config.disabled = true;
              this.providers.delete(name);
            }
          }
          return { success: false, error: res.error };
        }
        case 'openai':
          return this.verifyBearerGet('https://api.openai.com/v1/models', apiKey);
        case 'google': {
          if (!apiKey && !authToken)
            return { success: false, error: 'Missing apiKey or authToken' };
          // Gemini 3.1 / Thinking: v1beta often required; support ?key= and x-goog-api-key as fallbacks.
          const creds = { apiKey, authToken };
          const tryUrl = (base: string, useHeader: boolean) => {
            const path = `${base.replace(/\/?$/, '')}/models`;
            if (useHeader) {
              const { headers } = buildAuthHeaders(name, creds, { useGeminiHeader: true });
              return this.verifyHttpWithStatus(path, { method: 'GET', headers });
            }
            const urlWithKey = `${path}?key=${encodeURIComponent(apiKey!)}`;
            return this.verifyHttpWithStatus(urlWithKey, {
              method: 'GET',
              headers: { 'Content-Type': 'application/json', 'User-Agent': 'Koryphaios/1.0' },
            });
          };
          let result = await tryUrl(GEMINI_V1BETA_BASE, false);
          if (result.success) return { success: true };
          if (result.status === 401 && shouldMutateStoredState) {
            this.markKeyInvalid(name, result.error ?? 'Unauthorized');
            const config = this.providerConfigs.get(name);
            if (config) {
              config.disabled = true;
              this.providers.delete(name);
            }
            return { success: false, error: result.error };
          }
          if (result.status === 404) {
            result = await tryUrl(GEMINI_V1BETA_BASE, true);
            if (result.success) return { success: true };
            result = await tryUrl(GEMINI_V1_BASE, false);
            if (result.success) {
              try {
                const { getDb } = require('../db');
                getDb()
                  .prepare(
                    'INSERT OR REPLACE INTO provider_endpoint_override (provider, base_url, updated_at) VALUES (?, ?, ?)',
                  )
                  .run(name, GEMINI_V1_BASE, Date.now());
              } catch {
                // DB not initialized
              }
              return { success: true };
            }
          }
          return { success: false, error: result.error };
        }
        case 'copilot': {
          const token = authToken;
          if (!token) return { success: false, error: 'GitHub Copilot token not found' };
          const bearer = await exchangeGitHubTokenForCopilotAsync(token);
          if (!bearer)
            return { success: false, error: 'Failed to exchange GitHub token for Copilot bearer' };
          return this.verifyHttp('https://api.githubcopilot.com/models', {
            headers: {
              Authorization: `Bearer ${bearer}`,
              'Editor-Version': 'vscode/1.100.0',
              'Editor-Plugin-Version': 'copilot-chat/0.27.0',
              'Copilot-Integration-Id': 'vscode-chat',
              'User-Agent': 'Koryphaios/1.0',
            },
          });
        }
        case 'openrouter':
          return this.verifyBearerGet('https://openrouter.ai/api/v1/models', apiKey);
        case 'kimicode': {
          const resolvedToken = await resolveKimiCodeAccessToken(authToken ?? apiKey ?? null);
          if (!resolvedToken) return { success: false, error: 'Missing authToken' };
          const base = baseUrl?.replace(/\/+$/, '') || 'https://api.kimi.com/coding/v1';
          return this.verifyHttp(`${base}/models`, {
            method: 'GET',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${resolvedToken}`,
            },
          });
        }
        case 'mistral':
          return this.verifyBearerGet('https://api.mistral.ai/v1/models', apiKey);
        case 'groq':
          return this.verifyBearerGet('https://api.groq.com/openai/v1/models', apiKey);
        case 'xai':
          return this.verifyBearerGet('https://api.x.ai/v1/models', apiKey);
        case 'azure': {
          if (!apiKey && !authToken)
            return { success: false, error: 'Missing apiKey or authToken' };
          if (!baseUrl) return { success: false, error: 'Missing baseUrl' };
          const trimmed = baseUrl.replace(/\/+$/, '');
          const headers: Record<string, string> = {};
          if (apiKey) headers['api-key'] = apiKey;
          if (authToken) headers.Authorization = `Bearer ${authToken}`;
          return this.verifyHttp(`${trimmed}/openai/models?api-version=2024-10-21`, { headers });
        }
        case 'local': {
          if (!baseUrl) return { success: false, error: 'Missing baseUrl' };
          const trimmed = baseUrl.replace(/\/+$/, '');
          return this.verifyHttp(`${trimmed}/models`);
        }
        case 'ollama': {
          if (!baseUrl)
            return { success: false, error: 'Missing baseUrl (e.g. http://localhost:11434)' };
          const trimmed = baseUrl.replace(/\/+$/, '');
          return this.verifyHttp(`${trimmed}/api/tags`);
        }
        case 'bedrock':
          return this.verifyBedrockEnvironment();
        case 'vertexai':
          if (!apiKey)
            return {
              success: false,
              error:
                'Vertex AI requires an explicit API key (set GOOGLE_VERTEX_AI_API_KEY or add apiKey in settings)',
            };
          return { success: true };
        case 'codex': {
          const isMarker = authToken && isCodexCLIAuthMarker(authToken);
          const resolvedCodexToken = isMarker ? detectCodexAuthToken() : authToken;
          if (!resolvedCodexToken) {
            return {
              success: false,
              error: 'Missing authToken',
            };
          }
          // If auth came from CLI device flow (marker), trust the token without
          // a synchronous verification — the ChatGPT backend can be slow to
          // accept freshly issued tokens and the CodexProvider will validate
          // on first real API call anyway.
          if (isMarker) return { success: true };
          return this.verifyHttp(CODEX_MODELS_URL, {
            headers: { Authorization: `Bearer ${resolvedCodexToken}` },
          });
        }
        case 'jules': {
          if (!apiKey)
            return {
              success: false,
              error: 'Missing JULES_API_KEY (create at jules.google.com/settings#api)',
            };
          return this.verifyHttp('https://jules.googleapis.com/v1alpha/sources?pageSize=1', {
            method: 'GET',
            headers: { 'X-Goog-Api-Key': apiKey, 'User-Agent': 'Koryphaios/1.0' },
          });
        }
        case 'opencodezen': {
          if (!apiKey)
            return { success: false, error: 'Missing API key (get one at opencode.ai/auth)' };
          const base = 'https://opencode.ai/zen/v1';
          return this.verifyBearerGet(`${base}/models`, apiKey);
        }
        case 'opencodego': {
          if (!apiKey)
            return {
              success: false,
              error: 'Missing API key — subscribe to OpenCode Go at opencode.ai/auth',
            };
          const base = 'https://opencode.ai/zen/go/v1';
          return this.verifyBearerGet(`${base}/models`, apiKey);
        }
        case 'llamacpp': {
          const url = baseUrl ?? LLAMACPP_DEFAULT;
          if (!url)
            return { success: false, error: 'Missing baseUrl (e.g. http://127.0.0.1:8080/v1)' };
          return this.verifyHttp(`${url.replace(/\/v1\/?$/, '')}/v1/models`);
        }
        case 'lmstudio': {
          const url = baseUrl ?? LMSTUDIO_DEFAULT;
          if (!url)
            return { success: false, error: 'Missing baseUrl (e.g. http://localhost:1234/v1)' };
          return this.verifyHttp(`${url.replace(/\/v1\/?$/, '')}/v1/models`);
        }
        case 'azurecognitive': {
          if (!apiKey) return { success: false, error: 'Missing API key' };
          if (!baseUrl)
            return {
              success: false,
              error: 'Missing baseUrl (e.g. https://YOUR_RESOURCE.cognitiveservices.azure.com)',
            };
          const trimmed = baseUrl.replace(/\/+$/, '');
          return this.verifyHttp(`${trimmed}/openai/deployments?api-version=2024-02-15-preview`, {
            headers: { 'api-key': apiKey },
          });
        }
        case 'sapai': {
          if (!apiKey)
            return { success: false, error: 'Missing service key (JSON from SAP BTP Cockpit)' };
          if (!baseUrl)
            return { success: false, error: 'Missing baseUrl from service key (AI_API_URL)' };
          const trimmed = baseUrl.replace(/\/+$/, '');
          return this.verifyHttp(`${trimmed}/openai/deployments`, {
            headers: { Authorization: `Bearer ${apiKey}` },
          });
        }
        case 'zai': {
          // Z.AI: https://api.z.ai/api/paas/v4 (Standard) or .../api/coding/paas/v4 (Coding Plan) or open.bigmodel.cn (China)
          if (!apiKey) return { success: false, error: 'Missing API key' };
          const base = baseUrl?.replace(/\/+$/, '') ?? 'https://api.z.ai/api/paas/v4';
          return this.verifyHttp(`${base}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model: 'glm-4.5',
              messages: [{ role: 'user', content: 'Hi' }],
              max_tokens: 1,
            }),
          });
        }
        default: {
          const defaultBase = OPENCODE_DEFAULT_BASE_URL[name];
          const effectiveBase = baseUrl ?? defaultBase;
          const effectiveApiKey = apiKey || authToken;

          // Universal OpenAI-compatible verification
          if (effectiveBase && effectiveApiKey) {
            return this.verifyBearerGet(
              `${effectiveBase.replace(/\/?$/, '')}/models`,
              effectiveApiKey,
            );
          }

          if (effectiveBase) return { success: false, error: 'Missing API key' };
          return { success: false, error: `Unsupported provider: ${name}` };
        }
      }
    } catch (err: any) {
      return { success: false, error: err?.message ?? String(err) };
    }
  }

  /** Set/update provider credentials. */
  async setCredentials(
    name: ProviderName,
    credentials: {
      apiKey?: string;
      authToken?: string;
      baseUrl?: string;
      selectedModels?: string[];
      hideModelSelector?: boolean;
    },
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const existing = this.providerConfigs.get(name);

      // Auto-detect if blank
      const resolvedApiKey =
        credentials.apiKey?.trim() || existing?.apiKey || this.detectEnvKey(name) || undefined;
      const resolvedAuthToken = credentials.authToken?.trim() || existing?.authToken || undefined;
      const resolvedBaseUrl =
        credentials.baseUrl?.trim() || existing?.baseUrl || this.detectEnvUrl(name) || undefined;

      const nextConnection = {
        apiKey: resolvedApiKey,
        authToken: resolvedAuthToken,
        baseUrl: resolvedBaseUrl,
      };

      const validation = this.validateCredentials(name, nextConnection, existing);
      if (!validation.success) return validation;

      const connectionChanged =
        existing?.apiKey !== nextConnection.apiKey ||
        existing?.authToken !== nextConnection.authToken ||
        existing?.baseUrl !== nextConnection.baseUrl;

      if (connectionChanged) {
        const verification = await this.verifyConnection(name, nextConnection);
        if (!verification.success) return verification;
      }

      const providerConfig: ProviderConfig = {
        name,
        apiKey: resolvedApiKey,
        authToken: resolvedAuthToken,
        baseUrl: resolvedBaseUrl,
        selectedModels: credentials.selectedModels ?? existing?.selectedModels,
        hideModelSelector: credentials.hideModelSelector ?? existing?.hideModelSelector,
        disabled: false, // Explicitly enable on setCredentials
        headers: existing?.headers,
      };

      this.providerConfigs.set(name, providerConfig);

      const provider = this.createProvider(name, providerConfig);
      if (provider) {
        this.providers.set(name, provider);
        this.circuitStates.delete(name); // Reset circuit breaker
        this.clearKeyInvalid(name); // New key may be valid
        providerLog.info({ provider: name }, 'Provider configured');
        return { success: true };
      }
      return { success: false, error: 'Failed to initialize provider' };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  private validateCredentials(
    name: ProviderName,
    credentials: { apiKey?: string; authToken?: string; baseUrl?: string },
    existing?: ProviderConfig,
  ): { success: boolean; error?: string } {
    const authMode = this.authModeFor(name);
    const apiKey = credentials.apiKey?.trim();
    const authToken = credentials.authToken?.trim();
    const baseUrl = credentials.baseUrl?.trim();

    // Custom providers only require a base URL; the API key is optional.
    if (existing?.custom || this.customProviderIds.has(name)) {
      if (!baseUrl && !existing?.baseUrl) {
        return { success: false, error: 'Custom provider requires a base URL' };
      }
      return { success: true };
    }

    if (authMode === 'auth_only' && apiKey) {
      return {
        success: false,
        error: `${name} uses account auth only and does not accept API keys`,
      };
    }

    if (authMode === 'auth_only') {
      const hasAuth = !!(authToken || existing?.authToken);
      if (!hasAuth) {
        return { success: false, error: 'authToken is required' };
      }
    }

    if (authMode === 'api_key' && !apiKey) {
      return { success: false, error: 'apiKey is required' };
    }

    if (authMode === 'api_key_or_auth' && !apiKey && !authToken) {
      return { success: false, error: 'Provide apiKey or authToken' };
    }

    if (authMode === 'env_auth') {
      const envReady = this.hasBedrockEnvironment();
      if (!envReady)
        return { success: false, error: `${name} environment credentials not detected` };
    }

    if (authMode === 'base_url_only' && !baseUrl) {
      // Some local providers have defaults
      if (name === 'llamacpp' || name === 'lmstudio' || name === 'ollama') return { success: true };
      return { success: false, error: 'baseUrl is required' };
    }

    return { success: true };
  }

  /** Force-refresh a provider instance from current stored config. */
  refreshProvider(name: ProviderName): { success: boolean; error?: string } {
    const config = this.providerConfigs.get(name);
    if (!config) return { success: false, error: 'Provider config not found' };
    try {
      const provider = this.createProvider(name, config);
      if (!provider) return { success: false, error: 'Failed to initialize provider' };
      this.providers.set(name, provider);
      this.circuitStates.delete(name); // Reset circuit breaker on refresh
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message ?? String(err) };
    }
  }

  /** Remove a provider's API key. */
  removeApiKey(name: ProviderName): void {
    const config = this.providerConfigs.get(name);
    if (config) {
      config.apiKey = undefined;
      config.authToken = undefined;
      config.disabled = true;
      this.providerConfigs.set(name, config);
    }
    this.providers.delete(name);
    this.circuitStates.delete(name);
    providerLog.info({ provider: name }, 'Provider disconnected');
  }

  /** Get the env var name expected for a provider. */
  getExpectedEnvVar(
    name: ProviderName,
    kind: 'apiKey' | 'authToken' | 'baseUrl' = 'apiKey',
  ): string {
    if (kind === 'authToken') {
      return ENV_AUTH_TOKEN_MAP[name]?.[0] ?? `${name.toUpperCase()}_AUTH_TOKEN`;
    }
    if (kind === 'baseUrl') {
      return ENV_URL_MAP[name] ?? `${name.toUpperCase()}_BASE_URL`;
    }
    return ENV_API_KEY_MAP[name]?.[0] ?? `${name.toUpperCase()}_API_KEY`;
  }

  // ─── Private: Initialize all providers ──────────────────────────────────

  private initializeAll() {
    for (const name of Object.keys(PROVIDER_AUTH_MODE) as ProviderName[]) {
      const providerConfig = this.buildProviderConfig(name);
      this.providerConfigs.set(name, providerConfig);

      try {
        const provider = this.createProvider(name, providerConfig);
        if (provider) this.providers.set(name, provider);
      } catch (error) {
        providerLog.error({ provider: name, error }, 'Failed to initialize provider');
      }
    }

    // Restore user-defined custom providers persisted in the config.
    for (const [id, pc] of Object.entries(this.config?.providers ?? {})) {
      if (!pc?.custom || PROVIDER_AUTH_MODE[id as ProviderName]) continue;
      this.customProviderIds.add(id as ProviderName);
      const providerConfig = this.buildProviderConfig(id as ProviderName);
      this.providerConfigs.set(id, providerConfig);
      try {
        const provider = this.createProvider(id as ProviderName, providerConfig);
        if (provider) this.providers.set(id, provider);
      } catch (error) {
        providerLog.error({ provider: id, error }, 'Failed to initialize custom provider');
      }
    }

    // Proactively warm dynamic model-list caches (Claude Code / Codex / Grok Build fetch
    // live from their CLI/backend on a lazy TTL) so a fresh app launch surfaces current
    // models immediately instead of waiting for the first UI request to trigger it.
    for (const provider of this.providers.values()) {
      try {
        provider.listModels();
      } catch (error) {
        providerLog.debug({ provider: provider.name, error }, 'Startup model-list warm-up failed');
      }
    }

    this.logProviderStatus();
  }

  /**
   * Auto-enable providers backed by an agent CLI the user already has installed +
   * logged in on this machine (Claude Code, Codex, Gemini CLI, Grok Build) — so they
   * "just work" with no manual Connect step. A logged-in CLI is clear user intent,
   * unlike a stray environment variable (which we still don't auto-auth). Returns the
   * credentials to inject, or null when there's nothing to auto-enable.
   * Opt out entirely with KORY_DISABLE_CLI_AUTODETECT=1.
   */
  private buildProviderConfig(name: ProviderName): ProviderConfig {
    const userConfig = this.config?.providers?.[name];

    // Default to disabled to prevent "auto-authing" from environment variables without user intent.
    // Explicit opt-in (via UI "Connect" or config) is required — EXCEPT for providers backed by
    // an agent CLI the user has installed + logged in, which we treat as intent and auto-enable
    // (Claude Code, Codex, Gemini CLI, Grok Build). Opt out with KORY_DISABLE_CLI_AUTODETECT=1.
    const defaultDisabled = true;
    const autoCli = cliAutoEnableCreds(name);
    const isDisabled = autoCli ? false : (userConfig?.disabled ?? defaultDisabled);

    const providerConfig: ProviderConfig = {
      name,
      apiKey:
        userConfig?.apiKey ??
        autoCli?.apiKey ??
        (isDisabled ? undefined : this.detectEnvKey(name)) ??
        undefined,
      authToken:
        userConfig?.authToken ??
        autoCli?.authToken ??
        (isDisabled ? undefined : this.detectEnvAuthToken(name)) ??
        undefined,
      baseUrl: userConfig?.baseUrl ?? this.detectEnvUrl(name) ?? undefined,
      selectedModels: userConfig?.selectedModels ?? [],
      hideModelSelector: userConfig?.hideModelSelector ?? false,
      disabled: isDisabled,
      headers: userConfig?.headers,
      // Preserve custom-provider metadata so BYO providers survive restarts.
      ...(userConfig?.custom && {
        custom: true,
        kind: userConfig.kind,
        label: userConfig.label,
        models: userConfig.models,
      }),
    };

    return providerConfig;
  }

  private hasValidAuth(name: ProviderName, config: ProviderConfig): boolean {
    if (config.custom) return !!config.baseUrl;
    const authMode = this.authModeFor(name);
    const hasApi = !!config.apiKey;
    const hasAuth = !!config.authToken;
    const hasUrl = !!config.baseUrl;

    const hasAnyAuth =
      (authMode === 'api_key' && hasApi) ||
      (authMode === 'auth_only' && hasAuth) ||
      (authMode === 'api_key_or_auth' && (hasApi || hasAuth)) ||
      (authMode === 'env_auth' && this.hasBedrockEnvironment()) ||
      (authMode === 'base_url_only' && (hasUrl || name === 'lmstudio' || name === 'llamacpp'));

    if (hasAnyAuth) return true;

    // Provider has no auth — it will fail at runtime when called
    return false;
  }

  private createProvider(name: ProviderName, config: ProviderConfig): Provider | null {
    // User-defined custom providers (OpenAI/Anthropic/Gemini-compatible BYO endpoints).
    if (config.custom || this.customProviderIds.has(name)) {
      return config.baseUrl ? new CustomProvider(config) : null;
    }
    switch (name) {
      case 'anthropic':
        return new AnthropicProvider(config);
      case 'claude':
        // Claude Code subscription — runs the official `claude` CLI harness (no direct API calls).
        return new ClaudeCodeProvider(config);
      case 'openai':
        return new OpenAIProvider(config);
      case 'google':
        return config.apiKey || config.authToken ? new GoogleProvider(config) : null;
      case 'aistudio':
        // Google AI Studio — Gemini API key only (no gcloud OAuth).
        return config.apiKey ? new GoogleProvider({ ...config, name: 'aistudio' }) : null;
      case 'copilot':
        return new CopilotProvider(config);
      case 'codex':
        return new CodexProvider(config);
      case 'grok':
        // Grok Build subscription — runs the official `grok` CLI harness (no direct API calls).
        return new GrokBuildProvider(config);
      case 'antigravity':
        // Antigravity subscription — runs the official `agy` CLI harness (no direct API calls).
        return new AntigravityProvider(config);
      case 'cursor':
        // Cursor subscription — runs the official `cursor-agent` CLI harness (no API key).
        return new CursorProvider(config);
      case 'devin':
        // Devin subscription — runs Cognition's official `devin` CLI harness (no API key).
        return new DevinProvider(config);
      case 'cline':
        return new ClineProvider(config);
      case 'jules':
        // Google Jules — cloud async agent (REST API only, remote VMs + GitHub PRs).
        if (config.disabled || !config.apiKey) return null;
        return new JulesProvider(config);
      case 'kimicode':
        return new KimiCodeProvider(config);
      case 'openrouter':
        return new OpenRouterProvider(config);
      case 'opencodego':
        // OpenCode Go is dual-protocol — OpenCodeGoProvider dispatches per-model.
        return new OpenCodeGoProvider(config);
      case 'groq':
        return new GroqProvider(config);
      case 'xai':
        return new XAIProvider(config);
      case 'azure':
        return new AzureProvider(config);
      case 'azurecognitive':
        // Azure Cognitive Services uses the same Azure OpenAI wire contract (api-key
        // header + /openai/deployments/{deployment}?api-version), just a different host.
        return config.baseUrl ? new AzureProvider(config, 'azurecognitive') : null;
      case 'bedrock':
        // Claude on Amazon Bedrock — SigV4-signed via the official AnthropicBedrock client.
        return new BedrockProvider(config);
      case 'gitlab':
        // GitLab Duo Chat — POST /api/v4/chat/completions ({content} body, Bearer PAT).
        return config.apiKey || config.authToken ? new GitLabProvider(config) : null;
      case 'sapai':
        // SAP AI Core — OAuth (service key) + /v2/inference/deployments/{id} + AI-Resource-Group.
        return config.apiKey || config.authToken ? new SapAiProvider(config) : null;
      case 'vertexai':
        // Requires explicit API key — never auto-enable from GCP environment variables
        if (config.disabled || !config.apiKey) return null;
        return new GoogleProvider({ ...config, name: 'vertexai' });
      case 'local':
      case 'ollama':
      case 'llamacpp':
      case 'lmstudio': {
        const defaultBase =
          name === 'llamacpp'
            ? LLAMACPP_DEFAULT
            : name === 'lmstudio'
              ? LMSTUDIO_DEFAULT
              : undefined;
        if (config.baseUrl || defaultBase) {
          return new OpenAIProvider(config, name, config.baseUrl ?? defaultBase);
        }
        return null;
      }
      default: {
        const defaultBase = OPENCODE_DEFAULT_BASE_URL[name];
        if ((defaultBase || config.baseUrl) && (config.apiKey || config.authToken)) {
          return new OpenAIProvider(config, name, config.baseUrl ?? defaultBase);
        }
        if (name === 'sapai' && config.apiKey && config.baseUrl) {
          return new OpenAIProvider(config, 'sapai', config.baseUrl);
        }
        return null;
      }
    }
  }

  private detectEnvKey(name: ProviderName): string | null {
    const envVars = ENV_API_KEY_MAP[name] ?? [];
    for (const envVar of envVars) {
      const val = process.env[envVar];
      if (!val) continue;
      if (val.startsWith('env:') || val.startsWith('enc:')) return null;
      return val;
    }
    return null;
  }

  private detectEnvAuthToken(name: ProviderName): string | null {
    const envVars = ENV_AUTH_TOKEN_MAP[name] ?? [];
    for (const envVar of envVars) {
      const val = process.env[envVar];
      if (!val) continue;
      if (val.startsWith('env:') || val.startsWith('enc:')) return null;
      return val;
    }
    return null;
  }

  /** Resolve envelope-encrypted credentials after encryption is initialized. */
  async initializeEncryptedCredentials(): Promise<void> {
    if (!isUsingSecureEncryption()) return;
    for (const name of Object.keys(PROVIDER_AUTH_MODE) as ProviderName[]) {
      const config = this.providerConfigs.get(name);
      if (!config) continue;
      let apiKey = config.apiKey;
      let authToken = config.authToken;
      for (const envVar of ENV_API_KEY_MAP[name] ?? []) {
        const val = process.env[envVar];
        if (val?.startsWith('env:')) {
          try {
            apiKey = await secureDecrypt(val);
            break;
          } catch {
            providerLog.warn({ provider: name, envVar }, 'Failed to decrypt stored API key');
          }
        }
      }
      for (const envVar of ENV_AUTH_TOKEN_MAP[name] ?? []) {
        const val = process.env[envVar];
        if (val?.startsWith('env:')) {
          try {
            authToken = await secureDecrypt(val);
            break;
          } catch {
            providerLog.warn({ provider: name, envVar }, 'Failed to decrypt stored auth token');
          }
        }
      }
      if (apiKey !== config.apiKey || authToken !== config.authToken) {
        const updated = { ...config, apiKey, authToken };
        this.providerConfigs.set(name, updated);
        const provider = this.createProvider(name, updated);
        if (provider) this.providers.set(name, provider);
      }
    }
  }

  private detectEnvUrl(name: ProviderName): string | null {
    const envVar = ENV_URL_MAP[name];
    if (envVar) return process.env[envVar] ?? null;
    return null;
  }

  private hasBedrockEnvironment(): boolean {
    return !!(
      (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) ||
      process.env.AWS_PROFILE
    );
  }

  private verifyBedrockEnvironment(): { success: boolean; error?: string } {
    if (this.hasBedrockEnvironment()) return { success: true };
    return { success: false, error: 'AWS credentials not detected' };
  }

  private logProviderStatus() {
    const available = this.getAvailable();
    const names = available.map((p) => p.name);
    providerLog.info({ providers: names }, 'Providers ready');

    if (names.length === 0) {
      providerLog.warn('No providers configured - set API keys in .env');
    }
  }

  private async verifyBearerGet(
    url: string,
    token?: string | null,
  ): Promise<{ success: boolean; error?: string }> {
    if (!token) return { success: false, error: 'Missing token' };
    return this.verifyHttp(url, { headers: { Authorization: `Bearer ${token}` } });
  }

  /** Identify if an error is a quota/rate limit error that should trigger a reroute. */
  isQuotaError(error: any): boolean {
    const msg = String(error?.message || error || '').toLowerCase();
    const isQuota =
      msg.includes('quota') ||
      msg.includes('rate limit') ||
      msg.includes('429') ||
      msg.includes('insufficient_quota') ||
      msg.includes('credit balance');
    return isQuota;
  }

  /**
   * Dry-run connectivity test for a provider. Sends minimal-cost request (e.g. model list).
   * Returns 200 OK or specific "Out of Credits" vs timeout/refused. Never logs raw API keys.
   */
  async testConnection(name: ProviderName): Promise<{
    ok: boolean;
    status?: number;
    error?: string;
    outOfCredits?: boolean;
  }> {
    const result = await this.verifyConnection(name);
    if (result.success) return { ok: true, status: 200 };
    const err = (result.error ?? '').toLowerCase();
    const outOfCredits =
      err.includes('quota') ||
      err.includes('credit') ||
      err.includes('insufficient') ||
      err.includes('out of credits');
    return { ok: false, error: result.error, outOfCredits };
  }

  /** Persist invalid key state (401). No-op if DB not initialized. */
  private markKeyInvalid(name: ProviderName, lastError: string): void {
    try {
      const { getDb } = require('../db');
      getDb()
        .prepare(
          'INSERT OR REPLACE INTO provider_key_invalid (provider, invalid_since, last_error) VALUES (?, ?, ?)',
        )
        .run(name, Date.now(), lastError);
      const config = this.providerConfigs.get(name);
      providerLog.warn(
        { provider: name, keyMask: maskApiKey(config?.apiKey ?? config?.authToken) },
        'API key marked invalid (401); update key in settings',
      );
    } catch {
      // DB not initialized (e.g. tests)
    }
  }

  /** Clear invalid key state (e.g. after user updates key). */
  clearKeyInvalid(name: ProviderName): void {
    try {
      const { getDb } = require('../db');
      getDb().run('DELETE FROM provider_key_invalid WHERE provider = ?', name);
    } catch {
      // DB not initialized
    }
  }

  /** Check if provider was previously marked invalid. */
  private isKeyMarkedInvalid(name: ProviderName): boolean {
    try {
      const { getDb } = require('../db');
      const row = getDb()
        .query('SELECT provider FROM provider_key_invalid WHERE provider = ?')
        .get(name) as { provider?: string } | undefined;
      return !!row;
    } catch {
      return false;
    }
  }

  /** Like verifyHttp but returns status for 401/404 handling. */
  private async verifyHttpWithStatus(
    url: string,
    init?: RequestInit,
  ): Promise<{ success: boolean; status?: number; error?: string }> {
    const timeoutMs = 5_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = new Headers(init?.headers ?? {});
      if (!headers.has('User-Agent')) headers.set('User-Agent', 'Koryphaios/1.0');
      const response = await fetch(url, {
        method: 'GET',
        ...init,
        headers,
        signal: controller.signal,
      });
      if (response.ok) return { success: true, status: response.status };
      const body = await response.text();
      return {
        success: false,
        status: response.status,
        error: `HTTP ${response.status}: ${body.slice(0, 300)}`,
      };
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      if (msg.includes('abort') || msg.includes('timeout')) {
        return { success: false, error: 'Request timeout (5s)' };
      }
      return { success: false, error: msg };
    } finally {
      clearTimeout(timer);
    }
  }

  private async verifyHttp(
    url: string,
    init?: RequestInit,
  ): Promise<{ success: boolean; error?: string }> {
    const res = await this.verifyHttpWithStatus(url, init);
    return { success: res.success, error: res.error };
  }
}

export { ProviderRegistry };
