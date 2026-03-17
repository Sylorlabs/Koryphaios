import type { ModelDef } from "@koryphaios/shared";

export const DeepSeekModels: ModelDef[] = [
  {
    id: "deepseek-chat",
    name: "DeepSeek Chat",
    provider: "deepseek",
    apiModelId: "deepseek-chat",
    contextWindow: 64_000,
    maxOutputTokens: 8_192,
    costPerMInputTokens: 0.14,
    costPerMOutputTokens: 0.28,
    canReason: false,
    supportsAttachments: false,
    supportsStreaming: true,
    tier: "flagship",
  },
  {
    id: "deepseek-reasoner",
    name: "DeepSeek Reasoner",
    provider: "deepseek",
    apiModelId: "deepseek-reasoner",
    contextWindow: 64_000,
    maxOutputTokens: 8_192,
    costPerMInputTokens: 0.55,
    costPerMOutputTokens: 2.19,
    canReason: true,
    supportsAttachments: false,
    supportsStreaming: true,
    tier: "reasoning",
  },
  {
    id: "deepseek-coder",
    name: "DeepSeek Coder",
    provider: "deepseek",
    apiModelId: "deepseek-coder",
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
    id: "qwen-2.5-72b",
    name: "Qwen 2.5 72B",
    provider: "togetherai",
    apiModelId: "Qwen/Qwen2.5-72B-Instruct",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    costPerMInputTokens: 0.3,
    costPerMOutputTokens: 0.9,
    canReason: false,
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
    id: "llama-3.1-70b",
    name: "Llama 3.1 70B",
    provider: "cerebras",
    apiModelId: "llama-3.1-70b",
    contextWindow: 128_000,
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
    id: "llama-v3p1-405b-instruct",
    name: "Llama 3.1 405B Instruct",
    provider: "fireworks",
    apiModelId: "accounts/fireworks/models/llama-v3p1-405b-instruct",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    canReason: false,
    supportsAttachments: true,
    supportsStreaming: true,
    tier: "flagship",
  },
];

export const HuggingFaceModels: ModelDef[] = [
  {
    id: "meta-llama-3.1-70b",
    name: "Llama 3.1 70B Instruct",
    provider: "huggingface",
    apiModelId: "meta-llama/Meta-Llama-3.1-70B-Instruct",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    canReason: false,
    supportsAttachments: true,
    supportsStreaming: true,
    tier: "flagship",
  },
];

export const DeepInfraModels: ModelDef[] = [
  {
    id: "deepseek-v3-di",
    name: "DeepSeek V3",
    provider: "deepinfra",
    apiModelId: "deepseek-ai/DeepSeek-V3",
    contextWindow: 64_000,
    maxOutputTokens: 8_192,
    canReason: false,
    supportsAttachments: true,
    supportsStreaming: true,
    tier: "flagship",
  },
];

export const MiniMaxModels: ModelDef[] = [
  {
    id: "minimax-text-01",
    name: "MiniMax Text 01",
    provider: "minimax",
    apiModelId: "MiniMax-Text-01",
    contextWindow: 1_000_000,
    maxOutputTokens: 32_000,
    tier: "flagship",
  },
];

export const MoonshotModels: ModelDef[] = [
  {
    id: "kimi-k1.5",
    name: "Kimi K1.5",
    provider: "moonshot",
    apiModelId: "kimi-k1.5",
    contextWindow: 256_000,
    maxOutputTokens: 8_192,
    canReason: true,
    supportsAttachments: true,
    supportsStreaming: true,
    tier: "flagship",
  },
  {
    id: "kimi-k1.5-short",
    name: "Kimi K1.5 Short COT",
    provider: "moonshot",
    apiModelId: "kimi-k1.5-short",
    contextWindow: 256_000,
    maxOutputTokens: 8_192,
    tier: "fast",
  },
];

export const NebiusModels: ModelDef[] = [
  {
    id: "meta-llama-3.3-70b-nb",
    name: "Llama 3.3 70B",
    provider: "nebius",
    apiModelId: "meta-llama/Meta-Llama-3.3-70B-Instruct",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
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
    id: "mistral-nemo-12b",
    name: "Mistral Nemo 12B",
    provider: "scaleway",
    apiModelId: "mistral-nemo-12b-instruct-2407",
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
    id: "glm-4",
    name: "GLM-4",
    provider: "zai",
    apiModelId: "glm-4",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    canReason: true,
    supportsAttachments: true,
    supportsStreaming: true,
    tier: "flagship",
  },
  {
    id: "glm-4-air",
    name: "GLM-4 Air",
    provider: "zai",
    apiModelId: "glm-4-air",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    canReason: false,
    supportsAttachments: true,
    supportsStreaming: true,
    tier: "fast",
  },
];

export const ZenMuxModels: ModelDef[] = [
  {
    id: "qwen-2.5-coder-32b-zenmux",
    name: "Qwen 2.5 Coder 32B",
    provider: "zenmux",
    apiModelId: "qwen2.5-coder-32b-instruct",
    contextWindow: 32_768,
    maxOutputTokens: 8_192,
    tier: "flagship",
  },
];

export const OpenCodeZenModels: ModelDef[] = [
  {
    id: "qwen-2.5-coder-32b-zen",
    name: "Qwen 2.5 Coder 32B",
    provider: "opencodezen",
    apiModelId: "qwen2.5-coder-32b-instruct",
    contextWindow: 32_768,
    maxOutputTokens: 8_192,
    tier: "flagship",
  },
];

export const OllamaCloudModels: ModelDef[] = [
  {
    id: "qwen-2.5-coder-32b-ollamacloud",
    name: "Qwen 2.5 Coder 32B",
    provider: "ollamacloud",
    apiModelId: "qwen2.5-coder:32b",
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
    id: "duo-chat-default",
    name: "GitLab Duo Chat",
    provider: "gitlab",
    apiModelId: "duo-chat",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    tier: "flagship",
    isGeneric: true,
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
    id: "meta-llama-3.3-70b-cortecs",
    name: "Llama 3.3 70B",
    provider: "cortecs",
    apiModelId: "llama-3.3-70b-instruct",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
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
