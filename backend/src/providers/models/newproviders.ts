import type { ModelDef } from "@koryphaios/shared";

export const DeepSeekModels: ModelDef[] = [
  {
    id: "deepseek-v4",
    name: "DeepSeek V4",
    provider: "deepseek",
    apiModelId: "deepseek-v4",
    contextWindow: 1_000_000,
    maxOutputTokens: 32_000,
    costPerMInputTokens: 0.20,
    costPerMOutputTokens: 0.40,
    canReason: true,
    supportsAttachments: true,
    supportsStreaming: true,
    tier: "flagship",
  },
  {
    id: "deepseek-reasoner",
    name: "DeepSeek Reasoner",
    provider: "deepseek",
    apiModelId: "deepseek-reasoner",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    costPerMInputTokens: 0.55,
    costPerMOutputTokens: 1.1,
    canReason: true,
    supportsAttachments: false,
    supportsStreaming: true,
    tier: "reasoning",
  },
  {
    id: "deepseek-v3",
    name: "DeepSeek V3",
    provider: "deepseek",
    apiModelId: "deepseek-v3",
    contextWindow: 64_000,
    maxOutputTokens: 8_192,
    costPerMInputTokens: 0.14,
    costPerMOutputTokens: 0.28,
    canReason: false,
    supportsAttachments: false,
    supportsStreaming: true,
    tier: "flagship",
  },
];

export const TogetherAIModels: ModelDef[] = [
  {
    id: "qwen-3.5-35b",
    name: "Qwen 3.5 35B",
    provider: "togetherai",
    apiModelId: "Qwen/Qwen3.5-35B-Instruct",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    costPerMInputTokens: 0.3,
    costPerMOutputTokens: 0.9,
    canReason: true,
    supportsAttachments: true,
    supportsStreaming: true,
    tier: "flagship",
  },
  {
    id: "qwen-qwq-32b",
    name: "Qwen QwQ 32B",
    provider: "togetherai",
    apiModelId: "Qwen/QwQ-32B",
    contextWindow: 32_768,
    maxOutputTokens: 8_192,
    costPerMInputTokens: 0.5,
    costPerMOutputTokens: 1.5,
    canReason: true,
    supportsAttachments: false,
    supportsStreaming: true,
    tier: "reasoning",
  },
  {
    id: "llama-3.3-70b",
    name: "Llama 3.3 70B",
    provider: "togetherai",
    apiModelId: "meta-llama/Llama-3.3-70B-Instruct",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    costPerMInputTokens: 0.88,
    costPerMOutputTokens: 0.88,
    canReason: false,
    supportsAttachments: false,
    supportsStreaming: true,
    tier: "flagship",
  },
];

export const CerebrasModels: ModelDef[] = [
  {
    id: "qwen-3-coder-480b",
    name: "Qwen 3 Coder 480B",
    provider: "cerebras",
    apiModelId: "Qwen/Qwen3-Coder-480B",
    contextWindow: 32_768,
    maxOutputTokens: 8_192,
    costPerMInputTokens: 0.0,
    costPerMOutputTokens: 0.0,
    canReason: false,
    supportsAttachments: false,
    supportsStreaming: true,
    tier: "flagship",
  },
];

export const FireworksModels: ModelDef[] = [
  {
    id: "kimi-k2.5-instruct",
    name: "Kimi K2.5 Instruct",
    provider: "fireworks",
    apiModelId: "accounts/fireworks/models/kimi-k2-5-instruct",
    contextWindow: 128_000,
    maxOutputTokens: 32_000,
    canReason: true,
    supportsAttachments: true,
    supportsStreaming: true,
    tier: "flagship",
  },
];

export const HuggingFaceModels: ModelDef[] = [
  {
    id: "kimi-k2.5-instruct-hf",
    name: "Kimi K2.5 Instruct (HF)",
    provider: "huggingface",
    apiModelId: "moonshotai/kimi-k2.5-instruct",
    contextWindow: 128_000,
    maxOutputTokens: 32_000,
    canReason: true,
    supportsAttachments: true,
    supportsStreaming: true,
    tier: "flagship",
  },
];

export const DeepInfraModels: ModelDef[] = [
  {
    id: "deepseek-v4-di",
    name: "DeepSeek V4",
    provider: "deepinfra",
    apiModelId: "deepseek-ai/DeepSeek-V4",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    canReason: true,
    supportsAttachments: true,
    supportsStreaming: true,
    tier: "flagship",
  },
];

export const MiniMaxModels: ModelDef[] = [
  {
    id: "minimax-m2.1",
    name: "MiniMax M2.1",
    provider: "minimax",
    apiModelId: "MiniMax-M2.1",
    contextWindow: 1_000_000,
    maxOutputTokens: 32_000,
    tier: "flagship",
  },
];

export const MoonshotModels: ModelDef[] = [
  {
    id: "kimi-k2.5",
    name: "Kimi K2.5",
    provider: "moonshot",
    apiModelId: "kimi-k2.5",
    contextWindow: 512_000,
    maxOutputTokens: 32_000,
    canReason: true,
    supportsAttachments: true,
    supportsStreaming: true,
    tier: "flagship",
  },
  {
    id: "kimi-code",
    name: "Kimi Code",
    provider: "moonshot",
    apiModelId: "kimi-code",
    contextWindow: 128_000,
    maxOutputTokens: 32_000,
    tier: "flagship",
  },
];

export const NebiusModels: ModelDef[] = [
  {
    id: "kimi-k2.5-instruct-nb",
    name: "Kimi K2.5 Instruct",
    provider: "nebius",
    apiModelId: "kimi-k2.5-instruct",
    contextWindow: 128_000,
    maxOutputTokens: 32_000,
    tier: "flagship",
  },
];

export const VeniceModels: ModelDef[] = [
  {
    id: "llama-3.3-70b-venice",
    name: "Llama 3.3 70B",
    provider: "venice",
    apiModelId: "llama-3.3-70b",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    tier: "flagship",
  },
];

export const ScalewayModels: ModelDef[] = [
  {
    id: "devstral-2-123b",
    name: "Devstral 2 123B",
    provider: "scaleway",
    apiModelId: "devstral-2-123b-instruct-2512",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    tier: "flagship",
  },
];

export const IonetModels: ModelDef[] = [
  {
    id: "qwen-2.5-coder-32b-ionet",
    name: "Qwen 2.5 Coder 32B",
    provider: "ionet",
    apiModelId: "qwen2.5-coder-32b-instruct",
    contextWindow: 32_768,
    maxOutputTokens: 8_192,
    tier: "fast",
  },
];

export const ZAIModels: ModelDef[] = [
  {
    id: "glm-4.7",
    name: "GLM-4.7",
    provider: "zai",
    apiModelId: "glm-4.7",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    tier: "flagship",
  },
];

export const ZenMuxModels: ModelDef[] = [
  {
    id: "qwen3-coder-480b-zenmux",
    name: "Qwen 3 Coder 480B",
    provider: "zenmux",
    apiModelId: "qwen3-coder-480b",
    contextWindow: 32_768,
    maxOutputTokens: 8_192,
    tier: "flagship",
  },
];

export const OpenCodeZenModels: ModelDef[] = [
  {
    id: "qwen3-coder-480b-zen",
    name: "Qwen 3 Coder 480B",
    provider: "opencodezen",
    apiModelId: "qwen3-coder-480b",
    contextWindow: 32_768,
    maxOutputTokens: 8_192,
    tier: "flagship",
  },
];

export const OllamaCloudModels: ModelDef[] = [
  {
    id: "qwen3-coder-30b-a3b-ollamacloud",
    name: "Qwen3 Coder 30B A3B",
    provider: "ollamacloud",
    apiModelId: "qwen3-coder:30b-a3b",
    contextWindow: 32_768,
    maxOutputTokens: 8_192,
    tier: "flagship",
  },
];

export const CloudflareModels: ModelDef[] = [
  {
    id: "cf-ai-gateway-default",
    name: "Cloudflare AI Gateway",
    provider: "cloudflare",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    isGeneric: true,
  },
];

export const VercelModels: ModelDef[] = [
  {
    id: "vercel-default",
    name: "Vercel AI Gateway",
    provider: "vercel",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    isGeneric: true,
  },
];

export const GitLabModels: ModelDef[] = [
  {
    id: "duo-chat-haiku-4-5",
    name: "Duo Chat Haiku 4.5",
    provider: "gitlab",
    apiModelId: "duo-chat-haiku-4-5",
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    tier: "fast",
  },
  {
    id: "duo-chat-sonnet-4-5",
    name: "Duo Chat Sonnet 4.5",
    provider: "gitlab",
    apiModelId: "duo-chat-sonnet-4-5",
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    tier: "flagship",
  },
  {
    id: "duo-chat-opus-4-5",
    name: "Duo Chat Opus 4.5",
    provider: "gitlab",
    apiModelId: "duo-chat-opus-4-5",
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    tier: "flagship",
  },
];

export const BasetenModels: ModelDef[] = [
  {
    id: "baseten-default",
    name: "Baseten",
    provider: "baseten",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    isGeneric: true,
  },
];

export const FirmwareModels: ModelDef[] = [
  {
    id: "firmware-default",
    name: "Firmware AI",
    provider: "firmware",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    isGeneric: true,
  },
];

export const CortecsModels: ModelDef[] = [
  {
    id: "kimi-k2.5-instruct-cortecs",
    name: "Kimi K2.5 Instruct",
    provider: "cortecs",
    apiModelId: "kimi-k2.5-instruct",
    contextWindow: 128_000,
    maxOutputTokens: 32_000,
    tier: "flagship",
  },
];

export const LocalModels: ModelDef[] = [
  {
    id: "local-default",
    name: "Local Model",
    provider: "local",
    contextWindow: 128_000,
    maxOutputTokens: 4_096,
    isGeneric: true,
  },
];

export const LMStudioModels: ModelDef[] = [
  {
    id: "lmstudio-default",
    name: "LM Studio Model",
    provider: "lmstudio",
    contextWindow: 128_000,
    maxOutputTokens: 4_096,
    isGeneric: true,
  },
];

export const LlamaCppModels: ModelDef[] = [
  {
    id: "llamacpp-default",
    name: "llama.cpp Model",
    provider: "llamacpp",
    contextWindow: 128_000,
    maxOutputTokens: 4_096,
    isGeneric: true,
  },
];

export const OllamaModels: ModelDef[] = [
  {
    id: "ollama-default",
    name: "Ollama Model",
    provider: "ollama",
    contextWindow: 128_000,
    maxOutputTokens: 4_096,
    isGeneric: true,
  },
];
