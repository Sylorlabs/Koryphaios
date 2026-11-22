/**
 * Coarena (https://coarena.ai) — OpenAI-compatible Model API on one key.
 *
 * Every model answers at `https://coarena.ai/api/v1` (Chat Completions) and the
 * Anthropic Messages base is the same host without `/v1`. Koryphaios uses Chat
 * Completions. The catalog at `GET /models` is public (no key required) and
 * carries the provider's own facts:
 *
 *   - `context_length` / `max_input_tokens`
 *   - `max_completion_tokens` / `max_tokens`
 *   - `capabilities.vision` / `tools` / `json_schema`
 *   - `capabilities.reasoning_text` and the real `capabilities.efforts` ladder
 *     (`none`, `low`, `medium`, `high`, `xhigh`, `max`)
 *   - `lifecycle` / `deprecated_at` / `retires_at`
 *
 * Two catalog fields are deliberately NOT consumed:
 *
 *   - `pricing.prompt` / `pricing.completion` are `"0"` for every model, while
 *     only some models are free. Turning that zero into a $0 provider rate
 *     would report every paid Coarena turn as free. No per-token price is
 *     recorded; account usage comes from `/credits` and `/limits` instead
 *     (see `billing/provider-balances.ts`).
 *   - `aliases` stay metadata; the canonical `id` is the only wire id used.
 *
 * The authenticated `/credits` and `/limits` endpoints are the source of the
 * account's real balance and daily usage. They are not inference calls, so
 * they live in the billing probe rather than this adapter.
 *
 * Public catalog verified live on 2026-11-17 (20 models, 128k context, 16k
 * output, `has_more: false`). Authenticated chat and the usage endpoints were
 * not executed here because no Coarena API key was available.
 */

import type { ModelDef, ProviderConfig } from '@koryphaios/shared';
import { OpenAIProvider } from './openai';

/** Coarena's OpenAI-compatible inference and catalog surface. */
export const COARENA_BASE_URL = 'https://coarena.ai/api/v1';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asPositiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim().toLowerCase());
  return items.length ? [...new Set(items)] : undefined;
}

function asTimestampMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export class CoarenaProvider extends OpenAIProvider {
  constructor(config: ProviderConfig) {
    super(config, 'coarena', COARENA_BASE_URL);
  }

  override isAvailable(): boolean {
    return !this.config.disabled && !!(this.config.apiKey || this.config.authToken);
  }

  /** A retired model cannot answer, even though it is still in the catalog. */
  protected override isChatModelCandidate(raw: unknown, id: string): boolean {
    if (!super.isChatModelCandidate(raw, id)) return false;
    const row = asRecord(raw);
    if (!row) return true;
    if (row.lifecycle === 'retired') return false;
    const retiresAt = asTimestampMs(row.retires_at);
    return !(retiresAt !== undefined && retiresAt <= Date.now());
  }

  /**
   * Intentionally does not call `super`: the base enrichment records
   * `pricing.prompt` / `pricing.completion` as a provider rate, and Coarena
   * publishes `"0"` there for every model regardless of entitlement. The live
   * catalog fields that do describe the model are folded in below.
   */
  protected override enrichDiscoveredModel(raw: unknown, def: ModelDef): ModelDef {
    const row = asRecord(raw);
    if (!row) return def;
    let next = def;

    const name = asTrimmedString(row.display_name) ?? asTrimmedString(row.name);
    if (name) next = { ...next, name };

    const context = asPositiveInt(row.context_length) ?? asPositiveInt(row.max_input_tokens);
    if (context !== undefined) {
      next = { ...next, contextWindow: context, contextVerified: true };
    }

    const maxOutput = asPositiveInt(row.max_completion_tokens) ?? asPositiveInt(row.max_tokens);
    if (maxOutput !== undefined) next = { ...next, maxOutputTokens: maxOutput };

    const capabilities = asRecord(row.capabilities) ?? {};

    if (typeof capabilities.vision === 'boolean') {
      next = {
        ...next,
        vision: capabilities.vision,
        ...(capabilities.vision ? { supportsAttachments: true } : {}),
      };
    }

    if (typeof capabilities.tools === 'boolean') {
      next = { ...next, functionCall: capabilities.tools };
    }

    const efforts = asStringArray(capabilities.efforts);
    if (capabilities.reasoning_text === false) {
      next = { ...next, canReason: false };
    } else if (capabilities.reasoning_text === true || efforts?.length) {
      next = {
        ...next,
        canReason: true,
        ...(efforts?.length ? { reasoningLevels: efforts } : {}),
      };
    }

    // Deprecated models remain callable, so they stay listed and are marked.
    if (row.lifecycle === 'deprecated') next = { ...next, deprecated: true };

    // `createGenericModel` seeds these fields with zero. Coarena publishes
    // `"0"` pricing on every row while only some models are free, so leaving
    // the seed (or the catalog zero) would show a paid model as $0.
    return {
      ...next,
      costPerMInputTokens: undefined,
      costPerMOutputTokens: undefined,
      costPerMInputCached: undefined,
      costPerMOutputCached: undefined,
      creditsLabel: undefined,
    };
  }
}
