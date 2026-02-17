import { providerLog } from "../logger";
// Provider Registry — the universal auth hub.
// Auto-detects API keys from environment variables, config files, and CLI auth tokens.
// Mirrors OpenCode's provider initialization order and env var conventions.

import type { ProviderAuthMode, ProviderConfig, ProviderName, KoryphaiosConfig } from "@koryphaios/shared";
import type { Provider } from "./types";
import { AnthropicProvider } from "./anthropic";
import { OpenAIProvider, GroqProvider, OpenRouterProvider, XAIProvider, AzureProvider } from "./openai";
import { GeminiProvider, GeminiCLIProvider } from "./gemini";
import { CopilotProvider, detectCopilotToken, resolveCopilotBearerToken } from "./copilot";
import { CodexProvider } from "./codex";
import { ClineProvider } from "./cline";
import { decryptApiKey } from "../security";
import { resolveModel, getModelsForProvider, isLegacyModel, type StreamRequest, type ProviderEvent } from "./types";
import { detectClaudeCodeToken, detectCodexToken, detectGeminiCLIToken, detectAntigravityToken } from "./auth-utils";

// ─── Environment Variable Mapping (from OpenCode's config.go) ───────────────

const ENV_API_KEY_MAP: Partial<Record<ProviderName, string[]>> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  cline: ["CLINE_API_KEY"],
  groq: ["GROQ_API_KEY"],
  xai: ["XAI_API_KEY"],
  azure: ["AZURE_OPENAI_API_KEY"],
  // Popular alternatives
  deepseek: ["DEEPSEEK_API_KEY"],
  togetherai: ["TOGETHERAI_API_KEY", "TOGETHER_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  fireworks: ["FIREWORKS_API_KEY"],
  huggingface: ["HUGGINGFACE_API_KEY", "HF_TOKEN"],
  deepinfra: ["DEEPINFRA_API_KEY"],
  minimax: ["MINIMAX_API_KEY"],
  moonshot: ["MOONSHOT_API_KEY"],
  ollama: ["OLLAMA_API_KEY"],
  ollamacloud: ["OLLAMA_CLOUD_API_KEY"],
  lmstudio: ["LMSTUDIO_API_KEY"],
  llamacpp: ["LLAMACPP_API_KEY"],
  local: ["LOCAL_API_KEY"],
  // AI Gateways
  cloudflare: ["CLOUDFLARE_API_TOKEN"],
  cloudflareworkers: ["CLOUDFLARE_WORKERS_API_TOKEN"],
  vercel: ["VERCEL_API_TOKEN"],
  baseten: ["BASETEN_API_KEY"],
  helicone: ["HELICONE_API_KEY"],
  portkey: ["PORTKEY_API_KEY"],
  // High Performance
  hyperbolic: ["HYPERBOLIC_API_KEY"],
  ionet: ["IONET_API_KEY"],
  // Chinese AI
  nebius: ["NEBIUS_API_KEY"],
  zai: ["ZAI_API_KEY"],
  cortecs: ["CORTECS_API_KEY"],
  stepfun: ["STEPFUN_API_KEY"],
  qwen: ["QWEN_API_KEY"],
  alibaba: ["ALIBABA_API_KEY"],
  zhipuai: ["ZHIPUAI_API_KEY"],
  modelscope: ["MODELSCOPE_API_KEY"],
  // Open Source
  replicate: ["REPLICATE_API_KEY"],
  modal: ["MODAL_API_KEY"],
  scaleway: ["SCALEWAY_API_KEY"],
  venice: ["VENICE_API_KEY"],
  zenmux: ["ZENMUX_API_KEY"],
  firmware: ["FIRMWARE_API_KEY"],
  // Enterprise
  azurecognitive: ["AZURE_COGNITIVE_API_KEY"],
  sapai: ["SAPAI_SERVICE_KEY"],
  stackit: ["STACKIT_AUTH_TOKEN"],
  ovhcloud: ["OVHCLOUD_API_KEY"],
  // Developer Platforms
  gitlab: ["GITLAB_TOKEN"],
  // Specialized
  mistralai: ["MISTRALAI_API_KEY"],
  cohere: ["COHERE_API_KEY"],
  perplexity: ["PERPLEXITY_API_KEY"],
  luma: ["LUMA_API_KEY"],
  fal: ["FAL_API_KEY"],
  // Audio/Speech
  elevenlabs: ["ELEVENLABS_API_KEY"],
  deepgram: ["DEEPGRAM_API_KEY"],
  gladia: ["GLADIA_API_KEY"],
  assemblyai: ["ASSEMBLYAI_API_KEY"],
  lmnt: ["LMNT_API_KEY"],
  // Other
  nvidia: ["NVIDIA_API_KEY"],
  nim: ["NIM_API_KEY"],
  friendliai: ["FRIENDLI_API_KEY"],
  friendli: ["FRIENDLI_TOKEN"],
  voyageai: ["VOYAGE_API_KEY"],
  mixedbread: ["MIXEDBREAD_API_KEY"],
  mem0: ["MEM0_API_KEY"],
  letta: ["LETTA_API_KEY"],
  blackforestlabs: ["BLACKFORESTLABS_API_KEY"],
  klingai: ["KLINGAI_API_KEY"],
  prodia: ["PRODIA_API_KEY"],
  "302ai": ["A302AI_API_KEY"],
  opencodezen: ["OPENCODEZEN_API_KEY"],
  // Additional from models.dev
  "novita-ai": ["NOVITA_AI_API_KEY"],
  upstage: ["UPSTAGE_API_KEY"],
  v0: ["V0_API_KEY"],
  siliconflow: ["SILICONFLOW_API_KEY"],
  abacus: ["ABACUS_API_KEY"],
  llama: ["LLAMA_API_KEY"],
  vultr: ["VULTR_API_KEY"],
  wandb: ["WANDB_API_KEY"],
  poe: ["POE_API_KEY"],
  // Additional from models.dev
  "github-models": ["GITHUB_TOKEN"],
  requesty: ["REQUESTY_API_KEY"],
  inference: ["INFERENCE_API_KEY"],
  submodel: ["SUBMODEL_API_KEY"],
  synthetic: ["SYNTHETIC_API_KEY"],
  moark: ["MOARK_API_KEY"],
  nova: ["NOVA_API_KEY"],
};

const ENV_URL_MAP: Partial<Record<ProviderName, string>> = {
  azure: "AZURE_OPENAI_ENDPOINT",
  local: "LOCAL_ENDPOINT",
};

const ENV_AUTH_TOKEN_MAP: Partial<Record<ProviderName, string[]>> = {
  anthropic: ["ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"],
  copilot: ["GITHUB_COPILOT_TOKEN", "GITHUB_TOKEN"],
  cline: ["CLINE_AUTH_TOKEN"],
  azure: ["AZURE_OPENAI_AUTH_TOKEN"],
};

export const PROVIDER_AUTH_MODE: Record<ProviderName, ProviderAuthMode> = {
  anthropic: "api_key_or_auth",
  openai: "api_key",
  google: "api_key_or_auth",
  copilot: "auth_only",
  codex: "auth_only",
  openrouter: "api_key",
  cline: "api_key_or_auth",
  groq: "api_key",
  xai: "api_key",
  azure: "api_key_or_auth",
  bedrock: "env_auth",
  vertexai: "env_auth",
  local: "base_url_only",
  // Popular alternatives
  deepseek: "api_key",
  togetherai: "api_key",
  cerebras: "api_key",
  fireworks: "api_key",
  huggingface: "api_key",
  deepinfra: "api_key",
  minimax: "api_key",
  moonshot: "api_key",
  ollama: "api_key",
  ollamacloud: "api_key",
  lmstudio: "api_key",
  llamacpp: "api_key",
  // AI Gateways
  cloudflare: "api_key",
  cloudflareworkers: "api_key",
  vercel: "api_key",
  baseten: "api_key",
  helicone: "api_key",
  portkey: "api_key",
  // High Performance
  hyperbolic: "api_key",
  ionet: "api_key",
  // Chinese AI
  nebius: "api_key",
  zai: "api_key",
  cortecs: "api_key",
  stepfun: "api_key",
  qwen: "api_key",
  alibaba: "api_key",
  zhipuai: "api_key",
  modelscope: "api_key",
  // Open Source
  replicate: "api_key",
  modal: "api_key",
  scaleway: "api_key",
  venice: "api_key",
  zenmux: "api_key",
  firmware: "api_key",
  // Enterprise
  azurecognitive: "api_key",
  sapai: "api_key",
  stackit: "api_key",
  ovhcloud: "api_key",
  // Developer Platforms
  gitlab: "api_key",
  antigravity: "auth_only",
  chromeai: "auth_only",
  // Specialized
  mistralai: "api_key",
  cohere: "api_key",
  perplexity: "api_key",
  luma: "api_key",
  fal: "api_key",
  // Audio/Speech
  elevenlabs: "api_key",
  deepgram: "api_key",
  gladia: "api_key",
  assemblyai: "api_key",
  lmnt: "api_key",
  // Other
  nvidia: "api_key",
  nim: "api_key",
  friendliai: "api_key",
  friendli: "api_key",
  voyageai: "api_key",
  mixedbread: "api_key",
  mem0: "api_key",
  letta: "api_key",
  blackforestlabs: "api_key",
  klingai: "api_key",
  prodia: "api_key",
  "302ai": "api_key",
  opencodezen: "api_key",
  // Additional from models.dev
  "novita-ai": "api_key",
  upstage: "api_key",
  v0: "api_key",
  siliconflow: "api_key",
  abacus: "api_key",
  llama: "api_key",
  vultr: "api_key",
  wandb: "api_key",
  poe: "api_key",
  // Additional from models.dev
  "github-models": "api_key",
  requesty: "api_key",
  inference: "api_key",
  submodel: "api_key",
  synthetic: "api_key",
  moark: "api_key",
  nova: "api_key",
  aihubmix: "api_key",
  aimlapi: "api_key",
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
    { id: "antigravity", label: "Antigravity", description: "Authenticate via Antigravity OAuth" },
  ],
};

export class ProviderRegistry {
  private providers = new Map<ProviderName, Provider>();
  private providerConfigs = new Map<ProviderName, ProviderConfig>();
  private failureCounts = new Map<ProviderName, number>();
  private trippedUntil = new Map<ProviderName, number>();

  private readonly FAILURE_THRESHOLD = 5;
  private readonly TRIP_DURATION_MS = 60000; // 1 minute cooldown

  constructor(private config?: KoryphaiosConfig) {
    this.initializeAll();
  }

  /** Get a specific provider by name. */
  get(name: ProviderName): Provider | undefined {
    if (this.isTripped(name)) {
      providerLog.warn({ provider: name }, "Attempted to get tripped provider");
      return undefined;
    }
    return this.providers.get(name);
  }

  /** Get all available (authenticated and healthy) providers. */
  getAvailable(): Provider[] {
    return [...this.providers.values()].filter((p) => {
      const pn = p.name;
      return p.isAvailable() && !this.isTripped(pn);
    });
  }

  private isTripped(name: ProviderName): boolean {
    const until = this.trippedUntil.get(name);
    if (until && Date.now() < until) {
      return true;
    }
    if (until) {
      // Cooldown expired
      this.trippedUntil.delete(name);
      this.failureCounts.set(name, 0);
      providerLog.info({ provider: name }, "Circuit breaker reset (cooldown expired)");
    }
    return false;
  }

  /** Report a failure to the circuit breaker. */
  reportFailure(name: ProviderName) {
    const count = (this.failureCounts.get(name) || 0) + 1;
    this.failureCounts.set(name, count);

    if (count >= this.FAILURE_THRESHOLD) {
      const until = Date.now() + this.TRIP_DURATION_MS;
      this.trippedUntil.set(name, until);
      providerLog.error({ provider: name, failures: count, duration: this.TRIP_DURATION_MS }, "Circuit breaker TRIPPED");
    }
  }

  /** Report a success to reset failure count. */
  reportSuccess(name: ProviderName) {
    if (this.failureCounts.get(name) !== 0) {
      this.failureCounts.set(name, 0);
    }
  }

  /** Get provider status for all configured providers. */
  async getStatus(): Promise<Array<{
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
  }>> {
    const statuses = await Promise.all(Object.keys(PROVIDER_AUTH_MODE).map(async (name) => {
      const pn = name as ProviderName;
      const provider = this.providers.get(pn);
      const config = this.providerConfigs.get(pn);
      const authMode = PROVIDER_AUTH_MODE[pn];

      const isProviderAvailable = provider?.isAvailable() ?? false;
      const isEnabled = config ? !config.disabled : false;
      const isClaudeCodeCLI = config?.authToken?.startsWith("cli:claude");
      const isAuthenticated = isEnabled && (isProviderAvailable || 
        (pn === "anthropic" && (!!detectClaudeCodeToken() || isClaudeCodeCLI)) ||
        (pn === "copilot" && !!detectCopilotToken()));
      
      let allModels: string[] = [];
      if (isEnabled && isAuthenticated) {
        const models = await (provider?.listModels() ?? Promise.resolve(getModelsForProvider(pn)));
        allModels = models.map((m) => m.id);
      }
      
      const selectedModels = config?.selectedModels ?? [];
      const hideModelSelector = config?.hideModelSelector ?? false;

      if (pn === "anthropic") {
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
        enabled: isEnabled,
        authenticated: isAuthenticated,
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
    }));

    return statuses;
  }

  /** Find the best available provider for a given model ID. */
  async findProviderForModel(modelId: string): Promise<Provider | undefined> {
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

      const models = await provider.listModels();
      if (models.some((m) => m.id === modelId)) {
        return provider;
      }
    }
    return undefined;
  }

  /** Resolve the provider that should handle a model, with fallback chain. */
  async resolveProvider(modelId: string, preferredProvider?: ProviderName): Promise<Provider | undefined> {
    // 1. If a specific provider was requested AND it's available AND it supports this model, use it!
    if (preferredProvider) {
      const preferred = this.providers.get(preferredProvider);
      if (preferred?.isAvailable()) {
        const models = await preferred.listModels();
        if (models.some(m => m.id === modelId || m.apiModelId === modelId || m.id === `${preferredProvider}.${modelId}`)) {
          return preferred;
        }
      }
    }

    // 2. Check our global catalog for the "official" provider
    const modelDef = resolveModel(modelId);
    if (modelDef) {
      const provider = this.providers.get(modelDef.provider);
      if (provider?.isAvailable()) return provider;
      // If the official provider isn't available, we'll continue to find ANY provider
    }

    // 3. Fallback: search ALL available providers for one that claims to support this model ID
    return await this.findProviderForModel(modelId);
  }

  /** Execute a stream request with automatic retries and fallback to other models if necessary. */
  async *executeWithRetry(
    request: StreamRequest,
    preferredProvider?: ProviderName,
    fallbackChain?: string[]
  ): AsyncGenerator<ProviderEvent> {
    // If no fallback chain provided, just try the requested model
    const chain = fallbackChain && fallbackChain.length > 0 ? fallbackChain : [request.model];
    let lastError: any;

    for (const modelId of chain) {
      const provider = await this.resolveProvider(modelId, preferredProvider);
      if (!provider) {
        lastError = new Error(`No available provider for model: ${modelId}`);
        continue;
      }

      try {
        let success = false;
        let receivedAnyContent = false;

        // Execute the stream
        for await (const event of provider.streamResponse({ ...request, model: modelId })) {
          if (event.type === "error") {
            const isQuota = this.isQuotaError(event.error);
            if (isQuota && !receivedAnyContent) {
              providerLog.warn({ model: modelId, provider: provider.name }, "Quota exceeded, attempting fallback...");
              lastError = new Error(event.error);
              success = false;
              break; // Try next model in chain
            }
            // Yield terminal errors if we can't fallback
            yield event;
            return;
          }

          if (event.type === "content_delta" || event.type === "thinking_delta" || event.type === "tool_use_start") {
            receivedAnyContent = true;
          }

          if (event.type === "complete") {
            success = true;
            this.reportSuccess(provider.name);
          }

          yield event;
        }

        if (success) return; // Mission accomplished
      } catch (err: any) {
        this.reportFailure(provider.name);
        lastError = err;
        const isQuota = this.isQuotaError(err);
        if (!isQuota) {
          yield { type: "error", error: err.message ?? String(err) };
          return;
        }
        providerLog.warn({ model: modelId, provider: provider.name, err: err.message }, "Provider error, attempting fallback...");
      }
    }

    yield { type: "error", error: lastError?.message ?? "All fallback attempts failed" };
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
        case "openrouter":
          return this.verifyBearerGet("https://openrouter.ai/api/v1/models", apiKey);
        case "cline":
          return this.verifyBearerGet("https://api.cline.bot/api/v1/models", apiKey ?? authToken);
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
        // Popular alternatives
        case "deepseek":
          return this.verifyBearerGet("https://api.deepseek.com/v1/models", apiKey);
        case "togetherai":
          return this.verifyBearerGet("https://api.together.ai/v1/models", apiKey);
        case "cerebras":
          return this.verifyBearerGet("https://api.cerebras.ai/v1/models", apiKey);
        case "fireworks":
          return this.verifyBearerGet("https://api.fireworks.ai/inference/v1/models", apiKey);
        case "huggingface":
          return this.verifyBearerGet("https://api-inference.huggingface.co/v1/models", apiKey);
        case "deepinfra":
          return this.verifyBearerGet("https://api.deepinfra.com/v1/models", apiKey);
        case "minimax":
          return this.verifyBearerGet("https://api.minimax.chat/v1/models", apiKey);
        case "moonshot":
          return this.verifyBearerGet("https://api.moonshot.ai/v1/models", apiKey);
        case "ollama":
          return this.verifyHttp(process.env.OLLAMA_BASE_URL || "http://localhost:11434/api/tags");
        case "ollamacloud":
          return this.verifyBearerGet("https://ollama.com/api/tags", apiKey);
        case "lmstudio":
          return this.verifyHttp("http://localhost:1234/v1/models");
        case "llamacpp":
          return this.verifyHttp("http://localhost:8080/v1/models");
        // AI Gateways
        case "cloudflare":
          return this.verifyBearerGet("https://api.cloudflare.com/client/v4/accounts", apiKey);
        case "cloudflareworkers":
          return this.verifyBearerGet("https://api.cloudflare.com/client/v4/accounts", apiKey);
        case "vercel":
          return this.verifyBearerGet("https://api.vercel.com/v6/frameworks", apiKey);
        case "baseten":
          return this.verifyBearerGet("https://api.baseten.co/v1/models", apiKey);
        case "helicone":
          return this.verifyBearerGet("https://api.helicone.ai/v1/models", apiKey);
        case "portkey":
          return this.verifyBearerGet("https://api.portkey.ai/v1/models", apiKey);
        // High Performance
        case "hyperbolic":
          return this.verifyBearerGet("https://api.hyperbolic.xyz/v1/models", apiKey);
        case "ionet":
          return this.verifyBearerGet("https://api.intelligence.io.solutions/api/v1/models", apiKey);
        // Chinese AI
        case "nebius":
          return this.verifyBearerGet("https://api.nebius.ai/v1/models", apiKey);
        case "zai":
          return this.verifyBearerGet("https://api.z.ai/v1/models", apiKey);
        case "cortecs":
          return this.verifyBearerGet("https://api.cortecs.ai/v1/models", apiKey);
        case "stepfun":
          return this.verifyBearerGet("https://api.stepfun.com/v1/models", apiKey);
        case "qwen":
          return this.verifyBearerGet("https://dashscope.aliyuncs.com/compatible-mode/v1/models", apiKey);
        case "alibaba":
          return this.verifyBearerGet("https://dashscope.aliyuncs.com/compatible-mode/v1/models", apiKey);
        case "zhipuai":
          return this.verifyBearerGet("https://open.bigmodel.cn/api/paas/v4/models", apiKey);
        case "modelscope":
          return this.verifyBearerGet("https://api.modelscope.cn/v1/models", apiKey);
        // Open Source
        case "replicate":
          return this.verifyBearerGet("https://api.replicate.com/v1/models", apiKey);
        case "modal":
          return this.verifyBearerGet("https://api.modal.com/v1/models", apiKey);
        case "scaleway":
          return this.verifyBearerGet("https://api.scaleway.com/llm/v1/models", apiKey);
        case "venice":
          return this.verifyBearerGet("https://api.venice.ai/v1/models", apiKey);
        case "zenmux":
          return this.verifyBearerGet("https://zenmux.ai/api/anthropic/v1/models", apiKey);
        case "firmware":
          return this.verifyBearerGet("https://api.firmware.ai/v1/models", apiKey);
        // Enterprise
        case "azurecognitive":
          return this.verifyAzureCognitiveEnvironment();
        case "sapai":
          return this.verifyBearerGet("https://api.ai.sap.com/v1/models", apiKey);
        case "stackit":
          return this.verifyBearerGet("https://LLM.eu1.hana.ondemand.com/v1/models", apiKey);
        case "ovhcloud":
          return this.verifyBearerGet("https://deploy.ai.ovh.net/v1/models", apiKey);
        // Developer Platforms
        case "gitlab":
          return { success: true }; // Verified via OAuth
        case "antigravity":
          return { success: true }; // Google internal
        case "chromeai":
          return { success: true }; // Chrome built-in
        // Specialized
        case "mistralai":
          return this.verifyBearerGet("https://api.mistral.ai/v1/models", apiKey);
        case "cohere":
          return this.verifyBearerGet("https://api.cohere.ai/v1/models", apiKey);
        case "perplexity":
          return this.verifyBearerGet("https://api.perplexity.ai/v1/models", apiKey);
        case "luma":
          return this.verifyBearerGet("https://api.luma.ai/v1/models", apiKey);
        case "fal":
          return this.verifyBearerGet("https://queue.fal.run/models", apiKey);
        // Audio/Speech
        case "elevenlabs":
          return this.verifyBearerGet("https://api.elevenlabs.io/v1/models", apiKey);
        case "deepgram":
          return this.verifyBearerGet("https://api.deepgram.com/v1/models", apiKey);
        case "gladia":
          return this.verifyBearerGet("https://api.gladia.io/v1/models", apiKey);
        case "assemblyai":
          return this.verifyBearerGet("https://api.assemblyai.com/v1/models", apiKey);
        case "lmnt":
          return this.verifyBearerGet("https://api.lmnt.com/v1/models", apiKey);
        // Other
        case "nvidia":
          return this.verifyBearerGet("https://integrate.api.nvidia.com/v1/models", apiKey);
        case "nim":
          return this.verifyBearerGet("https://api.nimbleway.io/v1/models", apiKey);
        case "friendliai":
          return this.verifyBearerGet("https://api.friendli.ai/v1/models", apiKey);
        case "friendli":
          return this.verifyBearerGet("https://api.friendli.ai/serverless/v1/models", apiKey);
        case "voyageai":
          return this.verifyBearerGet("https://api.voyageai.com/v1/models", apiKey);
        case "mixedbread":
          return this.verifyBearerGet("https://api.mixedbread.ai/v1/models", apiKey);
        case "mem0":
          return this.verifyBearerGet("https://api.mem0.ai/v1/models", apiKey);
        case "letta":
          return this.verifyBearerGet("https://api.letta.com/v1/models", apiKey);
        case "blackforestlabs":
          return this.verifyBearerGet("https://api.blackforestlabs.ai/v1/models", apiKey);
        case "klingai":
          return this.verifyBearerGet("https://api.klingai.com/v1/models", apiKey);
        case "prodia":
          return this.verifyBearerGet("https://api.prodia.com/v1/models", apiKey);
        case "302ai":
          return this.verifyBearerGet("https://api.302.ai/v1/models", apiKey);
        case "opencodezen":
          return this.verifyBearerGet("https://opencode.ai/zen/v1/models", apiKey);
        // Additional from models.dev
        case "novita-ai":
          return this.verifyBearerGet("https://api.novita.ai/openai/v1/models", apiKey);
        case "upstage":
          return this.verifyBearerGet("https://api.upstage.ai/v1/solar/models", apiKey);
        case "v0":
          return this.verifyBearerGet("https://api.v0.dev/v1/models", apiKey);
        case "siliconflow":
          return this.verifyBearerGet("https://api.siliconflow.com/v1/models", apiKey);
        case "abacus":
          return this.verifyBearerGet("https://routellm.abacus.ai/v1/models", apiKey);
        case "llama":
          return this.verifyBearerGet("https://api.llama.com/compat/v1/models", apiKey);
        case "vultr":
          return this.verifyBearerGet("https://api.vultrinference.com/v1/models", apiKey);
        case "wandb":
          return this.verifyBearerGet("https://api.inference.wandb.ai/v1/models", apiKey);
        case "poe":
          return this.verifyBearerGet("https://api.poe.com/v1/models", apiKey);
        // Additional from models.dev
        case "github-models":
          return this.verifyBearerGet("https://models.github.ai/models", apiKey);
        case "requesty":
          return this.verifyBearerGet("https://router.requesty.ai/v1/models", apiKey);
        case "inference":
          return this.verifyBearerGet("https://inference.net/v1/models", apiKey);
        case "submodel":
          return this.verifyBearerGet("https://llm.submodel.ai/v1/models", apiKey);
        case "synthetic":
          return this.verifyBearerGet("https://api.synthetic.new/v1/models", apiKey);
        case "moark":
          return this.verifyBearerGet("https://moark.com/v1/models", apiKey);
        case "nova":
          return this.verifyBearerGet("https://api.nova.amazon.com/v1/models", apiKey);
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
      case "codex":
        return new CodexProvider(config);
      case "openrouter":
        return new OpenRouterProvider(config);
      case "cline":
        return new ClineProvider(config);
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
      // Popular alternatives
      case "deepseek":
        return new OpenAIProvider(config, "deepseek", "https://api.deepseek.com/v1");
      case "togetherai":
        return new OpenAIProvider(config, "togetherai", "https://api.together.ai/v1");
      case "cerebras":
        return new OpenAIProvider(config, "cerebras", "https://api.cerebras.ai/v1");
      case "fireworks":
        return new OpenAIProvider(config, "fireworks", "https://api.fireworks.ai/inference/v1");
      case "huggingface":
        return new OpenAIProvider(config, "huggingface", "https://api-inference.huggingface.co/v1");
      case "deepinfra":
        return new OpenAIProvider(config, "deepinfra", "https://api.deepinfra.com/v1");
      case "minimax":
        return new OpenAIProvider(config, "minimax", "https://api.minimax.chat/v1");
      case "moonshot":
        return new OpenAIProvider(config, "moonshot", "https://api.moonshot.ai/v1");
      case "ollama":
        return new OpenAIProvider(config, "ollama", process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1");
      case "ollamacloud":
        return new OpenAIProvider(config, "ollamacloud", "https://ollama.com/api");
      case "lmstudio":
        return new OpenAIProvider(config, "lmstudio", "http://localhost:1234/v1");
      case "llamacpp":
        return new OpenAIProvider(config, "llamacpp", "http://localhost:8080/v1");
      // AI Gateways
      case "cloudflare":
        return new OpenAIProvider(config, "cloudflare", "https://api.cloudflare.com/client/v4/accounts");
      case "cloudflareworkers":
        return new OpenAIProvider(config, "cloudflareworkers", "https://api.cloudflare.com/client/v4/accounts");
      case "vercel":
        return new OpenAIProvider(config, "vercel", "https://api.vercel.com");
      case "baseten":
        return new OpenAIProvider(config, "baseten", "https://api.baseten.co/v1");
      case "helicone":
        return new OpenAIProvider(config, "helicone", "https://api.helicone.ai/v1");
      case "portkey":
        return new OpenAIProvider(config, "portkey", "https://api.portkey.ai/v1");
      // High Performance
      case "hyperbolic":
        return new OpenAIProvider(config, "hyperbolic", "https://api.hyperbolic.xyz/v1");
      case "ionet":
        return new OpenAIProvider(config, "ionet", "https://api.intelligence.io.solutions/api/v1");
      // Chinese AI
      case "nebius":
        return new OpenAIProvider(config, "nebius", "https://api.nebius.ai/v1");
      case "zai":
        return new OpenAIProvider(config, "zai", "https://api.z.ai/v1");
      case "cortecs":
        return new OpenAIProvider(config, "cortecs", "https://api.cortecs.ai/v1");
      case "stepfun":
        return new OpenAIProvider(config, "stepfun", "https://api.stepfun.com/v1");
      case "qwen":
        return new OpenAIProvider(config, "qwen", "https://dashscope.aliyuncs.com/compatible-mode/v1");
      case "alibaba":
        return new OpenAIProvider(config, "alibaba", "https://dashscope.aliyuncs.com/compatible-mode/v1");
      case "zhipuai":
        return new OpenAIProvider(config, "zhipuai", "https://open.bigmodel.cn/api/paas/v4");
      case "modelscope":
        return new OpenAIProvider(config, "modelscope", "https://api.modelscope.cn/v1");
      // Open Source
      case "replicate":
        return new OpenAIProvider(config, "replicate", "https://api.replicate.com/v1");
      case "modal":
        return new OpenAIProvider(config, "modal", "https://api.modal.com/v1");
      case "scaleway":
        return new OpenAIProvider(config, "scaleway", "https://api.scaleway.com/llm/v1");
      case "venice":
        return new OpenAIProvider(config, "venice", "https://api.venice.ai/v1");
      case "zenmux":
        return new OpenAIProvider(config, "zenmux", "https://zenmux.ai/api/anthropic/v1");
      case "firmware":
        return new OpenAIProvider(config, "firmware", "https://api.firmware.ai/v1");
      // Enterprise
      case "azurecognitive":
        return new OpenAIProvider(config, "azurecognitive", "https://cognitiveservices.azure.com");
      case "sapai":
        return new OpenAIProvider(config, "sapai", "https://api.ai.sap.com/v1");
      case "stackit":
        return new OpenAIProvider(config, "stackit", "https://LLM.eu1.hana.ondemand.com/v1");
      case "ovhcloud":
        return new OpenAIProvider(config, "ovhcloud", "https://deploy.ai.ovh.net/v1");
      // Developer Platforms
      case "gitlab":
        return new OpenAIProvider(config, "gitlab", "https://gitlab.com/api/llm");
      case "antigravity":
        return null; // Google internal
      case "chromeai":
        return null; // Chrome built-in
      // Specialized
      case "mistralai":
        return new OpenAIProvider(config, "mistralai", "https://api.mistral.ai/v1");
      case "cohere":
        return new OpenAIProvider(config, "cohere", "https://api.cohere.ai/v1");
      case "perplexity":
        return new OpenAIProvider(config, "perplexity", "https://api.perplexity.ai/v1");
      case "luma":
        return new OpenAIProvider(config, "luma", "https://api.luma.ai/v1");
      case "fal":
        return new OpenAIProvider(config, "fal", "https://queue.fal.run");
      // Audio/Speech
      case "elevenlabs":
        return new OpenAIProvider(config, "elevenlabs", "https://api.elevenlabs.io/v1");
      case "deepgram":
        return new OpenAIProvider(config, "deepgram", "https://api.deepgram.com/v1");
      case "gladia":
        return new OpenAIProvider(config, "gladia", "https://api.gladia.io/v1");
      case "assemblyai":
        return new OpenAIProvider(config, "assemblyai", "https://api.assemblyai.com/v1");
      case "lmnt":
        return new OpenAIProvider(config, "lmnt", "https://api.lmnt.com/v1");
      // Other
      case "nvidia":
        return new OpenAIProvider(config, "nvidia", "https://integrate.api.nvidia.com/v1");
      case "nim":
        return new OpenAIProvider(config, "nim", "https://api.nimbleway.io/v1");
      case "friendliai":
        return new OpenAIProvider(config, "friendliai", "https://api.friendli.ai/v1");
      case "friendli":
        return new OpenAIProvider(config, "friendli", "https://api.friendli.ai/serverless/v1");
      case "voyageai":
        return new OpenAIProvider(config, "voyageai", "https://api.voyageai.com/v1");
      case "mixedbread":
        return new OpenAIProvider(config, "mixedbread", "https://api.mixedbread.ai/v1");
      case "mem0":
        return new OpenAIProvider(config, "mem0", "https://api.mem0.ai/v1");
      case "letta":
        return new OpenAIProvider(config, "letta", "https://api.letta.com/v1");
      case "blackforestlabs":
        return new OpenAIProvider(config, "blackforestlabs", "https://api.blackforestlabs.ai/v1");
      case "klingai":
        return new OpenAIProvider(config, "klingai", "https://api.klingai.com/v1");
      case "prodia":
        return new OpenAIProvider(config, "prodia", "https://api.prodia.com/v1");
      case "302ai":
        return new OpenAIProvider(config, "302ai", "https://api.302.ai/v1");
      case "opencodezen":
        return new OpenAIProvider(config, "opencodezen", "https://opencode.ai/zen/v1");
      // Additional from models.dev
      case "novita-ai":
        return new OpenAIProvider(config, "novita-ai", "https://api.novita.ai/v3/openai");
      case "upstage":
        return new OpenAIProvider(config, "upstage", "https://api.upstage.ai/v1/solar");
      case "v0":
        return new OpenAIProvider(config, "v0", "https://api.v0.dev/v1");
      case "siliconflow":
        return new OpenAIProvider(config, "siliconflow", "https://api.siliconflow.com/v1");
      case "abacus":
        return new OpenAIProvider(config, "abacus", "https://routellm.abacus.ai/v1");
      case "llama":
        return new OpenAIProvider(config, "llama", "https://api.llama.com/compat/v1");
      case "vultr":
        return new OpenAIProvider(config, "vultr", "https://api.vultrinference.com/v1");
      case "wandb":
        return new OpenAIProvider(config, "wandb", "https://api.inference.wandb.ai/v1");
      case "poe":
        return new OpenAIProvider(config, "poe", "https://api.poe.com/v1");
      // Additional from models.dev
      case "github-models":
        return new OpenAIProvider(config, "github-models", "https://models.github.ai/inference");
      case "requesty":
        return new OpenAIProvider(config, "requesty", "https://router.requesty.ai/v1");
      case "inference":
        return new OpenAIProvider(config, "inference", "https://inference.net/v1");
      case "submodel":
        return new OpenAIProvider(config, "submodel", "https://llm.submodel.ai/v1");
      case "synthetic":
        return new OpenAIProvider(config, "synthetic", "https://api.synthetic.new/v1");
      case "moark":
        return new OpenAIProvider(config, "moark", "https://moark.com/v1");
      case "nova":
        return new OpenAIProvider(config, "nova", "https://api.nova.amazon.com/v1");
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

  private verifyAzureCognitiveEnvironment(): { success: boolean; error?: string } {
    // Azure Cognitive Services requires API key and endpoint
    const apiKey = process.env.AZURE_COGNITIVE_API_KEY;
    const endpoint = process.env.AZURE_COGNITIVE_ENDPOINT;
    if (!apiKey || !endpoint) {
      return {
        success: false,
        error: "Azure Cognitive Services requires AZURE_COGNITIVE_API_KEY and AZURE_COGNITIVE_ENDPOINT environment variables.",
      };
    }
    return { success: true };
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
