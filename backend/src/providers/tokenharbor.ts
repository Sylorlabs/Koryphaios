/**
 * Token Harbor (https://tokenharbor.ai) — OpenAI- and Anthropic-compatible
 * gateway on one `thk_live_…` key.
 *
 * Its authenticated `GET /v1/models` is a rich catalog, not a bare id list.
 * Per model it publishes:
 *
 *   - `context_length` (null means unknown, not a guessed default)
 *   - `pricing.input_usd_per_1m` / `output_usd_per_1m` already in USD per
 *     million tokens, plus cache read/write rates
 *   - `reasoning.efforts` (the real `reasoning_effort` ladder),
 *     `reasoning.default_effort` and `reasoning.can_disable`, where `null`
 *     means "not checked" and `[]` means "checked, no level to set"
 *   - `tool_call` / `function_call`
 *   - `label` (display name) and `covered_by_plans` (billing coverage)
 *
 * The base OpenAI adapter already ingests `context_length`; this adapter adds
 * the Token Harbor-specific price and reasoning fields and records the provider
 * rate so per-turn billing uses the gateway's own numbers. Nothing is inferred
 * from a model id, and a catalog field that is null stays unknown.
 *
 * Free-tier allowance is not in this catalog and Token Harbor exposes no
 * key-based balance endpoint. The gateway does report it on every inference
 * response via `x-th-plan`, `x-th-free-used-pct` and `x-th-free-resets`; the
 * billing probe in `billing/provider-balances.ts` reads those headers from a
 * one-token free-model call instead of inventing a quota.
 *
 * Live-verified against https://tokenharbor.ai/v1 with a real key: 84-model
 * catalog, non-streaming and SSE chat, `reasoning_content`, tool calls,
 * `reasoning_effort`, and the Anthropic `/v1/messages` shape all work on
 * `:free` ids.
 */

import type { ModelDef, ProviderConfig } from '@koryphaios/shared';
import { OpenAIProvider } from './openai';
import { recordProviderModelPricing } from '../pricing';

/** Token Harbor's OpenAI-compatible inference and catalog surface. */
export const TOKENHARBOR_BASE_URL = 'https://tokenharbor.ai/v1';

function asTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asPositiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function asNonNegativeNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Number.parseFloat(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim().toLowerCase());
  return items.length ? [...new Set(items)] : undefined;
}

/** Compact, provider-derived price label. Never a converted or estimated rate. */
function priceLabel(
  inputPerM: number | undefined,
  outputPerM: number | undefined,
): string | undefined {
  if (inputPerM === 0 && outputPerM === 0) return 'Free';
  if (inputPerM === undefined && outputPerM === undefined) return undefined;
  const format = (value: number): string => {
    const fixed = value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
    return `$${fixed || '0'}`;
  };
  const parts: string[] = [];
  if (inputPerM !== undefined) parts.push(`${format(inputPerM)} in`);
  if (outputPerM !== undefined) parts.push(`${format(outputPerM)} out`);
  return `${parts.join(' / ')} per 1M`;
}

export class TokenHarborProvider extends OpenAIProvider {
  constructor(config: ProviderConfig) {
    super(config, 'tokenharbor', TOKENHARBOR_BASE_URL);
  }

  override isAvailable(): boolean {
    return !this.config.disabled && !!(this.config.apiKey || this.config.authToken);
  }

  protected override enrichDiscoveredModel(raw: unknown, def: ModelDef): ModelDef {
    let next = super.enrichDiscoveredModel(raw, def);
    if (!raw || typeof raw !== 'object') return next;
    const row = raw as Record<string, unknown>;

    const label = asTrimmedString(row.label);
    if (label) next = { ...next, name: label };

    // Stated explicitly so a catalog value of null never falls back to a
    // generic window: unknown stays unknown.
    const context = asPositiveInt(row.context_length);
    if (context !== undefined) {
      next = { ...next, contextWindow: context, contextVerified: true };
    }

    const pricing =
      row.pricing && typeof row.pricing === 'object'
        ? (row.pricing as Record<string, unknown>)
        : undefined;
    const inputPerM = asNonNegativeNumber(pricing?.input_usd_per_1m);
    const outputPerM = asNonNegativeNumber(pricing?.output_usd_per_1m);
    const cacheReadPerM = asNonNegativeNumber(pricing?.cache_read_usd_per_1m);
    const cacheWritePerM = asNonNegativeNumber(pricing?.cache_write_usd_per_1m);

    if (inputPerM !== undefined) next = { ...next, costPerMInputTokens: inputPerM };
    if (outputPerM !== undefined) next = { ...next, costPerMOutputTokens: outputPerM };
    if (cacheReadPerM !== undefined) next = { ...next, costPerMInputCached: cacheReadPerM };
    if (cacheWritePerM !== undefined) next = { ...next, costPerMOutputCached: cacheWritePerM };

    const labelText = priceLabel(inputPerM, outputPerM);
    if (labelText) next = { ...next, creditsLabel: labelText };

    // The billing registry stores USD *per token*, while this catalog quotes
    // USD per million. Only record a rate when both sides are published.
    if (inputPerM !== undefined && outputPerM !== undefined) {
      recordProviderModelPricing('tokenharbor', next.apiModelId ?? next.id, {
        pricing: {
          prompt: inputPerM / 1_000_000,
          completion: outputPerM / 1_000_000,
          ...(cacheReadPerM !== undefined
            ? { input_cache_read: cacheReadPerM / 1_000_000 }
            : {}),
          ...(cacheWritePerM !== undefined
            ? { input_cache_write: cacheWritePerM / 1_000_000 }
            : {}),
        },
      });
    }

    // `efforts: null` means the gateway has not checked; `[]` means it checked
    // and there is no adjustable level. `can_disable` is whether
    // `reasoning_effort: "none"` actually turns reasoning off.
    const reasoning =
      row.reasoning && typeof row.reasoning === 'object'
        ? (row.reasoning as Record<string, unknown>)
        : undefined;
    const efforts = asStringArray(reasoning?.efforts);
    const canDisable =
      typeof reasoning?.can_disable === 'boolean' ? reasoning.can_disable : undefined;
    if (canDisable === true) {
      const levels = efforts?.length
        ? efforts.includes('none')
          ? efforts
          : ['none', ...efforts]
        : ['none'];
      next = { ...next, canReason: true, reasoningLevels: levels };
    } else if (efforts?.length) {
      next = { ...next, canReason: true, reasoningLevels: efforts };
    } else if (Array.isArray(reasoning?.efforts)) {
      next = { ...next, canReason: false };
    }

    if (row.tool_call === true || row.function_call === true) {
      next = { ...next, functionCall: true };
    }

    return next;
  }
}
