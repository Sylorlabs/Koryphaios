/**
 * CrowLLM (https://crowllm.com) — one OpenAI-compatible gateway over its
 * Anthropic- and Gemini-shaped surfaces too. Koryphaios uses Chat Completions
 * at `https://crowllm.com/v1`.
 *
 * The catalog is public and needs no key: `GET /v1/models` returns OpenAI
 * model rows with `id`, `owned_by` and `supported_endpoint_types`. That is all
 * it publishes. In particular it carries no context window, output limit,
 * pricing, vision/tool flags or effort ladder, so this adapter does not invent
 * them. `contextWindow` stays unknown (`0`) and paid-model prices stay
 * undefined; only the catalog's explicit `:free` suffix becomes a zero price.
 *
 * `-thinking` ids are the gateway's explicit reasoning variants. The documented
 * Chat Completions surface accepts `reasoning_effort` low/medium/high, so those
 * are the levels exposed for those ids. This does not claim that every model
 * accepts tools or vision just because the gateway can forward them.
 *
 * The standard One API billing routes answered 401 unauthenticated:
 * `/v1/dashboard/billing/subscription` and `/v1/dashboard/billing/usage`.
 * Their authenticated payloads were not live-verified, so nothing is inferred
 * from them beyond explicitly reported fields; see `billing/provider-balances`.
 *
 * Live catalog read on 2026-11-17: 219+ rows, all advertising the `openai`
 * endpoint type, spanning 20 publishers and many `:free` ids.
 */

import type { ModelDef, ProviderConfig } from '@koryphaios/shared';
import { OpenAIProvider } from './openai';

export const CROWLLM_BASE_URL = 'https://crowllm.com/v1';

/** The documented Chat Completions effort values. */
const CROWLLM_REASONING_LEVELS = ['low', 'medium', 'high'];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A row served on the OpenAI-shaped surface is the only one Kory can call. */
function supportsOpenAIWire(raw: unknown): boolean {
  const row = asRecord(raw);
  if (!row) return true;
  const endpoints = row.supported_endpoint_types;
  if (!Array.isArray(endpoints)) return true;
  return endpoints.some((endpoint) => endpoint === 'openai');
}

export class CrowLLMProvider extends OpenAIProvider {
  constructor(config: ProviderConfig) {
    super(config, 'crowllm', CROWLLM_BASE_URL);
  }

  override isAvailable(): boolean {
    return !this.config.disabled && !!(this.config.apiKey || this.config.authToken);
  }

  protected override isChatModelCandidate(raw: unknown, id: string): boolean {
    return supportsOpenAIWire(raw) && super.isChatModelCandidate(raw, id);
  }

  /**
   * The catalog has no limits, prices or capability matrix. Consume only its
   * explicit facts: the exact id, the `:free` suffix, and `-thinking` variants.
   * `createGenericModel` seeds a zero per-token cost, so a paid model must have
   * those fields cleared rather than inherited.
   */
  protected override enrichDiscoveredModel(raw: unknown, def: ModelDef): ModelDef {
    const id = def.apiModelId ?? def.id;
    const free = /:free$/i.test(id);
    const thinking = /-thinking(?::free)?$/i.test(id);

    return {
      ...def,
      name: id,
      canReason: thinking,
      ...(thinking ? { reasoningLevels: [...CROWLLM_REASONING_LEVELS] } : {}),
      costPerMInputTokens: free ? 0 : undefined,
      costPerMOutputTokens: free ? 0 : undefined,
      costPerMInputCached: undefined,
      costPerMOutputCached: undefined,
      creditsLabel: free ? 'Free' : undefined,
    } as ModelDef;
  }
}
