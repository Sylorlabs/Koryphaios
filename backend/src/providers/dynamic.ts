// Dynamic OpenAI-Compatible Provider
// Supports unlimited OpenAI-compatible endpoints with full feature parity:
// - Cost tracking via credit-accountant
// - Circuit breaker integration
// - Custom headers and auth
// - Model discovery
// - Provider presets for common services
// - Custom reasoning mode configuration
//
// NEXT STEPS for full integration:
// 1. Add REST API endpoints in routes/providers.ts (TODOs already added)
// 2. Create Svelte components for add/edit dynamic providers
// 3. Update provider store to handle dynamic provider CRUD
// 4. Add config persistence for dynamicProviders array
// 5. Write tests for dynamic provider functionality
// See: NEXT_STEPS_DYNAMIC_PROVIDERS.md for detailed plan

import type { 
  ProviderConfig, 
  ProviderName, 
  ModelDef, 
  ReasoningConfig,
  DynamicProviderConfig as SharedDynamicProviderConfig,
} from "@koryphaios/shared";
import { 
  applyReasoningConfig,
  supportsReasoning,
  DEFAULT_REASONING_CONFIG,
} from "@koryphaios/shared";
import OpenAI from "openai";
import {
  type Provider,
  type ProviderEvent,
  type StreamRequest,
  getModelsForProvider,
  resolveModel,
  createGenericModel,
} from "./types";
import { withRetry, withTimeoutSignal } from "./utils";
import { createUsageInterceptingFetch } from "../credit-accountant";
import { providerLog } from "../logger";
import { OpenAIProvider } from "./openai";

// ─── Provider Presets ───────────────────────────────────────────────────────
// Pre-configured settings for popular OpenAI-compatible providers

export interface ProviderPreset {
  name: string;
  displayName: string;
  baseUrl: string;
  defaultModels?: string[];
  headers?: Record<string, string>;
  envVar?: string;
  description?: string;
  docsUrl?: string;
  icon?: string;
}

export const DYNAMIC_PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  fireworks: {
    name: "fireworks",
    displayName: "Fireworks AI",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    defaultModels: [
      "accounts/fireworks/models/llama-v3p1-405b-instruct",
      "accounts/fireworks/models/llama-v3p1-70b-instruct",
      "accounts/fireworks/models/mixtral-8x22b-instruct",
    ],
    envVar: "FIREWORKS_API_KEY",
    description: "Fast inference for open-source models",
    docsUrl: "https://docs.fireworks.ai",
  },
  together: {
    name: "together",
    displayName: "Together AI",
    baseUrl: "https://api.together.xyz/v1",
    defaultModels: [
      "meta-llama/Llama-3.3-70B-Instruct-Turbo",
      "meta-llama/Llama-3.1-405B-Instruct-Turbo",
      "Qwen/Qwen2.5-72B-Instruct-Turbo",
    ],
    envVar: "TOGETHER_API_KEY",
    description: "Inference for open-source models",
    docsUrl: "https://docs.together.ai",
  },
  perplexity: {
    name: "perplexity",
    displayName: "Perplexity",
    baseUrl: "https://api.perplexity.ai",
    defaultModels: [
      "sonar-pro",
      "sonar-reasoning-pro",
      "sonar",
    ],
    envVar: "PERPLEXITY_API_KEY",
    description: "Search-grounded AI models",
    docsUrl: "https://docs.perplexity.ai",
  },
  deepinfra: {
    name: "deepinfra",
    displayName: "DeepInfra",
    baseUrl: "https://api.deepinfra.com/v1/openai",
    defaultModels: [
      "meta-llama/Meta-Llama-3.1-405B-Instruct",
      "meta-llama/Meta-Llama-3.1-70B-Instruct",
      "Qwen/Qwen2.5-72B-Instruct",
    ],
    envVar: "DEEPINFRA_API_KEY",
    description: "Serverless inference for open models",
    docsUrl: "https://deepinfra.com",
  },
  cerebras: {
    name: "cerebras",
    displayName: "Cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    defaultModels: [
      "llama3.1-70b",
      "llama3.1-8b",
    ],
    envVar: "CEREBRAS_API_KEY",
    description: "Fast inference on specialized hardware",
    docsUrl: "https://docs.cerebras.ai",
  },
  mistral: {
    name: "mistral",
    displayName: "Mistral AI",
    baseUrl: "https://api.mistral.ai/v1",
    defaultModels: [
      "mistral-large-latest",
      "mistral-medium-latest",
      "codestral-latest",
    ],
    envVar: "MISTRAL_API_KEY",
    description: "European AI models",
    docsUrl: "https://docs.mistral.ai",
  },
  ai21: {
    name: "ai21",
    displayName: "AI21 Labs",
    baseUrl: "https://api.ai21.com/studio/v1",
    defaultModels: [
      "jamba-1.5-large",
      "jamba-1.5-mini",
    ],
    envVar: "AI21_API_KEY",
    description: "Jamba foundation models",
    docsUrl: "https://docs.ai21.com",
  },
  hyperbolic: {
    name: "hyperbolic",
    displayName: "Hyperbolic",
    baseUrl: "https://api.hyperbolic.xyz/v1",
    defaultModels: [
      "meta-llama/Meta-Llama-3.1-405B-Instruct",
      "meta-llama/Meta-Llama-3.1-70B-Instruct",
    ],
    envVar: "HYPERBOLIC_API_KEY",
    description: "GPU marketplace with inference API",
    docsUrl: "https://docs.hyperbolic.xyz",
  },
  novita: {
    name: "novita",
    displayName: "Novita AI",
    baseUrl: "https://api.novita.ai/v3/openai",
    defaultModels: [
      "meta-llama/llama-3.1-405b-instruct",
      "meta-llama/llama-3.1-70b-instruct",
      "qwen/qwen-2.5-72b-instruct",
    ],
    envVar: "NOVITA_API_KEY",
    description: "Serverless LLM inference",
    docsUrl: "https://novita.ai/docs",
  },
  siliconflow: {
    name: "siliconflow",
    displayName: "SiliconFlow",
    baseUrl: "https://api.siliconflow.cn/v1",
    defaultModels: [
      "deepseek-ai/DeepSeek-V2.5",
      "Qwen/Qwen2.5-72B-Instruct",
    ],
    envVar: "SILICONFLOW_API_KEY",
    description: "Chinese AI model hosting",
    docsUrl: "https://docs.siliconflow.cn",
  },
  opencodezen: {
    name: "opencodezen",
    displayName: "OpenCode Zen",
    baseUrl: "https://opencode.ai/zen/v1",
    defaultModels: [
      // Claude models (Anthropic)
      "claude-3-7-sonnet",
      "claude-3-5-sonnet",
      "claude-3-5-haiku",
      "claude-3-opus",
      "claude-3-haiku",
      // Gemini models (Google)
      "gemini-2.0-pro",
      "gemini-2.0-flash",
      "gemini-1.5-pro",
      "gemini-1.5-flash",
      // GPT models (OpenAI)
      "gpt-4o",
      "gpt-4o-mini",
      "o1",
      "o1-mini",
      "o3-mini",
      "gpt-4-turbo",
      "gpt-4",
      // GLM models
      "glm-5",
      "glm-4.7",
      "glm-4.6",
      // MiniMax models
      "minimax-m2.5",
      "minimax-m2.5-free",
      "minimax-m2.1",
      // Kimi models
      "kimi-k2.5",
      "kimi-k2",
      "kimi-k2-thinking",
      // Other models
      "trinity-large-preview-free",
      "big-pickle",
    ],
    envVar: "OPENCODE_ZEN_API_KEY",
    description: "Curated coding models via OpenCode Zen gateway (31 models)",
    docsUrl: "https://opencode.ai/docs/zen",
  },
  // Generic/custom option
  custom: {
    name: "custom",
    displayName: "Custom Provider",
    baseUrl: "",
    envVar: "",
    description: "Any OpenAI-compatible endpoint",
    docsUrl: "",
  },
};

// ─── Dynamic Provider Configuration ─────────────────────────────────────────

export interface DynamicProviderConfig extends ProviderConfig {
  /** Preset identifier or 'custom' */
  preset?: string;
  /** Human-readable display name */
  displayName?: string;
  /** Custom headers to include in requests */
  headers?: Record<string, string>;
  /** Model ID mappings (if provider uses different model IDs) */
  modelMappings?: Record<string, string>;
  /** Whether this provider supports function calling */
  supportsTools?: boolean;
  /** Whether this provider supports streaming */
  supportsStreaming?: boolean;
  /** 
   * Default reasoning configuration for this provider
   * Controls thinking/reasoning effort for supported models
   */
  reasoning?: ReasoningConfig;
  /**
   * Per-model reasoning overrides
   * Key: model ID, Value: reasoning config for that specific model
   */
  modelReasoning?: Record<string, ReasoningConfig>;
}

// ─── Dynamic OpenAI Provider Implementation ─────────────────────────────────

export class DynamicOpenAIProvider implements Provider {
  readonly name: ProviderName;
  readonly isDynamic: true = true;
  private _client: OpenAI | null = null;
  private readonly preset?: ProviderPreset;

  constructor(readonly config: DynamicProviderConfig) {
    this.name = config.name;
    this.preset = config.preset
      ? DYNAMIC_PROVIDER_PRESETS[config.preset]
      : undefined;
  }

  /** Resolved base URL: config > preset > undefined */
  private get baseUrl(): string | undefined {
    return this.config.baseUrl ?? this.preset?.baseUrl;
  }

  /** Resolved headers: config headers merged with preset headers */
  private get headers(): Record<string, string> | undefined {
    const presetHeaders = this.preset?.headers ?? {};
    const configHeaders = this.config.headers ?? {};
    const merged = { ...presetHeaders, ...configHeaders };
    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  protected get client(): OpenAI {
    if (!this._client) {
      const apiKey = this.config.apiKey || this.config.authToken;
      const baseUrl = this.baseUrl;

      if (!baseUrl && !apiKey) {
        throw new Error(
          `Dynamic provider "${this.name}" requires either baseUrl or apiKey`
        );
      }

      this._client = new OpenAI({
        apiKey: apiKey || "placeholder",
        baseURL: baseUrl,
        defaultHeaders: this.headers,
        fetch: createUsageInterceptingFetch(globalThis.fetch),
      });
    }
    return this._client;
  }

  isAvailable(): boolean {
    if (this.config.disabled) return false;
    
    // Check for API key or auth token
    const hasAuth = !!(this.config.apiKey || this.config.authToken);
    
    // Check environment variable if preset defines one
    const envVar = this.preset?.envVar;
    const hasEnvVar = envVar ? !!process.env[envVar] : false;
    
    return hasAuth || hasEnvVar;
  }

  /** Get display name for UI */
  getDisplayName(): string {
    return (
      this.config.displayName ??
      this.preset?.displayName ??
      this.name
    );
  }

  /** Get description for UI */
  getDescription(): string | undefined {
    return this.preset?.description;
  }

  /** Get documentation URL */
  getDocsUrl(): string | undefined {
    return this.preset?.docsUrl;
  }

  private cachedModels: ModelDef[] | null = null;
  private lastFetch = 0;
  private fetchInProgress = false;

  listModels(): ModelDef[] {
    // Return user-selected models if configured
    if (this.config.selectedModels?.length) {
      return this.config.selectedModels.map((id) =>
        createGenericModel(id, this.name)
      );
    }

    // Try to fetch from API first (if available)
    if (this.isAvailable()) {
      // Return cached if fresh (5 min)
      if (this.cachedModels && Date.now() - this.lastFetch < 5 * 60 * 1000) {
        return this.cachedModels;
      }

      // Trigger background refresh
      this.refreshModelsInBackground();
      
      // Return cached models if available, otherwise fall back to presets
      if (this.cachedModels) {
        return this.cachedModels;
      }
    }

    // Fall back to preset models if API not available or no cache yet
    if (this.preset?.defaultModels) {
      return this.preset.defaultModels.map((id) =>
        createGenericModel(id, this.name)
      );
    }

    return [];
  }

  private refreshModelsInBackground() {
    if (this.fetchInProgress) return;
    this.fetchInProgress = true;

    withRetry(() => this.client.models.list())
      .then(async (response) => {
        const remoteModels: ModelDef[] = [];
        for await (const model of response) {
          const id = model.id;
          // Apply model mapping if configured
          const mappedId = this.config.modelMappings?.[id] ?? id;
          remoteModels.push(createGenericModel(mappedId, this.name));
        }
        this.cachedModels = remoteModels;
        this.lastFetch = Date.now();
      })
      .catch((err) => {
        providerLog.warn(
          { provider: this.name, error: err.message },
          "Failed to fetch models for dynamic provider"
        );
      })
      .finally(() => {
        this.fetchInProgress = false;
      });
  }

  async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    // Determine reasoning config for this request
    // Check for per-model override first, then fall back to provider default
    const modelId = request.model;
    const reasoningConfig = this.config.modelReasoning?.[modelId] 
      ?? this.config.reasoning 
      ?? DEFAULT_REASONING_CONFIG;

    // Check if model supports reasoning
    const modelSupportsReasoning = supportsReasoning(modelId, this.name);
    
    // Only apply reasoning if model supports it and mode is not disabled
    const shouldApplyReasoning = modelSupportsReasoning && reasoningConfig.mode !== "disabled";

    providerLog.debug(
      { 
        provider: this.name, 
        model: modelId, 
        reasoningMode: reasoningConfig.mode,
        supportsReasoning: modelSupportsReasoning,
        applying: shouldApplyReasoning 
      },
      "Dynamic provider reasoning configuration"
    );

    // Use OpenAIProvider's implementation via delegation
    // Pass reasoning config so it can be applied to the API request
    const openAiProvider = new OpenAIProvider(
      {
        ...this.config,
        baseUrl: this.baseUrl,
        headers: this.headers,
      },
      this.name,
      this.baseUrl
    );

    // Apply reasoning configuration to the request if supported
    let modifiedRequest = request;
    if (shouldApplyReasoning) {
      modifiedRequest = {
        ...request,
        reasoningLevel: reasoningConfig.mode, // Pass reasoning mode via existing reasoningLevel field
        // Store full reasoning config for provider to use
        // @ts-ignore - extending StreamRequest with our config
        _reasoningConfig: reasoningConfig,
      };
    }

    // Delegate to OpenAI provider with our intercepted fetch and modified request
    yield* openAiProvider.streamResponse(modifiedRequest);
  }

  /** Get configuration for saving/exporting */
  toConfig(): DynamicProviderConfig {
    return {
      ...this.config,
      preset: this.preset?.name,
      displayName: this.getDisplayName(),
    };
  }

  /** 
   * Get the current reasoning configuration for a model
   * Returns per-model config if set, otherwise provider default
   */
  getReasoningConfig(modelId?: string): ReasoningConfig {
    if (modelId && this.config.modelReasoning?.[modelId]) {
      return this.config.modelReasoning[modelId];
    }
    return this.config.reasoning ?? DEFAULT_REASONING_CONFIG;
  }

  /**
   * Update the default reasoning configuration for this provider
   */
  setReasoningConfig(config: ReasoningConfig): void {
    this.config.reasoning = config;
  }

  /**
   * Update reasoning configuration for a specific model
   */
  setModelReasoningConfig(modelId: string, config: ReasoningConfig): void {
    if (!this.config.modelReasoning) {
      this.config.modelReasoning = {};
    }
    this.config.modelReasoning[modelId] = config;
  }

  /**
   * Check if a model supports reasoning
   */
  modelSupportsReasoning(modelId: string): boolean {
    return supportsReasoning(modelId, this.name);
  }

  /**
   * Test the provider connection
   * Returns success status, error message, and available models
   */
  async testConnection(): Promise<{ success: boolean; error?: string; models?: string[] }> {
    try {
      // Try to list models
      const response = await this.client.models.list();
      const models: string[] = [];
      for await (const model of response) {
        models.push(model.id);
      }
      return { success: true, models };
    } catch (err: any) {
      return { 
        success: false, 
        error: err.message || "Connection test failed" 
      };
    }
  }
}

// ─── Factory Functions ──────────────────────────────────────────────────────

/** Create a dynamic provider from a preset */
export function createProviderFromPreset(
  presetName: string,
  name?: string,
  apiKey?: string,
  overrides?: Partial<DynamicProviderConfig>
): DynamicOpenAIProvider {
  const preset = DYNAMIC_PROVIDER_PRESETS[presetName];
  if (!preset) {
    throw new Error(`Unknown provider preset: ${presetName}`);
  }

  // Use environment variable if no API key provided
  const envApiKey = preset.envVar ? process.env[preset.envVar] : undefined;

  return new DynamicOpenAIProvider({
    name: (name ?? preset.name) as ProviderName,
    preset: presetName,
    apiKey: apiKey ?? envApiKey ?? "",
    disabled: false,
    ...overrides,
  });
}

/** Create a completely custom provider */
export function createCustomProvider(
  name: string,
  baseUrl: string,
  apiKey: string,
  options?: Omit<DynamicProviderConfig, "name" | "baseUrl" | "apiKey" | "disabled">
): DynamicOpenAIProvider {
  return new DynamicOpenAIProvider({
    name: name as ProviderName,
    preset: "custom",
    baseUrl,
    apiKey,
    disabled: false,
    displayName: options?.displayName ?? name,
    ...options,
  });
}

// ─── Utility Functions ──────────────────────────────────────────────────────

/** Get all available presets as array */
export function getProviderPresets(): ProviderPreset[] {
  return Object.values(DYNAMIC_PROVIDER_PRESETS).filter((p) => p.name !== "custom");
}

/** Get preset by name */
export function getPreset(name: string): ProviderPreset | undefined {
  return DYNAMIC_PROVIDER_PRESETS[name];
}

/** Check if a provider name matches a preset */
export function isPresetProvider(name: string): boolean {
  return name in DYNAMIC_PROVIDER_PRESETS;
}

/** Validate dynamic provider configuration */
export function validateDynamicConfig(
  config: Partial<DynamicProviderConfig>
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!config.name) {
    errors.push("Provider name is required");
  }

  if (!config.baseUrl && !config.preset) {
    errors.push("Either baseUrl or preset is required");
  }

  if (config.preset && !(config.preset in DYNAMIC_PROVIDER_PRESETS)) {
    errors.push(`Unknown preset: ${config.preset}`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
