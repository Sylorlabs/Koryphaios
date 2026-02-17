import type { ModelDef, ProviderConfig, ProviderName } from "@koryphaios/shared";
import { OpenAIProvider } from "./openai";
import { createGenericModel, getModelsForProvider } from "./types";

const CLINE_API_BASE = "https://api.cline.bot";
const CLINE_OPENAI_BASE = `${CLINE_API_BASE}/api/v1`;
const CLINE_TOKEN_PREFIX = "workos:";

export function normalizeClineAuthToken(token?: string): string {
  const trimmed = token?.trim() ?? "";
  if (!trimmed) return "";
  return trimmed.startsWith(CLINE_TOKEN_PREFIX) ? trimmed : `${CLINE_TOKEN_PREFIX}${trimmed}`;
}

export class ClineProvider extends OpenAIProvider {
  private clineCachedModels: ModelDef[] | null = null;
  private clineLastFetch = 0;

  constructor(config: ProviderConfig) {
    const normalizedToken = normalizeClineAuthToken(config.authToken);
    super(
      {
        ...config,
        authToken: normalizedToken || config.authToken,
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
    return !this.config.disabled && !!normalizeClineAuthToken(this.config.authToken);
  }

  async listModels(): Promise<ModelDef[]> {
    const providerName = "cline" as ProviderName;
    const localModels = getModelsForProvider(providerName);

    if (!this.isAvailable()) {
      return localModels;
    }

    if (this.clineCachedModels && Date.now() - this.clineLastFetch < 5 * 60 * 1000) {
      return this.clineCachedModels;
    }

    const merged = new Map<string, ModelDef>();
    for (const model of localModels) {
      merged.set(model.id, model);
    }

    try {
      const response = await this.client.models.list();
      for await (const model of response) {
        if (!model?.id || merged.has(model.id)) continue;
        merged.set(model.id, createGenericModel(model.id, providerName));
      }
    } catch {
      // Keep local models only when Cline model endpoint is unavailable.
    }

    this.clineCachedModels = [...merged.values()];
    this.clineLastFetch = Date.now();
    return this.clineCachedModels;
  }
}
