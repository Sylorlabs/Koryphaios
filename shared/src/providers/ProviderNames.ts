// Provider Names - Central registry of all supported LLM providers
// Domain: Provider identification and enumeration

export const ProviderName = {
  // Frontier (Major providers with full implementations)
  Anthropic: "anthropic",
  OpenAI: "openai",
  Google: "google",
  XAI: "xai",

  // Aggregators (OpenAI-compatible APIs with implementations)
  OpenRouter: "openrouter",
  Groq: "groq",

  // Auth-only providers (OAuth/CLI based)
  Claude: "claude",
  Copilot: "copilot",
  Cline: "cline",
  Codex: "codex",

  // Curated coding models
  OpenCodeZen: "opencodezen",

  // Enterprise (with implementations)
  Azure: "azure",
  Bedrock: "bedrock",
  VertexAI: "vertexai",

  // Local/Custom endpoints (OpenAI-compatible)
  Local: "local",
  Ollama: "ollama",

  // OpenCode parity and additional providers
  "302AI": "302ai",
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

export type ProviderName = (typeof ProviderName)[keyof typeof ProviderName] | string;

// Helper to validate provider names
export function isValidProvider(name: string): boolean {
  return Object.values(ProviderName).includes(name as any);
}

// Get all provider names as array
export function getAllProviderNames(): string[] {
  return Object.values(ProviderName);
}
