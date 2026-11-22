/**
 * AMD Radeon Cloud — Token Factory
 * (https://developer.amd.com.cn/radeon/tokenfactory).
 *
 * AMD serves a small, platform-chosen catalog of open models on Radeon GPUs
 * through one OpenAI-compatible surface. Documented contract:
 *
 *   - Base URL `https://developer.amd.com.cn/radeon/api/v1`, Bearer auth.
 *   - One `rc-…` key works for every model in the factory; the console's "Your
 *     API key" card shows it, and it is not a per-model credential.
 *   - `GET /models` is the catalog. The platform picks the models and changes
 *     them without notice, so this adapter never ships a model table: whatever
 *     the authenticated catalog returns is what the picker offers.
 *   - Per-account daily spend cap reset at midnight Asia/Shanghai, 30 RPM per
 *     key, 120 RPM per IP, 8 concurrent per key. Rate-limit rejections are a
 *     429 with an OpenAI-style `token_rate_limit_exceeded` body and a
 *     `Retry-After` header, which the shared OpenAI retry path already reads.
 *   - An Anthropic-compatible `/v1/messages` exists on the same host; Koryphaios
 *     uses the OpenAI Chat Completions shape, which the same key accepts.
 *
 * Not live-verified against a real account: no entitlement, per-model
 * tool-calling, vision or reasoning support is claimed here. Context and
 * output limits are whatever the catalog reports, and a model the catalog
 * omits is simply not selectable.
 *
 * Where the numbers come from, in order:
 *
 *   1. A catalog row that states them (`context_length`, `max_model_len`, …).
 *   2. models.dev, through the gateway-fallback path, when the row is bare and
 *      the id belongs to an upstream lab (`DeepSeek-V4-Flash`, `Qwen3.8-…`).
 *   3. Nothing. The row then shows no verified window rather than a guess.
 *
 * Thinking text is real, not reconstructed: the base adapter streams the
 * model's own `reasoning_content` / `reasoning` deltas. `canReason` and the
 * effort ladder still only appear when the catalog or models.dev states them,
 * because sending `reasoning_effort` to a model that does not accept it fails
 * the turn.
 */

import type { ModelDef, ProviderConfig } from '@koryphaios/shared';
import { OpenAIProvider } from './openai';

/** Radeon Cloud Token Factory's OpenAI-compatible surface (China site only). */
export const RADEON_BASE_URL = 'https://developer.amd.com.cn/radeon/api/v1';

export class RadeonProvider extends OpenAIProvider {
  constructor(config: ProviderConfig) {
    super(config, 'radeon', RADEON_BASE_URL);
  }

  /** Endpoint-authenticated: the `rc-…` key is the only credential. */
  override isAvailable(): boolean {
    return !this.config.disabled && !!(this.config.apiKey || this.config.authToken);
  }

  getModelDiscoveryError(): string | undefined {
    if (this.isAvailable()) return undefined;
    return 'An AMD Radeon Cloud key is required (it starts with "rc-"). Copy it from the Token Factory page: https://developer.amd.com.cn/radeon/tokenfactory';
  }

  /**
   * Token Factory serves with vLLM, whose rows report `max_model_len` (the
   * model's full input+output window) instead of the OpenAI-style
   * `context_length` the base parser knows. Take it when the catalog states it;
   * never invent a window otherwise.
   */
  protected override enrichDiscoveredModel(raw: unknown, def: ModelDef): ModelDef {
    const next = super.enrichDiscoveredModel(raw, def);
    if (!raw || typeof raw !== 'object' || next.contextVerified) return next;
    const value = (raw as Record<string, unknown>).max_model_len;
    const maxModelLen =
      typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.floor(value)
        : undefined;
    return maxModelLen === undefined
      ? next
      : { ...next, contextWindow: maxModelLen, contextVerified: true };
  }
}
