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
  VERTEX_EXPRESS_VERIFY_URL,
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
import { FREEBUFF_UNAVAILABLE_ERROR, FreebuffProvider } from './freebuff';
import { AntigravityProvider } from './antigravity';
import { CursorProvider } from './cursor';
import { DevinProvider } from './devin';
import { ClineProvider } from './cline';
import { KiloCodeProvider } from './kilo-cli';
import { JulesProvider } from './jules';
import { JULES_APPROVAL_REQUIRED_ERROR } from './jules-runner';
import { BedrockProvider } from './bedrock';
import { GITLAB_DUO_UNAVAILABLE_ERROR, GitLabProvider } from './gitlab';
import { SapAiProvider, verifySapAiConnection } from './sapai';
import {
  GITHUB_MODELS_CATALOG_URL,
  GitHubModelsProvider,
  githubModelsHeaders,
  parseGitHubModelsCatalog,
} from './github-models';
import { CustomProvider } from './custom';
import {
  detectCodexCLILogin,
  detectClaudeCodeLogin,
  detectGrokCLILogin,
  detectAntigravityCLILogin,
  detectCursorCLILogin,
  detectDevinCLILogin,
  detectClineCLILogin,
} from './auth-utils';
import { cliAutoEnableCreds, probeCliVersion, whichBinary } from './cli-detection';
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
  LLAMACPP_DEFAULT,
  LMSTUDIO_DEFAULT,
  BASE_URL_PLACEHOLDERS,
  PROVIDER_AUTH_MODE,
  providerDefaultBaseUrl,
} from './constants';
import { safeProviderDiagnostic, safeProviderFailureMessage } from './provider-diagnostics';

function safeVerificationHttpError(
  status: number,
  label = 'Provider verification request',
): string {
  if (status === 401) return `${label} was not authenticated (HTTP 401).`;
  if (status === 403) return `${label} was denied by the provider (HTTP 403).`;
  if (status === 404) return `${label} endpoint was not found (HTTP 404).`;
  if (status === 408) return `${label} timed out (HTTP 408).`;
  if (status === 429) return `${label} was rate-limited (HTTP 429).`;
  return `${label} failed (HTTP ${status}).`;
}

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

// CLI harness providers that use a managed app-server instead of a CLI binary
// on PATH. They get the 'local' deployment but don't go through the standard
// cliAutoEnableCreds flow.
const MANAGED_CLI_PROVIDERS = new Set<ProviderName>(['codex-auth']);

const LOCAL_PROVIDER_KEYS = new Set<ProviderName>(['local', 'ollama', 'lmstudio', 'llamacpp']);

/** Built-ins whose APIs are not chat-completions contracts. */
export const UNSUPPORTED_CHAT_PROVIDER_NAMES = new Set<ProviderName>([
  'replicate',
  'modal',
  'luma',
  'fal',
  'elevenlabs',
  'deepgram',
  'gladia',
  'assemblyai',
  'lmnt',
  'voyageai',
  'mixedbread',
  'mem0',
  'letta',
  'blackforestlabs',
  'klingai',
  'prodia',
]);

function unsupportedChatReason(name: ProviderName): string | undefined {
  if (!UNSUPPORTED_CHAT_PROVIDER_NAMES.has(name)) return undefined;
  return `${generateProviderLabel(String(name))} is not available as a chat provider in this build. Its non-chat API requires a dedicated capability adapter; no generic chat fallback will be used.`;
}

function unavailableProviderReason(name: ProviderName): string | undefined {
  return (
    unsupportedChatReason(name) ??
    (name === 'gitlab' ? GITLAB_DUO_UNAVAILABLE_ERROR : undefined) ??
    (name === 'freebuff' ? FREEBUFF_UNAVAILABLE_ERROR : undefined) ??
    (name === 'jules' ? JULES_APPROVAL_REQUIRED_ERROR : undefined)
  );
}

function inferProviderDeployment(
  name: ProviderName,
  authMode: ProviderAuthMode,
  isCustom: boolean,
  hasDisplayDeployment?: ProviderDeployment,
): ProviderDeployment {
  if (hasDisplayDeployment) return hasDisplayDeployment;
  if (
    LOCAL_PROVIDER_KEYS.has(name) ||
    CLI_HARNESS_PROVIDERS.has(name) ||
    MANAGED_CLI_PROVIDERS.has(name)
  )
    return 'local';
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

type ProviderConnectionState = 'verified' | 'detected' | 'unknown' | 'failed';
type ProviderVerificationScope = 'credential' | 'account' | 'endpoint' | 'catalog' | 'runtime';

type ProviderVerificationResult = {
  /** The configuration/probe was accepted. This is not itself a verification verdict. */
  success: boolean;
  /** Omitted successful results are fully verified for backwards compatibility. */
  state?: ProviderConnectionState;
  error?: string;
};

interface ProviderVerificationRecord {
  state: ProviderConnectionState;
  checkedAt: number;
  scope: ProviderVerificationScope;
  error?: string;
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
  // Visible for explicit recovery messaging; execution fails closed.
  freebuff: (c) => new FreebuffProvider(c),
  // Kilo Code AI Gateway — OpenAI-compatible, API key auth.
  kilocode: (c) => new KiloCodeProvider(c),
  // Visible as approval-required; this adapter cannot mutate remote state.
  jules: (c) => new JulesProvider(c),
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
  // GitHub Models has a distinct catalog host; its dedicated adapter keeps
  // discovery separate from the OpenAI-compatible inference surface.
  'github-models': (c) => new GitHubModelsProvider(c),
  // Retained for explicit unavailable reporting; the provider itself never contacts GitLab.
  gitlab: (c) => (c.apiKey || c.authToken ? new GitLabProvider(c) : null),
  // SAP AI Core — OAuth (service key) + /v2/inference/deployments/{id} + AI-Resource-Group.
  sapai: (c) => (c.apiKey || c.authToken ? new SapAiProvider(c) : null),
  // Requires explicit API key — never auto-enable from GCP environment variables.
  vertexai: (c) =>
    c.disabled || !c.apiKey ? null : new GoogleProvider({ ...c, name: 'vertexai' }),
  local: (c) => openaiCompatLocal('local', c),
  ollama: (c) => openaiCompatLocal('ollama', c),
  llamacpp: (c) => openaiCompatLocal('llamacpp', c),
  lmstudio: (c) => openaiCompatLocal('lmstudio', c),
};

/** Shared factory for the OpenAI-compatible local providers (local/ollama/llamacpp/lmstudio). */
function openaiCompatLocal(name: ProviderName, config: ProviderConfig): Provider | null {
  const defaultBase =
    name === 'llamacpp' ? LLAMACPP_DEFAULT : name === 'lmstudio' ? LMSTUDIO_DEFAULT : undefined;
  const configuredBase = config.baseUrl ?? defaultBase;
  if (configuredBase) {
    // Ollama, LM Studio, and llama.cpp expose OpenAI-compatible inference at
    // /v1 even when their native discovery/health endpoint lives at the host
    // root. Keep those control-plane URLs separate from the chat base.
    const inferenceBase =
      name === 'ollama' || name === 'lmstudio' || name === 'llamacpp'
        ? `${configuredBase.replace(/\/v1\/?$/, '').replace(/\/+$/, '')}/v1`
        : configuredBase;
    return new OpenAICompatibleLocalProvider(config, name, inferenceBase);
  }
  return null;
}

/** Local OpenAI-compatible servers are endpoint-authenticated, not API-key-authenticated. */
class OpenAICompatibleLocalProvider extends OpenAIProvider {
  override isAvailable(): boolean {
    return !this.config.disabled && !!this.config.baseUrl?.trim();
  }
}

class ProviderRegistry {
  private providers = new Map<ProviderName, Provider>();
  private providerConfigs = new Map<ProviderName, ProviderConfig>();
  private circuitStates = new Map<ProviderName, CircuitState>();
  /** Process-local probe verdicts. Credential/file presence is tracked separately. */
  private verificationRecords = new Map<ProviderName, ProviderVerificationRecord>();
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
        serverLog.debug(
          { err: err instanceof Error ? err.message : String(err) },
          'Failed to resolve live model definition',
        );
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

  /** Get adapters with enough local configuration to attempt work. */
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

  private hasDetectedConnectionMaterial(
    name: ProviderName,
    config: ProviderConfig | undefined,
    providerAvailable: boolean,
  ): boolean {
    if (providerAvailable) return true;
    if (!config || config.disabled) return false;
    if (config.custom) return !!config.baseUrl?.trim();
    const authMode = this.authModeFor(name);
    if (authMode === 'env_auth') return this.hasBedrockEnvironment();
    if (authMode === 'base_url_only') return !!config.baseUrl?.trim();
    if (authMode === 'auth_only') return !!config.authToken?.trim();
    if (authMode === 'api_key_or_auth') {
      return !!(config.apiKey?.trim() || config.authToken?.trim());
    }
    return !!config.apiKey?.trim();
  }

  private verificationScopeFor(name: ProviderName): ProviderVerificationScope {
    if (CLI_HARNESS_PROVIDERS.has(name) || MANAGED_CLI_PROVIDERS.has(name)) return 'account';
    if (LOCAL_PROVIDER_KEYS.has(name) || String(name).startsWith('custom:')) return 'endpoint';
    if (
      name === 'sapai' ||
      name === 'bedrock' ||
      name === 'github-models' ||
      name === 'azure' ||
      name === 'azurecognitive'
    )
      return 'catalog';
    return 'credential';
  }

  /** Get explicit detection, verification, availability, and model status for every provider. */
  getStatus(options: { refreshModels?: boolean } = {}): Array<{
    name: ProviderName;
    enabled: boolean;
    authenticated: boolean;
    adapterAvailable: boolean;
    credentialDetected: boolean;
    connectionState:
      'not_configured' | 'detected' | 'verified' | 'failed' | 'unknown' | 'unavailable';
    verifiedAt?: number;
    verificationScope?: ProviderVerificationScope;
    verificationError?: string;
    models: string[];
    allAvailableModels: ReturnType<Provider['listModels']>;
    selectedModels: string[];
    hideModelSelector: boolean;
    authMode: ProviderAuthMode;
    supportsApiKey: boolean;
    supportsAuthToken: boolean;
    requiresBaseUrl: boolean;
    requiresDeployment?: boolean;
    deploymentName?: string;
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
      adapterAvailable: boolean;
      credentialDetected: boolean;
      connectionState:
        'not_configured' | 'detected' | 'verified' | 'failed' | 'unknown' | 'unavailable';
      verifiedAt?: number;
      verificationScope?: ProviderVerificationScope;
      verificationError?: string;
      models: string[];
      allAvailableModels: ReturnType<Provider['listModels']>;
      selectedModels: string[];
      hideModelSelector: boolean;
      authMode: ProviderAuthMode;
      supportsApiKey: boolean;
      supportsAuthToken: boolean;
      requiresBaseUrl: boolean;
      requiresDeployment?: boolean;
      deploymentName?: string;
      configurationBlocked?: boolean;
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
      const credentialDetected = this.hasDetectedConnectionMaterial(
        name,
        config,
        isProviderAvailable,
      );
      const verification = this.verificationRecords.get(name);
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
      const providerUnavailableReason = unavailableProviderReason(name);
      const modelDiscoveryError =
        providerUnavailableReason ??
        provider?.getModelDiscoveryError?.() ??
        (isEnabled && isProviderAvailable && !hideModelSelector && allModels.length === 0
          ? 'No models were reported by this configured provider. Refresh discovery or check its account and CLI/API authentication.'
          : undefined);

      const enabledModels =
        selectedModels.length > 0
          ? allModels.filter((model) => selectedModels.includes(model.id)).map((model) => model.id)
          : allModels.map((model) => model.id);

      const blocksChatConfiguration = !!providerUnavailableReason;
      const connectionState = blocksChatConfiguration
        ? ('unavailable' as const)
        : verification?.state === 'verified' && isProviderAvailable
          ? ('verified' as const)
          : verification?.state === 'failed'
            ? ('failed' as const)
            : verification?.state === 'unknown'
              ? ('unknown' as const)
              : verification?.state === 'detected'
                ? ('detected' as const)
                : credentialDetected
                  ? ('detected' as const)
                  : isEnabled
                    ? ('unknown' as const)
                    : ('not_configured' as const);
      const requiresDeployment = name === 'azure' || name === 'azurecognitive' || name === 'sapai';
      const requiresBaseUrl =
        !blocksChatConfiguration &&
        (isCustom ||
          authMode === 'base_url_only' ||
          name === 'cloudflare' ||
          name === 'modal' ||
          name === 'azure' ||
          name === 'azurecognitive' ||
          name === 'sapai' ||
          name === 'zai');
      const baseUrlPlaceholder: string | undefined = requiresBaseUrl
        ? (BASE_URL_PLACEHOLDERS[name] ??
          providerDefaultBaseUrl(name) ??
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
      const inferredDeployment = inferProviderDeployment(
        name,
        authMode,
        isCustom,
        display?.deployment,
      );

      result.push({
        name,
        enabled: isEnabled,
        // Keep the compatibility field truthful: detection and adapter
        // construction alone do not establish authenticated provider access.
        authenticated: connectionState === 'verified',
        adapterAvailable: isProviderAvailable,
        credentialDetected,
        connectionState,
        ...(verification &&
          (verification.state === 'verified' || verification.state === 'detected') && {
            verificationScope: verification.scope,
          }),
        ...(verification?.state === 'verified' && { verifiedAt: verification.checkedAt }),
        ...(verification?.error && { verificationError: verification.error }),
        models: enabledModels,
        allAvailableModels: allModels,
        selectedModels,
        hideModelSelector,
        authMode,
        supportsApiKey:
          !blocksChatConfiguration &&
          (isCustom || authMode === 'api_key' || authMode === 'api_key_or_auth'),
        supportsAuthToken:
          !blocksChatConfiguration && (authMode === 'auth_only' || authMode === 'api_key_or_auth'),
        requiresBaseUrl,
        ...(requiresDeployment && { requiresDeployment: true }),
        ...(config?.deployment && { deploymentName: config.deployment }),
        ...(blocksChatConfiguration && { configurationBlocked: true }),
        circuitOpen,
        ...(modelDiscoveryError && { error: modelDiscoveryError }),
        ...(isCustom && { custom: true, label: config?.label ?? String(name) }),
        ...(display?.label && !isCustom && { label: display.label }),
        // Auto-generate a human-readable label for providers without a display entry.
        ...(!display?.label &&
          !isCustom &&
          !String(name).startsWith('remote-') && {
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
        serverLog.debug(
          { err: err instanceof Error ? err.message : String(err) },
          'Provider model refresh failed (non-fatal)',
        );
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
    this.verificationRecords.delete(id);
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
          // A successful provider turn is the strongest account proof we have.
          // Local files, env vars, and CLI presence remain "detected" until the
          // provider actually accepts a request; after that, Billing and
          // Settings may truthfully show the connection as active.
          this.verificationRecords.set(provider.name, {
            state: 'verified',
            checkedAt: Date.now(),
            scope: this.verificationScopeFor(provider.name),
          });
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
        const diagnostic = safeProviderDiagnostic(provider.name, 'stream', err);
        providerLog.error({ ...diagnostic, model: currentModel }, 'Provider error');
        this.recordFailure(provider.name);

        if (i === chain.length - 1) {
          yield {
            type: 'error',
            error: safeProviderFailureMessage(provider.name, diagnostic),
          };
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

  /**
   * Validate provider credentials and retain a process-local verdict. The
   * record is updated only when probing the active config (or immediately
   * after setCredentials installs a newly verified config), so a rejected
   * replacement key cannot poison the last working provider's state.
   */
  async verifyConnection(
    name: ProviderName,
    credentials?: { apiKey?: string; authToken?: string; baseUrl?: string; deployment?: string },
  ): Promise<ProviderVerificationResult> {
    const existing = this.providerConfigs.get(name);
    const probesActiveConfig =
      credentials == null ||
      ((credentials.apiKey ?? undefined) === (existing?.apiKey ?? undefined) &&
        (credentials.authToken ?? undefined) === (existing?.authToken ?? undefined) &&
        (credentials.baseUrl ?? undefined) === (existing?.baseUrl ?? undefined) &&
        (credentials.deployment ?? undefined) === (existing?.deployment ?? undefined));
    const result = await this.verifyConnectionInternal(name, credentials);
    if (probesActiveConfig) {
      this.verificationRecords.set(name, {
        state: result.state ?? (result.success ? 'verified' : 'failed'),
        checkedAt: Date.now(),
        scope: this.verificationScopeFor(name),
        ...(result.error && { error: result.error }),
      });
    }
    return result;
  }

  private async verifyConnectionInternal(
    name: ProviderName,
    credentials?: { apiKey?: string; authToken?: string; baseUrl?: string; deployment?: string },
  ): Promise<ProviderVerificationResult> {
    const unavailableReason = unavailableProviderReason(name);
    if (unavailableReason) return { success: false, error: unavailableReason };

    const existing = this.providerConfigs.get(name);
    const apiKey = credentials?.apiKey ?? existing?.apiKey;
    const authToken = credentials?.authToken ?? existing?.authToken;
    const baseUrl = credentials?.baseUrl ?? existing?.baseUrl;
    const deployment = credentials?.deployment ?? existing?.deployment;
    const shouldMutateStoredState =
      credentials == null ||
      ((credentials.apiKey ?? undefined) === (existing?.apiKey ?? undefined) &&
        (credentials.authToken ?? undefined) === (existing?.authToken ?? undefined) &&
        (credentials.baseUrl ?? undefined) === (existing?.baseUrl ?? undefined) &&
        (credentials.deployment ?? undefined) === (existing?.deployment ?? undefined));

    try {
      switch (name) {
        case 'claude': {
          // Claude Code subscription is verified by confirming the official CLI is
          // logged in. We never validate a raw token against the API — the CLI owns
          // auth and runs every request, keeping us compliant with Anthropic's terms.
          const claudeBin = whichBinary('claude');
          if (!claudeBin) {
            return {
              success: false,
              error: 'Claude Code CLI (claude) was not found on PATH. Install it, then reconnect.',
            };
          }
          if (!detectClaudeCodeLogin()) {
            return {
              success: false,
              error:
                'No Claude Code login material was detected. Run "claude login" in your terminal, then check again.',
            };
          }
          if (!probeCliVersion(claudeBin, 'claude')) {
            return {
              success: true,
              state: 'detected',
              error:
                'Claude Code CLI was found on PATH with login material but did not respond to a version probe. The binary may be broken or its dependencies may be missing.',
            };
          }
          return { success: true, state: 'verified' };
        }
        case 'grok': {
          const grokBin = whichBinary('grok');
          if (!grokBin) {
            return {
              success: false,
              error: 'Grok Build CLI (grok) was not found on PATH. Install it, then reconnect.',
            };
          }
          if (!detectGrokCLILogin()) {
            return {
              success: false,
              error:
                'No Grok Build login material was detected. Install the grok CLI, run "grok login", then check again.',
            };
          }
          if (!probeCliVersion(grokBin, 'grok')) {
            return {
              success: true,
              state: 'detected',
              error:
                'Grok Build CLI was found on PATH with login material but did not respond to a version probe. The binary may be broken or its dependencies may be missing.',
            };
          }
          return { success: true, state: 'verified' };
        }
        case 'antigravity': {
          const agyBin = whichBinary('agy');
          if (!agyBin) {
            return {
              success: false,
              error: 'Antigravity CLI (agy) was not found on PATH. Install it, then reconnect.',
            };
          }
          if (!detectAntigravityCLILogin()) {
            return {
              success: false,
              error:
                'No Antigravity login material was detected. Install agy, run "agy login", then check again.',
            };
          }
          if (!probeCliVersion(agyBin, 'antigravity')) {
            return {
              success: true,
              state: 'detected',
              error:
                'Antigravity CLI was found on PATH with login material but did not respond to a version probe. The binary may be broken or its dependencies may be missing.',
            };
          }
          return { success: true, state: 'verified' };
        }
        case 'cursor': {
          // Subscription CLI harness — no API key; the logged-in cursor-agent
          // binary authenticates itself.
          const cursorBin = whichBinary('cursor-agent');
          if (!cursorBin) {
            return {
              success: false,
              error: 'Cursor CLI (cursor-agent) was not found on PATH. Install it, then reconnect.',
            };
          }
          if (!detectCursorCLILogin()) {
            return {
              success: false,
              error:
                'No Cursor login material was detected. Install cursor-agent, run "cursor-agent login", then check again.',
            };
          }
          if (!probeCliVersion(cursorBin, 'cursor')) {
            return {
              success: true,
              state: 'detected',
              error:
                'Cursor CLI was found on PATH with login material but did not respond to a version probe. The binary may be broken or its dependencies may be missing.',
            };
          }
          return { success: true, state: 'verified' };
        }
        case 'devin': {
          const devinBin = whichBinary('devin');
          if (!devinBin) {
            return {
              success: false,
              error: 'Devin CLI (devin) was not found on PATH. Install it, then reconnect.',
            };
          }
          if (!detectDevinCLILogin()) {
            return {
              success: false,
              error:
                'No Devin login material was detected. Install devin, run "devin auth login", then check again.',
            };
          }
          if (!probeCliVersion(devinBin, 'devin')) {
            return {
              success: true,
              state: 'detected',
              error:
                'Devin CLI was found on PATH with login material but did not respond to a version probe. The binary may be broken or its dependencies may be missing.',
            };
          }
          return { success: true, state: 'verified' };
        }
        case 'cline': {
          const clineBin = whichBinary('cline');
          if (!clineBin) {
            return {
              success: false,
              error: 'Cline CLI was not found on PATH. Install the Cline CLI, then reconnect.',
            };
          }
          if (!detectClineCLILogin()) {
            return {
              success: false,
              error:
                'No Cline credential material was detected. Install cline, configure it with "cline auth --provider <p> --apikey <k>", then check again.',
            };
          }
          if (!probeCliVersion(clineBin, 'cline')) {
            return {
              success: true,
              state: 'detected',
              error:
                'Cline CLI was found on PATH with login material but did not respond to a version probe. The binary may be broken or its dependencies may be missing.',
            };
          }
          return { success: true, state: 'verified' };
        }
        case 'anthropic': {
          if (!apiKey && !authToken)
            return { success: false, error: 'Missing apiKey or authToken' };
          const { headers } = buildAuthHeaders(name, { apiKey, authToken });
          const url =
            getVerifyUrl(name, undefined, { apiKey, authToken }) ||
            `${PROVIDER_BASE_URLS.anthropic}/models`;
          const res = await this.verifyModelCatalogWithStatus(
            url,
            { method: 'GET', headers },
            'openai',
          );
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
            return {
              success: false,
              error: error instanceof Error ? error.message : 'Could not verify OpenAI Codex',
            };
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
              return this.verifyModelCatalogWithStatus(path, { method: 'GET', headers }, 'gemini');
            }
            const urlWithKey = `${path}?key=${encodeURIComponent(apiKey!)}`;
            return this.verifyModelCatalogWithStatus(
              urlWithKey,
              {
                method: 'GET',
                headers: { 'Content-Type': 'application/json', 'User-Agent': 'Koryphaios/1.0' },
              },
              'gemini',
            );
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
                serverLog.debug(
                  { err: err instanceof Error ? err.message : String(err) },
                  'Failed to persist Gemini v1 endpoint override (DB not initialized)',
                );
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
          return this.verifyModelCatalog(
            'https://api.githubcopilot.com/models',
            {
              headers: {
                Authorization: `Bearer ${bearer}`,
                'Editor-Version': 'vscode/1.100.0',
                'Editor-Plugin-Version': 'copilot-chat/0.27.0',
                'Copilot-Integration-Id': 'vscode-chat',
                'User-Agent': 'Koryphaios/1.0',
              },
            },
            'openai',
          );
        }
        case 'openrouter':
          return this.verifyBearerGet('https://openrouter.ai/api/v1/models', apiKey);
        case 'github-models': {
          const token = apiKey || authToken;
          if (!token) return { success: false, error: 'Missing GitHub token' };
          return this.verifyGitHubModelsCatalog(token);
        }
        case 'kimicode': {
          const resolvedToken = await resolveKimiCodeAccessToken(authToken ?? apiKey ?? null);
          if (!resolvedToken) return { success: false, error: 'Missing authToken' };
          const base = baseUrl?.replace(/\/+$/, '') || 'https://api.kimi.com/coding/v1';
          return this.verifyModelCatalog(
            `${base}/models`,
            {
              method: 'GET',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${resolvedToken}`,
              },
            },
            'openai',
          );
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
          if (apiKey && authToken) {
            return {
              success: false,
              error:
                'Azure OpenAI accepts either an API key or a Microsoft Entra bearer token, not both. Disconnect the existing credential before switching auth modes.',
            };
          }
          if (!baseUrl) return { success: false, error: 'Missing baseUrl' };
          if (!deployment) {
            return {
              success: false,
              error:
                'Azure OpenAI requires the deployment name you created. A base model id is not a deployment.',
            };
          }
          const trimmed = baseUrl.replace(/\/+$/, '');
          const headers: Record<string, string> = {};
          if (apiKey) headers['api-key'] = apiKey;
          if (authToken) headers.Authorization = `Bearer ${authToken}`;
          const catalog = await this.verifyModelCatalog(
            `${trimmed}/openai/models?api-version=2024-10-21`,
            { headers },
            'openai',
          );
          // The data-plane model catalog can validate the resource credential,
          // but it cannot prove that the user-entered deployment exists. Keep
          // the adapter usable while reporting the deployment as detected,
          // never verified, until an actual inference succeeds.
          return catalog.success ? { success: true, state: 'detected' } : catalog;
        }
        case 'local': {
          if (!baseUrl) return { success: false, error: 'Missing baseUrl' };
          const trimmed = baseUrl.replace(/\/+$/, '');
          return this.verifyModelCatalog(`${trimmed}/models`, undefined, 'openai');
        }
        case 'ollama': {
          if (!baseUrl)
            return { success: false, error: 'Missing baseUrl (e.g. http://localhost:11434)' };
          const trimmed = baseUrl.replace(/\/+$/, '');
          return this.verifyModelCatalog(`${trimmed}/api/tags`, undefined, 'ollama');
        }
        case 'bedrock': {
          if (!this.hasBedrockEnvironment()) {
            return { success: false, error: 'AWS credential source not detected' };
          }
          const provider = new BedrockProvider({
            ...(existing ?? { name: 'bedrock' }),
            name: 'bedrock',
            disabled: false,
          } as ProviderConfig);
          return provider.verifyAccess();
        }
        case 'vertexai':
          if (!apiKey)
            return {
              success: false,
              error:
                'Vertex AI requires an explicit API key (set GOOGLE_VERTEX_AI_API_KEY or add apiKey in settings)',
            };
          return this.verifyVertexExpressKey(apiKey);
        case 'codex': {
          const codexBin = whichBinary('codex');
          if (!codexBin) {
            return {
              success: false,
              error: 'Codex CLI (codex) was not found on PATH. Install it, then reconnect.',
            };
          }
          if (
            !detectCodexCLILogin() &&
            !discoverCliAccounts().some((account) => account.provider === 'codex')
          ) {
            return {
              success: false,
              error:
                'No Codex CLI login material was detected. Run "codex login" in your terminal, then check again.',
            };
          }
          if (!probeCliVersion(codexBin, 'codex')) {
            return {
              success: true,
              state: 'detected',
              error:
                'Codex CLI was found on PATH with login material but did not respond to a version probe. The binary may be broken or its dependencies may be missing.',
            };
          }
          return { success: true, state: 'verified' };
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
          return this.verifyModelCatalog(
            `${url.replace(/\/v1\/?$/, '')}/v1/models`,
            undefined,
            'openai',
          );
        }
        case 'lmstudio': {
          const url = baseUrl ?? LMSTUDIO_DEFAULT;
          if (!url)
            return { success: false, error: 'Missing baseUrl (e.g. http://localhost:1234/v1)' };
          return this.verifyModelCatalog(
            `${url.replace(/\/v1\/?$/, '')}/v1/models`,
            undefined,
            'openai',
          );
        }
        case 'azurecognitive': {
          if (!apiKey) return { success: false, error: 'Missing API key' };
          if (!baseUrl)
            return {
              success: false,
              error: 'Missing baseUrl (e.g. https://YOUR_RESOURCE.cognitiveservices.azure.com)',
            };
          if (!deployment) {
            return {
              success: false,
              error:
                'Azure Cognitive requires the deployment name you created. A base model id is not a deployment.',
            };
          }
          const trimmed = baseUrl.replace(/\/+$/, '');
          const catalog = await this.verifyModelCatalog(
            `${trimmed}/openai/models?api-version=2024-10-21`,
            { headers: { 'api-key': apiKey } },
            'openai',
          );
          return catalog.success ? { success: true, state: 'detected' } : catalog;
        }
        case 'sapai': {
          if (!apiKey && !authToken) {
            return { success: false, error: 'Missing SAP service key JSON or bearer token' };
          }
          return verifySapAiConnection({
            ...(existing ?? { name: 'sapai' }),
            name: 'sapai',
            apiKey,
            authToken,
            baseUrl,
            deployment,
            disabled: false,
          } as ProviderConfig);
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
          const defaultBase = providerDefaultBaseUrl(name);
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
      return { success: false, error: 'Provider verification failed safely.' };
    }
  }

  /** Set/update provider credentials. */
  async setCredentials(
    name: ProviderName,
    credentials: {
      apiKey?: string;
      authToken?: string;
      baseUrl?: string;
      deployment?: string;
      selectedModels?: string[];
      hideModelSelector?: boolean;
    },
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const unavailableReason = unavailableProviderReason(name);
      if (unavailableReason) return { success: false, error: unavailableReason };

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
      const resolvedDeployment =
        credentials.deployment?.trim() || existing?.deployment || undefined;

      // Return the CLI's actionable local state rather than the generic
      // auth-only validation error when there is no existing session marker.
      if (CLI_HARNESS_PROVIDERS.has(name) && !resolvedAuthToken) {
        return this.verifyConnection(name);
      }

      const nextConnection = {
        apiKey: resolvedApiKey,
        authToken: resolvedAuthToken,
        baseUrl: resolvedBaseUrl,
        deployment: resolvedDeployment,
      };

      const validation = this.validateCredentials(name, nextConnection, existing);
      if (!validation.success) return validation;

      const connectionChanged =
        existing?.apiKey !== nextConnection.apiKey ||
        existing?.authToken !== nextConnection.authToken ||
        existing?.baseUrl !== nextConnection.baseUrl ||
        existing?.deployment !== nextConnection.deployment;
      let acceptedState: ProviderConnectionState =
        this.verificationRecords.get(name)?.state ?? 'unknown';

      // A CLI may have moved off PATH or lost its local login material since
      // its marker was saved. Re-evaluate that detection on every reconnect;
      // only a supported account probe may produce a verified state.
      if (
        connectionChanged ||
        CLI_HARNESS_PROVIDERS.has(name) ||
        this.verificationRecords.get(name)?.state !== 'verified'
      ) {
        const verification = await this.verifyConnection(name, nextConnection);
        if (!verification.success) return verification;
        acceptedState = verification.state ?? 'verified';
      }

      const providerConfig: ProviderConfig = {
        name,
        apiKey: resolvedApiKey,
        authToken: resolvedAuthToken,
        baseUrl: resolvedBaseUrl,
        deployment: resolvedDeployment,
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
        this.verificationRecords.set(name, {
          state: acceptedState,
          checkedAt: Date.now(),
          scope: this.verificationScopeFor(name),
        });
        providerLog.info({ provider: name }, 'Provider configured');
        return { success: true };
      }
      return { success: false, error: 'Failed to initialize provider' };
    } catch (err: unknown) {
      return { success: false, error: 'Provider configuration could not be initialized.' };
    }
  }

  private validateCredentials(
    name: ProviderName,
    credentials: {
      apiKey?: string;
      authToken?: string;
      baseUrl?: string;
      deployment?: string;
    },
    existing?: ProviderConfig,
  ): { success: boolean; error?: string } {
    const authMode = this.authModeFor(name);
    const apiKey = credentials.apiKey?.trim();
    const authToken = credentials.authToken?.trim();
    const baseUrl = credentials.baseUrl?.trim();
    const deployment = credentials.deployment?.trim() || existing?.deployment?.trim();

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

    if (name === 'azure' && apiKey && authToken) {
      return {
        success: false,
        error:
          'Azure OpenAI accepts either an API key or a Microsoft Entra bearer token, not both. Disconnect the existing credential before switching auth modes.',
      };
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

    if ((name === 'azure' || name === 'azurecognitive') && !deployment) {
      return {
        success: false,
        error: `${name} requires the explicit Azure deployment name; base model ids cannot be used as deployments`,
      };
    }

    if (name === 'sapai' && !deployment) {
      return {
        success: false,
        error: 'SAP AI Core requires an explicit running deployment ID',
      };
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
      return { success: false, error: 'Provider refresh could not be initialized.' };
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
    this.verificationRecords.delete(name);
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

      // A disabled provider is configuration metadata, not a runnable adapter.
      // Several CLI adapters discover accounts or launch model probes from their
      // constructor/listModels path, so constructing them here would bypass both
      // the user's Disconnect choice and KORY_DISABLE_CLI_AUTODETECT.
      if (providerConfig.disabled) continue;

      try {
        const provider = this.createProvider(name, providerConfig);
        if (provider) this.providers.set(name, provider);
      } catch (error) {
        providerLog.error(
          safeProviderDiagnostic(name, 'configuration', error),
          'Failed to initialize provider',
        );
      }
    }

    // Restore user-defined custom providers persisted in the config.
    for (const [id, pc] of Object.entries(this.config?.providers ?? {})) {
      if (!pc?.custom || PROVIDER_AUTH_MODE[id as ProviderName]) continue;
      this.customProviderIds.add(id as ProviderName);
      const providerConfig = this.buildProviderConfig(id as ProviderName);
      this.providerConfigs.set(id, providerConfig);
      if (providerConfig.disabled) continue;
      try {
        const provider = this.createProvider(id as ProviderName, providerConfig);
        if (provider) this.providers.set(id, provider);
      } catch (error) {
        providerLog.error(
          safeProviderDiagnostic(id, 'configuration', error),
          'Failed to initialize custom provider',
        );
      }
    }

    // Proactively warm only explicitly enabled adapters. Disabled adapters are
    // deliberately absent from this.providers, so startup cannot spawn a CLI or
    // contact an endpoint the user did not enable.
    for (const provider of this.providers.values()) {
      try {
        provider.listModels();
      } catch (error) {
        providerLog.debug(
          safeProviderDiagnostic(provider.name, 'configuration', error),
          'Startup model-list warm-up failed',
        );
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
    // An explicit Disconnect/disabled setting always wins over machine-level
    // discovery. Otherwise a still-installed CLI would silently reconnect on
    // the next launch.
    const autoCli = userConfig?.disabled === true ? null : cliAutoEnableCreds(name);
    const isDisabled = userConfig?.disabled ?? (autoCli ? false : defaultDisabled);

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
      // One canonical default reaches both runtime construction and the
      // synthetic request-shape suite. Explicit user/env URLs still win.
      baseUrl:
        userConfig?.baseUrl ?? this.detectEnvUrl(name) ?? providerDefaultBaseUrl(name) ?? undefined,
      deployment: userConfig?.deployment,
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
    // Non-chat APIs never inherit OpenAI-compatible chat by URL coincidence.
    if (UNSUPPORTED_CHAT_PROVIDER_NAMES.has(name)) return null;

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
    const defaultBase = providerDefaultBaseUrl(name);
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
      if (!config || config.disabled) continue;
      let apiKey = config.apiKey;
      let authToken = config.authToken;
      for (const envVar of ENV_API_KEY_MAP[name] ?? []) {
        const val = process.env[envVar];
        if (val?.startsWith('env:')) {
          try {
            apiKey = await secureDecrypt(val);
            break;
          } catch (err: unknown) {
            serverLog.debug(
              { err: err instanceof Error ? err.message : String(err) },
              'Failed to decrypt stored API key',
            );
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
            serverLog.debug(
              { err: err instanceof Error ? err.message : String(err) },
              'Failed to decrypt stored auth token',
            );
            providerLog.warn({ provider: name, envVar }, 'Failed to decrypt stored auth token');
          }
        }
      }
      if (apiKey !== config.apiKey || authToken !== config.authToken) {
        const updated = { ...config, apiKey, authToken };
        this.providerConfigs.set(name, updated);
        const provider = updated.disabled ? null : this.createProvider(name, updated);
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
    return this.verifyModelCatalog(
      url,
      { headers: { Authorization: `Bearer ${token}` } },
      'openai',
    );
  }

  /**
   * Verify a model-catalog endpoint by both authentication outcome and response
   * shape. HTTP 2xx alone is not evidence: reverse-proxy login pages, generic
   * mocks, empty accounts, and malformed JSON all remain unverified.
   */
  private async verifyModelCatalog(
    url: string,
    init: RequestInit | undefined,
    shape: 'openai' | 'gemini' | 'ollama',
  ): Promise<{ success: boolean; error?: string }> {
    const result = await this.verifyModelCatalogWithStatus(url, init, shape);
    return { success: result.success, error: result.error };
  }

  private async verifyModelCatalogWithStatus(
    url: string,
    init: RequestInit | undefined,
    shape: 'openai' | 'gemini' | 'ollama',
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
      if (!response.ok) {
        await response.arrayBuffer();
        return {
          success: false,
          status: response.status,
          error: safeVerificationHttpError(response.status),
        };
      }

      let payload: unknown;
      try {
        payload = JSON.parse(await response.text()) as unknown;
      } catch {
        return {
          success: false,
          status: response.status,
          error: `HTTP ${response.status}: model catalog did not return valid JSON`,
        };
      }

      if (!this.hasValidModelCatalogEntry(payload, shape)) {
        return {
          success: false,
          status: response.status,
          error: `HTTP ${response.status}: model catalog returned no valid ${shape} model entries`,
        };
      }
      return { success: true, status: response.status };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('abort') || message.includes('timeout')) {
        return { success: false, error: 'Request timeout (5s)' };
      }
      return { success: false, error: 'Provider model-catalog verification request failed.' };
    } finally {
      clearTimeout(timer);
    }
  }

  private hasValidModelCatalogEntry(
    payload: unknown,
    shape: 'openai' | 'gemini' | 'ollama',
  ): boolean {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    const body = payload as Record<string, unknown>;
    const validId = (value: unknown): boolean =>
      typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 512;

    if (shape === 'openai') {
      return (
        Array.isArray(body.data) &&
        body.data.some(
          (entry) =>
            !!entry &&
            typeof entry === 'object' &&
            !Array.isArray(entry) &&
            validId((entry as Record<string, unknown>).id),
        )
      );
    }

    if (!Array.isArray(body.models)) return false;
    if (shape === 'ollama') {
      return body.models.some(
        (entry) =>
          !!entry &&
          typeof entry === 'object' &&
          !Array.isArray(entry) &&
          (validId((entry as Record<string, unknown>).name) ||
            validId((entry as Record<string, unknown>).model)),
      );
    }

    return body.models.some((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
      const model = entry as Record<string, unknown>;
      if (!validId(model.name) || !(model.name as string).trim().startsWith('models/'))
        return false;
      const methods = model.supportedGenerationMethods;
      return (
        !Array.isArray(methods) ||
        methods.some((method) => method === 'generateContent' || method === 'streamGenerateContent')
      );
    });
  }

  private async verifyGitHubModelsCatalog(
    token: string,
  ): Promise<{ success: boolean; error?: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(GITHUB_MODELS_CATALOG_URL, {
        method: 'GET',
        headers: githubModelsHeaders(token),
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.arrayBuffer();
        return {
          success: false,
          error: safeVerificationHttpError(response.status, 'GitHub Models catalog verification'),
        };
      }
      const models = parseGitHubModelsCatalog(await response.json());
      if (models.length === 0) {
        return {
          success: false,
          error: 'GitHub Models catalog returned no chat-capable models for this token',
        };
      }
      return { success: true };
    } catch (error: unknown) {
      return { success: false, error: 'GitHub Models verification request failed.' };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Prove a Vertex AI express-mode key against Google's authenticated API.
   * Presence alone is never treated as authentication. countTokens performs
   * no content generation and its response shape gives us authenticated
   * service metadata to validate instead of accepting an arbitrary HTTP 200.
   */
  private async verifyVertexExpressKey(
    apiKey: string,
  ): Promise<{ success: boolean; error?: string }> {
    const timeoutMs = 5_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const { headers } = buildAuthHeaders('vertexai', { apiKey });
      const response = await fetch(VERTEX_EXPRESS_VERIFY_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Koryphaios connection check' }] }],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        await response.arrayBuffer();
        return {
          success: false,
          error: safeVerificationHttpError(response.status, 'Vertex AI verification'),
        };
      }

      const payload = (await response.json()) as { totalTokens?: unknown };
      if (typeof payload.totalTokens !== 'number' || !Number.isFinite(payload.totalTokens)) {
        return {
          success: false,
          error:
            'Vertex AI returned an invalid countTokens response; connection remains unverified',
        };
      }

      return { success: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.toLowerCase().includes('abort') || message.toLowerCase().includes('timeout')) {
        return { success: false, error: 'Vertex AI verification timed out after 5 seconds' };
      }
      return { success: false, error: 'Vertex AI verification request failed.' };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Identify if an error is a quota/rate limit error that should trigger a reroute. */
  isQuotaError(error: unknown): boolean {
    const msg = String(
      (error as { message?: string } | undefined)?.message || error || '',
    ).toLowerCase();
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
    if (result.success && (result.state ?? 'verified') === 'verified') {
      return { ok: true, status: 200 };
    }
    if (result.success) {
      return {
        ok: false,
        error:
          'Local setup material was detected, but this provider has no supported read-only account or deployment probe. Access remains unverified until runtime.',
      };
    }
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
      serverLog.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'Failed to mark key invalid (DB not initialized)',
      );
      // DB not initialized (e.g. tests)
    }
  }

  /** Clear invalid key state (e.g. after user updates key). */
  clearKeyInvalid(name: ProviderName): void {
    try {
      const { getDb } = require('../db');
      getDb().run('DELETE FROM provider_key_invalid WHERE provider = ?', name);
    } catch (err: unknown) {
      serverLog.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'Failed to clear invalid key state (DB not initialized)',
      );
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
      serverLog.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'Failed to check invalid key state, assuming not invalid',
      );
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
      await response.arrayBuffer();
      return {
        success: false,
        status: response.status,
        error: safeVerificationHttpError(response.status),
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('abort') || msg.includes('timeout')) {
        return { success: false, error: 'Request timeout (5s)' };
      }
      return { success: false, error: 'Provider verification request failed.' };
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
