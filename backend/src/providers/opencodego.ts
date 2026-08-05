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

import type { ProviderConfig } from '@koryphaios/shared';
import {
  type ProviderEvent,
  type StreamRequest,
} from './types';
import { OpenAIProvider } from './openai';
import { providerLog } from '../logger';

const OPENCODE_GO_BASE = 'https://opencode.ai/zen/go/v1';

/**
 * OpenCode Go dispatches per-model to either OpenAIProvider (default) or
 * AnthropicProvider (for /v1/messages-compatible models). The underlying clients
 * share the same base URL and API key; only the wire protocol differs.
 */
export class OpenCodeGoProvider extends OpenAIProvider {
  constructor(config: ProviderConfig, baseUrl: string = OPENCODE_GO_BASE) {
    super({ ...config, baseUrl }, 'opencodego', baseUrl);
  }

  async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    providerLog.debug(
      { provider: this.name, model: request.model },
      'Routing OpenCode Go request through OpenAI-compatible /v1/chat/completions',
    );
    yield* super.streamResponse(request);
  }
}
