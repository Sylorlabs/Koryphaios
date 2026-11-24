/**
 * Runcrate (https://www.runcrate.ai) — OpenAI-compatible inference API.
 *
 * One `rc_live_…` key covers the whole catalog, and the same account also pays
 * for GPU instances through a separate infrastructure API. Koryphaios uses only
 * the inference surface:
 *
 *   - Base URL `https://api.runcrate.ai/v1`, `Authorization: Bearer rc_live_…`.
 *   - `POST /chat/completions` (streaming SSE, tool calls, JSON mode) is the
 *     path the base adapter drives.
 *   - `GET /models` is public and is the catalog. Every row carries its own
 *     limits and capabilities, so this adapter ships no model table:
 *     `context_length`, `max_output_length`, `input_modalities`,
 *     `output_modalities`, `supported_features` (`tools`, `reasoning`,
 *     `json_mode`, `structured_outputs`, `logprobs`) and `pricing.prompt` /
 *     `pricing.completion` as USD-per-token decimal strings.
 *
 * The catalog is not chat-only: the same list holds image, video, TTS, ASR and
 * embedding models. Those rows must never reach the chat picker, so
 * `isChatModelCandidate` keeps text-out rows and drops the ASR rows (Whisper,
 * Voxtral) whose only feature is `json_mode` — a model that cannot hold a
 * conversation is not a chat model.
 *
 * Nothing is inferred from a model id. `context_length`/`max_output_length` of
 * `0` means unstated, so that row keeps no verified window rather than a guess.
 * `free_tier` is an *allowance* (GitHub sign-in, resets) and not a price, so it
 * never becomes a $0 rate; the billed per-token prices in the row are used
 * as-is.
 *
 * Reasoning is capability-only: the catalog says `reasoning` exists but
 * publishes no effort ladder, so no `reasoning_effort` value is invented.
 *
 * Live-verified on 2026-11-16 with a real `rc_live_` key:
 *
 *   - authenticated `GET /v1/models` → 200, 121 rows, 74 chat models;
 *   - non-streaming chat on `Qwen/Qwen3.8-Flash`, `zai-org/GLM-5.3` and
 *     `deepseek-ai/DeepSeek-V4.1-Flash` (all free-tier, `usage.cost: 0`);
 *   - SSE streaming with `stream_options.include_usage`, which returns the
 *     final `usage` object including `cost`;
 *   - `reasoning_content` deltas from Qwen3.8-Flash and DeepSeek-V4.1-Flash;
 *   - tool calls: `finish_reason: "tool_calls"` with the function name and
 *     JSON arguments.
 *
 * Per-model availability is not guaranteed: `openai/gpt-oss-120b` answered
 * `503 {"error":"overloaded"}` (a string error body) during verification, and
 * `zai-org/GLM-5.3-Flash` returned HTTP 200 with no `choices` and no `usage`.
 * The free allowance itself (GitHub sign-in, resets) is account state that the
 * API does not expose here, so it is not claimed.
 */

import type { ModelDef, ProviderConfig } from '@koryphaios/shared';
import { OpenAIProvider } from './openai';

/** Runcrate's OpenAI-compatible inference and catalog surface. */
export const RUNCRATE_BASE_URL = 'https://api.runcrate.ai/v1';

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
  return typeof parsed === 'number' && Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** The catalog prices in USD per token (`"0.000000336"`); Koryphaios shows
 *  USD per million tokens. Rounding keeps float noise out of cost comparisons. */
function usdPerTokenToPerMillion(value: unknown): number | undefined {
  const perToken = asNonNegativeNumber(value);
  if (perToken === undefined) return undefined;
  return Math.round(perToken * 1_000_000 * 1e6) / 1e6;
}

/** Compact, provider-derived price label. Never a converted or estimated rate. */
function priceLabel(
  inputPerM: number | undefined,
  outputPerM: number | undefined,
): string | undefined {
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

function asStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim().toLowerCase())
    : [];
}

export class RuncrateProvider extends OpenAIProvider {
  constructor(config: ProviderConfig) {
    super(config, 'runcrate', RUNCRATE_BASE_URL);
  }

  /** Endpoint-authenticated: one `rc_live_…` key is the only credential. */
  override isAvailable(): boolean {
    return !this.config.disabled && !!(this.config.apiKey || this.config.authToken);
  }

  getModelDiscoveryError(): string | undefined {
    if (this.isAvailable()) return undefined;
    return 'A Runcrate API key is required (it starts with "rc_live_"). Create one at https://www.runcrate.ai/dashboard/keys';
  }

  /**
   * The catalog is not chat-only. Keep a row only when it returns text and is
   * not an audio-in transcription model: the ASR rows (Whisper, Voxtral)
   * return text but expose only `json_mode`, and Chat Completions cannot
   * transcribe audio.
   */
  protected override isChatModelCandidate(raw: unknown, id: string): boolean {
    if (!super.isChatModelCandidate(raw, id)) return false;
    if (!raw || typeof raw !== 'object') return true;
    const row = raw as Record<string, unknown>;
    const outputModalities = asStringList(row.output_modalities);
    const inputModalities = asStringList(row.input_modalities);
    const features = asStringSet(row.supported_features);
    if (outputModalities.length > 0 && !outputModalities.includes('text')) return false;
    if (
      inputModalities.includes('audio') &&
      !features.has('tools') &&
      !features.has('structured_outputs')
    ) {
      return false;
    }
    return true;
  }

  /**
   * Fold the catalog's own limits, modalities and prices into the model row.
   * The base implementation already reads `context_length`; this adds the
   * Runcrate-specific output limit, display name, feature flags and USD prices.
   */
  protected override enrichDiscoveredModel(raw: unknown, def: ModelDef): ModelDef {
    let next = super.enrichDiscoveredModel(raw, def);
    if (!raw || typeof raw !== 'object') return next;
    const row = raw as Record<string, unknown>;

    const name = asTrimmedString(row.name);
    if (name) next = { ...next, name };

    const context = asPositiveInt(row.context_length);
    if (context !== undefined) {
      next = { ...next, contextWindow: context, contextVerified: true };
    }

    const maxOutput = asPositiveInt(row.max_output_length);
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

    const inputModalities = asStringList(row.input_modalities);
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

    const features = asStringSet(row.supported_features);
    if (features.has('tools')) next = { ...next, functionCall: true };
    // The catalog states reasoning exists but publishes no effort ladder, so
    // record the capability and let the ladder stay unset rather than guessed.
    if (features.has('reasoning')) next = { ...next, canReason: true };

    return next;
  }
}
