import type { ModelDef, ProviderConfig } from "@koryphaios/shared";
import { createGenericModel, getModelsForProvider } from "./types";
import { OpenAIProvider } from "./openai";

type OpenRouterModelsResponse = {
  data?: Array<{ id?: string }>;
};

export class ClineProvider extends OpenAIProvider {
  private openRouterCache: ModelDef[] | null = null;
  private openRouterLastFetch = 0;

  constructor(config: ProviderConfig) {
    super(config, "cline", "https://api.cline.bot/api/v1");
  }

  override async listModels(): Promise<ModelDef[]> {
    const discoveredByClineApi = await super.listModels();
    const localModels = getModelsForProvider("cline");

    if (this.openRouterCache && Date.now() - this.openRouterLastFetch < 5 * 60 * 1000) {
      return dedupeById([...localModels, ...discoveredByClineApi, ...this.openRouterCache]);
    }

    try {
      const res = await fetch("https://openrouter.ai/api/v1/models");
      if (!res.ok) {
        return dedupeById([...localModels, ...discoveredByClineApi]);
      }

      const payload = (await res.json()) as OpenRouterModelsResponse;
      const remote = (payload.data ?? [])
        .map((m) => m.id?.trim())
        .filter((id): id is string => Boolean(id))
        .map((id) => createGenericModel(id, "cline"));

      this.openRouterCache = remote;
      this.openRouterLastFetch = Date.now();
      return dedupeById([...localModels, ...discoveredByClineApi, ...remote]);
    } catch {
      return dedupeById([...localModels, ...discoveredByClineApi]);
    }
  }
}

function dedupeById(models: ModelDef[]): ModelDef[] {
  const seen = new Set<string>();
  const deduped: ModelDef[] = [];
  for (const model of models) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    deduped.push(model);
  }
  return deduped;
}
