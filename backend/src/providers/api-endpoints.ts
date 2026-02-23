/**
 * 2026 Core API Endpoints & Auth Headers
 * Single source of truth for provider base URLs and auth header construction.
 * Anthropic: anthropic-version required; Gemini: x-goog-api-key and ?key= fallbacks.
 */

import type { ProviderName } from "@koryphaios/shared";

/** Anthropic API version header (2023-06-01 is current stable; update when 2026 equivalent is announced). */
export const ANTHROPIC_VERSION = "2023-06-01";

/** 2026 base URLs for connectivity and verification. Primary endpoints per provider. */
export const PROVIDER_BASE_URLS: Partial<Record<ProviderName, string>> = {
  anthropic: "https://api.anthropic.com/v1",
  openai: "https://api.openai.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
  deepseek: "https://api.deepseek.com/v1",
  mistral: "https://api.mistral.ai/v1",
  groq: "https://api.groq.com/openai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  xai: "https://api.x.ai/v1",
};

/** Gemini: v1beta often required for Thinking models and Live API (early 2026). */
export const GEMINI_VERIFY_PATH = "/models";
export const GEMINI_V1BETA_BASE = "https://generativelanguage.googleapis.com/v1beta";
export const GEMINI_V1_BASE = "https://generativelanguage.googleapis.com/v1";

/** Mask API key for logs and errors. Never log raw keys. */
export function maskApiKey(key: string | undefined | null): string {
  if (!key || typeof key !== "string") return "(none)";
  const trimmed = key.trim();
  if (trimmed.length <= 8) return "***";
  return trimmed.slice(0, 4) + "..." + trimmed.slice(-4);
}

export type AuthHeaderKind =
  | "x-api-key"
  | "bearer"
  | "anthropic"
  | "gemini-query"
  | "gemini-header"
  | "api-key"
  | "azure";

export interface AuthHeadersResult {
  headers: Record<string, string>;
  /** For Gemini: URL with ?key= if using query auth (fallback). */
  urlSuffix?: string;
}

/**
 * Build auth headers (and optional URL suffix) for a provider.
 * Use for verification and minimal-cost requests only; actual SDKs may add their own.
 */
export function buildAuthHeaders(
  provider: ProviderName,
  credentials: { apiKey?: string | null; authToken?: string | null },
  options?: { useGeminiHeader?: boolean }
): AuthHeadersResult {
  const apiKey = credentials.apiKey?.trim() || null;
  const authToken = credentials.authToken?.trim() || null;
  const token = apiKey || authToken;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "Koryphaios/1.0",
  };

  switch (provider) {
    case "anthropic":
      headers["anthropic-version"] = ANTHROPIC_VERSION;
      if (token) headers["x-api-key"] = token;
      if (authToken && !apiKey) headers["Authorization"] = `Bearer ${authToken}`;
      return { headers };

    case "openai":
    case "groq":
    case "xai":
    case "openrouter":
    case "deepseek":
    case "mistral":
      if (token) headers["Authorization"] = `Bearer ${token}`;
      return { headers };

    case "google": {
      // Gemini: support both ?key= (query) and x-goog-api-key (header) as fallbacks.
      if (options?.useGeminiHeader && token) {
        headers["x-goog-api-key"] = token;
        return { headers };
      }
      // Default: use query param for verification (matches existing behavior).
      return { headers, urlSuffix: token ? `?key=${encodeURIComponent(token)}` : "" };
    }

    case "azure":
      if (apiKey) headers["api-key"] = apiKey;
      if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
      return { headers };

    default:
      if (token) headers["Authorization"] = `Bearer ${token}`;
      return { headers };
  }
}

/** GET URL for provider verification (models list or equivalent minimal-cost). */
export function getVerifyUrl(
  provider: ProviderName,
  baseUrlOverride?: string | null,
  credentials?: { apiKey?: string | null; authToken?: string | null }
): string {
  const base = baseUrlOverride ?? PROVIDER_BASE_URLS[provider];
  if (!base) return "";

  switch (provider) {
    case "anthropic":
      return `${base}/models`;
    case "openai":
    case "groq":
    case "xai":
    case "openrouter":
    case "deepseek":
    case "mistral":
      return `${base.replace(/\/?$/, "")}/models`;
    case "google": {
      const suffix = credentials
        ? buildAuthHeaders(provider, credentials).urlSuffix ?? ""
        : "";
      return `${base.replace(/\/?$/, "")}${GEMINI_VERIFY_PATH}${suffix}`;
    }
    default:
      return `${base.replace(/\/?$/, "")}/models`;
  }
}
