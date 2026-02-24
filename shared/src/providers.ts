// Real Provider Definitions - Only actually implemented providers

export const ProviderName = {
  // Frontier (Major providers with full implementations)
  Anthropic: "anthropic",
  OpenAI: "openai",
  Google: "google",
  XAI: "xai",
  
  // Aggregators (OpenAI-compatible APIs)
  OpenRouter: "openrouter",
  Groq: "groq",
  
  // Auth-only providers (CLI-based)
  Claude: "claude",
  Cline: "cline",
  Codex: "codex",
  Copilot: "copilot",
  
  // Curated coding models (OpenCode Zen)
  OpenCodeZen: "opencodezen",
  
  // Enterprise
  Azure: "azure",
  Bedrock: "bedrock",
  VertexAI: "vertexai",
  
  // Local/Custom endpoints (OpenAI-compatible)
  Local: "local",
  Ollama: "ollama",

  // OpenCode parity — API-key or base-URL providers (OpenAI-compatible unless noted)
  A302AI: "302ai",
  AzureCognitive: "azurecognitive",
  Baseten: "baseten",
  Cerebras: "cerebras",
  Cloudflare: "cloudflare",
  Cortecs: "cortecs",
  DeepSeek: "deepseek",
  DeepInfra: "deepinfra",
  Firmware: "firmware",
  Fireworks: "fireworks",
  GitLab: "gitlab",
  HuggingFace: "huggingface",
  Helicone: "helicone",
  LlamaCpp: "llamacpp",
  IoNet: "ionet",
  LMStudio: "lmstudio",
  Mistral: "mistral",
  Moonshot: "moonshot",
  MiniMax: "minimax",
  Nebius: "nebius",
  OllamaCloud: "ollamacloud",
  SAPAI: "sapai",
  Stackit: "stackit",
  OVHcloud: "ovhcloud",
  Scaleway: "scaleway",
  TogetherAI: "togetherai",
  Venice: "venice",
  Vercel: "vercel",
  ZAI: "zai",
  ZenMux: "zenmux",
} as const;

export type ProviderName = (typeof ProviderName)[keyof typeof ProviderName];

export const IMPLEMENTED_PROVIDERS: ProviderName[] = [
  "anthropic",
  "claude",
  "cline",
  "codex",
  "openai",
  "google",
  "xai",
  "openrouter",
  "groq",
  "copilot",
  "opencodezen",
  "azure",
  "bedrock",
  "vertexai",
  "local",
  "ollama",
  "302ai",
  "azurecognitive",
  "baseten",
  "cerebras",
  "cloudflare",
  "cortecs",
  "deepseek",
  "deepinfra",
  "firmware",
  "fireworks",
  "gitlab",
  "huggingface",
  "helicone",
  "llamacpp",
  "ionet",
  "lmstudio",
  "moonshot",
  "minimax",
  "nebius",
  "mistral",
  "ollamacloud",
  "sapai",
  "stackit",
  "ovhcloud",
  "scaleway",
  "togetherai",
  "venice",
  "vercel",
  "zai",
  "zenmux",
];

export type ModelTier = "flagship" | "fast" | "cheap" | "reasoning";

export interface ModelDef {
  id: string;
  name: string;
  provider: ProviderName;
  /** Model ID sent to the API. Defaults to `id` if omitted. */
  apiModelId?: string;
  contextWindow: number;
  maxOutputTokens: number;
  costPerMInputTokens: number;
  costPerMOutputTokens: number;
  costPerMInputCached?: number;
  costPerMOutputCached?: number;
  canReason: boolean;
  supportsAttachments: boolean;
  supportsStreaming: boolean;
  tier?: ModelTier;
  isGeneric?: boolean;
  /** Whether this model is deprecated and should not be used for new sessions */
  deprecated?: boolean;
}

export interface ProviderConfig {
  name: ProviderName;
  apiKey?: string;
  authToken?: string;
  baseUrl?: string;
  disabled: boolean;
  /** List of model IDs enabled by the user. If empty or undefined, all are enabled. */
  selectedModels?: string[];
  /** Whether to skip the model selection dialog in the future. */
  hideModelSelector?: boolean;
  headers?: Record<string, string>;
}

export type ProviderAuthMode = "api_key" | "auth_only" | "api_key_or_auth" | "base_url_only" | "env_auth";

/** Maps provider names to their authentication modes */
export const PROVIDER_AUTH_MODES: Record<ProviderName, ProviderAuthMode> = {
  anthropic: "api_key",
  claude: "auth_only",
  cline: "auth_only",
  codex: "auth_only",
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
  moonshot: "api_key",
  minimax: "api_key",
  nebius: "api_key",
  mistral: "api_key",
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

/** Environment variable mappings for providers */
export const PROVIDER_ENV_VARS: Record<ProviderName, { apiKey?: string; baseUrl?: string; authToken?: string }> = {
  anthropic: { apiKey: "ANTHROPIC_API_KEY" },
  claude: { authToken: "CLAUDE_CODE_OAUTH_TOKEN" },
  openai: { apiKey: "OPENAI_API_KEY" },
  google: { apiKey: "GEMINI_API_KEY", authToken: "GEMINI_AUTH_TOKEN" },
  xai: { apiKey: "XAI_API_KEY" },
  openrouter: { apiKey: "OPENROUTER_API_KEY", baseUrl: "OPENROUTER_BASE_URL" },
  groq: { apiKey: "GROQ_API_KEY" },
  cline: { authToken: "CLINE_AUTH_TOKEN" },
  copilot: { authToken: "GITHUB_TOKEN" },
  opencodezen: { apiKey: "OPENCODE_ZEN_API_KEY" },
  azure: { apiKey: "AZURE_OPENAI_API_KEY", baseUrl: "AZURE_OPENAI_ENDPOINT" },
  bedrock: {}, // Uses AWS credentials
  vertexai: {}, // Uses Google Application Default Credentials
  local: { baseUrl: "LOCAL_ENDPOINT" },
  ollama: { baseUrl: "OLLAMA_BASE_URL" },
  codex: {}, // Uses CLI auth
  "302ai": { apiKey: "A302AI_API_KEY" },
  azurecognitive: { apiKey: "AZURE_COGNITIVE_API_KEY", baseUrl: "AZURE_COGNITIVE_RESOURCE_URL" },
  baseten: { apiKey: "BASETEN_API_KEY" },
  cerebras: { apiKey: "CEREBRAS_API_KEY" },
  cloudflare: { apiKey: "CLOUDFLARE_API_TOKEN" },
  cortecs: { apiKey: "CORTECS_API_KEY" },
  deepseek: { apiKey: "DEEPSEEK_API_KEY" },
  deepinfra: { apiKey: "DEEPINFRA_API_KEY" },
  firmware: { apiKey: "FIRMWARE_API_KEY" },
  fireworks: { apiKey: "FIREWORKS_API_KEY" },
  gitlab: { apiKey: "GITLAB_API_KEY" },
  huggingface: { apiKey: "HUGGINGFACE_API_KEY" },
  helicone: { apiKey: "HELICONE_API_KEY" },
  llamacpp: { baseUrl: "LLAMACPP_BASE_URL" },
  ionet: { apiKey: "IONET_API_KEY" },
  lmstudio: { baseUrl: "LMSTUDIO_BASE_URL" },
  moonshot: { apiKey: "MOONSHOT_API_KEY" },
  minimax: { apiKey: "MINIMAX_API_KEY" },
  nebius: { apiKey: "NEBIUS_API_KEY" },
  mistral: { apiKey: "MISTRAL_API_KEY" },
  ollamacloud: { apiKey: "OLLAMA_CLOUD_API_KEY" },
  sapai: { apiKey: "AICORE_SERVICE_KEY" },
  stackit: { apiKey: "STACKIT_API_KEY" },
  ovhcloud: { apiKey: "OVHCLOUD_API_KEY" },
  scaleway: { apiKey: "SCALEWAY_API_KEY" },
  togetherai: { apiKey: "TOGETHER_API_KEY" },
  venice: { apiKey: "VENICE_API_KEY" },
  vercel: { apiKey: "VERCEL_AI_API_KEY" },
  zai: { apiKey: "ZAI_API_KEY" },
  zenmux: { apiKey: "ZENMUX_API_KEY" },
};
