// Provider configurations — data-driven provider definitions
// This replaces the massive switch statements in registry.ts

import type { ProviderName, ProviderAuthMode } from '@koryphaios/shared';

export interface ProviderConfig {
  name: ProviderName;
  baseUrl: string;
  authMode: ProviderAuthMode;
  envKeys: string[];
  envUrlKey?: string;
  envAuthTokenKey?: string;
}

// All provider configurations in a single data structure
export const PROVIDER_CONFIGS: ProviderConfig[] = [
  // Frontier Providers
  {
    name: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    authMode: 'api_key_or_auth',
    envKeys: ['ANTHROPIC_API_KEY'],
    envAuthTokenKey: 'ANTHROPIC_AUTH_TOKEN',
  },
  {
    name: 'openai',
    baseUrl: 'https://api.openai.com',
    authMode: 'api_key',
    envKeys: ['OPENAI_API_KEY'],
  },
  {
    name: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com',
    authMode: 'api_key',
    envKeys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  },
  {
    name: 'google-subscription',
    baseUrl: 'https://generativelanguage.googleapis.com',
    authMode: 'auth_only',
    envKeys: [],
    envAuthTokenKey: 'GOOGLE_SUBSCRIPTION_OAUTH_TOKEN',
  },
  { name: 'xai', baseUrl: 'https://api.x.ai', authMode: 'api_key', envKeys: ['XAI_API_KEY'] },

  // Aggregators
  {
    name: 'openrouter',
    baseUrl: 'https://openrouter.ai/api',
    authMode: 'api_key',
    envKeys: ['OPENROUTER_API_KEY'],
  },
  {
    name: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    authMode: 'api_key',
    envKeys: ['GROQ_API_KEY'],
  },
  {
    name: 'copilot',
    baseUrl: 'https://api.githubcopilot.com',
    authMode: 'auth_only',
    envKeys: [],
    envAuthTokenKey: 'GITHUB_COPILOT_TOKEN',
  },
  {
    name: 'codex',
    baseUrl: '',
    authMode: 'auth_only',
    envKeys: [],
    envAuthTokenKey: 'CODEX_AUTH_TOKEN',
  },
  {
    name: 'jules',
    baseUrl: 'https://jules.googleapis.com/v1alpha',
    authMode: 'api_key',
    envKeys: ['JULES_API_KEY'],
  },

  // Enterprise
  {
    name: 'azure',
    baseUrl: '',
    authMode: 'api_key_or_auth',
    envKeys: ['AZURE_OPENAI_API_KEY'],
    envUrlKey: 'AZURE_OPENAI_ENDPOINT',
  },
  { name: 'bedrock', baseUrl: '', authMode: 'env_auth', envKeys: [] },
  { name: 'vertexai', baseUrl: '', authMode: 'env_auth', envKeys: [] },

  // Local
  {
    name: 'local',
    baseUrl: '',
    authMode: 'base_url_only',
    envKeys: [],
    envUrlKey: 'LOCAL_ENDPOINT',
  },
  {
    name: 'ollama',
    baseUrl: 'http://localhost:11434',
    authMode: 'api_key',
    envKeys: ['OLLAMA_API_KEY'],
    envUrlKey: 'OLLAMA_BASE_URL',
  },
  {
    name: 'lmstudio',
    baseUrl: 'http://localhost:1234',
    authMode: 'api_key',
    envKeys: ['LMSTUDIO_API_KEY'],
  },
  {
    name: 'llamacpp',
    baseUrl: 'http://localhost:8080',
    authMode: 'api_key',
    envKeys: ['LLAMACPP_API_KEY'],
  },
  {
    name: 'ollamacloud',
    baseUrl: 'https://ollama.com/api',
    authMode: 'api_key',
    envKeys: ['OLLAMA_CLOUD_API_KEY'],
  },

  // Chinese AI Providers
  {
    name: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    authMode: 'api_key',
    envKeys: ['DEEPSEEK_API_KEY'],
  },
  {
    name: 'minimax',
    baseUrl: 'https://api.minimax.io/v1',
    authMode: 'api_key',
    envKeys: ['MINIMAX_API_KEY'],
  },
  {
    name: 'kimicode',
    baseUrl: 'https://api.kimi.com/coding/v1',
    authMode: 'auth_only',
    envKeys: [],
    envAuthTokenKey: 'KIMI_CODE_AUTH_TOKEN',
  },
  {
    name: 'moonshot',
    baseUrl: 'https://api.moonshot.ai/v1',
    authMode: 'api_key',
    envKeys: ['MOONSHOT_API_KEY'],
  },
  {
    name: 'zai',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    authMode: 'api_key',
    envKeys: ['ZAI_API_KEY'],
  },
  {
    name: 'cortecs',
    baseUrl: 'https://api.cortecs.ai/v1',
    authMode: 'api_key',
    envKeys: ['CORTECS_API_KEY'],
  },
  {
    name: 'stepfun',
    baseUrl: 'https://api.stepfun.com/v1',
    authMode: 'api_key',
    envKeys: ['STEPFUN_API_KEY'],
  },
  // Alibaba DashScope (Qwen models) - supports both QWEN_API_KEY and ALIBABA_API_KEY
  {
    name: 'qwen',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    authMode: 'api_key',
    envKeys: ['QWEN_API_KEY', 'ALIBABA_API_KEY'],
  },
  {
    name: 'zhipuai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    authMode: 'api_key',
    envKeys: ['ZHIPUAI_API_KEY'],
  },
  {
    name: 'modelscope',
    baseUrl: 'https://api-inference.modelscope.cn/v1',
    authMode: 'api_key',
    envKeys: ['MODELSCOPE_API_KEY'],
  },

  // High Performance
  {
    name: 'cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    authMode: 'api_key',
    envKeys: ['CEREBRAS_API_KEY'],
  },
  {
    name: 'fireworks',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    authMode: 'api_key',
    envKeys: ['FIREWORKS_API_KEY'],
  },
  {
    name: 'deepinfra',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    authMode: 'api_key',
    envKeys: ['DEEPINFRA_API_KEY'],
  },
  {
    name: 'ionet',
    baseUrl: 'https://api.intelligence.io.solutions/api/v1',
    authMode: 'api_key',
    envKeys: ['IONET_API_KEY'],
  },
  {
    name: 'hyperbolic',
    baseUrl: 'https://api.hyperbolic.xyz/v1',
    authMode: 'api_key',
    envKeys: ['HYPERBOLIC_API_KEY'],
  },

  // Open Source Platforms
  // Note: HuggingFace Inference API uses the model ID in the URL
  // Format: https://api-inference.huggingface.co/models/{model_id}
  {
    name: 'huggingface',
    baseUrl: 'https://api-inference.huggingface.co',
    authMode: 'api_key',
    envKeys: ['HUGGINGFACE_API_KEY', 'HF_TOKEN'],
  },
  {
    name: 'replicate',
    baseUrl: 'https://api.replicate.com/v1',
    authMode: 'api_key',
    envKeys: ['REPLICATE_API_KEY'],
  },
  {
    name: 'modal',
    baseUrl: 'https://api.modal.com/v1',
    authMode: 'api_key',
    envKeys: ['MODAL_API_KEY'],
  },

  // AI Gateways
  {
    name: 'cloudflare',
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts',
    authMode: 'api_key',
    envKeys: ['CLOUDFLARE_API_TOKEN'],
  },
  // Note: Vercel AI Gateway is a routing service, not a direct LLM provider
  // Base URL for AI Gateway: https://ai-gateway.vercel.sh/v1 (requires separate setup)
  // Vercel AI SDK is a framework that works with other providers
  {
    name: 'vercel',
    baseUrl: 'https://ai-gateway.vercel.sh',
    authMode: 'api_key',
    envKeys: ['VERCEL_API_TOKEN'],
  },
  {
    name: 'baseten',
    baseUrl: 'https://api.baseten.co/v1',
    authMode: 'api_key',
    envKeys: ['BASETEN_API_KEY'],
  },
  {
    name: 'helicone',
    baseUrl: 'https://api.helicone.ai/v1',
    authMode: 'api_key',
    envKeys: ['HELICONE_API_KEY'],
  },
  {
    name: 'portkey',
    baseUrl: 'https://api.portkey.ai/v1',
    authMode: 'api_key',
    envKeys: ['PORTKEY_API_KEY'],
  },

  // European Providers
  // Note: Scaleway Generative APIs endpoint is https://api.scaleway.ai/v1
  {
    name: 'scaleway',
    baseUrl: 'https://api.scaleway.ai/v1',
    authMode: 'api_key',
    envKeys: ['SCALEWAY_API_KEY'],
  },
  {
    name: 'ovhcloud',
    baseUrl: 'https://deploy.ai.ovh.net',
    authMode: 'api_key',
    envKeys: ['OVHCLOUD_API_KEY'],
  },
  {
    name: 'stackit',
    baseUrl: 'https://LLM.eu1.hana.ondemand.com',
    authMode: 'api_key',
    envKeys: ['STACKIT_AUTH_TOKEN'],
  },
  // Note: Nebius AI Studio endpoint is https://api.studio.nebius.ai/v1
  {
    name: 'nebius',
    baseUrl: 'https://api.studio.nebius.ai/v1',
    authMode: 'api_key',
    envKeys: ['NEBIUS_API_KEY'],
  },

  // Subscription-based
  {
    name: 'togetherai',
    baseUrl: 'https://api.together.xyz',
    authMode: 'api_key',
    envKeys: ['TOGETHERAI_API_KEY', 'TOGETHER_API_KEY'],
  },
  {
    name: 'venice',
    baseUrl: 'https://api.venice.ai/api/v1',
    authMode: 'api_key',
    envKeys: ['VENICE_API_KEY'],
  },
  {
    name: 'zenmux',
    baseUrl: 'https://zenmux.ai/api/anthropic',
    authMode: 'api_key',
    envKeys: ['ZENMUX_API_KEY'],
  },
  {
    name: 'opencodezen',
    baseUrl: 'https://opencode.ai/zen',
    authMode: 'api_key',
    envKeys: ['OPENCODE_ZEN_API_KEY'],
  },
  {
    name: 'opencodego',
    baseUrl: 'https://opencode.ai/zen/go',
    authMode: 'api_key',
    envKeys: ['OPENCODE_GO_API_KEY', 'OPENCODEGO_API_KEY'],
  },
  {
    name: '302ai',
    baseUrl: 'https://api.302.ai',
    authMode: 'api_key',
    envKeys: ['A302AI_API_KEY'],
  },

  // CLI-based Auth Providers
  {
    name: 'claude',
    baseUrl: '',
    authMode: 'auth_only',
    envKeys: [],
    envAuthTokenKey: 'CLAUDE_CODE_OAUTH_TOKEN',
  },

  // Specialized
  // Mistral AI - European LLM provider
  {
    name: 'mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    authMode: 'api_key',
    envKeys: ['MISTRAL_API_KEY', 'MISTRALAI_API_KEY'],
  },
  {
    name: 'cohere',
    baseUrl: 'https://api.cohere.ai/v1',
    authMode: 'api_key',
    envKeys: ['COHERE_API_KEY'],
  },
  {
    name: 'perplexity',
    baseUrl: 'https://api.perplexity.ai',
    authMode: 'api_key',
    envKeys: ['PERPLEXITY_API_KEY'],
  },
  // Note: Perplexity doesn't use /v1 path - keep as is
  // Note: Luma AI (lu.ma) is for event management - not an LLM API
  // For Luma Dream Machine (video generation), use fal.ai provider
  { name: 'luma', baseUrl: 'https://api.luma.ai', authMode: 'api_key', envKeys: ['LUMA_API_KEY'] },
  { name: 'fal', baseUrl: 'https://queue.fal.run', authMode: 'api_key', envKeys: ['FAL_API_KEY'] },

  // Audio/Speech
  {
    name: 'elevenlabs',
    baseUrl: 'https://api.elevenlabs.io/v1',
    authMode: 'api_key',
    envKeys: ['ELEVENLABS_API_KEY'],
  },
  {
    name: 'deepgram',
    baseUrl: 'https://api.deepgram.com/v1',
    authMode: 'api_key',
    envKeys: ['DEEPGRAM_API_KEY'],
  },
  {
    name: 'gladia',
    baseUrl: 'https://api.gladia.io/v2',
    authMode: 'api_key',
    envKeys: ['GLADIA_API_KEY'],
  },
  {
    name: 'assemblyai',
    baseUrl: 'https://api.assemblyai.com/v2',
    authMode: 'api_key',
    envKeys: ['ASSEMBLYAI_API_KEY'],
  },
  {
    name: 'lmnt',
    baseUrl: 'https://api.lmnt.com/v1',
    authMode: 'api_key',
    envKeys: ['LMNT_API_KEY'],
  },

  // Other
  {
    name: 'nvidia',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    authMode: 'api_key',
    envKeys: ['NVIDIA_API_KEY'],
  },
  {
    name: 'nim',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    authMode: 'api_key',
    envKeys: ['NVIDIA_API_KEY', 'NIM_API_KEY'],
  },
  // Friendli AI - serverless inference
  {
    name: 'friendli',
    baseUrl: 'https://api.friendli.ai/serverless/v1',
    authMode: 'api_key',
    envKeys: ['FRIENDLI_API_KEY', 'FRIENDLI_TOKEN'],
  },
  {
    name: 'voyageai',
    baseUrl: 'https://api.voyageai.com/v1',
    authMode: 'api_key',
    envKeys: ['VOYAGE_API_KEY'],
  },
  {
    name: 'mixedbread',
    baseUrl: 'https://api.mixedbread.ai/v1',
    authMode: 'api_key',
    envKeys: ['MIXEDBREAD_API_KEY'],
  },
  {
    name: 'mem0',
    baseUrl: 'https://api.mem0.ai/v1',
    authMode: 'api_key',
    envKeys: ['MEM0_API_KEY'],
  },
  {
    name: 'letta',
    baseUrl: 'https://api.letta.com/v1',
    authMode: 'api_key',
    envKeys: ['LETTA_API_KEY'],
  },
  {
    name: 'blackforestlabs',
    baseUrl: 'https://api.blackforestlabs.ai/v1',
    authMode: 'api_key',
    envKeys: ['BLACKFORESTLABS_API_KEY'],
  },
  {
    name: 'klingai',
    baseUrl: 'https://api.klingai.com/v1',
    authMode: 'api_key',
    envKeys: ['KLINGAI_API_KEY'],
  },
  {
    name: 'prodia',
    baseUrl: 'https://api.prodia.com/v1',
    authMode: 'api_key',
    envKeys: ['PRODIA_API_KEY'],
  },

  // Additional providers
  {
    name: 'novita-ai',
    baseUrl: 'https://api.novita.ai/v3/openai',
    authMode: 'api_key',
    envKeys: ['NOVITA_AI_API_KEY'],
  },
  {
    name: 'upstage',
    baseUrl: 'https://api.upstage.ai/v1/solar',
    authMode: 'api_key',
    envKeys: ['UPSTAGE_API_KEY'],
  },
  // Note: v0 is Vercel's design tool (v0.dev), not a public LLM API
  // It generates UI designs, not text/chat completions
  // { name: "v0", baseUrl: "https://api.v0.dev", authMode: "api_key", envKeys: ["V0_API_KEY"] },
  {
    name: 'siliconflow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    authMode: 'api_key',
    envKeys: ['SILICONFLOW_API_KEY'],
  },
  {
    name: 'abacus',
    baseUrl: 'https://routellm.abacus.ai',
    authMode: 'api_key',
    envKeys: ['ABACUS_API_KEY'],
  },
  {
    name: 'llama',
    baseUrl: 'https://api.llama.com/compat',
    authMode: 'api_key',
    envKeys: ['LLAMA_API_KEY'],
  },
  {
    name: 'vultr',
    baseUrl: 'https://api.vultrinference.com/v1',
    authMode: 'api_key',
    envKeys: ['VULTR_API_KEY'],
  },
  {
    name: 'wandb',
    baseUrl: 'https://api.inference.wandb.ai/v1',
    authMode: 'api_key',
    envKeys: ['WANDB_API_KEY'],
  },
  { name: 'poe', baseUrl: 'https://api.poe.com/v1', authMode: 'api_key', envKeys: ['POE_API_KEY'] },
  {
    name: 'github-models',
    baseUrl: 'https://models.github.ai/inference',
    authMode: 'api_key',
    envKeys: ['GITHUB_TOKEN'],
  },
  {
    name: 'requesty',
    baseUrl: 'https://router.requesty.ai/v1',
    authMode: 'api_key',
    envKeys: ['REQUESTY_API_KEY'],
  },
  {
    name: 'inference',
    baseUrl: 'https://api.inference.net/v1',
    authMode: 'api_key',
    envKeys: ['INFERENCE_API_KEY'],
  },
  {
    name: 'submodel',
    baseUrl: 'https://llm.submodel.ai/v1',
    authMode: 'api_key',
    envKeys: ['SUBMODEL_API_KEY'],
  },
  {
    name: 'synthetic',
    baseUrl: 'https://api.synthetic.new/v1',
    authMode: 'api_key',
    envKeys: ['SYNTHETIC_API_KEY'],
  },
  {
    name: 'moark',
    baseUrl: 'https://moark.com/v1',
    authMode: 'api_key',
    envKeys: ['MOARK_API_KEY'],
  },
  // Note: Amazon Nova models are accessed through AWS Bedrock, not a separate API
  // Use 'bedrock' provider with nova models instead
];

// Create lookup maps for fast access
export const PROVIDER_CONFIG_MAP = new Map<ProviderName, ProviderConfig>(
  PROVIDER_CONFIGS.map((c) => [c.name, c]),
);

export const PROVIDER_AUTH_MODE_MAP = new Map<ProviderName, ProviderAuthMode>(
  PROVIDER_CONFIGS.map((c) => [c.name, c.authMode]),
);

export const ENV_API_KEY_MAP = new Map<ProviderName, string[]>(
  PROVIDER_CONFIGS.map((c) => [c.name, c.envKeys]),
);

export const ENV_URL_MAP = new Map<ProviderName, string | undefined>(
  PROVIDER_CONFIGS.map((c) => [c.name, c.envUrlKey]),
);

export const ENV_AUTH_TOKEN_MAP = new Map<ProviderName, string | undefined>(
  PROVIDER_CONFIGS.map((c) => [c.name, c.envAuthTokenKey]),
);

export const BASE_URL_MAP = new Map<ProviderName, string>(
  PROVIDER_CONFIGS.map((c) => [c.name, c.baseUrl]),
);
