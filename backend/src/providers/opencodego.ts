// OpenCode Go provider — low-cost subscription for popular open coding models.
// Hosted at https://opencode.ai/zen/go/v1. Uses the same API key as OpenCode Zen
// (subscribe at opencode.ai/auth).
//
// Go is dual-protocol: most models use the OpenAI-compatible /v1/chat/completions
// endpoint, while a subset (MiniMax and Qwen3.x) use the Anthropic-compatible
// /v1/messages endpoint. This provider dispatches to OpenAIProvider or
// AnthropicProvider based on the requested model.
//
// See: https://opencode.ai/docs/go/

import { applyModelsDevMetadata } from './models-dev';
import type { ProviderConfig, ProviderName, ModelDef } from '@koryphaios/shared';
import {
  type Provider,
  type ProviderEvent,
  type StreamRequest,
  getModelsForProvider,
  resolveModel,
} from './types';
import { OpenAIProvider } from './openai';
import { AnthropicProvider } from './anthropic';
import { providerLog } from '../logger';

const OPENCODE_GO_BASE = 'https://opencode.ai/zen/go/v1';

/**
 * Models that must be routed through the Anthropic-compatible /v1/messages
 * endpoint. Verified against https://opencode.ai/docs/go/ (Endpoints table).
 */
const ANTHROPIC_COMPATIBLE_MODELS = new Set<string>([
  'minimax-m3',
  'minimax-m2.7',
  'minimax-m2.5',
  'qwen3.7-max',
  'qwen3.7-plus',
  'qwen3.6-plus',
]);

function isAnthropicCompatible(modelId: string): boolean {
  const apiModelId = resolveModel(modelId)?.apiModelId ?? modelId;
  return ANTHROPIC_COMPATIBLE_MODELS.has(apiModelId);
}

/**
 * OpenCode Go dispatches per-model to either OpenAIProvider (default) or
 * AnthropicProvider (for /v1/messages-compatible models). The underlying clients
 * share the same base URL and API key; only the wire protocol differs.
 */
export class OpenCodeGoProvider implements Provider {
  readonly name: ProviderName = 'opencodego';
  readonly config: ProviderConfig;

  private readonly openai: OpenAIProvider;
  private readonly anthropic: AnthropicProvider;
  private readonly baseUrl: string;

  constructor(config: ProviderConfig, baseUrl: string = OPENCODE_GO_BASE) {
    this.config = config;
    this.baseUrl = baseUrl;
    this.openai = new OpenAIProvider({ ...config, baseUrl }, 'opencodego', baseUrl);
    this.anthropic = new AnthropicProvider({ ...config, baseUrl }, 'opencodego');
  }

  isAvailable(): boolean {
    return !this.config.disabled && !!(this.config.apiKey || this.config.authToken);
  }

  listModels(): ModelDef[] {
    // Enrich with models.dev capability data (reasoning tiers, real context
    // windows) — the Go /models endpoint only returns bare ids.
    return applyModelsDevMetadata(this.name, getModelsForProvider(this.name));
  }

  async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    if (isAnthropicCompatible(request.model)) {
      providerLog.debug(
        { provider: this.name, model: request.model },
        'Routing OpenCode Go request through Anthropic-compatible /v1/messages',
      );
      yield* this.anthropic.streamResponse(request);
      return;
    }
    providerLog.debug(
      { provider: this.name, model: request.model },
      'Routing OpenCode Go request through OpenAI-compatible /v1/chat/completions',
    );
    yield* this.openai.streamResponse(request);
  }
}
