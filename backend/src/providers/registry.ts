// Clean Provider Registry - Only real providers with proper circuit breaker

import type {
  ProviderAuthMode,
  ProviderConfig,
  ProviderName,
  KoryphaiosConfig,
} from '@koryphaios/shared';
import { providerLog, serverLog } from '../logger';
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
import { CodexCliProvider } from './codex-cli';
import { CodexAuthProvider } from './codex-auth';
import { getManagedCodexAppServer } from './codex-app-server';
import { ClaudeCodeProvider } from './claude-code';
import { GrokBuildProvider } from './grok-build';
import { FreebuffProvider } from './freebuff';
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
  detectCodexCLILogin,
  detectClaudeCodeLogin,
  detectGrokCLILogin,
  detectAntigravityCLILogin,
  detectCursorCLILogin,
  detectDevinCLILogin,
  detectClineCLILogin,
  detectFreebuffCLILogin,
  readFreebuffAuthToken,
} from './auth-utils';
import { cliAutoEnableCreds, whichBinary } from './cli-detection';
import { discoverCliAccounts } from './cli-accounts';
import { type ProviderDeployment, getProviderDisplay } from './provider-display';
import { KimiCodeProvider } from './kimicode';
import { resolveKimiCodeAccessToken } from './kimicode-auth';
import { secureDecrypt, isUsingSecureEncryption } from '../security';
import {
  resolveModel,
  isLegacyModel,
  registerLiveModelResolver,
  type StreamRequest,
  type ProviderEvent,
  type Provider,
} from './types';
import { CapabilityRegistry } from './CapabilityRegistry';
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
import { PROVIDER_CONFIG_MAP } from './provider-configs';

const CLI_HARNESS_PROVIDERS = new Set<ProviderName>([
  'claude',
  'codex',
  'grok',
  'antigravity',
  'cursor',
  'devin',
  'cline',
  'freebuff',
]);

const LOCAL_PROVIDER_KEYS = new Set<ProviderName>([
  'local',
  'ollama',
  'lmstudio',
  'llamacpp',
]);

function inferProviderDeployment(
  name: ProviderName,
  authMode: ProviderAuthMode,
  isCustom: boolean,
  hasDisplayDeployment?: ProviderDeployment,
): ProviderDeployment {
  if (hasDisplayDeployment) return hasDisplayDeployment;
  if (LOCAL_PROVIDER_KEYS.has(name) || CLI_HARNESS_PROVIDERS.has(name)) return 'local';
  if (String(name).startsWith('remote-')) return 'cloud';
  if (isCustom) return 'api';
  if (authMode === 'base_url_only') return 'local';
  return 'api';
}

// Circuit breaker states
interface CircuitState {
  failures: number;
  lastFailure: number;
  isOpen: boolean;
}

/**
 * Generate a human-readable display label from a provider's machine name.
 * Used when no explicit label is defined in PROVIDER_DISPLAY, so every
 * provider in PROVIDER_CONFIGS gets a readable label without a hardcoded list.
 *
 *   '302ai'        -> '302.ai'
 *   'opencodezen'  -> 'OpenCode Zen'
 *   'codex-auth'   -> 'Codex Auth'
 *   'novita-ai'    -> 'Novita AI'
 *   'togetherai'   -> 'Together AI'
 *   'huggingface'  -> 'HuggingFace'
 */
function generateProviderLabel(name: string): string {
  // Special-case a few names where naive splitting looks wrong.
  const SPECIAL: Record<string, string> = {
    '302ai': '302.ai',
    aistudio: 'Google AI Studio',
    huggingface: 'HuggingFace',
    ollamacloud: 'Ollama Cloud',
    opencodezen: 'OpenCode Zen',
    opencodego: 'OpenCode Go',
    blackforestlabs: 'Black Forest Labs',
    klingai: 'Kling AI',
    novitaai: 'Novita AI',
    novita: 'Novita AI',
    'novita-ai': 'Novita AI',
    togetherai: 'Together AI',
    together: 'Together AI',
    zai: 'ZAI',
    xai: 'xAI',
    groq: 'Groq',
    'codex-auth': 'Codex Auth',
    kimicode: 'Kimi Code',
    moonshot: 'Moonshot AI',
    mixedbread: 'Mixedbread',
    mem0: 'Mem0',
    letta: 'Letta',
    prodia: 'Prodia',
    gladia: 'Gladia',
    lmnt: 'LMNT',
    fal: 'Fal',
    luma: 'Luma',
    poe: 'Poe',
    moark: 'Moark',
    wandb: 'Weights & Biases',
    submodel: 'SubModel',
    synthetic: 'Synthetic',
    inference: 'Inference.net',
    requesty: 'Requesty',
    vultr: 'Vultr',
    abacus: 'Abacus',
    llama: 'Meta Llama',
    friendli: 'Friendli',
    voyageai: 'Voyage AI',
    perplexity: 'Perplexity',
    elevenlabs: 'ElevenLabs',
    assemblyai: 'AssemblyAI',
    deepgram: 'Deepgram',
    nvidia: 'NVIDIA NIM',
    upstage: 'Upstage',
    siliconflow: 'SiliconFlow',
    stepfun: 'StepFun',
    modelscope: 'ModelScope',
    qwen: 'Qwen',
    hyperbolic: 'Hyperbolic',
    deepinfra: 'DeepInfra',
    ionet: 'IO.net',
    fireworks: 'Fireworks AI',
    cerebras: 'Cerebras',
    cortecs: 'Cortecs',
    minimax: 'MiniMax',
    nebius: 'Nebius',
    scaleway: 'Scaleway',
    ovhcloud: 'OVHcloud',
    stackit: 'STACKIT',
    venice: 'Venice AI',
    zenmux: 'ZenMux',
    baseten: 'Baseten',
    helicone: 'Helicone',
    portkey: 'Portkey',
    modal: 'Modal',
    replicate: 'Replicate',
    cloudflare: 'Cloudflare',
    vercel: 'Vercel',
    mistral: 'Mistral AI',
    cohere: 'Cohere',
    // Well-known providers that need proper capitalization.
    anthropic: 'Anthropic',
    openai: 'OpenAI',
    openrouter: 'OpenRouter',
    google: 'Google',
    copilot: 'GitHub Copilot',
    azure: 'Azure OpenAI',
    bedrock: 'AWS Bedrock',
    vertexai: 'Vertex AI',
    local: 'Local (custom endpoint)',
    ollama: 'Ollama',
    lmstudio: 'LM Studio',
    llamacpp: 'Llama.cpp',
    deepseek: 'DeepSeek',
    claude: 'Claude Code',
    jules: 'Google Jules',
    azurecognitive: 'Azure Cognitive',
    sapai: 'SAP AI',
    gitlab: 'GitLab',
  };
  if (SPECIAL[name]) return SPECIAL[name];

  // Generic: split on hyphens and camelCase boundaries, title-case each part.
  const parts = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[-_]/)
    .map((part) => {
      if (part.length <= 3) return part.toUpperCase();
      return part.charAt(0).toUpperCase() + part.slice(1);
    });
  return parts.join(' ');
}

const CIRCUIT_THRESHOLD = 5;
const CIRCUIT_TIMEOUT = 60_000; // 1 minute

// ─── Provider factory registry ──────────────────────────────────────────────
// Each built-in provider registers a factory here instead of being dispatched
// from a central `switch (name)`. Adding a provider is now a single entry in
// this map, not an edit to a switch in createProvider() AND a second switch in
// the auth route. A factory returns null when the config lacks what the
// provider needs (e.g. no API key / base URL), matching the prior switch's
// per-case null returns.
type ProviderFactory = (config: ProviderConfig) => Provider | null;

const PROVIDER_FACTORIES: Partial<Record<ProviderName, ProviderFactory>> = {
  anthropic: (c) => new AnthropicProvider(c),
  // Claude Code subscription — runs the official `claude` CLI harness (no direct API calls).
  claude: (c) => new ClaudeCodeProvider(c),
  openai: (c) => new OpenAIProvider(c),
  // Direct Google Gemini API only. It never consumes CLI OAuth, ADC, or any
  // other Google provider's credentials.
  google: (c) => (c.apiKey ? new GoogleProvider(c) : null),
  // Google AI Studio — Gemini API key only (no gcloud OAuth).
  aistudio: (c) => (c.apiKey ? new GoogleProvider({ ...c, name: 'aistudio' }) : null),
  copilot: (c) => new CopilotProvider(c),
  codex: (c) => new CodexCliProvider(c),
  'codex-auth': (c) => new CodexAuthProvider(c),
  // Grok Build subscription — runs the official `grok` CLI harness (no direct API calls).
  grok: (c) => new GrokBuildProvider(c),
  // Antigravity subscription — runs the official `agy` CLI harness (no direct API calls).
  antigravity: (c) => new AntigravityProvider(c),
  // Cursor subscription — runs the official `cursor-agent` CLI harness (no API key).
  cursor: (c) => new CursorProvider(c),
  // Devin subscription — runs Cognition's official `devin` CLI harness (no API key).
  devin: (c) => new DevinProvider(c),
  cline: (c) => new ClineProvider(c),
  // Freebuff — free, ad-supported Codebuff build. Uses @codebuff/sdk's
  // CodebuffClient (no subprocess, no TUI, no ads). Reads credentials from
  // ~/.config/manicode/credentials.json.
  freebuff: (c) => new FreebuffProvider(c),
  // Google Jules — cloud async agent (REST API only, remote VMs + GitHub PRs).
  jules: (c) => (c.disabled || !c.apiKey ? null : new JulesProvider(c)),
  kimicode: (c) => new KimiCodeProvider(c),
  openrouter: (c) => new OpenRouterProvider(c),
  // OpenCode Go is dual-protocol — OpenCodeGoProvider dispatches per-model.
  opencodego: (c) => new OpenCodeGoProvider(c),
  groq: (c) => new GroqProvider(c),
  xai: (c) => new XAIProvider(c),
  azure: (c) => new AzureProvider(c),
  // Azure Cognitive Services uses the same Azure OpenAI wire contract (api-key
  // header + /openai/deployments/{deployment}?api-version), just a different host.
  azurecognitive: (c) => (c.baseUrl ? new AzureProvider(c, 'azurecognitive') : null),
  // Claude on Amazon Bedrock — SigV4-signed via the official AnthropicBedrock client.
  bedrock: (c) => new BedrockProvider(c),
  // GitLab Duo Chat — POST /api/v4/chat/completions ({content} body, Bearer PAT).
  gitlab: (c) => (c.apiKey || c.authToken ? new GitLabProvider(c) : null),
  // SAP AI Core — OAuth (service key) + /v2/inference/deployments/{id} + AI-Resource-Group.
  sapai: (c) => (c.apiKey || c.authToken ? new SapAiProvider(c) : null),
  // Requires explicit API key — never auto-enable from GCP environment variables.
  vertexai: (c) => (c.disabled || !c.apiKey ? null : new GoogleProvider({ ...c, name: 'vertexai' })),
  local: (c) => openaiCompatLocal('local', c),
  ollama: (c) => openaiCompatLocal('ollama', c),
  llamacpp: (c) => openaiCompatLocal('llamacpp', c),
  lmstudio: (c) => openaiCompatLocal('lmstudio', c),
};

/** Shared factory for the OpenAI-compatible local providers (local/ollama/llamacpp/lmstudio). */
function openaiCompatLocal(name: ProviderName, config: ProviderConfig): Provider | null {
  const defaultBase =
    name === 'llamacpp' ? LLAMACPP_DEFAULT : name === 'lmstudio' ? LMSTUDIO_DEFAULT : undefined;
  if (config.baseUrl || defaultBase) {
    return new OpenAIProvider(config, name, config.baseUrl ?? defaultBase);
  }
  return null;
}

class ProviderRegistry {
  private providers = new Map<ProviderName, Provider>();
  private providerConfigs = new Map<ProviderName, ProviderConfig>();
  private circuitStates = new Map<ProviderName, CircuitState>();
  /** IDs of user-defined custom providers (e.g. "custom:my-llm"). */
  private customProviderIds = new Set<ProviderName>();
  /** Capability-based model selection — replaces blind first-match fallback. */
  private capabilityRegistry: CapabilityRegistry | undefined;

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
          .find((m) => m.id === modelId || m.apiModelId === modelId || m.realModelId === modelId);
      } catch (err: unknown) {
        serverLog.debug({ err: err instanceof Error ? err.message : String(err) }, 'Failed to resolve live model definition');
        return undefined;
      }
    });
    // Initialize capability-based model selection (lazy import to avoid
    // circular dependency — CapabilityRegistry imports from this file).
    this.capabilityRegistry = new CapabilityRegistry(this);
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
  getStatus(options: { refreshModels?: boolean } = {}): Array<{
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
    deployment?: 'cloud' | 'api' | 'local' | 'hybrid';
    description?: string;
    credentialUrl?: string;
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
    deployment?: 'cloud' | 'api' | 'local' | 'hybrid';
      description?: string;
      credentialUrl?: string;
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
        if (provider) {
          if (options.refreshModels) {
            provider.refreshModels?.(true);
          }
          allModels = provider.listModels();
        }
      }

      const selectedModels = config?.selectedModels ?? [];
      const hideModelSelector = config?.hideModelSelector ?? false;
      const modelDiscoveryError =
        provider?.getModelDiscoveryError?.() ??
        (isEnabled && isProviderAvailable && !hideModelSelector && allModels.length === 0
          ? 'No models were reported by this connected provider. Refresh discovery or check its account and CLI/API authentication.'
          : undefined);

      const enabledModels =
        selectedModels.length > 0
          ? allModels.filter((model) => selectedModels.includes(model.id)).map((model) => model.id)
          : allModels.map((model) => model.id);

      const requiresBaseUrl =
        isCustom ||
        authMode === 'base_url_only' ||
        name === 'cloudflare' ||
        name === 'modal' ||
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
      const inferredDeployment = inferProviderDeployment(name, authMode, isCustom, display?.deployment);

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
        ...(modelDiscoveryError && { error: modelDiscoveryError }),
        ...(isCustom && { custom: true, label: config?.label ?? String(name) }),
        ...(display?.label && !isCustom && { label: display.label }),
        // Auto-generate a human-readable label for providers without a display entry.
        ...(!display?.label && !isCustom && !String(name).startsWith('remote-') && {
          label: generateProviderLabel(String(name)),
        }),
        ...(display?.iconPath && { iconPath: display.iconPath }),
        deployment: inferredDeployment,
        ...(display?.description && { description: display.description }),
        ...(display?.credentialUrl && { credentialUrl: display.credentialUrl }),
        ...(baseUrlPlaceholder && { baseUrlPlaceholder }),
        // Remote providers (served by another machine) carry an agentic flag so
        // the composer can confirm the "your files go to the host" CLI flow.
        ...(String(name).startsWith('remote-') && {
          remote: true,
          remoteAgentic: (provider as { agentic?: boolean } | undefined)?.agentic === true,
          label: config?.label ?? String(name),
        }),
      });
    }

    return result;
  }

  /** Refresh model catalogs for enabled providers that expose a refresh hook. */
  async refreshModelCatalogs(): Promise<void> {
    const refreshes: Promise<unknown>[] = [];
    const names = this.getVisibleProviderNames();

    for (const name of names) {
      const provider = this.providers.get(name);
      const config = this.providerConfigs.get(name);
      const isEnabled = config ? !config.disabled : false;
      if (!provider || !isEnabled) continue;

      try {
        const result = provider.refreshModels?.(true);
        if (result && typeof (result as Promise<unknown>).then === 'function') {
          refreshes.push(result);
        }
      } catch (err: unknown) {
        serverLog.debug({ err: err instanceof Error ? err.message : String(err) }, 'Provider model refresh failed (non-fatal)');
        // Refresh failures are non-fatal here; provider status can still render
        // with cached/fallback models and users can retry manually from settings.
      }
    }

    if (refreshes.length > 0) {
      await Promise.allSettled(refreshes);
    }
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

  /** Register a REMOTE provider (inference served by another machine's host).
   *  Appears in the picker like any provider; the manager runs tools locally. */
  registerRemoteProvider(provider: Provider): void {
    const id = provider.name;
    this.providerConfigs.set(id, provider.config);
    this.customProviderIds.add(id);
    this.providers.set(id, provider);
    this.circuitStates.delete(id);
    providerLog.info({ provider: id }, 'Remote provider registered');
  }

  /** Remove every registered remote provider (id prefix `remote-`). */
  clearRemoteProviders(): void {
    for (const id of [...this.customProviderIds]) {
      if (String(id).startsWith('remote-')) this.removeCustomProvider(id);
    }
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

  /** Return the best available model for "auto" fallback, using
   *  capability-based scoring instead of blind first-match. Falls back to
   *  the original first-match behavior if the capability registry returns
   *  nothing (e.g. all providers have open circuit breakers). */
  getFirstAvailableRouting(): { model: string; provider: ProviderName } | undefined {
    // Try capability-based selection first — picks the best model by tier,
    // context window, and capabilities rather than insertion order.
    const capability = this.capabilityRegistry?.findBestModel({
      preferredTier: 'flagship',
    });
    if (capability) return capability;
    // Fallback: original blind first-match for edge cases where the
    // capability registry has no candidates (e.g. all legacy models).
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
        let usageAccountId: string | undefined;
        const stream = provider.streamResponse({ ...request, model: currentModel });

        for await (const event of stream) {
          if (this.isContentEvent(event)) hasContent = true;
          if (event.type === 'usage_update') {
            if (typeof event.tokensIn === 'number') accTokensIn = event.tokensIn;
            if (typeof event.tokensOut === 'number') accTokensOut = event.tokensOut;
            if (event.accountId) usageAccountId = event.accountId;
          }
          yield event;
        }

        if (hasContent) {
          if (accTokensIn > 0 || accTokensOut > 0) {
            creditRecordUsage(currentModel, provider.name, accTokensIn, accTokensOut, {
              accountId: usageAccountId,
              sessionId: request.sessionId,
            });
          }
          this.recordSuccess(provider.name);
          return;
        }

        providerLog.warn(
          { model: currentModel, provider: provider.name },
          'Empty response, trying fallback',
        );
        this.recordFailure(provider.name);
      } catch (err: unknown) {
        providerLog.error(
          { model: currentModel, provider: provider.name, error: err instanceof Error ? err.message : String(err) },
          'Provider error',
        );
        this.recordFailure(provider.name);

        if (i === chain.length - 1) {
          yield { type: 'error', error: (err instanceof Error ? err.message : String(err)) || 'Unknown error' };
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
          if (!whichBinary('claude')) {
            return { success: false, error: 'Claude Code CLI (claude) was not found on PATH. Install it, then reconnect.' };
          }
          if (detectClaudeCodeLogin()) return { success: true };
          return {
            success: false,
            error:
              'Claude Code is not logged in. Run "claude login" in your terminal to connect your Claude subscription.',
          };
        }
        case 'grok': {
          if (!whichBinary('grok')) {
            return { success: false, error: 'Grok Build CLI (grok) was not found on PATH. Install it, then reconnect.' };
          }
          if (detectGrokCLILogin()) return { success: true };
          return {
            success: false,
            error: 'Grok Build CLI is not logged in. Install the grok CLI and run "grok login".',
          };
        }
        case 'antigravity': {
          if (!whichBinary('agy')) {
            return { success: false, error: 'Antigravity CLI (agy) was not found on PATH. Install it, then reconnect.' };
          }
          if (detectAntigravityCLILogin()) return { success: true };
          return {
            success: false,
            error: 'Antigravity CLI is not logged in. Install agy and run "agy login".',
          };
        }
        case 'cursor': {
          // Subscription CLI harness — no API key; the logged-in cursor-agent
          // binary authenticates itself.
          if (!whichBinary('cursor-agent')) {
            return { success: false, error: 'Cursor CLI (cursor-agent) was not found on PATH. Install it, then reconnect.' };
          }
          if (detectCursorCLILogin()) return { success: true };
          return {
            success: false,
            error:
              'Cursor CLI is not logged in. Install cursor-agent and run "cursor-agent login".',
          };
        }
        case 'devin': {
          if (!whichBinary('devin')) {
            return { success: false, error: 'Devin CLI (devin) was not found on PATH. Install it, then reconnect.' };
          }
          if (detectDevinCLILogin()) return { success: true };
          return {
            success: false,
            error: 'Devin CLI is not logged in. Install devin and run "devin auth login".',
          };
        }
        case 'cline': {
          if (!whichBinary('cline')) {
            return {
              success: false,
              error: 'Cline CLI was not found on PATH. Install the Cline CLI, then reconnect.',
            };
          }
          if (detectClineCLILogin()) return { success: true };
          return {
            success: false,
            error:
              'Cline CLI is not signed in. Install cline and run "cline auth --provider <p> --apikey <k>".',
          };
        }
        case 'freebuff': {
          // Freebuff is verified by confirming the on-disk credentials file
          // at ~/.config/manicode/credentials.json has a valid authToken.
          // The CLI binary is optional — Koryphaios calls the Codebuff
          // backend via @codebuff/sdk, not via subprocess.
          if (detectFreebuffCLILogin() || readFreebuffAuthToken()) {
            return { success: true };
          }
          return {
            success: false,
            error:
              'Freebuff CLI is not logged in. Run "freebuff login" in your terminal, then reconnect.',
          };
        }
        case 'kimicode': {
          // Kimi Code is verified by confirming the auth token resolves to a
          // live access token — either the managed device-flow session at
          // KORY_KIMI_HOME, a discovered ~/.kimi* CLI profile, or a raw token.
          const token = await resolveKimiCodeAccessToken(authToken);
          if (token) return { success: true };
          return {
            success: false,
            error:
              'Kimi Code is not signed in. Run "kimi login" in your terminal, or sign in from Settings.',
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
        case 'codex-auth': {
          try {
            // This runs while connecting, before the provider instance exists.
            // The official app-server is the OAuth authority, so query it directly.
            const account = await getManagedCodexAppServer().account(true);
            return account.account?.type === 'chatgpt'
              ? { success: true }
              : { success: false, error: 'OpenAI Codex is not signed in with ChatGPT' };
          } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : 'Could not verify OpenAI Codex' };
          }
        }
        case 'google':
        case 'aistudio': {
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
              } catch (err: unknown) {
                serverLog.debug({ err: err instanceof Error ? err.message : String(err) }, 'Failed to persist Gemini v1 endpoint override (DB not initialized)');
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
          if (!whichBinary('codex')) {
            return { success: false, error: 'Codex CLI (codex) was not found on PATH. Install it, then reconnect.' };
          }
          if (detectCodexCLILogin() || discoverCliAccounts().some((account) => account.provider === 'codex')) return { success: true };
          return { success: false, error: 'Codex CLI is not signed in. Run "codex login" in your terminal, then reconnect.' };
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
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
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
      // CLI harnesses own their credentials. A reconnect must re-read the local
      // CLI state, never ask the user to paste a token Koryphaios does not own.
      const localCliAuth = CLI_HARNESS_PROVIDERS.has(name) ? cliAutoEnableCreds(name) : null;
      const resolvedAuthToken = CLI_HARNESS_PROVIDERS.has(name)
        ? localCliAuth?.authToken
        : credentials.authToken?.trim() || existing?.authToken || undefined;
      const resolvedBaseUrl =
        credentials.baseUrl?.trim() || existing?.baseUrl || this.detectEnvUrl(name) || undefined;

      // Return the CLI's actionable local state rather than the generic
      // auth-only validation error when there is no existing session marker.
      if (CLI_HARNESS_PROVIDERS.has(name) && !resolvedAuthToken) {
        return this.verifyConnection(name);
      }

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

      // A CLI may have moved off PATH or been signed out since its marker was
      // saved. Always prove the actual CLI is usable on reconnect.
      if (connectionChanged || CLI_HARNESS_PROVIDERS.has(name)) {
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
        // The Codex app-server exposes its authenticated model catalog. Wait
        // for it on explicit connect so the picker never opens with a stale
        // hardcoded fallback list.
        if (provider instanceof CodexCliProvider || provider instanceof CodexAuthProvider) {
          await provider.refreshModels();
        }
        this.providers.set(name, provider);
        this.circuitStates.delete(name); // Reset circuit breaker
        this.clearKeyInvalid(name); // New key may be valid
        providerLog.info({ provider: name }, 'Provider configured');
        return { success: true };
      }
      return { success: false, error: 'Failed to initialize provider' };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
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
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
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
   * logged in on this machine (Claude Code, Codex, Grok Build) — so they
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
    // (Claude Code, Codex, Grok Build). Opt out with KORY_DISABLE_CLI_AUTODETECT=1.
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
      // The canonical registry URL must reach the runtime config. Previously
      // only providers duplicated in OPENCODE_DEFAULT_BASE_URL received their
      // endpoint, leaving valid entries visible in Settings but impossible to
      // instantiate after a key was entered.
      baseUrl:
        userConfig?.baseUrl ??
        this.detectEnvUrl(name) ??
        PROVIDER_CONFIG_MAP.get(name)?.baseUrl ??
        undefined,
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
    // Built-in providers with an explicit factory.
    const factory = PROVIDER_FACTORIES[name];
    if (factory) return factory(config);

    // Unmapped names that still have a known OpenAI-compatible default base URL
    // (302ai, deepseek, mistral, cohere, perplexity, novita, …) get a generic
    // OpenAIProvider. This keeps BYO OpenAI-compatible endpoints working without
    // requiring a per-name factory entry.
    const defaultBase = OPENCODE_DEFAULT_BASE_URL[name];
    if ((defaultBase || config.baseUrl) && (config.apiKey || config.authToken)) {
      return new OpenAIProvider(config, name, config.baseUrl ?? defaultBase);
    }
    if (name === 'sapai' && config.apiKey && config.baseUrl) {
      return new OpenAIProvider(config, 'sapai', config.baseUrl);
    }
    return null;
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
          } catch (err: unknown) {
            serverLog.debug({ err: err instanceof Error ? err.message : String(err) }, 'Failed to decrypt stored API key');
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
          } catch (err: unknown) {
            serverLog.debug({ err: err instanceof Error ? err.message : String(err) }, 'Failed to decrypt stored auth token');
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
    } catch (err: unknown) {
      serverLog.debug({ err: err instanceof Error ? err.message : String(err) }, 'Failed to mark key invalid (DB not initialized)');
      // DB not initialized (e.g. tests)
    }
  }

  /** Clear invalid key state (e.g. after user updates key). */
  clearKeyInvalid(name: ProviderName): void {
    try {
      const { getDb } = require('../db');
      getDb().run('DELETE FROM provider_key_invalid WHERE provider = ?', name);
    } catch (err: unknown) {
      serverLog.debug({ err: err instanceof Error ? err.message : String(err) }, 'Failed to clear invalid key state (DB not initialized)');
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
    } catch (err: unknown) {
      serverLog.debug({ err: err instanceof Error ? err.message : String(err) }, 'Failed to check invalid key state, assuming not invalid');
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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
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
