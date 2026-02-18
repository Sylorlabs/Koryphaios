import { providerLog } from "../logger";
// Provider Registry — the universal auth hub.
// Auto-detects API keys from environment variables, config files, and CLI auth tokens.
// Mirrors OpenCode's provider initialization order and env var conventions.

import type { ProviderAuthMode, ProviderConfig, ProviderName, KoryphaiosConfig } from "@koryphaios/shared";
import type { Provider } from "./types";
import { AnthropicProvider } from "./anthropic";
import { detectClaudeCodeToken } from "./auth-utils";
import { OpenAIProvider, GroqProvider, OpenRouterProvider, XAIProvider, AzureProvider } from "./openai";
import { ClineProvider, normalizeClineAuthToken } from "./cline";
import { GeminiProvider, GeminiCLIProvider } from "./gemini";
import { CopilotProvider, detectCopilotToken, resolveCopilotBearerToken } from "./copilot";
import { CodexProvider } from "./codex";
import { decryptApiKey } from "../security";
import { resolveModel, getModelsForProvider } from "./types";

// ─── Environment Variable Mapping (from OpenCode's config.go) ───────────────

const ENV_API_KEY_MAP: Partial<Record<ProviderName, string[]>> = {
  // Frontier (Major providers)
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  xai: ["XAI_API_KEY"],
  // Aggregators
  openrouter: ["OPENROUTER_API_KEY"],
  cline: ["CLINE_API_KEY"],
  groq: ["GROQ_API_KEY"],
  copilot: [], // auth only
  // Enterprise
  azure: ["AZURE_OPENAI_API_KEY"],
  bedrock: ["AWS_ACCESS_KEY_ID"],
  vertexai: ["GOOGLE_VERTEX_AI_API_KEY"],
  // Local
  local: [],
  ollama: [],
  lmstudio: [],
  llamacpp: [],
  ollamacloud: ["OLLAMA_CLOUD_API_KEY"],
  // Chinese AI Providers
  deepseek: ["DEEPSEEK_API_KEY"],
  minimax: ["MINIMAX_API_KEY"],
  moonshot: ["MOONSHOT_API_KEY"],
  zai: ["ZAI_API_KEY"],
  cortecs: ["CORTECS_API_KEY"],
  stepfun: ["STEPFUN_API_KEY"],
  // High Performance / Speed
  cerebras: ["CEREBRAS_API_KEY"],
  fireworks: ["FIREWORKS_API_KEY"],
  deepinfra: ["DEEPINFRA_API_KEY"],
  ionet: ["IONET_API_KEY"],
  hyperbolic: ["HYPERBOLIC_API_KEY"],
  // Open Source Platforms
  huggingface: ["HUGGINGFACE_API_KEY"],
  replicate: ["REPLICATE_API_TOKEN"],
  modal: ["MODAL_API_KEY"],
  // AI Gateways
  vercel: ["VERCEL_AI_API_KEY"],
  cloudflare: ["CLOUDFLARE_AI_API_KEY"],
  cloudflareworkers: ["CLOUDFLARE_WORKERS_AI_API_KEY"],
  baseten: ["BASETEN_API_KEY"],
  helicone: ["HELICONE_API_KEY"],
  portkey: ["PORTKEY_API_KEY"],
  // European Providers
  scaleway: ["SCALEWAY_API_KEY"],
  ovhcloud: ["OVHAI_API_KEY"],
  stackit: ["STACKIT_API_KEY"],
  nebius: ["NEBIUS_API_KEY"],
  // Subscription-based
  togetherai: ["TOGETHER_AI_API_KEY"],
  venice: ["VENICE_API_KEY"],
  zenmux: ["ZENMUX_API_KEY"],
  opencodezen: ["OPICODEZEN_API_KEY"],
  firmware: ["FIRMWARE_API_KEY"],
  "302ai": ["A302AI_API_KEY"],
  // Specialized
  mistralai: ["MISTRAL_API_KEY"],
  cohere: ["COHERE_API_KEY"],
  perplexity: ["PERPLEXITY_API_KEY"],
  luma: ["LUMA_API_KEY"],
  fal: ["FAL_API_KEY"],
  // Audio/Speech
  elevenlabs: ["ELEVENLABS_API_KEY"],
  assemblyai: ["ASSEMBLYAI_API_KEY"],
  deepgram: ["DEEPGRAM_API_KEY"],
  gladia: ["GLADIA_API_KEY"],
  lmnt: ["LMNT_API_KEY"],
  // Enterprise
  azurecognitive: ["AZURE_COGNITIVE_SERVICES_KEY"],
  sapai: ["SAP_AI_API_KEY"],
  // Developer Platforms
  gitlab: ["GITLAB_API_KEY"],
  // NVIDIA
  nvidia: ["NVIDIA_API_KEY"],
  nim: ["NVIDIA_NIM_API_KEY"],
  // Friendli
  friendliai: ["FRIENDLI_AI_API_KEY"],
  // Embeddings
  voyageai: ["VOYAGE_API_KEY"],
  mixedbread: ["MIXEDBREAD_API_KEY"],
  // Memory
  mem0: ["MEM0_API_KEY"],
  letta: ["LETTA_API_KEY"],
  // Qwen
  qwen: ["QWEN_API_KEY"],
  alibaba: ["ALIBABA_API_KEY"],
  // Chrome
  chromeai: [],
  // Requesty
  requesty: ["REQUESTY_API_KEY"],
  // AIHubMix
  aihubmix: ["AIHUBMIX_API_KEY"],
  aimlapi: ["AIMLAPI_API_KEY"],
  // Black Forest Labs
  blackforestlabs: ["BLACKFORESTLABS_API_KEY"],
  // Kling AI
  klingai: ["KLINGAI_API_KEY"],
  // Prodia
  prodia: ["PRODIA_API_KEY"],
  // Legacy
  codex: [], // auth only
  antigravity: ["ANTIGRAVITY_API_KEY"],
  // Additional providers
  novita: ["NOVITA_API_KEY"],
  banbri: ["BANBRI_API_KEY"],
};

const ENV_URL_MAP: Partial<Record<ProviderName, string>> = {
  azure: "AZURE_OPENAI_ENDPOINT",
  local: "LOCAL_ENDPOINT",
  ollama: "OLLAMA_BASE_URL",
  lmstudio: "LMSTUDIO_BASE_URL",
  llamacpp: "LLAMACPP_BASE_URL",
  ollamacloud: "OLLAMA_CLOUD_BASE_URL",
  deepinfra: "DEEPINFRA_BASE_URL",
  hyperbolic: "HYPERBOLIC_BASE_URL",
  togetherai: "TOGETHER_AI_BASE_URL",
  openrouter: "OPENROUTER_BASE_URL",
  novita: "NOVITA_BASE_URL",
  banbri: "BANBRI_BASE_URL",
  fireworks: "FIREWORKS_BASE_URL",
  cerebras: "CEREBRAS_BASE_URL",
  ionet: "IONET_BASE_URL",
  replicate: "REPLICATE_BASE_URL",
  modal: "MODAL_BASE_URL",
  vercel: "VERCEL_AI_BASE_URL",
  cloudflare: "CLOUDFLARE_AI_BASE_URL",
  portkey: "PORTKEY_BASE_URL",
  helicone: "HELICONE_BASE_URL",
  baseten: "BASETEN_BASE_URL",
  venice: "VENICE_BASE_URL",
  zenmux: "ZENMUX_BASE_URL",
  opencodezen: "OPICODEZEN_BASE_URL",
  firmware: "FIRMWARE_BASE_URL",
  "302ai": "A302AI_BASE_URL",
  perplexity: "PERPLEXITY_BASE_URL",
  prodia: "PRODIA_BASE_URL",
  fal: "FAL_BASE_URL",
  luma: "LUMA_BASE_URL",
  klingai: "KLINGAI_BASE_URL",
  blackforestlabs: "BLACKFORESTLABS_BASE_URL",
};

const ENV_AUTH_TOKEN_MAP: Partial<Record<ProviderName, string[]>> = {
  anthropic: ["ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"],
  copilot: ["GITHUB_COPILOT_TOKEN", "GITHUB_TOKEN"],
  cline: ["CLINE_AUTH_TOKEN"],
  azure: ["AZURE_OPENAI_AUTH_TOKEN"],
  codex: ["CODEX_AUTH_TOKEN"],
  google: ["GEMINI_AUTH_TOKEN"],
  antigravity: ["ANTIGRAVITY_AUTH_TOKEN"],
};

const PROVIDER_AUTH_MODE: Record<ProviderName, ProviderAuthMode> = {
  // Frontier (Major providers)
  anthropic: "api_key_or_auth",
  openai: "api_key",
  google: "api_key_or_auth",
  xai: "api_key",
  // Aggregators
  openrouter: "api_key",
  cline: "auth_only",
  groq: "api_key",
  copilot: "auth_only",
  // Enterprise
  azure: "api_key_or_auth",
  bedrock: "env_auth",
  vertexai: "env_auth",
  // Local
  local: "base_url_only",
  ollama: "base_url_only",
  lmstudio: "base_url_only",
  llamacpp: "base_url_only",
  ollamacloud: "api_key",
  // Chinese AI Providers
  deepseek: "api_key",
  minimax: "api_key",
  moonshot: "api_key",
  zai: "api_key",
  cortecs: "api_key",
  stepfun: "api_key",
  // High Performance / Speed
  cerebras: "api_key",
  fireworks: "api_key",
  deepinfra: "api_key",
  ionet: "api_key",
  hyperbolic: "api_key",
  // Open Source Platforms
  huggingface: "api_key",
  replicate: "api_key",
  modal: "api_key",
  // AI Gateways
  vercel: "api_key",
  cloudflare: "api_key",
  cloudflareworkers: "api_key",
  baseten: "api_key",
  helicone: "api_key",
  portkey: "api_key",
  // European Providers
  scaleway: "api_key",
  ovhcloud: "api_key",
  stackit: "api_key",
  nebius: "api_key",
  // Subscription-based
  togetherai: "api_key",
  venice: "api_key",
  zenmux: "api_key",
  opencodezen: "api_key",
  firmware: "api_key",
  "302ai": "api_key",
  // Specialized
  mistralai: "api_key",
  cohere: "api_key",
  perplexity: "api_key",
  luma: "api_key",
  fal: "api_key",
  // Audio/Speech
  elevenlabs: "api_key",
  assemblyai: "api_key",
  deepgram: "api_key",
  gladia: "api_key",
  lmnt: "api_key",
  // Enterprise
  azurecognitive: "api_key_or_auth",
  sapai: "api_key",
  // Developer Platforms
  gitlab: "api_key",
  // NVIDIA
  nvidia: "api_key",
  nim: "api_key",
  // Friendli
  friendliai: "api_key",
  // Embeddings
  voyageai: "api_key",
  mixedbread: "api_key",
  // Memory
  mem0: "api_key",
  letta: "api_key",
  // Qwen
  qwen: "api_key",
  alibaba: "api_key",
  // Chrome
  chromeai: "env_auth",
  // Requesty
  requesty: "api_key",
  // AIHubMix
  aihubmix: "api_key",
  aimlapi: "api_key",
  // Black Forest Labs
  blackforestlabs: "api_key",
  // Kling AI
  klingai: "api_key",
  // Prodia
  prodia: "api_key",
  // Legacy
  codex: "auth_only",
  antigravity: "api_key",
  // Additional providers
  novita: "api_key",
  banbri: "api_key",
};

const EXTRA_AUTH_MODES: Partial<Record<ProviderName, Array<{ id: string; label: string; description: string }>>> = {
  anthropic: [
    { id: "api_key", label: "API Key", description: "Standard Anthropic API key (sk-ant-...)" },
    { id: "claude_code", label: "Claude Code", description: "Authenticate via Claude Pro/Max CLI session" },
  ],
  openai: [
    { id: "api_key", label: "API Key", description: "Standard OpenAI API key (sk-...)" },
    { id: "codex", label: "Codex Auth", description: "Authenticate via codex CLI session" },
  ],
  google: [
    { id: "api_key", label: "API Key", description: "Google AI Studio API key" },
    { id: "cli", label: "Gemini CLI", description: "Authenticate via gemini CLI session" },
  ],
};

export class ProviderRegistry {
  private providers = new Map<ProviderName, Provider>();
  private providerConfigs = new Map<ProviderName, ProviderConfig>();

  constructor(private config?: KoryphaiosConfig) {
    this.initializeAll();
  }

  /** Get a specific provider by name. */
  get(name: ProviderName): Provider | undefined {
    return this.providers.get(name);
  }

  /** Get all available (authenticated) providers. */
  getAvailable(): Provider[] {
    return [...this.providers.values()].filter((p) => p.isAvailable());
  }

  /** Get provider status for all configured providers. */
  getStatus(): Array<{
    name: ProviderName;
    enabled: boolean;
    authenticated: boolean;
    models: string[];
    allAvailableModels: string[];
    selectedModels: string[];
    hideModelSelector: boolean;
    authMode: ProviderAuthMode;
    supportsApiKey: boolean;
    supportsAuthToken: boolean;
    requiresBaseUrl: boolean;
    extraAuthModes?: Array<{ id: string; label: string; description: string }>;
    error?: string;
  }> {
    return Object.keys(PROVIDER_AUTH_MODE).map((name) => {
      const pn = name as ProviderName;
      const provider = this.providers.get(pn);
      const config = this.providerConfigs.get(pn);
      const authMode = PROVIDER_AUTH_MODE[pn];

      // Only get models from the provider if it's actually enabled and authenticated
      const isProviderAvailable = provider?.isAvailable() ?? false;
      const isEnabled = config ? !config.disabled : false;
      const isClaudeCodeCLI = config?.authToken?.startsWith("cli:claude");
      const isAuthenticated = isProviderAvailable ||
        (pn === "anthropic" && (!!detectClaudeCodeToken() || isClaudeCodeCLI)) ||
        (pn === "claude-code" && (!!detectClaudeCodeToken() || isClaudeCodeCLI)) ||
        (pn === "copilot" && !!detectCopilotToken());

      // Only show models if the provider is enabled AND authenticated
      let allModels: string[] = [];
      if (isEnabled && isAuthenticated) {
        const modelProviderId = pn === "claude-code" ? "anthropic" : pn;
        allModels = provider?.listModels().map((m) => m.id)
          ?? getModelsForProvider(modelProviderId).map((m) => m.id);
      }

      const selectedModels = config?.selectedModels ?? [];
      const hideModelSelector = config?.hideModelSelector ?? false;

      // Special case for Claude Code: only show modern flagship models
      if (pn === "claude-code") {
        const flagshipModels = ["claude-opus-4-6", "claude-sonnet-4-5", "claude-haiku-4-5"];
        allModels = allModels.filter(id => flagshipModels.includes(id));
      } else if (pn === "anthropic") {
        const isClaudeCodeAuth = config?.authToken?.startsWith("cli:claude") || detectClaudeCodeToken() !== null;
        if (isClaudeCodeAuth) {
          const flagshipModels = ["claude-opus-4-6", "claude-sonnet-4-5", "claude-haiku-4-5"];
          allModels = allModels.filter(id => flagshipModels.includes(id));
        }
      }

      // The 'models' field returned to UI should only be the ENABLED ones
      const enabledModels = (selectedModels.length > 0)
        ? allModels.filter(id => selectedModels.includes(id))
        : allModels;

      return {
        name: pn,
        enabled: config ? !config.disabled : false,
        authenticated: provider?.isAvailable() ?? false,
        models: enabledModels,
        allAvailableModels: allModels,
        selectedModels: selectedModels,
        hideModelSelector,
        authMode,
        supportsApiKey: authMode === "api_key" || authMode === "api_key_or_auth",
        supportsAuthToken: authMode === "api_key_or_auth",
        requiresBaseUrl: authMode === "base_url_only" || pn === "azure",
        extraAuthModes: EXTRA_AUTH_MODES[pn],
      };
    });
  }

  /** Find the best available provider for a given model ID. */
  findProviderForModel(modelId: string): Provider | undefined {
    for (const provider of this.getAvailable()) {
      const config = this.providerConfigs.get(provider.name);
      const selected = config?.selectedModels ?? [];

      // If user has selected specific models, only allow those
      if (selected.length > 0 && !selected.includes(modelId)) {
        continue;
      }

      // Special case for Claude Code: only allow 4.5/4.6 models
      const isClaudeCodeAuth = config?.authToken?.startsWith("cli:claude") || detectClaudeCodeToken() !== null;
      if (provider.name === "anthropic" && isClaudeCodeAuth) {
        const flagshipModels = ["claude-opus-4-6", "claude-sonnet-4-5", "claude-haiku-4-5"];
        if (!flagshipModels.includes(modelId)) continue;
      }

      if (provider.listModels().some((m) => m.id === modelId)) {
        return provider;
      }
    }
    return undefined;
  }

  /** Resolve the provider that should handle a model, with fallback chain. */
  resolveProvider(modelId: string, preferredProvider?: ProviderName): Provider | undefined {
    const modelDef = resolveModel(modelId);

    // If the model is explicitly in our catalog, we MUST respect its assigned provider
    // (e.g. Codex models must use the Codex CLI provider)
    if (modelDef) {
      const provider = this.providers.get(modelDef.provider);
      if (provider?.isAvailable()) return provider;
      return undefined; // If the required provider isn't available, don't fallback to a different provider type
    }

    if (preferredProvider) {
      const preferred = this.providers.get(preferredProvider);
      if (preferred?.isAvailable()) return preferred;
    }
    return this.findProviderForModel(modelId);
  }

  /** Validate provider credentials by making a lightweight authenticated API call. */
  async verifyConnection(
    name: ProviderName,
    credentials?: { apiKey?: string; authToken?: string; baseUrl?: string },
  ): Promise<{ success: boolean; error?: string }> {
    const existing = this.providerConfigs.get(name);
    const apiKey = credentials?.apiKey ?? existing?.apiKey;
    const authToken = credentials?.authToken ?? existing?.authToken;
    const baseUrl = credentials?.baseUrl ?? existing?.baseUrl;

    try {
      switch (name) {
        case "anthropic": {
          if (!apiKey && !authToken) return { success: false, error: "Missing apiKey or authToken" };
          const headers: Record<string, string> = {
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          };
          if (apiKey) headers["x-api-key"] = apiKey;
          if (authToken) headers.Authorization = `Bearer ${authToken}`;
          return await this.verifyHttp("https://api.anthropic.com/v1/models", { method: "GET", headers });
        }
        case "openai":
          return this.verifyBearerGet("https://api.openai.com/v1/models", apiKey);
        case "google": {
          // If CLI auth token, verify gemini CLI
          if (authToken?.startsWith("cli:") || (!apiKey && !authToken)) {
            const whichProc = Bun.spawnSync(["which", "gemini"], { stdout: "pipe", stderr: "pipe" });
            if (whichProc.exitCode !== 0) {
              return { success: false, error: "gemini CLI not found in PATH. Install it first." };
            }
            return { success: true };
          }
          if (!apiKey) return { success: false, error: "Missing apiKey" };
          return await this.verifyHttp(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`);
        }
        case "copilot": {
          const token = authToken ?? detectCopilotToken();
          if (!token) return { success: false, error: "GitHub Copilot auth token not found. Authenticate with GitHub first." };
          const bearer = resolveCopilotBearerToken(token);
          if (!bearer) return { success: false, error: "Failed to exchange GitHub token for Copilot bearer token" };
          // Copilot API requires IDE headers on ALL requests, including /models
          return this.verifyHttp("https://api.githubcopilot.com/models", {
            headers: {
              Authorization: `Bearer ${bearer}`,
              "Editor-Version": "vscode/1.100.0",
              "Editor-Plugin-Version": "copilot-chat/0.27.0",
              "Copilot-Integration-Id": "vscode-chat",
              "User-Agent": "Koryphaios/1.0",
            },
          });
        }
        case "cline": {
          if (!authToken) return { success: false, error: "Missing authToken" };
          const normalizedToken = normalizeClineAuthToken(authToken);
          return this.verifyHttp("https://api.cline.bot/api/v1/users/me", {
            headers: {
              Authorization: `Bearer ${normalizedToken}`,
              "HTTP-Referer": "https://cline.bot",
              "X-Title": "Koryphaios",
            },
          });
        }
        case "openrouter":
          return this.verifyBearerGet("https://openrouter.ai/api/v1/models", apiKey);
        case "groq":
          return this.verifyBearerGet("https://api.groq.com/openai/v1/models", apiKey);
        case "xai":
          return this.verifyBearerGet("https://api.x.ai/v1/models", apiKey);
        case "azure": {
          if (!apiKey && !authToken) return { success: false, error: "Missing apiKey or authToken" };
          if (!baseUrl) return { success: false, error: "Missing baseUrl" };
          const trimmed = baseUrl.replace(/\/+$/, "");
          const headers: Record<string, string> = {};
          if (apiKey) headers["api-key"] = apiKey;
          if (authToken) headers.Authorization = `Bearer ${authToken}`;
          return this.verifyHttp(`${trimmed}/openai/models?api-version=2024-10-21`, { headers });
        }
        case "local": {
          if (!baseUrl) return { success: false, error: "Missing baseUrl" };
          const trimmed = baseUrl.replace(/\/+$/, "");
          return this.verifyHttp(`${trimmed}/models`);
        }
        case "bedrock":
          return this.verifyBedrockEnvironment();
        case "vertexai":
          return this.verifyVertexEnvironment();
        case "codex": {
          // Verify codex CLI is installed and responsive
          const whichProc = Bun.spawnSync(["which", "codex"], { stdout: "pipe", stderr: "pipe" });
          if (whichProc.exitCode !== 0) {
            return { success: false, error: "codex CLI not found in PATH. Run: npm install -g @openai/codex" };
          }
          return { success: true };
        }
        default:
          return { success: false, error: `Unsupported provider: ${name}` };
      }
    } catch (err: any) {
      return { success: false, error: err?.message ?? String(err) };
    }
  }

  /** Set/update provider credentials at runtime — re-initializes the provider. */
  setCredentials(
    name: ProviderName,
    credentials: { apiKey?: string; authToken?: string; baseUrl?: string; selectedModels?: string[]; hideModelSelector?: boolean },
  ): { success: boolean; error?: string } {
    try {
      const existing = this.providerConfigs.get(name);
      const authMode = PROVIDER_AUTH_MODE[name];
      const apiKey = credentials.apiKey?.trim();
      const authToken = credentials.authToken?.trim();
      const baseUrl = credentials.baseUrl?.trim();

      if (authMode === "auth_only" && apiKey) {
        return { success: false, error: `${name} uses account auth only and does not accept API keys` };
      }
      if (authMode === "auth_only") {
        const hasAuthToken = !!(authToken || existing?.authToken);
        const hasDetectedCopilot = name === "copilot" && !!detectCopilotToken();
        if (!hasAuthToken && !hasDetectedCopilot) {
          return { success: false, error: "authToken is required" };
        }
      }
      if (authMode === "api_key" && !apiKey) {
        return { success: false, error: "apiKey is required" };
      }
      if (authMode === "api_key_or_auth" && !apiKey && !authToken && !existing?.authToken) {
        // Check for Claude Code token for anthropic
        if (name === "anthropic" && detectClaudeCodeToken()) {
          // OK - will use detected token
        } else {
          return { success: false, error: "Provide apiKey or authToken" };
        }
      }
      if (authMode === "env_auth") {
        const envReady = name === "bedrock" ? this.hasBedrockEnvironment() : this.hasVertexEnvironment();
        if (!envReady) {
          return { success: false, error: `${name} environment credentials not detected` };
        }
      }
      if (authMode === "base_url_only" && !baseUrl && !existing?.baseUrl) {
        return { success: false, error: "baseUrl is required" };
      }

      const providerConfig: ProviderConfig = {
        name,
        apiKey: apiKey ?? existing?.apiKey,
        authToken: authToken ?? existing?.authToken,
        baseUrl: baseUrl ?? existing?.baseUrl,
        selectedModels: credentials.selectedModels ?? existing?.selectedModels,
        hideModelSelector: credentials.hideModelSelector ?? existing?.hideModelSelector,
        disabled: false,
        headers: existing?.headers,
      };

      this.providerConfigs.set(name, providerConfig);

      // Re-create the provider instance
      const provider = this.createProvider(name, providerConfig);
      if (provider) {
        this.providers.set(name, provider);
        providerLog.info({ provider: name }, "Configured with new API key");
        return { success: true };
      }
      return { success: false, error: "Failed to initialize provider" };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /** Force-refresh a provider instance from current stored config. */
  refreshProvider(name: ProviderName): { success: boolean; error?: string } {
    const config = this.providerConfigs.get(name);
    if (!config) return { success: false, error: "Provider config not found" };
    try {
      const provider = this.createProvider(name, config);
      if (!provider) return { success: false, error: "Failed to initialize provider" };
      this.providers.set(name, provider);
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
    providerLog.info({ provider: name }, "Disconnected");
  }

  /** Get the env var name expected for a provider. */
  getExpectedEnvVar(name: ProviderName, kind: "apiKey" | "authToken" | "baseUrl" = "apiKey"): string {
    if (kind === "authToken") {
      return ENV_AUTH_TOKEN_MAP[name]?.[0] ?? `${name.toUpperCase()}_AUTH_TOKEN`;
    }
    if (kind === "baseUrl") {
      return ENV_URL_MAP[name] ?? `${name.toUpperCase()}_BASE_URL`;
    }
    return ENV_API_KEY_MAP[name]?.[0] ?? `${name.toUpperCase()}_API_KEY`;
  }

  // ─── Private: Initialize all providers ──────────────────────────────────

  private initializeAll() {
    const configProviders = this.config?.providers ?? {};

    for (const name of Object.keys(PROVIDER_AUTH_MODE) as ProviderName[]) {
      const userConfig = configProviders[name];
      const envKey = this.detectEnvKey(name);
      const envAuthToken = this.detectEnvAuthToken(name);
      const envUrl = this.detectEnvUrl(name);

      const providerConfig: ProviderConfig = {
        name,
        apiKey: userConfig?.apiKey ?? envKey ?? undefined,
        authToken: userConfig?.authToken ?? envAuthToken ?? undefined,
        baseUrl: userConfig?.baseUrl ?? envUrl ?? undefined,
        selectedModels: userConfig?.selectedModels ?? [],
        hideModelSelector: userConfig?.hideModelSelector ?? false,
        disabled: userConfig?.disabled ?? false,
        headers: userConfig?.headers,
      };

      const authMode = PROVIDER_AUTH_MODE[name];
      const hasApi = !!providerConfig.apiKey;
      const hasAuth = !!providerConfig.authToken
        || (name === "copilot" && !!detectCopilotToken())
        || (name === "anthropic" && !!detectClaudeCodeToken());
      const hasUrl = !!providerConfig.baseUrl;
      const hasAnyAuth = (authMode === "api_key" && hasApi)
        || (authMode === "auth_only" && hasAuth)
        || (authMode === "api_key_or_auth" && (hasApi || hasAuth))
        || (authMode === "env_auth" && (name === "bedrock" ? this.hasBedrockEnvironment() : this.hasVertexEnvironment()))
        || (authMode === "base_url_only" && hasUrl);

      // Auto-disable when no usable auth is available
      // Exception: copilot uses local token detection, anthropic uses Claude Code, gemini/codex use CLI wrappers
      const isCliWrapper = name === "google" || name === "codex";
      if (!hasAnyAuth && name !== "copilot" && name !== "anthropic" && !isCliWrapper) {
        providerConfig.disabled = true;
      }

      this.providerConfigs.set(name, providerConfig);

      try {
        const provider = this.createProvider(name, providerConfig);
        if (provider) {
          this.providers.set(name, provider);
        }
      } catch (err) {
        providerLog.warn({ provider: name, err }, "Failed to initialize");
      }
    }

    this.logProviderStatus();
  }

  private createProvider(name: ProviderName, config: ProviderConfig): Provider | null {
    switch (name) {
      case "anthropic":
        // Use Claude Code token if no apiKey or authToken provided
        if (!config.apiKey && !config.authToken) {
          const claudeCodeToken = detectClaudeCodeToken();
          if (claudeCodeToken) {
            return new AnthropicProvider({ ...config, authToken: claudeCodeToken });
          }
        }
        return new AnthropicProvider(config);
      case "openai":
        return new OpenAIProvider(config);
      case "google":
        // Use CLI wrapper if no API key but gemini CLI is available
        if (!config.apiKey && (config.authToken?.startsWith("cli:") || !config.apiKey)) {
          const cliProvider = new GeminiCLIProvider(config);
          if (cliProvider.isAvailable()) return cliProvider;
        }
        if (config.apiKey) return new GeminiProvider(config);
        return null;

      case "copilot":
        return new CopilotProvider(config);
      case "cline":
        return new ClineProvider(config);
      case "codex":
        return new CodexProvider(config);
      case "openrouter":
        return new OpenRouterProvider(config);
      case "groq":
        return new GroqProvider(config);
      case "xai":
        return new XAIProvider(config);
      case "azure":
        return new AzureProvider(config);
      case "bedrock":
        // Bedrock uses AWS SDK default credentials, not API key
        return new OpenAIProvider(config, "bedrock", config.baseUrl);
      case "vertexai":
        return new GeminiProvider({ ...config, name: "vertexai" });
      case "local":
        if (config.baseUrl) {
          return new OpenAIProvider(config, "local", config.baseUrl);
        }
        return null;
      default:
        return null;
    }
  }

  private detectEnvKey(name: ProviderName): string | null {
    const envVars = ENV_API_KEY_MAP[name] ?? [];
    for (const envVar of envVars) {
      const val = process.env[envVar];
      if (val) return decryptApiKey(val);
    }
    return null;
  }

  private detectEnvAuthToken(name: ProviderName): string | null {
    const envVars = ENV_AUTH_TOKEN_MAP[name] ?? [];
    for (const envVar of envVars) {
      const val = process.env[envVar];
      if (val) return decryptApiKey(val);
    }
    return null;
  }

  private detectEnvUrl(name: ProviderName): string | null {
    const envVar = ENV_URL_MAP[name];
    if (envVar) return process.env[envVar] ?? null;
    return null;
  }

  private hasBedrockEnvironment(): boolean {
    return !!(
      (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY)
      || process.env.AWS_PROFILE
      || process.env.AWS_DEFAULT_PROFILE
      || process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
      || process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI
    );
  }

  private hasVertexEnvironment(): boolean {
    return !!(
      (process.env.VERTEXAI_PROJECT && process.env.VERTEXAI_LOCATION)
      || (process.env.GOOGLE_CLOUD_PROJECT && (process.env.GOOGLE_CLOUD_REGION || process.env.GOOGLE_CLOUD_LOCATION))
      || process.env.GOOGLE_APPLICATION_CREDENTIALS
    );
  }

  private verifyBedrockEnvironment(): { success: boolean; error?: string } {
    if (this.hasBedrockEnvironment()) return { success: true };
    return {
      success: false,
      error: "AWS credentials not detected (set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY or AWS_PROFILE).",
    };
  }

  private verifyVertexEnvironment(): { success: boolean; error?: string } {
    if (this.hasVertexEnvironment()) return { success: true };
    return {
      success: false,
      error: "Vertex AI credentials not detected (set VERTEXAI_PROJECT + VERTEXAI_LOCATION or GOOGLE_APPLICATION_CREDENTIALS).",
    };
  }

  private logProviderStatus() {
    const available = this.getAvailable();
    const names = available.map((p) => p.name);
    providerLog.info({ providers: names }, "Providers ready");

    if (names.length === 0) {
      providerLog.warn("No providers configured");
    }
  }

  private async verifyBearerGet(url: string, token?: string | null): Promise<{ success: boolean; error?: string }> {
    if (!token) return { success: false, error: "Missing token" };
    return this.verifyHttp(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
  }

  private async verifyHttp(
    url: string,
    init?: RequestInit,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const headers = new Headers(init?.headers ?? {});
      if (!headers.has("User-Agent")) {
        headers.set("User-Agent", "Koryphaios/1.0");
      }

      const response = await fetch(url, {
        method: "GET",
        ...init,
        headers,
      });
      if (response.ok) return { success: true };
      const body = await response.text();
      return { success: false, error: `HTTP ${response.status}: ${body.slice(0, 300)}` };
    } catch {
      // Some environments block Bun fetch egress while curl is allowed.
      return this.verifyHttpWithCurl(url, init);
    }
  }

  /** Identify if an error is a quota/rate limit error that should trigger a reroute. */
  isQuotaError(error: any): boolean {
    const msg = String(error?.message || error || "").toLowerCase();
    const isQuota =
      msg.includes("quota") ||
      msg.includes("rate limit") ||
      msg.includes("429") ||
      msg.includes("insufficient_quota") ||
      msg.includes("credit balance");
    return isQuota;
  }

  private verifyHttpWithCurl(
    url: string,
    init?: RequestInit,
  ): { success: boolean; error?: string } {
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers ?? {});
    if (!headers.has("User-Agent")) {
      headers.set("User-Agent", "Koryphaios/1.0");
    }

    const args = ["-sS", "-X", method, "-o", "-", "-w", "\n%{http_code}", url];
    for (const [k, v] of headers.entries()) {
      args.push("-H", `${k}: ${v}`);
    }

    const proc = Bun.spawnSync(["curl", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });

    if (proc.exitCode !== 0) {
      const stderr = proc.stderr ? new TextDecoder().decode(proc.stderr).trim() : "";
      return { success: false, error: `curl failed: ${stderr || `exit ${proc.exitCode}`}` };
    }

    const output = proc.stdout ? new TextDecoder().decode(proc.stdout) : "";
    const splitAt = output.lastIndexOf("\n");
    const body = splitAt >= 0 ? output.slice(0, splitAt) : "";
    const statusRaw = splitAt >= 0 ? output.slice(splitAt + 1).trim() : "";
    const status = Number(statusRaw);
    if (status >= 200 && status < 300) return { success: true };
    return { success: false, error: `HTTP ${status || "unknown"}: ${body.slice(0, 300)}` };
  }
}
