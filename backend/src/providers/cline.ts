/** Cline API-key provider (https://api.cline.bot/api/v1).
 *
 * Cline's hosted inference API is an OpenAI-compatible Chat Completions
 * surface. Koryphaios talks to it directly with a Cline API key — no `cline`
 * CLI is spawned, no local Cline installation is read, and no Cline-owned
 * credential is ever stored. This provider is deliberately NOT the old
 * Cline CLI harness: that adapter shelled out to a versioned child process and
 * scraped `~/.cline` for its model list.
 *
 * Cline routes ~460 models from Anthropic, OpenAI, Google, xAI, DeepSeek,
 * Mistral, Qwen and more through one key, using OpenRouter-style
 * `provider/model` ids. Three documented endpoints carry the state this
 * adapter needs; all three are read here, because none is a superset of the
 * others:
 *
 *   1. `GET  {base}/models`                      — the model ids this Cline
 *      deployment serves. Cline answers this route publicly (HTTP 200 with or
 *      without a credential), so it is a deployment inventory, NOT proof that
 *      a given key may call these models; the credential is validated by
 *      `verifyConnection()` and by the first real completion instead.
 *      OpenAI-shaped and bare: id / object / created / owned_by only.
 *   2. `GET  {host}/api/v1/ai/cline/models`      — the rich capability
 *      catalog: real `context_length`, `top_provider.max_completion_tokens`,
 *      USD pricing, input modalities, and the `supported_parameters` each
 *      model accepts (`tools`, `reasoning`, `reasoning_effort`,
 *      `include_reasoning`, `structured_outputs`, …). Public.
 *   3. `GET  {host}/api/v1/ai/cline/recommended-models` — Cline's curated
 *      `recommended` and promotional `free` sets, used to badge the picker.
 *      Public.
 *
 * Per-model reasoning *values* are the one thing no endpoint reports, so they
 * come from Cline's own published catalog (see cline-catalog.generated.ts).
 * A model with no real ladder gets no reasoning picker rather than a guessed
 * one.
 */

import type { ModelDef, ProviderConfig } from '@koryphaios/shared';
import OpenAI from 'openai';
import { OpenAIProvider } from './openai';
import { createUsageInterceptingFetch } from '../credit-accountant';
import {
  enrichFromRemoteMetadata,
  isLikelyChatModelId,
  isModelListCacheFresh,
  modelFromRemoteId,
} from './model-list-cache';
import { applyModelsDevMetadata, modelsDevKeysFor, refreshModelsDevCache } from './models-dev';
import { providerLog } from '../logger';
import {
  CLINE_EFFORT_REASONING_LEVELS,
  CLINE_TOGGLE_REASONING_MODELS,
} from './cline-catalog.generated';

/** Cline's hosted API. Inference is OpenAI-compatible under `/api/v1`. */
export const CLINE_API_BASE_URL = 'https://api.cline.bot/api/v1';
/** The capability catalog lives beside the inference prefix, not under it. */
const CLINE_API_HOST = 'https://api.cline.bot';
/** Rich capability catalog — public, no key required. */
const CLINE_CATALOG_URL = `${CLINE_API_HOST}/api/v1/ai/cline/models`;
/** Cline's curated recommended + free model sets — public. */
const CLINE_RECOMMENDED_URL = `${CLINE_API_HOST}/api/v1/ai/cline/recommended-models`;

const CLINE_CATALOG_TIMEOUT_MS = 15_000;
/** The live catalog is stable; re-read it rarely so the picker stays cheap. */
const CLINE_CATALOG_TTL_MS = 30 * 60_000;

// ─── Cline catalog wire shapes ──────────────────────────────────────────────

interface ClineCatalogArchitecture {
  input_modalities?: unknown;
  output_modalities?: unknown;
}

interface ClineCatalogModel {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  context_length?: unknown;
  architecture?: ClineCatalogArchitecture;
  pricing?: Record<string, unknown>;
  top_provider?: { max_completion_tokens?: unknown };
  supported_parameters?: unknown;
}

interface ClineRecommendedEntry {
  id?: unknown;
  name?: unknown;
}

interface ClineRecommendedPayload {
  recommended?: ClineRecommendedEntry[];
  free?: ClineRecommendedEntry[];
}

function asPositiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function asTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringSet(value: unknown): ReadonlySet<string> {
  return new Set(
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [],
  );
}

function collectIds(entries: ClineRecommendedEntry[] | undefined): string[] {
  return (entries ?? [])
    .map((entry) => asTrimmedString(entry?.id))
    .filter((id): id is string => !!id);
}

/**
 * Cline reports USD prices as decimal strings, per token
 * (`"prompt": "0.000002"`). The model catalog elsewhere in this codebase is
 * denominated in USD per million tokens.
 */
function usdPerTokenToPerMillion(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Number.parseFloat(value) : undefined;
  if (parsed === undefined || !Number.isFinite(parsed) || parsed < 0) return undefined;
  // Prices arrive as short decimal strings, so per-million is exact to a few
  // decimal places. Round to 6 to keep binary-float noise (0.0000002 ->
  // 0.19999999999999998) out of the UI and out of cost comparisons.
  return Math.round(parsed * 1_000_000 * 1e6) / 1e6;
}

/**
 * Read one of Cline's public catalog endpoints. No credential is sent: these
 * routes answer unauthenticated, and deliberately not attaching a key that may
 * be missing or wrong keeps capability metadata available even while the
 * credential itself is being fixed.
 */
async function fetchPublicJson<T>(url: string, what: string): Promise<T> {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Koryphaios/1.0' },
    signal: AbortSignal.timeout(CLINE_CATALOG_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${what} returned HTTP ${response.status}`);
  return (await response.json()) as T;
}

export class ClineProvider extends OpenAIProvider {
  private clineCatalog: Map<string, ClineCatalogModel> | null = null;
  private clineCatalogFetchedAt = 0;
  private clineBadges = new Set<string>();
  private clineFreeModels = new Set<string>();
  private clineCatalogRefresh: Promise<void> | null = null;
  /** Live model ids seen from the authenticated `/models` endpoint. */
  private clineServedIds: Set<string> | null = null;

  constructor(readonly config: ProviderConfig) {
    super(config, 'cline', CLINE_API_BASE_URL);
  }

  /**
   * Endpoint-authenticated: a Cline API key is the only credential. The base
   * implementation would also kick its own bare-slug `/models` refresh, which
   * the two-source discovery below supersedes.
   */
  override isAvailable(): boolean {
    return !this.config.disabled && !!this.token();
  }

  private token(): string | undefined {
    return this.config.apiKey?.trim() || this.config.authToken?.trim() || undefined;
  }

  /**
   * Cline documents optional `HTTP-Referer` / `X-Title` headers for usage
   * attribution. They are advisory, so user-configured headers always win.
   */
  protected override get client(): OpenAI {
    if (!this._client) {
      this._client = new OpenAI({
        apiKey: this.token() ?? 'placeholder',
        baseURL: this.baseUrl ?? this.config.baseUrl,
        defaultHeaders: {
          'HTTP-Referer': 'https://koryphaios.com',
          'X-Title': 'Koryphaios',
          ...(this.config.headers ?? {}),
        },
        fetch: createUsageInterceptingFetch(globalThis.fetch),
      });
    }
    return this._client;
  }

  override listModels(): ModelDef[] {
    if (!this.isAvailable()) return [];
    if (this.clineServedIds && this.catalogIsFresh()) return this.buildClineModels();
    void this.refreshClineCatalog();
    return this.clineServedIds ? this.buildClineModels() : [];
  }

  async refreshModels(forceRefresh = false): Promise<void> {
    if (!forceRefresh) return;
    this.clineServedIds = null;
    this.clineCatalog = null;
    this.clineCatalogFetchedAt = 0;
    this.clineBadges = new Set();
    this.clineFreeModels = new Set();
    await this.refreshClineCatalog();
  }

  /**
   * Why discovery can legitimately be empty. Cline publishes no static model
   * list, so a failed fetch means "unknown" — never substitute a guess.
   */
  getModelDiscoveryError(): string | undefined {
    if (this.isAvailable()) return undefined;
    return 'A Cline API key is required. Create one at app.cline.bot → Settings → API Keys.';
  }

  /**
   * Model ids this Cline deployment serves, from `/models`. This route is
   * public, so the list is Cline's deployment inventory rather than a
   * per-key entitlement claim; the credential is validated separately by
   * `verifyConnection()` and by the first real completion.
   */
  private async fetchServedModelIds(): Promise<Set<string>> {
    const response = await this.client.models.list();
    const ids = new Set<string>();
    for await (const model of response) {
      const id = asTrimmedString((model as { id?: unknown }).id);
      if (id) ids.add(id);
    }
    return ids;
  }

  private catalogIsFresh(): boolean {
    return isModelListCacheFresh(this.clineCatalogFetchedAt, CLINE_CATALOG_TTL_MS);
  }

  private refreshClineCatalog(): Promise<void> {
    if (this.clineCatalogRefresh) return this.clineCatalogRefresh;
    this.clineCatalogRefresh = (async () => {
      try {
        // Start the shared models.dev catalog loading so the Plan B/C enrichment
        // is available by the time discovery finishes. Non-blocking, idempotent.
        refreshModelsDevCache();
        // 1. Rich public capability catalog (metadata for every model). Cline
        //    publishes it unauthenticated, so it is never gated on the key.
        const payload = await fetchPublicJson<{ data?: unknown }>(
          CLINE_CATALOG_URL,
          'Cline model catalog',
        );
        const catalog = new Map<string, ClineCatalogModel>();
        if (Array.isArray(payload.data)) {
          for (const entry of payload.data) {
            if (!entry || typeof entry !== 'object') continue;
            const model = entry as ClineCatalogModel;
            const id = asTrimmedString(model.id);
            if (id) catalog.set(id, model);
          }
        }
        this.clineCatalog = catalog;

        // 2. Curated badges. Purely cosmetic — a failure must not block the
        //    catalog, so it degrades to "no badges".
        try {
          const recommended = await fetchPublicJson<ClineRecommendedPayload>(
            CLINE_RECOMMENDED_URL,
            'Cline recommended models',
          );
          this.clineBadges = new Set(
            collectIds(recommended.recommended),
          );
          this.clineFreeModels = new Set(collectIds(recommended.free));
        } catch (err: unknown) {
          providerLog.debug(
            { err: err instanceof Error ? err.message : String(err) },
            'Cline recommended-model badges unavailable',
          );
        }

        // 3. The deployment's served-model inventory.
        this.clineServedIds = await this.fetchServedModelIds();
        this.clineCatalogFetchedAt = Date.now();
        providerLog.debug(
          {
            provider: 'cline',
            served: this.clineServedIds.size,
            catalog: catalog.size,
            recommended: this.clineBadges.size,
          },
          'Cline model catalog refreshed',
        );
      } catch (err: unknown) {
        // Cache the failure for the normal TTL too, or every status render
        // re-issues a failing request.
        this.clineCatalogFetchedAt = Date.now();
        providerLog.debug(
          { provider: 'cline', err: err instanceof Error ? err.message : String(err) },
          'Cline catalog refresh failed; leaving the picker empty rather than guessing',
        );
      } finally {
        this.clineCatalogRefresh = null;
      }
    })();
    return this.clineCatalogRefresh;
  }

  private buildClineModels(): ModelDef[] {
    const served = this.clineServedIds;
    if (!served) return [];
    const catalog = this.clineCatalog ?? new Map<string, ClineCatalogModel>();
    const defs: ModelDef[] = [];
    for (const id of served) {
      if (!isLikelyChatModelId(id, this.name)) continue;
      defs.push(this.clineModelDef(id, catalog.get(id)));
    }
    // Plan B/C of the shared enrichment chain. Fill-only: Cline's own live
    // catalog supplies the real limits and Cline's first-party catalog supplies
    // the reasoning ladder, so this only adds reasoning tiers and context for
    // models neither of those covers. It is what lets a brand-new Cline model
    // show real reasoning levels with no code change and no regeneration.
    const enriched = applyModelsDevMetadata(
      this.name,
      defs,
      modelsDevKeysFor(this.name, this.config.kind),
    );
    // Recommended first so Cline's curated picks lead the picker, then the
    // rest alphabetically for a stable, scannable list.
    return enriched.sort((a, b) => {
      const aRec = this.clineBadges.has(a.apiModelId ?? a.id) ? 0 : 1;
      const bRec = this.clineBadges.has(b.apiModelId ?? b.id) ? 0 : 1;
      if (aRec !== bRec) return aRec - bRec;
      return (a.apiModelId ?? a.id).localeCompare(b.apiModelId ?? b.id);
    });
  }

  private clineModelDef(id: string, row: ClineCatalogModel | undefined): ModelDef {
    let def: ModelDef = modelFromRemoteId(id, this.name, []);
    if (row) {
      // Reuse the shared remote-metadata reader for the OpenAI-shaped fields
      // it already understands (context_length, top_provider.max_completion_tokens).
      def = enrichFromRemoteMetadata(row, def);
    }
    if (!def.name || def.name === def.id) {
      const label = asTrimmedString(row?.name);
      if (label) def = { ...def, name: label };
    }

    const supported = stringSet(row?.supported_parameters);
    const modalities = Array.isArray(row?.architecture?.input_modalities)
      ? (row.architecture?.input_modalities as unknown[]).map((m) => String(m).toLowerCase())
      : [];
    const vision = modalities.includes('image');
    const acceptsFiles = modalities.includes('file');
    const acceptsAudio = modalities.includes('audio');
    const tools = supported.has('tools');
    const streaming = supported.size === 0 || !supported.has('stream');

    // Reasoning: prefer Cline's own per-model ladder. `reasoning_effort` and
    // the boolean `include_reasoning` are the only two controls its API takes.
    const effortLevels = CLINE_EFFORT_REASONING_LEVELS[id];
    const toggleOnly = CLINE_TOGGLE_REASONING_MODELS.has(id);
    const acceptsEffort = supported.has('reasoning_effort') || !!effortLevels;
    const acceptsToggle = supported.has('include_reasoning') || toggleOnly;
    const canReason = acceptsEffort || acceptsToggle;

    let reasoningLevels: string[] | undefined;
    if (effortLevels) {
      reasoningLevels = [...effortLevels];
    } else if (!acceptsEffort && acceptsToggle) {
      // Toggle-only model: reasoning is genuinely on/off, so the picker offers
      // exactly those two states. Cline's catalog calls this a `toggle`, and
      // `on`/`off` are already level vocabularies elsewhere in Koryphaios.
      reasoningLevels = ['off', 'on'];
    }

    const contextWindow = asPositiveInt(row?.context_length) ?? def.contextWindow;
    const maxOut =
      asPositiveInt(row?.top_provider?.max_completion_tokens) ?? def.maxOutputTokens;
    const inPerM = usdPerTokenToPerMillion(row?.pricing?.prompt);
    const outPerM = usdPerTokenToPerMillion(row?.pricing?.completion);
    const cachePerM = usdPerTokenToPerMillion(row?.pricing?.input_cache_read);

    return {
      ...def,
      apiModelId: id,
      name: def.name || id,
      contextWindow,
      maxOutputTokens: maxOut,
      // Only mark verified when Cline itself reported the number.
      ...(asPositiveInt(row?.context_length)
        ? { contextVerified: true }
        : {}),
      ...(reasoningLevels ? { reasoningLevels } : {}),
      ...(canReason ? { canReason: true } : {}),
      ...(vision || acceptsFiles || acceptsAudio
        ? { vision, supportsAttachments: true }
        : {}),
      supportsStreaming: streaming,
      ...(tools ? { functionCall: true } : {}),
      ...(inPerM !== undefined ? { costPerMInputTokens: inPerM } : {}),
      ...(outPerM !== undefined ? { costPerMOutputTokens: outPerM } : {}),
      ...(cachePerM !== undefined ? { costPerMInputCached: cachePerM } : {}),
      ...(this.clineFreeModels.has(id) ? { tier: 'cheap' as const } : {}),
    };
  }

  /**
   * Cline routes each request to whichever upstream model matches, so there is
   * no OpenRouter-style sticky session key to send. Reasoning is the one
   * control that is not plain `reasoning_effort`:
   *
   *  - tiered models → `reasoning_effort` with the exact declared value
   *  - toggle models → the boolean `include_reasoning`
   *
   * The ladder is checked per model rather than against the caller's union of
   * tiers, so a shared level name can never reach a model that only has the
   * other control.
   */
  protected override applyReasoningControls(
    params: Record<string, unknown>,
    options: {
      canReason: boolean;
      effort: string | undefined;
      supported: ReadonlySet<string>;
      modelDef?: ModelDef;
      requestModel: string;
    },
  ): void {
    const effort = options.effort;
    if (!effort) return;
    // Resolve from the request's own model id, not from live discovery: these
    // two tables are committed, authoritative evidence, so the control works on
    // a cold adapter and never depends on the async catalog having loaded.
    // `canReason` is intentionally not required — it is derived from live
    // metadata that may not have arrived yet, and the ladder itself already
    // proves this model takes a reasoning control.
    const apiModelId = options.requestModel || options.modelDef?.apiModelId || options.modelDef?.id;
    if (!apiModelId) return;

    const levels = CLINE_EFFORT_REASONING_LEVELS[apiModelId];
    if (levels) {
      if (levels.includes(effort)) params.reasoning_effort = effort;
      return;
    }
    if (CLINE_TOGGLE_REASONING_MODELS.has(apiModelId)) {
      if (effort === 'off') params.include_reasoning = false;
      else if (effort === 'on') params.include_reasoning = true;
    }
  }
}
