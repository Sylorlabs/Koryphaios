// Custom (bring-your-own) provider — user-defined endpoints.
//
// A user can add their own provider by giving a base URL + optional API key and choosing
// a wire format ("kind"): OpenAI-compatible (default — the most common), Anthropic-compatible
// (/v1/messages), or Gemini-compatible. We wrap the matching built-in provider so all the
// streaming/parsing logic is reused, and merge any explicitly-declared models with whatever
// the endpoint's /models discovery returns.

import type { ProviderConfig, ModelDef, ProviderName } from '@koryphaios/shared';
import {
  type Provider,
  type ProviderEvent,
  type StreamRequest,
  createGenericModel,
} from './types';
import { OpenAIProvider } from './openai';
import { AnthropicProvider } from './anthropic';
import { GeminiProvider } from './gemini';

export type CustomProviderKind = 'openai' | 'anthropic' | 'gemini';

export class CustomProvider implements Provider {
  readonly name: ProviderName;
  private readonly inner: Provider;

  constructor(readonly config: ProviderConfig) {
    this.name = config.name;
    const kind: CustomProviderKind = config.kind ?? 'openai';
    if (kind === 'anthropic') {
      this.inner = new AnthropicProvider(config, config.name);
    } else if (kind === 'gemini') {
      this.inner = new GeminiProvider({ ...config });
    } else {
      this.inner = new OpenAIProvider(config, config.name, config.baseUrl);
    }
  }

  isAvailable(): boolean {
    // A custom provider is usable as long as it's enabled and has an endpoint. The API key
    // is optional (many self-hosted OpenAI-compatible servers don't require one).
    if (this.config.disabled) return false;
    if (!this.config.baseUrl) return false;
    return true;
  }

  listModels(): ModelDef[] {
    const declared = (this.config.models ?? []).map((id) => {
      const m = createGenericModel(id, this.name);
      m.apiModelId = id;
      return m;
    });
    let live: ModelDef[] = [];
    try {
      live = this.inner.listModels();
    } catch {
      live = [];
    }
    const seen = new Set<string>();
    const merged: ModelDef[] = [];
    for (const m of [...declared, ...live]) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      merged.push(m);
    }
    return merged;
  }

  streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    return this.inner.streamResponse(request);
  }
}

/** Derive a stable provider id from a user-supplied label. */
export function customProviderId(label: string): string {
  const slug = label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `custom:${slug || 'provider'}`;
}

export function isCustomProviderId(name: string): boolean {
  return typeof name === 'string' && name.startsWith('custom:');
}
