// Command Code Provider API — one key, two native API formats.
//
// Contract: https://commandcode.ai/docs/provider
//
//   POST /provider/v1/chat/completions   OpenAI Chat Completions (open + other models)
//   POST /provider/v1/messages           Anthropic Messages     (Claude models)
//   GET  /provider/v1/models             Shared model catalog
//
// The same COMMAND_CODE_API_KEY authenticates both routes: `Authorization:
// Bearer` on the OpenAI format, `x-api-key` on the Anthropic format.
//
// Command Code routes by model family and rejects a mismatch — a Claude model
// sent to /chat/completions returns 400, and a non-Anthropic model sent to
// /messages does too. Dispatching on the model id is therefore the vendor's
// documented contract, not a client-side workaround.

import type { ProviderConfig } from '@koryphaios/shared';
import { AnthropicProvider } from './anthropic';
import { OpenAIProvider } from './openai';
import { resolveModel, type ProviderEvent, type StreamRequest } from './types';

export const COMMAND_CODE_BASE_URL = 'https://api.commandcode.ai/provider/v1';

/**
 * The Anthropic SDK owns the `/v1` segment: given a base URL it requests
 * `<base>/v1/messages`. Command Code's Messages route is already versioned
 * (`/provider/v1/messages`), so that client takes the base one segment earlier
 * and the SDK supplies the rest. The OpenAI client takes
 * COMMAND_CODE_BASE_URL verbatim, because that SDK adds no version itself.
 */
export const COMMAND_CODE_ANTHROPIC_BASE_URL = 'https://api.commandcode.ai/provider';

/**
 * True for the Claude models Command Code serves on its Anthropic Messages
 * route. The catalog lists them both bare (`claude-sonnet-4-6`) and namespaced
 * (`anthropic/claude-…`), so the namespace is stripped before matching.
 */
export function isCommandCodeClaudeModel(model: string): boolean {
  const normalized = model
    .trim()
    .toLowerCase()
    .replace(/^anthropic\//, '');
  return (
    normalized === 'claude' || normalized.startsWith('claude-') || normalized.startsWith('claude/')
  );
}

/**
 * Command Code gateway. Reuses Koryphaios's native OpenAI and Anthropic clients
 * and dispatches per request by model family, per the vendor contract. Both
 * formats share the provider's live /models catalog.
 */
export class CommandCodeProvider extends OpenAIProvider {
  constructor(config: ProviderConfig) {
    super(config, 'commandcode', COMMAND_CODE_BASE_URL);
  }

  override async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    // Route on the same effective model id the request will send, so a catalog
    // entry whose apiModelId differs from its display id still lands correctly.
    const effectiveModel = resolveModel(request.model)?.apiModelId ?? request.model;

    if (isCommandCodeClaudeModel(effectiveModel)) {
      // Supplying apiKey makes the Anthropic SDK send the credential as
      // x-api-key, the header Command Code accepts on the Messages route.
      const anthropic = new AnthropicProvider(
        { ...this.config, baseUrl: COMMAND_CODE_ANTHROPIC_BASE_URL },
        'commandcode',
      );
      yield* anthropic.streamResponse(request);
      return;
    }

    yield* super.streamResponse(request);
  }
}
