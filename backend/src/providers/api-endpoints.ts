/**
 * 2026 Core API Endpoints & Auth Headers
 * Single source of truth for provider base URLs and auth header construction.
 * Anthropic: anthropic-version required; Gemini: x-goog-api-key and ?key= fallbacks.
 */

import type { ProviderName } from '@koryphaios/shared';

/**
 * Anthropic Messages API version documented by Anthropic.
 *
 * This is an API contract version, not the current calendar date. Inventing a
 * future date makes otherwise-valid credentials fail before the request can be
 * evaluated. Keep this value pinned to Anthropic's published version history.
 * @see https://platform.claude.com/docs/en/api/versioning
 */
export const ANTHROPIC_VERSION = '2023-06-01';

/** 2026 base URLs for connectivity and verification. Primary endpoints per provider. */
export const PROVIDER_BASE_URLS: Partial<Record<ProviderName, string>> = {
  anthropic: 'https://api.anthropic.com/v1',
  openai: 'https://api.openai.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  // AI Studio is Google's API-key surface for the same Gemini API. It is not
  // Vertex AI and it does not use Google Cloud ADC/OAuth.
  aistudio: 'https://generativelanguage.googleapis.com/v1beta',
  deepseek: 'https://api.deepseek.com/v1',
  kimicode: 'https://api.kimi.com/coding/v1',
  mistral: 'https://api.mistral.ai/v1',
  moonshot: 'https://api.moonshot.ai/v1',
  groq: 'https://api.groq.com/openai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  agentrouter: 'https://agentrouter.org/v1',
  unorouter: 'https://api.unorouter.com/v1',
  experientiallabs: 'https://api.experientiallabs.ai/v1',
  tokenharbor: 'https://tokenharbor.ai/v1',
  logfare: 'https://logfare.ai/v1',
  apinex: 'https://api.apinex.bond/v1',
  gwarden: 'https://gwarden.su/v1',
  vyceai: 'https://vyceai.com/v1',
  respan: 'https://api.respan.ai/api/v1',
  poe: 'https://api.poe.com/v1',
  workbuddy: 'https://tokenhub-intl.tencentcloudmaas.com/v1',
  xai: 'https://api.x.ai/v1',
  // Hoplite is an async-agent control plane, not an OpenAI-compatible chat
  // host: its verification probe is the authenticated project catalog, not a
  // model list.
  hoplite: 'https://api.hoplite.sh',
};

/** Gemini: v1beta often required for Thinking models and Live API (early 2026). */
export const GEMINI_VERIFY_PATH = '/models';
export const GEMINI_V1BETA_BASE = 'https://generativelanguage.googleapis.com/v1beta';
export const GEMINI_V1_BASE = 'https://generativelanguage.googleapis.com/v1';

/**
 * Vertex AI express-mode credential probe.
 *
 * Google does not expose a model-list method on the express surface. A tiny
 * countTokens request proves that the key is accepted by Vertex AI without
 * generating model output. Keep this on the official global endpoint and do
 * not fall back to the consumer Gemini API: those credentials are different
 * provider contracts.
 */
export const VERTEX_EXPRESS_VERIFY_URL =
  'https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-flash:countTokens';

/** Mask API key for logs and errors. Never log raw keys. */
export function maskApiKey(key: string | undefined | null): string {
  if (!key || typeof key !== 'string') return '(none)';
  const trimmed = key.trim();
  if (trimmed.length <= 8) return '***';
  return trimmed.slice(0, 4) + '...' + trimmed.slice(-4);
}

/** Return a display-safe endpoint without credentials, query strings, or fragments. */
export function safeEndpointUrl(value: string | undefined | null): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

export type AuthHeaderKind =
  'x-api-key' | 'bearer' | 'anthropic' | 'gemini-query' | 'gemini-header' | 'api-key' | 'azure';

export interface AuthHeadersResult {
  headers: Record<string, string>;
  /** For Gemini: URL with ?key= if using query auth (fallback). */
  urlSuffix?: string;
}

/**
 * OpenRouter app-attribution headers.
 *
 * OpenRouter requires `HTTP-Referer` to identify the calling application and
 * `X-OpenRouter-Title` for its display name. Without these, OpenRouter does
 * not recognize the caller as a registered agentic harness and may refuse to
 * route to certain models (especially agentic/premium models). The
 * `X-OpenRouter-Categories` header declares the harness type so OpenRouter
 * can gate model access correctly.
 *
 * User-configured headers always take precedence over these defaults.
 *
 * @see https://openrouter.ai/docs/app-attribution
 */
export const OPENROUTER_ATTRIBUTION_HEADERS: Record<string, string> = {
  'HTTP-Referer': 'https://koryphaios.ai',
  'X-OpenRouter-Title': 'Koryphaios',
  'X-OpenRouter-Categories': 'cli-agent,cloud-agent',
};

/** Merge OpenRouter attribution headers under user-provided overrides. */
export function withOpenRouterAttribution(
  userHeaders?: Record<string, string> | null,
): Record<string, string> {
  return { ...OPENROUTER_ATTRIBUTION_HEADERS, ...(userHeaders ?? {}) };
}

/**
 * Build auth headers (and optional URL suffix) for a provider.
 * Use for verification and minimal-cost requests only; actual SDKs may add their own.
 */
export function buildAuthHeaders(
  provider: ProviderName,
  credentials: { apiKey?: string | null; authToken?: string | null },
  options?: { useGeminiHeader?: boolean },
): AuthHeadersResult {
  const apiKey = credentials.apiKey?.trim() || null;
  const authToken = credentials.authToken?.trim() || null;
  const token = apiKey || authToken;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'Koryphaios/1.0',
  };

  switch (provider) {
    case 'anthropic':
      headers['anthropic-version'] = ANTHROPIC_VERSION;
      if (token) headers['x-api-key'] = token;
      if (authToken && !apiKey) headers['Authorization'] = `Bearer ${authToken}`;
      return { headers };

    case 'openai':
    case 'kimicode':
    case 'groq':
    case 'xai':
    case 'openrouter':
    case 'agentrouter':
    case 'unorouter':
    case 'experientiallabs':
    case 'tokenharbor':
    case 'logfare':
    case 'apinex':
    case 'gwarden':
    case 'vyceai':
    case 'respan':
    case 'poe':
    case 'deepseek':
    case 'moonshot':
    case 'mistral':
    case 'workbuddy':
      if (token) headers['Authorization'] = `Bearer ${token}`;
      if (provider === 'openrouter') {
        Object.assign(headers, withOpenRouterAttribution());
      }
      return { headers };

    case 'google':
    case 'aistudio': {
      // Gemini: support both ?key= (query) and x-goog-api-key (header) as fallbacks.
      if (options?.useGeminiHeader && token) {
        headers['x-goog-api-key'] = token;
        return { headers };
      }
      // Default: use query param for verification (matches existing behavior).
      return { headers, urlSuffix: token ? `?key=${encodeURIComponent(token)}` : '' };
    }

    case 'vertexai':
      if (token) headers['x-goog-api-key'] = token;
      return { headers };

    case 'hoplite':
      // Hoplite documents the X-Api-Key header for its org-scoped hop_ keys;
      // it does not use an Authorization bearer shape.
      if (token) headers['X-Api-Key'] = token;
      return { headers };

    case 'azure':
      if (apiKey) headers['api-key'] = apiKey;
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
      return { headers };

    default:
      if (token) headers['Authorization'] = `Bearer ${token}`;
      return { headers };
  }
}

/** GET URL for provider verification (models list or equivalent minimal-cost). */
export function getVerifyUrl(
  provider: ProviderName,
  baseUrlOverride?: string | null,
  credentials?: { apiKey?: string | null; authToken?: string | null },
): string {
  const base = baseUrlOverride ?? PROVIDER_BASE_URLS[provider];
  if (!base) return '';

  switch (provider) {
    case 'anthropic':
      return `${base}/models`;
    case 'openai':
    case 'kimicode':
    case 'groq':
    case 'xai':
    case 'openrouter':
    case 'agentrouter':
    case 'unorouter':
    case 'experientiallabs':
    case 'tokenharbor':
    case 'logfare':
    case 'apinex':
    case 'gwarden':
    case 'vyceai':
    case 'respan':
    case 'poe':
    case 'deepseek':
    case 'moonshot':
    case 'mistral':
    case 'workbuddy':
      return `${base.replace(/\/?$/, '')}/models`;
    case 'google':
    case 'aistudio': {
      const suffix = credentials ? (buildAuthHeaders(provider, credentials).urlSuffix ?? '') : '';
      return `${base.replace(/\/?$/, '')}${GEMINI_VERIFY_PATH}${suffix}`;
    }
    case 'hoplite':
      // The cheapest authenticated Hoplite probe is the project catalog; there
      // is no /models endpoint to fall back to.
      return `${base.replace(/\/?$/, '')}/api/projects`;
    default:
      return `${base.replace(/\/?$/, '')}/models`;
  }
}
