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
    authMode: 'api_key',
    envKeys: ['ANTHROPIC_API_KEY'],
  },
  {
    name: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    authMode: 'api_key',
    envKeys: ['OPENAI_API_KEY'],
  },
  {
    name: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com',
    authMode: 'api_key',
    // Google direct API is deliberately separate from the AI Studio account.
    envKeys: ['GOOGLE_API_KEY'],
  },
  {
    name: 'aistudio',
    baseUrl: 'https://generativelanguage.googleapis.com',
    authMode: 'api_key',
    envKeys: ['GEMINI_API_KEY', 'AI_STUDIO_API_KEY'],
  },
  { name: 'xai', baseUrl: 'https://api.x.ai', authMode: 'api_key', envKeys: ['XAI_API_KEY'] },

  // Reflection AI — Chat Completions and Models, Bearer API key.
  // https://developers.reflection.ai/openai-compatibility.md
  {
    name: 'beam',
    baseUrl: 'https://api.reflection.ai/openai/v1',
    authMode: 'api_key',
    envKeys: ['REFLECTION_API_KEY'],
  },

  // Aggregators
  {
    name: 'openrouter',
    baseUrl: 'https://openrouter.ai/api',
    authMode: 'api_key',
    envKeys: ['OPENROUTER_API_KEY'],
  },
  // UnoRouter — open-source OpenRouter alternative; one key for 200+ models.
  // OpenAI-compatible Chat Completions at /v1 (docs: unorouter.com/en/docs).
  // Verification probes GET /v1/models with `Authorization: Bearer <key>`.
  {
    name: 'unorouter',
    baseUrl: 'https://api.unorouter.com/v1',
    authMode: 'api_key',
    envKeys: ['UNOROUTER_API_KEY'],
  },
  // Experiential Labs — open-source AI gateway; one key for hosted/BYOK/local models.
  // OpenAI-compatible Chat Completions at /v1 (docs: platform.experientiallabs.ai/docs).
  // Verification probes GET /v1/models with `Authorization: Bearer <key>`.
  {
    // Cline's hosted inference API. One key routes ~460 models across
    // Anthropic/OpenAI/Google/xAI/DeepSeek/Mistral/Qwen with OpenRouter-style
    // `provider/model` ids over an OpenAI-compatible Chat Completions surface.
    name: 'cline',
    baseUrl: 'https://api.cline.bot/api/v1',
    authMode: 'api_key',
    envKeys: ['CLINE_API_KEY'],
  },
  {
    name: 'experientiallabs',
    baseUrl: 'https://api.experientiallabs.ai/v1',
    authMode: 'api_key',
    envKeys: ['EXPERIENTIALLABS_API_KEY', 'EXPLABS_API_KEY'],
  },
  // 100MillionSeek — OpenAI-compatible Chat Completions and an authenticated
  // /v1/models catalog that reports real context/output limits plus the
  // vendor's own price label and quota multiplier.
  // https://100milionseek.top
  {
    name: 'hundredmillionseek',
    baseUrl: 'https://100milionseek.top/v1',
    authMode: 'api_key',
    envKeys: ['HUNDREDMILLIONSEEK_API_KEY'],
  },
  // Numes — multi-model OpenAI-compatible gateway on the OpenRouter wire
  // shape. Its /api/v1/models catalog carries per-token USD pricing, context
  // and output limits, reasoning effort ladders and modalities.
  // https://numes.ai
  {
    name: 'numes',
    baseUrl: 'https://api.numes.ai/api/v1',
    authMode: 'api_key',
    envKeys: ['NUMES_API_KEY'],
  },
  // Coarena — OpenAI-compatible Model API on one key. The public /models
  // catalog carries real context/output limits, vision/tools/reasoning flags
  // and the provider's reasoning_effort ladder; /credits and /limits expose
  // the account's real balance and daily usage.
  // https://coarena.ai/docs
  {
    name: 'coarena',
    baseUrl: 'https://coarena.ai/api/v1',
    authMode: 'api_key',
    envKeys: ['COARENA_API_KEY'],
  },
  // CrowLLM — OpenAI-compatible gateway on one key, with Anthropic- and
  // Gemini-shaped surfaces on the same host. The public /v1/models catalog
  // carries the exact ids, publishers and :free/-thinking variants.
  // https://crowllm.com/docs
  {
    name: 'crowllm',
    baseUrl: 'https://crowllm.com/v1',
    authMode: 'api_key',
    envKeys: ['CROWLLM_API_KEY'],
  },
  // AMD Radeon Cloud — Token Factory serves a platform-chosen open-model
  // catalog on Radeon GPUs through an OpenAI-compatible /v1 surface. One rc-…
  // key covers every model and GET /v1/models is the catalog. China site only.
  // https://developer.amd.com.cn/radeon/tokenfactory
  {
    name: 'radeon',
    baseUrl: 'https://developer.amd.com.cn/radeon/api/v1',
    authMode: 'api_key',
    envKeys: ['RADEON_API_KEY', 'AMD_API_KEY'],
  },
  // Runcrate — OpenAI-compatible inference on one `rc_live_…` key, alongside a
  // GPU infrastructure API on the same account. GET /v1/models is public and
  // carries real context/output limits, modalities, features and USD prices.
  // https://www.runcrate.ai/docs/models/overview
  {
    name: 'runcrate',
    baseUrl: 'https://api.runcrate.ai/v1',
    authMode: 'api_key',
    envKeys: ['RUNCRATE_API_KEY'],
  },
  // Token Harbor — OpenAI-compatible (and Anthropic-compatible) gateway on one
  // `thk_live_…` key. Verification probes GET /v1/models with Bearer auth.
  // https://tokenharbor.ai/docs/api/curl
  {
    name: 'tokenharbor',
    baseUrl: 'https://tokenharbor.ai/v1',
    authMode: 'api_key',
    envKeys: ['TOKENHARBOR_API_KEY'],
  },
  // Logfare — free, community-run OpenAI-compatible inference host.
  // `logfare/auto` routes across its catalog; GET /v1/models is public.
  // https://logfare.ai/
  {
    name: 'logfare',
    baseUrl: 'https://logfare.ai/v1',
    authMode: 'api_key',
    envKeys: ['LOGFARE_API_KEY'],
  },
  // APInex — OpenAI-compatible model + web-tool gateway. The API lives on the
  // `api.` host while keys are issued on the site root.
  // https://apinex.bond/developers
  {
    name: 'apinex',
    baseUrl: 'https://api.apinex.bond/v1',
    authMode: 'api_key',
    envKeys: ['APINEX_API_KEY'],
  },
  // Gwarden AI — unified gateway speaking the OpenAI, Anthropic and Responses
  // APIs over one key. Its public /v1/models catalog reports context_length
  // and max_output_tokens per model, so discovery carries real limits.
  // https://gwarden.su
  {
    name: 'gwarden',
    baseUrl: 'https://gwarden.su/v1',
    authMode: 'api_key',
    envKeys: ['GWARDEN_API_KEY'],
  },
  // Vyce AI — OpenAI-compatible multi-model API proxy. The documented API
  // surface is rooted at /v1 and uses a Bearer API key.
  {
    name: 'vyceai',
    baseUrl: 'https://vyceai.com/v1',
    authMode: 'api_key',
    envKeys: ['VYCEAI_API_KEY', 'VYCE_AI_API_KEY'],
  },
  {
    name: 'respan',
    baseUrl: 'https://api.respan.ai/api/v1',
    authMode: 'api_key',
    envKeys: ['RESPAN_API_KEY'],
  },
  {
    name: 'tokenrouter',
    baseUrl: 'https://api.tokenrouter.com/v1',
    authMode: 'api_key',
    envKeys: ['TOKENROUTER_API_KEY'],
  },
  {
    name: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    authMode: 'api_key',
    envKeys: ['GROQ_API_KEY'],
  },
  {
    name: 'digitalocean',
    baseUrl: 'https://inference.do-ai.run/v1',
    authMode: 'api_key',
    envKeys: ['DIGITALOCEAN_API_KEY'],
  },
  // Command Code Provider API — OpenAI- and Anthropic-compatible endpoints on
  // one key. Claude models dispatch to /messages; see command-code.ts.
  {
    name: 'commandcode',
    baseUrl: 'https://api.commandcode.ai/provider/v1',
    authMode: 'api_key',
    envKeys: ['COMMAND_CODE_API_KEY'],
  },
  {
    name: 'copilot',
    baseUrl: 'https://api.githubcopilot.com',
    authMode: 'auth_only',
    envKeys: [],
    envAuthTokenKey: 'GITHUB_COPILOT_TOKEN',
  },
  // CLI harness providers — authenticated via their own CLI login, no API key.
  {
    name: 'codex',
    baseUrl: '',
    authMode: 'auth_only',
    envKeys: [],
    envAuthTokenKey: 'CODEX_AUTH_TOKEN',
  },
  { name: 'codex-auth', baseUrl: '', authMode: 'auth_only', envKeys: [] },
  {
    name: 'claude',
    baseUrl: '',
    authMode: 'auth_only',
    envKeys: [],
    envAuthTokenKey: 'CLAUDE_CODE_OAUTH_TOKEN',
  },
  {
    name: 'grok',
    baseUrl: '',
    authMode: 'auth_only',
    envKeys: [],
    envAuthTokenKey: 'GROK_CODE_XAI_API_KEY',
  },
  {
    name: 'codebuddy',
    baseUrl: '',
    authMode: 'auth_only',
    envKeys: [],
    envAuthTokenKey: 'CODEBUDDY_API_KEY',
  },
  { name: 'antigravity', baseUrl: '', authMode: 'auth_only', envKeys: [] },
  { name: 'cursor', baseUrl: '', authMode: 'auth_only', envKeys: [] },
  { name: 'devin', baseUrl: '', authMode: 'auth_only', envKeys: [] },
  { name: 'freebuff', baseUrl: '', authMode: 'auth_only', envKeys: [] },
  { name: 'omnirush', baseUrl: '', authMode: 'auth_only', envKeys: [] },
  { name: 'opencode', baseUrl: '', authMode: 'auth_only', envKeys: [] },
  {
    name: 'codebuff',
    baseUrl: 'https://www.codebuff.com/api',
    authMode: 'api_key',
    envKeys: ['CODEBUFF_API_KEY'],
  },
  {
    name: 'kilocode',
    baseUrl: 'https://api.kilo.ai/api/gateway',
    authMode: 'api_key',
    envKeys: ['KILO_API_KEY'],
  },
  // Hybrid async agent (Hoplite) — org-scoped API key created in app.hoplite.sh
  // organization settings. A thread runs in a Hoplite cloud sandbox or on a local
  // Codex/Claude agent, producing threads/PRs either way; the key verifies
  // against the project catalog.
  {
    name: 'hoplite',
    baseUrl: 'https://api.hoplite.sh',
    authMode: 'api_key',
    envKeys: ['HOPLITE_API_KEY'],
  },

  // Enterprise
  {
    name: 'azure',
    baseUrl: '',
    authMode: 'api_key_or_auth',
    envKeys: ['AZURE_OPENAI_API_KEY'],
    envUrlKey: 'AZURE_OPENAI_ENDPOINT',
  },
  { name: 'bedrock', baseUrl: '', authMode: 'env_auth', envKeys: ['AWS_ACCESS_KEY_ID'] },
  {
    name: 'vertexai',
    baseUrl: '',
    authMode: 'api_key',
    envKeys: ['GOOGLE_VERTEX_AI_API_KEY'],
  },

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
    authMode: 'base_url_only',
    envKeys: [],
    envUrlKey: 'OLLAMA_BASE_URL',
  },
  {
    name: 'lmstudio',
    baseUrl: 'http://localhost:1234',
    authMode: 'base_url_only',
    envKeys: [],
  },
  {
    name: 'llamacpp',
    baseUrl: 'http://localhost:8080',
    authMode: 'base_url_only',
    envKeys: [],
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
    baseUrl: 'https://inference.baseten.co/v1',
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
    // Keep in sync with OPENCODE_DEFAULT_BASE_URL in constants.ts, which takes
    // precedence in providerDefaultBaseUrl(). The OpenAI SDK appends
    // `/chat/completions` to this value verbatim, and these endpoints live
    // under `/zen/v1` — a copy without `/v1` silently returns an HTML page.
    name: 'opencodezen',
    baseUrl: 'https://opencode.ai/zen/v1',
    authMode: 'api_key',
    envKeys: ['OPENCODE_ZEN_API_KEY'],
  },
  {
    name: 'opencodego',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    authMode: 'api_key',
    envKeys: ['OPENCODE_GO_API_KEY', 'OPENCODE_ZEN_API_KEY'],
  },
  {
    name: '302ai',
    baseUrl: 'https://api.302.ai',
    authMode: 'api_key',
    envKeys: ['A302AI_API_KEY'],
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
    baseUrl: 'https://api.cohere.ai/compatibility/v1',
    authMode: 'api_key',
    envKeys: ['COHERE_API_KEY'],
  },
  {
    name: 'perplexity',
    baseUrl: 'https://api.perplexity.ai/v1',
    authMode: 'api_key',
    envKeys: ['PERPLEXITY_API_KEY'],
  },
  // Luma Dream Machine: video and image generation through the asynchronous
  // generation API. This is `api.lumalabs.ai` (Dream Machine), not `api.luma.ai`
  // and not lu.ma event management. No chat-completions endpoint exists here.
  {
    name: 'luma',
    baseUrl: 'https://api.lumalabs.ai/dream-machine/v1',
    authMode: 'api_key',
    envKeys: ['LUMA_API_KEY'],
  },
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
    baseUrl: 'https://api.bfl.ai',
    authMode: 'api_key',
    envKeys: ['BFL_API_KEY', 'BLACKFORESTLABS_API_KEY'],
  },
  {
    name: 'klingai',
    // Kling moved off api.klingai.com; the documented endpoint is the
    // Singapore host, which also covers non-CN accounts.
    baseUrl: 'https://api-singapore.klingai.com',
    authMode: 'api_key',
    envKeys: ['KLINGAI_API_KEY'],
  },
  {
    name: 'prodia',
    // Prodia v2 unified inference job endpoint. The legacy v1 SD endpoints on
    // api.prodia.com require a different credential and are not used here.
    baseUrl: 'https://inference.prodia.com/v2/job',
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
    baseUrl: 'https://routellm.abacus.ai/v1',
    authMode: 'api_key',
    envKeys: ['ABACUS_API_KEY'],
  },
  {
    name: 'llama',
    baseUrl: 'https://api.llama.com/compat/v1',
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
  // WorkBuddy (workbuddy.ai) — Tencent's full-scenario AI agent desktop product.
  // Keys are issued by the Tencent TokenHub gateway (OpenAI Chat Completions
  // compatible); the intl host below is what WorkBuddy's own docs configure,
  // the China host is https://tokenhub.tencentcloudmaas.com/v1.
  {
    name: 'workbuddy',
    baseUrl: 'https://tokenhub-intl.tencentcloudmaas.com/v1',
    authMode: 'api_key',
    envKeys: ['WORKBUDDY_API_KEY'],
  },
  {
    // WorkBuddy AI desktop app: local runtime, no base URL (the app bundle
    // owns the endpoint). The desktop app's own auth context is used.
    name: 'workbuddy-desktop',
    baseUrl: '',
    authMode: 'auth_only',
    envKeys: [],
  },
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
    baseUrl: 'https://api.moark.ai/v1',
    authMode: 'api_key',
    envKeys: ['MOARK_API_KEY'],
  },
  {
    name: 'notion',
    baseUrl: 'https://api.notion.com/v1',
    authMode: 'api_key',
    envKeys: ['NOTION_API_KEY'],
  },
  // Legacy/enterprise providers kept for backward compatibility with existing configs.
  {
    name: 'azurecognitive',
    baseUrl: '',
    authMode: 'api_key',
    envKeys: ['AZURE_COGNITIVE_API_KEY'],
    envUrlKey: 'AZURE_COGNITIVE_RESOURCE_URL',
  },
  { name: 'sapai', baseUrl: '', authMode: 'api_key', envKeys: ['AICORE_SERVICE_KEY'] },
  {
    name: 'gitlab',
    baseUrl: 'https://gitlab.com/api/v4',
    authMode: 'api_key',
    // GITLAB_TOKEN is the name models.dev and the Duo docs use; GITLAB_API_KEY
    // keeps the generic convention. GITLAB_BASE_URL points at a self-managed
    // instance, with or without the /api/v4 suffix.
    envKeys: ['GITLAB_API_KEY', 'GITLAB_TOKEN'],
    envUrlKey: 'GITLAB_BASE_URL',
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
