import type { ProviderAuthMode, ProviderName } from '@koryphaios/shared';
import { PROVIDER_CONFIGS } from './provider-configs';

// ── Derived maps (single source of truth: PROVIDER_CONFIGS) ──────────────
// Previously these were hardcoded lists that drifted out of sync with
// provider-configs.ts, causing 40+ providers to be invisible in the app.
// Now they derive from the canonical PROVIDER_CONFIGS array so adding a
// provider there automatically makes it visible everywhere.

export const PROVIDER_AUTH_MODE: Record<string, ProviderAuthMode> = Object.fromEntries(
  PROVIDER_CONFIGS.map((c) => [c.name, c.authMode]),
);

export const ENV_API_KEY_MAP: Record<string, string[]> = Object.fromEntries(
  PROVIDER_CONFIGS.map((c) => [c.name, c.envKeys]),
);

export const ENV_URL_MAP: Record<string, string | undefined> = Object.fromEntries(
  PROVIDER_CONFIGS.map((c) => [c.name, c.envUrlKey]),
);

// provider-configs.ts stores a single envAuthTokenKey; the old constants.ts
// had arrays for some providers (e.g. grok accepted two env vars). Merge both.
export const ENV_AUTH_TOKEN_MAP: Record<string, string[]> = Object.fromEntries(
  PROVIDER_CONFIGS.map((c) => [c.name, c.envAuthTokenKey ? [c.envAuthTokenKey] : []]),
);

// Merge in extra env token keys that the old hardcoded map had but
// provider-configs.ts doesn't capture (multi-env-var providers).
const EXTRA_ENV_AUTH_TOKENS: Record<string, string[]> = {
  grok: ['GROK_CODE_XAI_API_KEY', 'XAI_API_KEY'],
  copilot: ['GITHUB_COPILOT_TOKEN', 'GITHUB_TOKEN'],
};
for (const [name, keys] of Object.entries(EXTRA_ENV_AUTH_TOKENS)) {
  const existing = ENV_AUTH_TOKEN_MAP[name] ?? [];
  ENV_AUTH_TOKEN_MAP[name] = [...new Set([...existing, ...keys])];
}

// Merge in extra env URL keys that the old hardcoded map had.
const EXTRA_ENV_URLS: Record<string, string> = {
  openrouter: 'OPENROUTER_BASE_URL',
};
for (const [name, key] of Object.entries(EXTRA_ENV_URLS)) {
  if (!ENV_URL_MAP[name]) ENV_URL_MAP[name] = key;
}

// Merge in extra env API keys that the old hardcoded map had but configs didn't.
const EXTRA_ENV_API_KEYS: Record<string, string[]> = {
  bedrock: ['AWS_ACCESS_KEY_ID'],
};
for (const [name, keys] of Object.entries(EXTRA_ENV_API_KEYS)) {
  const existing = ENV_API_KEY_MAP[name] ?? [];
  ENV_API_KEY_MAP[name] = [...new Set([...existing, ...keys])];
}

/** Default base URLs for OpenAI-compatible OpenCode parity providers (verify + chat use these).
 *  Providers not listed here use the baseUrl from PROVIDER_CONFIGS. */
export const OPENCODE_DEFAULT_BASE_URL: Partial<Record<string, string>> = {
  '302ai': 'https://api.302.ai/v1',
  opencodezen: 'https://opencode.ai/zen/v1',
  opencodego: 'https://opencode.ai/zen/go/v1',
  baseten: 'https://inference.baseten.co/v1',
  cerebras: 'https://api.cerebras.ai/v1',
  cloudflare: 'https://gateway.ai.cloudflare.com/v1',
  deepseek: 'https://api.deepseek.com',
  deepinfra: 'https://api.deepinfra.com/v1',
  fireworks: 'https://api.fireworks.ai/inference/v1',
  gitlab: 'https://gitlab.com/api/v4',
  helicone: 'https://oai.hconeai.com/v1',
  huggingface: 'https://router.huggingface.co/v1',
  ionet: 'https://api.intelligence.io.solutions/api/v1',
  kimicode: 'https://api.kimi.com/coding/v1',
  minimax: 'https://api.minimax.chat/v1',
  mistral: 'https://api.mistral.ai/v1',
  moonshot: 'https://api.moonshot.ai/v1',
  nebius: 'https://api.studio.nebius.com/v1',
  ollamacloud: 'https://api.ollama.com/v1',
  ovhcloud: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
  scaleway: 'https://api.scaleway.ai/v1',
  stackit: 'https://api.openai-compat.model-serving.eu01.onstackit.cloud/v1',
  togetherai: 'https://api.together.xyz/v1',
  venice: 'https://api.venice.ai/v1',
  vercel: 'https://ai-gateway.vercel.sh/v1',
  zai: 'https://api.z.ai/api/paas/v4',
  zenmux: 'https://zenmux.ai/api/v1',
  cortecs: 'https://api.cortecs.ai/v1',
  cohere: 'https://api.cohere.ai/compatibility/v1',
  perplexity: 'https://api.perplexity.ai/v1',
  groq: 'https://api.groq.com/openai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  tokenrouter: 'https://tokenrouter.me/v1',
  digitalocean: 'https://inference.do-ai.run/v1',
  xai: 'https://api.x.ai/v1',
  novita: 'https://api.novita.ai/v3/openai',
  upstage: 'https://api.upstage.ai/v1/solar',
  siliconflow: 'https://api.siliconflow.cn/v1',
  vultr: 'https://api.vultrinference.com/v1',
  friendli: 'https://api.friendli.ai/serverless/v1',
  together: 'https://api.together.xyz/v1',
  deepgram: 'https://api.deepgram.com/v1',
  elevenlabs: 'https://api.elevenlabs.io/v1',
  abacus: 'https://routellm.abacus.ai/v1',
  llama: 'https://api.llama.com/compat/v1',
  poe: 'https://api.poe.com/v1',
};

export const LLAMACPP_DEFAULT = 'http://127.0.0.1:8080/v1';
export const LMSTUDIO_DEFAULT = 'http://localhost:1234/v1';

/** Placeholder/hint for the base URL input in the UI. Backend is the single source of truth; frontend uses this instead of hardcoding. */
export const BASE_URL_PLACEHOLDERS: Partial<Record<string, string>> = {
  zai: 'https://api.z.ai/api/paas/v4 (Standard) or .../api/coding/paas/v4 (Coding Plan) or https://open.bigmodel.cn/api/paas/v4 (China)',
  azure: 'https://YOUR_RESOURCE.cognitiveservices.azure.com',
  local: 'http://localhost:1234/v1 (or your local server)',
  ollama: 'http://localhost:11434',
  llamacpp: 'http://127.0.0.1:8080/v1',
  lmstudio: 'http://localhost:1234/v1',
  kimicode: 'https://api.kimi.com/coding/v1',
};
