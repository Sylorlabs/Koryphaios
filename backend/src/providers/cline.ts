// Cline Provider - uses Cline's OpenAI-compatible API
// Users authenticate via `cline auth` CLI, which stores a token with workos: prefix
// API Base: https://api.cline.bot/api/v1

import type { ModelDef, ProviderConfig, ProviderName } from "@koryphaios/shared";
import { OpenAIProvider } from "./openai";
import { createGenericModel, getModelsForProvider } from "./types";

const CLINE_API_BASE = "https://api.cline.bot";
const CLINE_OPENAI_BASE = `${CLINE_API_BASE}/api/v1`;

/**
 * Cline tokens use a 'workos:' prefix for WorkOS-based authentication.
 * This ensures the token has the correct prefix for the API.
 */
export function normalizeClineAuthToken(token?: string): string {
  const trimmed = token?.trim() ?? "";
  if (!trimmed) return "";
  // Cline uses workos: prefix for their WorkOS-based auth
  const prefix = "workos:";
  return trimmed.startsWith(prefix) ? trimmed : `${prefix}${trimmed}`;
}

export class ClineProvider extends OpenAIProvider {
  private clineCachedModels: ModelDef[] | null = null;
  private clineLastFetch = 0;

  constructor(config: ProviderConfig) {
    super(
      {
        ...config,
        // Cline doesn't need a prefix - the token is used as-is (with workos: prefix if present)
        authToken: config.authToken?.trim(),
        headers: {
          "HTTP-Referer": "https://cline.bot",
          "X-Title": "Koryphaios",
          ...(config.headers ?? {}),
        },
      },
      "cline" as ProviderName,
      CLINE_OPENAI_BASE,
    );
  }

  isAvailable(): boolean {
    // Cline is available if it has an auth token (from `cline auth` CLI)
    return !this.config.disabled && !!(this.config.authToken?.trim());
  }

  listModels(): ModelDef[] {
    const localModels = getModelsForProvider("cline" as ProviderName);

    if (!this.isAvailable()) {
      return localModels;
    }

    // Return cached models if still fresh (5 min cache)
    const now = Date.now();
    if (this.clineCachedModels && now - this.clineLastFetch < 5 * 60 * 1000) {
      return this.clineCachedModels;
    }

    // Background fetch Cline models from their API
    this.fetchClineModels().then((models) => {
      if (models.length > 0) {
        this.clineCachedModels = models;
        this.clineLastFetch = Date.now();
      }
    }).catch(() => {
      // Ignore fetch errors, fallback to local models
    });

    // Return local models immediately while fetching in background
    return this.clineCachedModels ?? localModels;
  }

  private async fetchClineModels(): Promise<ModelDef[]> {
    try {
      const resp = await fetch(`${CLINE_OPENAI_BASE}/models`, {
        headers: {
          "Authorization": `Bearer ${this.config.authToken}`,
          "HTTP-Referer": "https://cline.bot",
          "X-Title": "Koryphaios",
        },
      });

      if (!resp.ok) {
        throw new Error(`Cline API error: ${resp.status}`);
      }

      const data = await resp.json() as { data?: Array<{ id: string; name?: string; description?: string; context_window?: number }> };
      
      if (!data.data || !Array.isArray(data.data)) {
        return [];
      }

      return data.data.map((m) => ({
        ...createGenericModel(m.id, "cline" as ProviderName),
        name: m.name ?? m.id,
        contextWindow: m.context_window ?? 128000,
      }));
    } catch {
      return [];
    }
  }
}
