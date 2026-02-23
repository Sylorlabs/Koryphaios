/**
 * KeyValidator — Minimal API key verification for provider credentials.
 *
 * Performs a minimal ping (e.g. GET /v1/models) to verify the API key is active.
 * Does NOT run full prompts; minimizes cost. All network calls use a 5s timeout
 * to prevent shell/IDE hangs.
 *
 * 2026 endpoints (aligned with api-endpoints.ts):
 * - Anthropic: https://api.anthropic.com/v1/models, anthropic-version header
 * - OpenAI: https://api.openai.com/v1/models
 * - Google Gemini: https://generativelanguage.googleapis.com/v1beta/models (?key= or x-goog-api-key)
 */

import { ANTHROPIC_VERSION } from "../../providers/api-endpoints";

const VERIFY_TIMEOUT_MS = 5_000;

export type KeyStatus = "VALID" | "INVALID" | "NO_KEY";

export interface KeyValidationResult {
  status: KeyStatus;
  error?: string;
}

/** Provider-specific minimal ping config */
const ENDPOINTS: Record<
  string,
  { url: string; auth: "x-api-key" | "bearer" | "query" }
> = {
  anthropic: {
    url: "https://api.anthropic.com/v1/models",
    auth: "x-api-key",
  },
  openai: {
    url: "https://api.openai.com/v1/models",
    auth: "bearer",
  },
  google: {
    url: "https://generativelanguage.googleapis.com/v1beta/models",
    auth: "query",
  },
  groq: {
    url: "https://api.groq.com/openai/v1/models",
    auth: "bearer",
  },
  openrouter: {
    url: "https://openrouter.ai/api/v1/models",
    auth: "bearer",
  },
  xai: {
    url: "https://api.x.ai/v1/models",
    auth: "bearer",
  },
};

/**
 * Run a single fetch with timeout. Never logs or exposes the key.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number = VERIFY_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: new Headers({
        "User-Agent": "Koryphaios/1.0",
        ...(init.headers as Record<string, string>),
      }),
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Validate a single provider's key with a minimal ping.
 * Keys are never logged; only status and optional error message are returned.
 */
export async function validateProviderKey(
  provider: string,
  credentials: { apiKey?: string | null; authToken?: string | null }
): Promise<KeyValidationResult> {
  const apiKey = credentials.apiKey?.trim() || null;
  const authToken = credentials.authToken?.trim() || null;
  const token = apiKey || authToken;

  if (!token) {
    return { status: "NO_KEY" };
  }

  const config = ENDPOINTS[provider.toLowerCase()];
  if (!config) {
    return { status: "INVALID", error: `Unsupported provider: ${provider}` };
  }

  let url = config.url;
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  switch (config.auth) {
    case "x-api-key":
      headers["x-api-key"] = token;
      headers["anthropic-version"] = ANTHROPIC_VERSION;
      break;
    case "bearer":
      headers["Authorization"] = `Bearer ${token}`;
      break;
    case "query":
      url = `${url}?key=${encodeURIComponent(token)}`;
      break;
  }

  try {
    const response = await fetchWithTimeout(url, {
      method: "GET",
      headers,
    });

    if (response.ok) {
      return { status: "VALID" };
    }

    if (response.status === 401) {
      return { status: "INVALID", error: "Unauthorized (invalid or expired key)" };
    }

    const body = await response.text();
    return {
      status: "INVALID",
      error: `HTTP ${response.status}: ${body.slice(0, 200)}`,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("abort") || message.includes("timeout")) {
      return { status: "INVALID", error: "Timeout (5s)" };
    }
    return { status: "INVALID", error: message };
  }
}

/**
 * Validate multiple providers. Returns a map of model display name (or provider) to status.
 * Intended for Health Check CLI: [Model Name]: [VALID|INVALID|NO_KEY].
 */
export async function validateProviderKeys(credentialsByProvider: {
  [provider: string]: { apiKey?: string | null; authToken?: string | null };
}): Promise<Record<string, KeyStatus>> {
  const entries = await Promise.all(
    Object.entries(credentialsByProvider).map(async ([provider, creds]) => {
      const result = await validateProviderKey(provider, creds);
      return [provider, result.status] as const;
    })
  );
  return Object.fromEntries(entries);
}
