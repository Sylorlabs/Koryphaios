/**
 * Numes (https://numes.ai) — multi-model OpenAI-compatible gateway.
 *
 * Numes publishes an OpenRouter-shaped catalog at `GET /api/v1/models`. Unlike
 * a bare-slug `/models` list, that catalog is the authoritative source for
 * everything the picker shows and billing needs:
 *
 *   - `context_length` / `max_input_tokens` / `top_provider.context_length`
 *   - `maximum_output_length` / `top_provider.max_completion_tokens`
 *   - `pricing.prompt` / `pricing.completion` / `pricing.input_cache_read`
 *     as USD-per-token decimal strings (converted to USD per million here)
 *   - `reasoning.supported_efforts` (the real effort ladder), plus
 *     `supported_parameters` for tool calling
 *   - `architecture.input_modalities` / `architecture.output_modalities`
 *
 * Nothing is inferred from a model id: a field the catalog omits stays unknown
 * instead of being guessed. The request path is the base OpenAI Chat
 * Completions adapter, which already streams `delta.reasoning` (the shape
 * Numes returns) and reads provider-reported usage. Numes reports its actual
 * per-turn USD charge in `usage.cost`, which the base adapter forwards as
 * `reportedCostUsd`.
 *
 * Live-verified against https://api.numes.ai/api/v1 with a real key:
 * catalog (153 models), streaming, tool calls, and both `reasoning_effort` and
 * the unified `reasoning: { effort }` control were accepted. Paid-model turns
 * were not executed because that key has no credit, so account entitlement for
 * every listed model is not claimed.
 */

import type { ModelDef, ProviderConfig } from '@koryphaios/shared';
import { OpenAIProvider } from './openai';

/** Numes' OpenAI-compatible inference and catalog surface. */
export const NUMES_API_BASE_URL = 'https://api.numes.ai/api/v1';

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

/**
 * The catalog prices in USD per token (`"0.00001"`). The rest of Koryphaios
 * denominates model costs in USD per million tokens. Rounding keeps binary
 * float noise out of the picker and out of cost comparisons.
 */
function usdPerTokenToPerMillion(value: unknown): number | undefined {
  const perToken = asNonNegativeNumber(value);
  if (perToken === undefined) return undefined;
  return Math.round(perToken * 1_000_000 * 1e6) / 1e6;
}

/** Compact, provider-derived price label. Never a converted or estimated rate. */
function priceLabel(inputPerM: number | undefined, outputPerM: number | undefined): string | undefined {
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

function asStringSet(value: unknown): ReadonlySet<string> {
  return new Set(
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [],
  );
}

export class NumesProvider extends OpenAIProvider {
  constructor(config: ProviderConfig) {
    super(config, 'numes', NUMES_API_BASE_URL);
  }

  /**
   * Endpoint-authenticated like the other gateways: a Numes key is the only
   * credential, and the catalog is served under the same `/api/v1` prefix.
   */
  override isAvailable(): boolean {
    return !this.config.disabled && !!(this.config.apiKey || this.config.authToken);
  }

  /**
   * Fold the catalog's own pricing, limits and modalities into the model row.
   * The base implementation already reads `context_length`,
   * `top_provider.max_completion_tokens`, nested `reasoning.supported_efforts`
   * and output modalities; this adds the Numes-specific fields and the USD
   * prices that drive both the picker and per-turn billing.
   */
  protected override enrichDiscoveredModel(raw: unknown, def: ModelDef): ModelDef {
    let next = super.enrichDiscoveredModel(raw, def);
    if (!raw || typeof raw !== 'object') return next;
    const row = raw as Record<string, unknown>;

    const name = asTrimmedString(row.name);
    if (name) next = { ...next, name };

    const context =
      asPositiveInt(row.context_length) ??
      asPositiveInt(row.max_input_tokens) ??
      asPositiveInt((row.top_provider as Record<string, unknown> | undefined)?.context_length);
    if (context !== undefined) {
      next = { ...next, contextWindow: context, contextVerified: true };
    }

    const maxOutput =
      asPositiveInt(row.maximum_output_length) ??
      asPositiveInt(
        (row.top_provider as Record<string, unknown> | undefined)?.max_completion_tokens,
      );
    if (maxOutput !== undefined) next = { ...next, maxOutputTokens: maxOutput };

    const pricing =
      row.pricing && typeof row.pricing === 'object'
        ? (row.pricing as Record<string, unknown>)
        : undefined;
    const inputPerM = usdPerTokenToPerMillion(pricing?.prompt);
    const outputPerM = usdPerTokenToPerMillion(pricing?.completion);
    const cacheReadPerM = usdPerTokenToPerMillion(pricing?.input_cache_read);
    const cacheWritePerM = usdPerTokenToPerMillion(pricing?.input_cache_write);
    if (inputPerM !== undefined) next = { ...next, costPerMInputTokens: inputPerM };
    if (outputPerM !== undefined) next = { ...next, costPerMOutputTokens: outputPerM };
    if (cacheReadPerM !== undefined) next = { ...next, costPerMInputCached: cacheReadPerM };
    if (cacheWritePerM !== undefined) next = { ...next, costPerMOutputCached: cacheWritePerM };
    const label = priceLabel(inputPerM, outputPerM);
    if (label) next = { ...next, creditsLabel: label };

    const architecture =
      row.architecture && typeof row.architecture === 'object'
        ? (row.architecture as Record<string, unknown>)
        : undefined;
    const inputModalities = Array.isArray(architecture?.input_modalities)
      ? (architecture?.input_modalities as unknown[]).map((m) => String(m).toLowerCase())
      : [];
    const vision = inputModalities.includes('image');
    const acceptsAttachments = inputModalities.some((modality) =>
      ['image', 'file', 'audio', 'video'].includes(modality),
    );
    if (vision || acceptsAttachments) {
      next = {
        ...next,
        ...(vision ? { vision: true } : {}),
        supportsAttachments: next.supportsAttachments || acceptsAttachments,
      };
    }

    const supported = asStringSet(row.supported_parameters);
    if (supported.has('tools')) next = { ...next, functionCall: true };

    // The catalog states whether a model accepts the unified reasoning object.
    // The ladder itself comes from `reasoning.supported_efforts` (handled by
    // the base enrichment); only record capability when Numes says it exists.
    const reasoning =
      row.reasoning && typeof row.reasoning === 'object'
        ? (row.reasoning as Record<string, unknown>)
        : undefined;
    if (reasoning || supported.has('reasoning') || supported.has('reasoning_effort')) {
      // The catalog stated reasoning exists. `canReason` must not stay at the
      // generic false default just because the effort ladder is absent.
      next = { ...next, canReason: true };
    }

    return next;
  }
}
