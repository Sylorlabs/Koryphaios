// Clean Provider Registry - Only real providers with proper circuit breaker

import type { ProviderAuthMode, ProviderConfig, ProviderName, KoryphaiosConfig } from "@koryphaios/shared";
import { providerLog } from "../logger";
import {
  buildAuthHeaders,
  getVerifyUrl,
  maskApiKey,
  GEMINI_V1BETA_BASE,
  GEMINI_V1_BASE,
  PROVIDER_BASE_URLS,
} from "./api-endpoints";
import { AnthropicProvider } from "./anthropic";
import { detectGeminiCLIToken, detectCopilotToken } from "./auth-utils";
import { OpenAIProvider, GroqProvider, OpenRouterProvider, XAIProvider, AzureProvider } from "./openai";

import { GeminiProvider, GeminiCLIProvider } from "./gemini";
import { CopilotProvider, exchangeGitHubTokenForCopilotAsync } from "./copilot";

import { decryptApiKey, secureDecrypt, isUsingSecureEncryption } from "../security";
import { resolveModel, getModelsForProvider, isLegacyModel, type StreamRequest, type ProviderEvent, type Provider } from "./types";
import { withRetry } from "./utils";

// Environment variable mappings for real providers only
const ENV_API_KEY_MAP: Record<ProviderName, string[]> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  xai: ["XAI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  groq: ["GROQ_API_KEY"],
  copilot: [], // auth only - uses GitHub OAuth
  opencodezen: ["OPENCODE_ZEN_API_KEY"],
  azure: ["AZURE_OPENAI_API_KEY"],
  bedrock: ["AWS_ACCESS_KEY_ID"],
  vertexai: ["GOOGLE_VERTEX_AI_API_KEY"],
  local: [],
  ollama: [],
  "302ai": ["A302AI_API_KEY"],
  azurecognitive: ["AZURE_COGNITIVE_API_KEY"],
  baseten: ["BASETEN_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  cloudflare: ["CLOUDFLARE_API_TOKEN"],
  cortecs: ["CORTECS_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  deepinfra: ["DEEPINFRA_API_KEY"],
  firmware: ["FIRMWARE_API_KEY"],
  fireworks: ["FIREWORKS_API_KEY"],
  gitlab: ["GITLAB_API_KEY"],
  huggingface: ["HUGGINGFACE_API_KEY"],
  helicone: ["HELICONE_API_KEY"],
  llamacpp: [],
  ionet: ["IONET_API_KEY"],
  lmstudio: [],
  mistral: ["MISTRAL_API_KEY"],
  moonshot: ["MOONSHOT_API_KEY"],
  minimax: ["MINIMAX_API_KEY"],
  nebius: ["NEBIUS_API_KEY"],
  ollamacloud: ["OLLAMA_CLOUD_API_KEY"],
  sapai: ["AICORE_SERVICE_KEY"],
  stackit: ["STACKIT_API_KEY"],
  ovhcloud: ["OVHCLOUD_API_KEY"],
  scaleway: ["SCALEWAY_API_KEY"],
  togetherai: ["TOGETHER_API_KEY"],
  venice: ["VENICE_API_KEY"],
  vercel: ["VERCEL_AI_API_KEY"],
  zai: ["ZAI_API_KEY"],
  zenmux: ["ZENMUX_API_KEY"],
};

const ENV_URL_MAP: Partial<Record<ProviderName, string>> = {
  azure: "AZURE_OPENAI_ENDPOINT",
  local: "LOCAL_ENDPOINT",
  ollama: "OLLAMA_BASE_URL",
  openrouter: "OPENROUTER_BASE_URL",
  azurecognitive: "AZURE_COGNITIVE_RESOURCE_URL",
  llamacpp: "LLAMACPP_BASE_URL",
  lmstudio: "LMSTUDIO_BASE_URL",
};

const ENV_AUTH_TOKEN_MAP: Partial<Record<ProviderName, string[]>> = {
  anthropic: ["ANTHROPIC_AUTH_TOKEN"],
  copilot: ["GITHUB_COPILOT_TOKEN", "GITHUB_TOKEN"],
  azure: ["AZURE_OPENAI_AUTH_TOKEN"],
  google: ["GEMINI_AUTH_TOKEN"],
};

/** Default base URLs for OpenAI-compatible OpenCode parity providers (verify + chat use these). */
const OPENCODE_DEFAULT_BASE_URL: Partial<Record<ProviderName, string>> = {
  "302ai": "https://api.302.ai/v1",
  baseten: "https://api.baseten.co/v1",
  cerebras: "https://api.cerebras.ai/v1",
  cloudflare: "https://gateway.ai.cloudflare.com/v1",
  cortecs: "https://api.cortecs.ai/v1",
  deepseek: "https://api.deepseek.com",
  deepinfra: "https://api.deepinfra.com/v1",
  firmware: "https://api.firmware.ai/v1",
  fireworks: "https://api.fireworks.ai/inference/v1",
  gitlab: "https://gitlab.com/api/v4",
  helicone: "https://oai.hconeai.com/v1",
  huggingface: "https://api-inference.huggingface.co/v1",
  ionet: "https://api.io.net/v1",
  minimax: "https://api.minimax.chat/v1",
  moonshot: "https://api.moonshot.cn/v1",
  nebius: "https://api.nebius.com/v1",
  ollamacloud: "https://api.ollama.com/v1",
  ovhcloud: "https://ai.endpoints.ovh.net/v1",
  scaleway: "https://api.scaleway.com/llm/v1",
  stackit: "https://api.stackit.cloud/ai/v1",
  togetherai: "https://api.together.xyz/v1",
  venice: "https://api.venice.ai/v1",
  vercel: "https://ai.vercel.com/v1",
  zai: "https://api.z.ai/api/paas/v4",
  zenmux: "https://api.zenmux.ai/v1",
};
const LLAMACPP_DEFAULT = "http://127.0.0.1:8080/v1";
const LMSTUDIO_DEFAULT = "http://localhost:1234/v1";

const PROVIDER_AUTH_MODE: Record<ProviderName, ProviderAuthMode> = {
  anthropic: "api_key",
  openai: "api_key",
  google: "api_key_or_auth",
  xai: "api_key",
  openrouter: "api_key",
  groq: "api_key",
  copilot: "auth_only",
  opencodezen: "api_key",
  azure: "api_key_or_auth",
  bedrock: "env_auth",
  vertexai: "env_auth",
  local: "base_url_only",
  ollama: "base_url_only",
  "302ai": "api_key",
  azurecognitive: "api_key",
  baseten: "api_key",
  cerebras: "api_key",
  cloudflare: "api_key",
  cortecs: "api_key",
  deepseek: "api_key",
  deepinfra: "api_key",
  firmware: "api_key",
  fireworks: "api_key",
  gitlab: "api_key",
  huggingface: "api_key",
  helicone: "api_key",
  llamacpp: "base_url_only",
  ionet: "api_key",
  lmstudio: "base_url_only",
  mistral: "api_key",
  moonshot: "api_key",
  minimax: "api_key",
  nebius: "api_key",
  ollamacloud: "api_key",
  sapai: "api_key",
  stackit: "api_key",
  ovhcloud: "api_key",
  scaleway: "api_key",
  togetherai: "api_key",
  venice: "api_key",
  vercel: "api_key",
  zai: "api_key",
  zenmux: "api_key",
};

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
      providerLog.warn({ provider: name, failures: state.failures }, "Circuit breaker opened");
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
    allAvailableModels: string[];
    selectedModels: string[];
    hideModelSelector: boolean;
    authMode: ProviderAuthMode;
    supportsApiKey: boolean;
    supportsAuthToken: boolean;
    requiresBaseUrl: boolean;
    circuitOpen: boolean;
    error?: string;
  }> {
    const names = Object.keys(PROVIDER_AUTH_MODE) as ProviderName[];
    const result: Array<{
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
      circuitOpen: boolean;
      error?: string;
    }> = [];

    for (const name of names) {
      const provider = this.providers.get(name);
      const config = this.providerConfigs.get(name);
      const authMode = PROVIDER_AUTH_MODE[name];
      const circuitOpen = this.isCircuitOpen(name);

      const isProviderAvailable = provider?.isAvailable() ?? false;
      const isAuthenticated = isProviderAvailable ||
        (name === "copilot" && !!detectCopilotToken());

      // Include all providers - authenticated or not - so users can configure them

      const isEnabled = config ? !config.disabled : false;
      let allModels: string[] = [];
      if (isEnabled) {
        allModels = provider?.listModels().map((m) => m.id)
          ?? getModelsForProvider(name).map((m) => m.id);
      }

      const selectedModels = config?.selectedModels ?? [];
      const hideModelSelector = config?.hideModelSelector ?? false;



      const enabledModels = (selectedModels.length > 0)
        ? allModels.filter(id => selectedModels.includes(id))
        : allModels;

      result.push({
        name,
        enabled: true,
        authenticated: isProviderAvailable,
        models: enabledModels,
        allAvailableModels: allModels,
        selectedModels,
        hideModelSelector,
        authMode,
        supportsApiKey: authMode === "api_key" || authMode === "api_key_or_auth",
        supportsAuthToken: authMode === "api_key_or_auth",
        requiresBaseUrl: authMode === "base_url_only" || name === "azure",
        circuitOpen,
      });
    }

    return result;
  }

  /** All provider types that can be added (for "Add provider" UI). Not filtered by auth. */
  getAvailableProviderTypes(): Array<{ name: ProviderName; authMode: ProviderAuthMode }> {
    return (Object.keys(PROVIDER_AUTH_MODE) as ProviderName[]).map((name) => ({
      name,
      authMode: PROVIDER_AUTH_MODE[name],
    }));
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
      if (catalogProvider?.isAvailable() && !this.isCircuitOpen(catalogProvider.name)) return catalogProvider;
      // Catalog provider missing or unavailable: try user's preferred provider if it can serve this model, then any available provider.
      if (preferredProvider) {
        const preferred = this.providers.get(preferredProvider);
        if (preferred?.isAvailable() && !this.isCircuitOpen(preferredProvider) && preferred.listModels().some((m) => m.id === modelId))
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
      if (this.isCircuitOpen(provider.name)) continue;
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
    fallbackChain: string[] = []
  ): AsyncGenerator<ProviderEvent> {
    const chain = [request.model, ...fallbackChain];

    for (let i = 0; i < chain.length; i++) {
      const currentModel = chain[i];
      const provider = this.resolveProvider(currentModel, i === 0 ? preferredProvider : undefined);

      if (!provider) {
        if (i === chain.length - 1) {
          yield { type: "error", error: `No available provider for model: ${currentModel}` };
          return;
        }
        providerLog.warn({ model: currentModel }, "No provider available, trying fallback");
        continue;
      }

      // Check circuit breaker
      if (this.isCircuitOpen(provider.name)) {
        providerLog.warn({ provider: provider.name }, "Circuit breaker open, skipping");
        if (i === chain.length - 1) {
          yield { type: "error", error: `Provider ${provider.name} circuit breaker open` };
          return;
        }
        continue;
      }

      try {
        let hasContent = false;
        const stream = provider.streamResponse({ ...request, model: currentModel });

        for await (const event of stream) {
          if (this.isContentEvent(event)) hasContent = true;
          yield event;
        }

        if (hasContent) {
          this.recordSuccess(provider.name);
          return;
        }
        
        providerLog.warn({ model: currentModel, provider: provider.name }, "Empty response, trying fallback");
        this.recordFailure(provider.name);
      } catch (err: any) {
        providerLog.error({ model: currentModel, provider: provider.name, error: err.message }, "Provider error");
        this.recordFailure(provider.name);
        
        if (i === chain.length - 1) {
          yield { type: "error", error: err.message || "Unknown error" };
          return;
        }
        providerLog.info("Trying next model in fallback chain");
      }
    }
  }

  private isContentEvent(event: ProviderEvent): boolean {
    return event.type === "content_delta" || event.type === "thinking_delta" || event.type === "tool_use_start";
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

    try {
      switch (name) {
        case "anthropic": {
          if (!apiKey && !authToken) return { success: false, error: "Missing apiKey or authToken" };
          const { headers } = buildAuthHeaders(name, { apiKey, authToken });
          const url = getVerifyUrl(name, undefined, { apiKey, authToken }) || `${PROVIDER_BASE_URLS.anthropic}/models`;
          const res = await this.verifyHttpWithStatus(url, { method: "GET", headers });
          if (res.success) return { success: true };
          if (res.status === 401) {
            this.markKeyInvalid(name, res.error ?? "Unauthorized");
            const config = this.providerConfigs.get(name);
            if (config) {
              config.disabled = true;
              this.providers.delete(name);
            }
          }
          return { success: false, error: res.error };
        }
        case "openai":
          return this.verifyBearerGet("https://api.openai.com/v1/models", apiKey);
        case "google": {
          if (authToken?.startsWith("cli:") || (!apiKey && !authToken)) {
            if (!Bun.which("gemini")) {
              return { success: false, error: "gemini CLI not found in PATH" };
            }
            return { success: true };
          }
          if (!apiKey) return { success: false, error: "Missing apiKey" };
          // Gemini 3.1 / Thinking: v1beta often required; support ?key= and x-goog-api-key as fallbacks.
          const creds = { apiKey, authToken };
          const tryUrl = (base: string, useHeader: boolean) => {
            const path = `${base.replace(/\/?$/, "")}/models`;
            if (useHeader) {
              const { headers } = buildAuthHeaders(name, creds, { useGeminiHeader: true });
              return this.verifyHttpWithStatus(path, { method: "GET", headers });
            }
            const urlWithKey = `${path}?key=${encodeURIComponent(apiKey!)}`;
            return this.verifyHttpWithStatus(urlWithKey, {
              method: "GET",
              headers: { "Content-Type": "application/json", "User-Agent": "Koryphaios/1.0" },
            });
          };
          let result = await tryUrl(GEMINI_V1BETA_BASE, false);
          if (result.success) return { success: true };
          if (result.status === 401) {
            this.markKeyInvalid(name, result.error ?? "Unauthorized");
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
                const { getDb } = require("../db/sqlite");
                getDb()
                  .prepare(
                    "INSERT OR REPLACE INTO provider_endpoint_override (provider, base_url, updated_at) VALUES (?, ?, ?)"
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
        case "copilot": {
          const token = authToken ?? detectCopilotToken();
          if (!token) return { success: false, error: "GitHub Copilot token not found" };
          const bearer = await exchangeGitHubTokenForCopilotAsync(token);
          if (!bearer) return { success: false, error: "Failed to exchange GitHub token for Copilot bearer" };
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
        case "mistral":
          return this.verifyBearerGet("https://api.mistral.ai/v1/models", apiKey);
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
        case "ollama": {
          if (!baseUrl) return { success: false, error: "Missing baseUrl (e.g. http://localhost:11434)" };
          const trimmed = baseUrl.replace(/\/+$/, "");
          return this.verifyHttp(`${trimmed}/api/tags`);
        }
        case "bedrock":
          return this.verifyBedrockEnvironment();
        case "vertexai":
          return this.verifyVertexEnvironment();
        case "opencodezen": {
          if (!apiKey) return { success: false, error: "Missing API key (get one at opencode.ai/auth)" };
          const base = "https://opencode.ai/zen/v1";
          return this.verifyBearerGet(`${base}/models`, apiKey);
        }
        case "llamacpp": {
          const url = baseUrl ?? LLAMACPP_DEFAULT;
          if (!url) return { success: false, error: "Missing baseUrl (e.g. http://127.0.0.1:8080/v1)" };
          return this.verifyHttp(`${url.replace(/\/v1\/?$/, "")}/v1/models`);
        }
        case "lmstudio": {
          const url = baseUrl ?? LMSTUDIO_DEFAULT;
          if (!url) return { success: false, error: "Missing baseUrl (e.g. http://localhost:1234/v1)" };
          return this.verifyHttp(`${url.replace(/\/v1\/?$/, "")}/v1/models`);
        }
        case "azurecognitive": {
          if (!apiKey) return { success: false, error: "Missing API key" };
          if (!baseUrl) return { success: false, error: "Missing baseUrl (e.g. https://YOUR_RESOURCE.cognitiveservices.azure.com)" };
          const trimmed = baseUrl.replace(/\/+$/, "");
          return this.verifyHttp(`${trimmed}/openai/deployments?api-version=2024-02-15-preview`, {
            headers: { "api-key": apiKey },
          });
        }
        case "sapai": {
          if (!apiKey) return { success: false, error: "Missing service key (JSON from SAP BTP Cockpit)" };
          if (!baseUrl) return { success: false, error: "Missing baseUrl from service key (AI_API_URL)" };
          const trimmed = baseUrl.replace(/\/+$/, "");
          return this.verifyHttp(`${trimmed}/openai/deployments`, { headers: { Authorization: `Bearer ${apiKey}` } });
        }
        case "zai": {
          // Z.AI uses https://api.z.ai/api/paas/v4 and does not expose GET /models; verify via minimal chat request
          if (!apiKey) return { success: false, error: "Missing API key" };
          const base = baseUrl?.replace(/\/+$/, "") ?? "https://api.z.ai/api/paas/v4";
          return this.verifyHttp(`${base}/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model: "glm-5",
              messages: [{ role: "user", content: "Hi" }],
              max_tokens: 1,
            }),
          });
        }
        default: {
          const defaultBase = OPENCODE_DEFAULT_BASE_URL[name];
          if (defaultBase && apiKey) return this.verifyBearerGet(`${defaultBase.replace(/\/?$/, "")}/models`, apiKey);
          if (defaultBase) return { success: false, error: "Missing API key" };
          return { success: false, error: `Unsupported provider: ${name}` };
        }
      }
    } catch (err: any) {
      return { success: false, error: err?.message ?? String(err) };
    }
  }

  /** Set/update provider credentials. */
  setCredentials(
    name: ProviderName,
    credentials: { apiKey?: string; authToken?: string; baseUrl?: string; selectedModels?: string[]; hideModelSelector?: boolean },
  ): { success: boolean; error?: string } {
    try {
      const existing = this.providerConfigs.get(name);
      const validation = this.validateCredentials(name, credentials, existing);
      if (!validation.success) return validation;

      const providerConfig: ProviderConfig = {
        name,
        apiKey: credentials.apiKey?.trim() ?? existing?.apiKey,
        authToken: credentials.authToken?.trim() ?? existing?.authToken,
        baseUrl: credentials.baseUrl?.trim() ?? existing?.baseUrl,
        selectedModels: credentials.selectedModels ?? existing?.selectedModels,
        hideModelSelector: credentials.hideModelSelector ?? existing?.hideModelSelector,
        disabled: false,
        headers: existing?.headers,
      };

      this.providerConfigs.set(name, providerConfig);

      const provider = this.createProvider(name, providerConfig);
      if (provider) {
        this.providers.set(name, provider);
        this.circuitStates.delete(name); // Reset circuit breaker
        this.clearKeyInvalid(name); // New key may be valid
        providerLog.info({ provider: name }, "Provider configured");
        return { success: true };
      }
      return { success: false, error: "Failed to initialize provider" };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  private validateCredentials(
    name: ProviderName,
    credentials: { apiKey?: string; authToken?: string; baseUrl?: string },
    existing?: ProviderConfig
  ): { success: boolean; error?: string } {
    const authMode = PROVIDER_AUTH_MODE[name];
    const apiKey = credentials.apiKey?.trim();
    const authToken = credentials.authToken?.trim();
    const baseUrl = credentials.baseUrl?.trim();

    if (authMode === "auth_only" && apiKey) {
      return { success: false, error: `${name} uses account auth only and does not accept API keys` };
    }

    if (authMode === "auth_only") {
      const hasAuth = !!(authToken || existing?.authToken) || (name === "copilot" && !!detectCopilotToken());
      if (!hasAuth) return { success: false, error: "authToken is required" };
    }

    if (authMode === "api_key" && !apiKey) {
      return { success: false, error: "apiKey is required" };
    }

    if (authMode === "api_key_or_auth" && !apiKey && !authToken && !existing?.authToken) {
      return { success: false, error: "Provide apiKey or authToken" };
    }

    if (authMode === "env_auth") {
      const envReady = name === "bedrock" ? this.hasBedrockEnvironment() : this.hasVertexEnvironment();
      if (!envReady) return { success: false, error: `${name} environment credentials not detected` };
    }

    if (authMode === "base_url_only" && !baseUrl && !existing?.baseUrl) {
      return { success: false, error: "baseUrl is required" };
    }

    return { success: true };
  }

  /** Force-refresh a provider instance from current stored config. */
  refreshProvider(name: ProviderName): { success: boolean; error?: string } {
    const config = this.providerConfigs.get(name);
    if (!config) return { success: false, error: "Provider config not found" };
    try {
      const provider = this.createProvider(name, config);
      if (!provider) return { success: false, error: "Failed to initialize provider" };
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
    providerLog.info({ provider: name }, "Provider disconnected");
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
    for (const name of Object.keys(PROVIDER_AUTH_MODE) as ProviderName[]) {
      const providerConfig = this.buildProviderConfig(name);
      this.providerConfigs.set(name, providerConfig);

      try {
        const provider = this.createProvider(name, providerConfig);
        if (provider) this.providers.set(name, provider);
      } catch (error) {
        providerLog.error({ provider: name, error }, "Failed to initialize provider");
      }
    }
    this.logProviderStatus();
  }

  private buildProviderConfig(name: ProviderName): ProviderConfig {
    const userConfig = this.config?.providers?.[name];
    const providerConfig: ProviderConfig = {
      name,
      apiKey: userConfig?.apiKey ?? this.detectEnvKey(name) ?? undefined,
      authToken: userConfig?.authToken ?? this.detectEnvAuthToken(name) ?? undefined,
      baseUrl: userConfig?.baseUrl ?? this.detectEnvUrl(name) ?? undefined,
      selectedModels: userConfig?.selectedModels ?? [],
      hideModelSelector: userConfig?.hideModelSelector ?? false,
      disabled: userConfig?.disabled ?? false,
      headers: userConfig?.headers,
    };

    // Providers enabled by default - auth checked at runtime

    return providerConfig;
  }

  private hasValidAuth(name: ProviderName, config: ProviderConfig): boolean {
    const authMode = PROVIDER_AUTH_MODE[name];
    const hasApi = !!config.apiKey;
    const hasAuth = !!config.authToken ||
      (name === "copilot" && !!detectCopilotToken());
    const hasUrl = !!config.baseUrl;

    const hasAnyAuth =
      (authMode === "api_key" && hasApi) ||
      (authMode === "auth_only" && hasAuth) ||
      (authMode === "api_key_or_auth" && (hasApi || hasAuth)) ||
      (authMode === "env_auth" && (name === "bedrock" ? this.hasBedrockEnvironment() : this.hasVertexEnvironment())) ||
      (authMode === "base_url_only" && (hasUrl || name === "lmstudio" || name === "llamacpp"));

    if (hasAnyAuth) return true;

    // Provider has no auth — it will fail at runtime when called
    return false;
  }

  private createProvider(name: ProviderName, config: ProviderConfig): Provider | null {
    switch (name) {
      case "anthropic":
        return new AnthropicProvider(config);
      case "openai":
        return new OpenAIProvider(config);
      case "google":
        // API key takes priority — use direct Gemini API
        if (config.apiKey) return new GeminiProvider(config);
        // Fall back to CLI if explicitly set or auto-detected
        if (config.authToken?.startsWith("cli:") || detectGeminiCLIToken()) {
          const cliProvider = new GeminiCLIProvider(config);
          if (cliProvider.isAvailable()) return cliProvider;
        }
        return null;
      case "copilot":
        return new CopilotProvider(config);
      case "cline":
        return new ClineProvider(config);
      case "openrouter":
        return new OpenRouterProvider(config);
      case "groq":
        return new GroqProvider(config);
      case "xai":
        return new XAIProvider(config);
      case "azure":
        return new AzureProvider(config);
      case "bedrock":
        return new OpenAIProvider(config, "bedrock", config.baseUrl);
      case "vertexai":
        return new GeminiProvider({ ...config, name: "vertexai" });
      case "local":
        if (config.baseUrl) {
          return new OpenAIProvider(config, "local", config.baseUrl);
        }
        return null;
      case "ollama":
        if (config.baseUrl) {
          return new OpenAIProvider(config, "ollama", config.baseUrl);
        }
        return null;
      case "opencodezen":
        if (config.apiKey) {
          return new OpenAIProvider(
            config,
            "opencodezen" as ProviderName,
            config.baseUrl ?? "https://opencode.ai/zen/v1",
          );
        }
        return null;
      case "llamacpp":
        if (config.baseUrl) {
          return new OpenAIProvider(config, "llamacpp", config.baseUrl);
        }
        return new OpenAIProvider(config, "llamacpp", LLAMACPP_DEFAULT);
      case "lmstudio":
        if (config.baseUrl) {
          return new OpenAIProvider(config, "lmstudio", config.baseUrl);
        }
        return new OpenAIProvider(config, "lmstudio", LMSTUDIO_DEFAULT);
      default: {
        const defaultBase = OPENCODE_DEFAULT_BASE_URL[name];
        if (defaultBase && config.apiKey) {
          return new OpenAIProvider(config, name, config.baseUrl ?? defaultBase);
        }
        if (name === "sapai" && config.apiKey && config.baseUrl) {
          return new OpenAIProvider(config, "sapai", config.baseUrl);
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
      if (val.startsWith("env:")) return null;
      return decryptApiKey(val);
    }
    return null;
  }

  private detectEnvAuthToken(name: ProviderName): string | null {
    const envVars = ENV_AUTH_TOKEN_MAP[name] ?? [];
    for (const envVar of envVars) {
      const val = process.env[envVar];
      if (!val) continue;
      if (val.startsWith("env:")) return null;
      return decryptApiKey(val);
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
        if (val?.startsWith("env:")) {
          try {
            apiKey = await secureDecrypt(val);
            break;
          } catch {
            providerLog.warn({ provider: name, envVar }, "Failed to decrypt stored API key");
          }
        }
      }
      for (const envVar of ENV_AUTH_TOKEN_MAP[name] ?? []) {
        const val = process.env[envVar];
        if (val?.startsWith("env:")) {
          try {
            authToken = await secureDecrypt(val);
            break;
          } catch {
            providerLog.warn({ provider: name, envVar }, "Failed to decrypt stored auth token");
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
      (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY)
      || process.env.AWS_PROFILE
    );
  }

  private hasVertexEnvironment(): boolean {
    return !!(
      process.env.GOOGLE_APPLICATION_CREDENTIALS
      || (process.env.GOOGLE_CLOUD_PROJECT && process.env.GOOGLE_CLOUD_REGION)
    );
  }

  private verifyBedrockEnvironment(): { success: boolean; error?: string } {
    if (this.hasBedrockEnvironment()) return { success: true };
    return { success: false, error: "AWS credentials not detected" };
  }

  private verifyVertexEnvironment(): { success: boolean; error?: string } {
    if (this.hasVertexEnvironment()) return { success: true };
    return { success: false, error: "Vertex AI credentials not detected" };
  }

  private logProviderStatus() {
    const available = this.getAvailable();
    const names = available.map((p) => p.name);
    providerLog.info({ providers: names }, "Providers ready");

    if (names.length === 0) {
      providerLog.warn("No providers configured - set API keys in .env");
    }
  }

  private async verifyBearerGet(url: string, token?: string | null): Promise<{ success: boolean; error?: string }> {
    if (!token) return { success: false, error: "Missing token" };
    return this.verifyHttp(url, { headers: { Authorization: `Bearer ${token}` } });
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
    const err = (result.error ?? "").toLowerCase();
    const outOfCredits =
      err.includes("quota") ||
      err.includes("credit") ||
      err.includes("insufficient") ||
      err.includes("out of credits");
    return { ok: false, error: result.error, outOfCredits };
  }

  /** Persist invalid key state (401). No-op if DB not initialized. */
  private markKeyInvalid(name: ProviderName, lastError: string): void {
    try {
      const { getDb } = require("../db/sqlite");
      getDb()
        .prepare(
          "INSERT OR REPLACE INTO provider_key_invalid (provider, invalid_since, last_error) VALUES (?, ?, ?)"
        )
        .run(name, Date.now(), lastError);
      const config = this.providerConfigs.get(name);
      providerLog.warn(
        { provider: name, keyMask: maskApiKey(config?.apiKey ?? config?.authToken) },
        "API key marked invalid (401); update key in settings"
      );
    } catch {
      // DB not initialized (e.g. tests)
    }
  }

  /** Clear invalid key state (e.g. after user updates key). */
  clearKeyInvalid(name: ProviderName): void {
    try {
      const { getDb } = require("../db/sqlite");
      getDb().run("DELETE FROM provider_key_invalid WHERE provider = ?", name);
    } catch {
      // DB not initialized
    }
  }

  /** Check if provider was previously marked invalid. */
  private isKeyMarkedInvalid(name: ProviderName): boolean {
    try {
      const { getDb } = require("../db/sqlite");
      const row = getDb()
        .query<{ provider: string }>("SELECT provider FROM provider_key_invalid WHERE provider = ?")
        .get(name);
      return !!row;
    } catch {
      return false;
    }
  }

  /** Like verifyHttp but returns status for 401/404 handling. */
  private async verifyHttpWithStatus(
    url: string,
    init?: RequestInit
  ): Promise<{ success: boolean; status?: number; error?: string }> {
    const timeoutMs = 5_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = new Headers(init?.headers ?? {});
      if (!headers.has("User-Agent")) headers.set("User-Agent", "Koryphaios/1.0");
      const response = await fetch(url, {
        method: "GET",
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
      if (msg.includes("abort") || msg.includes("timeout")) {
        return { success: false, error: "Request timeout (5s)" };
      }
      return { success: false, error: msg };
    } finally {
      clearTimeout(timer);
    }
  }

  private async verifyHttp(url: string, init?: RequestInit): Promise<{ success: boolean; error?: string }> {
    const res = await this.verifyHttpWithStatus(url, init);
    return { success: res.success, error: res.error };
  }
}

export { ProviderRegistry };
