/**
 * 100MillionSeek (https://100milionseek.top) — OpenAI-compatible inference.
 *
 * The authenticated `GET /v1/models` catalog is the only source of truth for
 * this provider. It reports, per model:
 *
 *   - `context_length` and `max_output_tokens` (real limits)
 *   - `price_label` (`"1x price"`, `"JEV: 1/5 price"`), the vendor's own quota
 *     wording, kept verbatim rather than converted into a currency
 *   - `quota_multiplier`, the vendor's numeric quota factor
 *   - `endpoint`, when the model is served somewhere other than
 *     `/v1/chat/completions`
 *
 * A model that declares a non-chat `endpoint` is not a chat model and is not
 * offered in the picker. JEV (`jev-1.13-free`, endpoint `/v1/systemone`) is
 * exactly this case: that endpoint takes a `questions`/`state` structured
 * request, not a chat completion, so listing it would let a user select a
 * model that cannot answer a turn. The provider publishes no USD rates, so no
 * cost is invented; the catalog's own price label is surfaced instead.
 *
 * Live-verified against https://100milionseek.top/v1 with a real key:
 * model catalog, streaming SSE, tool calls, and usage reporting all work on
 * `deepseek-v4.1-flash-free`. The catalog does not report vision or reasoning
 * support, so neither is claimed here.
 */

import type { ModelDef, ProviderConfig } from '@koryphaios/shared';
import { OpenAIProvider } from './openai';
import { isLikelyChatModelId, isModelListCacheFresh, modelFromRemoteId } from './model-list-cache';
import { foldVendorSpeedTiers } from './speed-tiers';
import { providerLog } from '../logger';

/** OpenAI-compatible inference base. */
export const HUNDREDMILLIONSEEK_BASE_URL = 'https://100milionseek.top/v1';
/** The only chat endpoint this catalog can serve. */
const CHAT_ENDPOINT = '/v1/chat/completions';

const CATALOG_TIMEOUT_MS = 15_000;

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

export class HundredMillionSeekProvider extends OpenAIProvider {
  private catalog: ModelDef[] | null = null;
  private catalogFetchedAt = 0;
  private catalogRefresh: Promise<void> | null = null;

  constructor(config: ProviderConfig) {
    super(config, 'hundredmillionseek', HUNDREDMILLIONSEEK_BASE_URL);
  }

  override isAvailable(): boolean {
    return !this.config.disabled && !!(this.config.apiKey || this.config.authToken);
  }

  /**
   * Discovery is owned by this adapter: the base class would call the same
   * `/models` route through the SDK and discard the vendor's quota fields.
   */
  override listModels(): ModelDef[] {
    if (!this.isAvailable()) return [];
    if (this.catalog && isModelListCacheFresh(this.catalogFetchedAt)) return this.catalog;
    void this.refreshCatalog();
    return this.catalog ?? [];
  }

  override refreshModels(forceRefresh = false): Promise<void> {
    if (!forceRefresh) return Promise.resolve();
    this.catalog = null;
    this.catalogFetchedAt = 0;
    return this.refreshCatalog();
  }

  getModelDiscoveryError(): string | undefined {
    if (this.isAvailable()) return undefined;
    return 'A 100MillionSeek API key is required. Create one at https://100milionseek.top.';
  }

  private refreshCatalog(): Promise<void> {
    if (this.catalogRefresh) return this.catalogRefresh;
    this.catalogRefresh = (async () => {
      try {
        const token = this.config.apiKey?.trim() || this.config.authToken?.trim();
        const response = await fetch(`${HUNDREDMILLIONSEEK_BASE_URL}/models`, {
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Koryphaios/1.0',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(this.config.headers ?? {}),
          },
          signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
        });
        if (!response.ok) {
          throw new Error(`100MillionSeek model catalog returned HTTP ${response.status}`);
        }
        const payload = (await response.json()) as { data?: unknown };
        const models: ModelDef[] = [];
        if (Array.isArray(payload.data)) {
          for (const entry of payload.data) {
            if (!entry || typeof entry !== 'object') continue;
            const def = this.modelDef(entry as Record<string, unknown>);
            if (def) models.push(def);
          }
        }
        this.catalog = foldVendorSpeedTiers(models);
        this.catalogFetchedAt = Date.now();
        providerLog.debug(
          { provider: this.name, count: models.length },
          '100MillionSeek model catalog refreshed',
        );
      } catch (err: unknown) {
        // Negative-cache the failure for the normal discovery TTL, or every
        // provider-status render re-issues the failing request.
        this.catalogFetchedAt = Date.now();
        providerLog.debug(
          { provider: this.name, err: err instanceof Error ? err.message : String(err) },
          '100MillionSeek catalog refresh failed; leaving the last verified catalog',
        );
      } finally {
        this.catalogRefresh = null;
      }
    })();
    return this.catalogRefresh;
  }

  private modelDef(row: Record<string, unknown>): ModelDef | undefined {
    const id = asTrimmedString(row.id);
    if (!id || !isLikelyChatModelId(id, this.name)) return undefined;

    // A declared endpoint other than chat completions is a different API
    // contract (JEV's `/v1/systemone` takes structured questions), so it must
    // never appear as a selectable chat model.
    const endpoint = asTrimmedString(row.endpoint);
    if (endpoint && endpoint !== CHAT_ENDPOINT) return undefined;

    const def = modelFromRemoteId(id, this.name, []);
    const context = asPositiveInt(row.context_length);
    const maxOutput = asPositiveInt(row.max_output_tokens);
    const priceLabel = asTrimmedString(row.price_label);
    const quotaMultiplier = asNonNegativeNumber(row.quota_multiplier);
    const name = asTrimmedString(row.name);

    return {
      ...def,
      apiModelId: id,
      ...(name ? { name } : {}),
      ...(context !== undefined ? { contextWindow: context, contextVerified: true } : {}),
      ...(maxOutput !== undefined ? { maxOutputTokens: maxOutput } : {}),
      ...(priceLabel ? { creditsLabel: priceLabel } : {}),
      ...(quotaMultiplier !== undefined ? { quotaMultiplier } : {}),
    };
  }
}
