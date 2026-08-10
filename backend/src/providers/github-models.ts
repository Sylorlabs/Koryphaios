// GitHub Models provider.
//
// Inference is OpenAI-compatible at https://models.github.ai/inference, but
// model discovery is a separate GitHub catalog API at /catalog/models. Treating
// /inference/models as a catalog produced false connection failures and no
// selectable models.
//
// Official contract:
// https://docs.github.com/en/rest/models/catalog?apiVersion=2022-11-28

import type { ModelDef, ProviderConfig } from '@koryphaios/shared';
import { providerLog } from '../logger';
import { OpenAIProvider } from './openai';
import { isLikelyChatModelId, modelFromRemoteId } from './model-list-cache';
import { withTimeoutSignal } from './utils';

export const GITHUB_MODELS_INFERENCE_BASE = 'https://models.github.ai/inference';
export const GITHUB_MODELS_CATALOG_URL = 'https://models.github.ai/catalog/models';
export const GITHUB_MODELS_API_VERSION = '2022-11-28';

type CatalogEntry = {
  id?: unknown;
  name?: unknown;
  capabilities?: unknown;
  limits?: { max_input_tokens?: unknown; max_output_tokens?: unknown };
  supported_input_modalities?: unknown;
};

export function githubModelsHeaders(token: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': GITHUB_MODELS_API_VERSION,
    'User-Agent': 'Koryphaios/1.0',
  };
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function parseGitHubModelsCatalog(payload: unknown): ModelDef[] {
  if (!Array.isArray(payload)) return [];
  const result: ModelDef[] = [];
  const seen = new Set<string>();
  for (const raw of payload as CatalogEntry[]) {
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    if (!id || seen.has(id) || !isLikelyChatModelId(id, 'github-models')) continue;
    seen.add(id);
    const def = modelFromRemoteId(id, 'github-models', []);
    const maxInput = positiveNumber(raw.limits?.max_input_tokens);
    const maxOutput = positiveNumber(raw.limits?.max_output_tokens);
    const modalities = Array.isArray(raw.supported_input_modalities)
      ? raw.supported_input_modalities.filter((item): item is string => typeof item === 'string')
      : [];
    const capabilities = Array.isArray(raw.capabilities)
      ? raw.capabilities.filter((item): item is string => typeof item === 'string')
      : [];
    result.push({
      ...def,
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : def.name,
      ...(maxInput ? { contextWindow: maxInput, contextVerified: true } : {}),
      ...(maxOutput ? { maxOutputTokens: maxOutput } : {}),
      supportsStreaming: capabilities.includes('streaming'),
      supportsAttachments: modalities.includes('image'),
      vision: modalities.includes('image'),
    });
  }
  return result;
}

export class GitHubModelsProvider extends OpenAIProvider {
  private catalog: ModelDef[] = [];
  private catalogAt = 0;
  private catalogRequest: Promise<void> | null = null;
  private catalogError: string | undefined;

  constructor(config: ProviderConfig) {
    super(config, 'github-models', config.baseUrl || GITHUB_MODELS_INFERENCE_BASE);
  }

  override isAvailable(): boolean {
    return !this.config.disabled && !!(this.config.apiKey || this.config.authToken);
  }

  override listModels(): ModelDef[] {
    if (!this.isAvailable()) return [];
    if (Date.now() - this.catalogAt > 5 * 60_000) void this.refreshModels(true);
    return this.catalog;
  }

  override refreshModels(forceRefresh = false): Promise<void> {
    if (!forceRefresh || !this.isAvailable()) return Promise.resolve();
    if (this.catalogRequest) return this.catalogRequest;
    this.catalogRequest = this.fetchCatalog().finally(() => {
      this.catalogRequest = null;
    });
    return this.catalogRequest;
  }

  getModelDiscoveryError(): string | undefined {
    return this.catalogError;
  }

  private async fetchCatalog(): Promise<void> {
    const token = this.config.apiKey || this.config.authToken;
    if (!token) {
      this.catalogError = 'GitHub Models requires a GitHub token';
      return;
    }
    try {
      const response = await fetch(GITHUB_MODELS_CATALOG_URL, {
        method: 'GET',
        headers: githubModelsHeaders(token),
        signal: withTimeoutSignal(undefined, 10_000),
      });
      if (!response.ok) {
        const body = (await response.text()).slice(0, 240);
        this.catalogError = `GitHub Models catalog HTTP ${response.status}${body ? `: ${body}` : ''}`;
        return;
      }
      const models = parseGitHubModelsCatalog(await response.json());
      if (models.length === 0) {
        this.catalogError = 'GitHub Models returned no chat-capable catalog entries';
        return;
      }
      this.catalog = models;
      this.catalogAt = Date.now();
      this.catalogError = undefined;
    } catch (error: unknown) {
      this.catalogError = error instanceof Error ? error.message : String(error);
      providerLog.debug(
        { provider: 'github-models', error: this.catalogError },
        'GitHub Models catalog discovery failed',
      );
    }
  }
}
