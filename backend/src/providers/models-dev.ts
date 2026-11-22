// models.dev enrichment — opencode's public model catalog (the same data the
// opencode client uses) exposes per-model reasoning support, reasoning options
// (effort tiers / toggle / budget) and real context limits.
//
// Capability resolution runs as an ordered backup chain so a provider with a
// thin /models response still shows real numbers instead of "unknown":
//   Plan A — the provider's own /models metadata (enrichFromRemoteMetadata in
//     model-list-cache.ts; context windows, output limits, vision, reasoning).
//   Plan B — this file: the provider's own models.dev key (direct mapping).
//   Plan C — cross-lab fallback: multi-lab gateways and BYO endpoints resolve
//     each model id against the upstream labs' keys, then the whole catalog.
//   Plan D — the static fallback merge (mergeModelLists) for exact-id matches.
// Only plans that match a model's real id ever attach metadata; nothing is
// invented, and local servers are deliberately excluded from plan C so a lab
// entry can never overstate a self-hosted model's trusted context window.

import type { ModelDef } from '@koryphaios/shared';
import { buildModelParameters } from '@koryphaios/shared';
import { providerLog } from '../logger';

const MODELS_DEV_URL = 'https://models.dev/api.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Koryphaios provider name → models.dev provider key.
 *  Used for capability enrichment (reasoning tiers, real context windows).
 *  Only providers whose /models endpoint returns bare ids (or no /models at
 *  all) need this — the rest get context/vision from enrichFromRemoteMetadata
 *  and reasoning from models.dev per-model metadata. */
const PROVIDER_KEY: Record<string, string> = {
  // Major API providers — models.dev provides per-model reasoning support
  // and context windows so we don't need static reasoning tables.
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'google',
  gemini: 'google',
  aistudio: 'google',
  vertexai: 'google',
  xai: 'xai',
  deepseek: 'deepseek',
  groq: 'groq',
  // CLI providers — these ship with bare model ids from their local CLI
  // discovery (e.g. `agy models` -> "gemini-3.7-flash-high"). The CLI itself
  // does not report the context window or output limit; models.dev is the
  // only authoritative open data source for these Gemini/Claude/GPT slugs.
  antigravity: 'google',
  // Codex (CLI) and codex-auth report slugs like "gpt-5.6-terra" / "gpt-5.5"
  // via the local `model/list` JSON-RPC and the on-disk models_cache.json.
  // The CLI omits the context window from the live response, so we keep the
  // on-disk cache reader authoritative for the real number; models.dev acts
  // as a fallback when the cache is empty (e.g. first-time discovery before
  // the CLI has refreshed its own cache).
  codex: 'openai',
  // OpenCode providers — /models returns bare ids only
  opencodezen: 'opencode',
  opencodego: 'opencode-go',
  // Gateway / hosted providers — /models returns bare ids or namespaced ids
  // that match models.dev; enrichment adds reasoning + real context windows.
  openrouter: 'openrouter',
  unorouter: 'unorouter',
  tokenrouter: 'tokenrouter',
  digitalocean: 'digitalocean',
  togetherai: 'togetherai',
  cerebras: 'cerebras',
  fireworks: 'fireworks-ai',
  huggingface: 'huggingface',
  baseten: 'baseten',
  cloudflare: 'cloudflare-ai-gateway',
  vercel: 'vercel',
  ollama: 'ollama-cloud',
  ollamacloud: 'ollama-cloud',
  lmstudio: 'lmstudio',
  minimax: 'minimax',
  moonshot: 'moonshotai',
  // Kimi Code serves Moonshot models; the Console-issued API surface matches
  // the moonshotai lab entries.
  kimicode: 'moonshotai',
  nebius: 'nebius',
  venice: 'venice',
  deepinfra: 'deepinfra',
  scaleway: 'scaleway',
  ovhcloud: 'ovhcloud',
  stackit: 'stackit',
  zai: 'zai',
  zenmux: 'zenmux',
  mistral: 'mistral',
  modal: 'modal',
  modelscope: 'modelscope',
  cortecs: 'cortecs',
  azure: 'azure',
  azurecognitive: 'azure-cognitive-services',
  sapai: 'sap-ai-core',
  copilot: 'github-copilot',
  friendli: 'friendli',
  'novita-ai': 'novita-ai',
  upstage: 'upstage',
  siliconflow: 'siliconflow',
  abacus: 'abacus',
  llama: 'llama',
  vultr: 'vultr',
  wandb: 'wandb',
  poe: 'poe',
  inference: 'inference',
  submodel: 'submodel',
  synthetic: 'synthetic',
  moark: 'moark',
  // Alibaba DashScope serves Qwen; Kimi/Moonshot ids are covered above.
  qwen: 'alibaba',
  // xAI's Grok Build CLI serves xAI models under xAI ids.
  grok: 'xai',
  // Claude Code serves Anthropic models under Anthropic ids.
  claude: 'anthropic',
  // Kilo gateway ids match the kilo catalog.
  kilocode: 'kilo',
  // IO.net inference ids match the io-net catalog.
  ionet: 'io-net',
  // TokenHub gateway serves its Hunyuan models (hy3, hy4-preview) under its
  // own key; the rest of the WorkBuddy catalog (GLM/DeepSeek/Kimi/MiniMax)
  // resolve through the cross-lab fallback in modelsDevKeysFor below.
  workbuddy: 'tencent-tokenhub',
  gitlab: 'gitlab',
  mistralai: 'mistral',
  cohere: 'cohere',
  perplexity: 'perplexity',
  hyperbolic: 'hyper',
  stepfun: 'stepfun',
  alibaba: 'alibaba',
  helicone: 'helicone',
  nvidia: 'nvidia',
  friendliai: 'friendli',
  requesty: 'requesty',
  aihubmix: 'aihubmix',
  '302ai': '302ai',
  bedrock: 'amazon-bedrock',
};

/** Built-in providers that resell many upstream labs under upstream model ids
 *  with no single models.dev key of their own. Like custom BYO endpoints they
 *  resolve through the cross-lab fallback (Plan C): common-lab keys first,
 *  then a full-catalog scan. Deliberately excludes local servers (local,
 *  ollama, llamacpp, lmstudio): a lab entry must never overstate a
 *  self-hosted model's trusted context window. */
const GATEWAY_FALLBACK_PROVIDERS = new Set([
  'experientiallabs',
  // Numes resells many upstream labs under OpenRouter-style `lab/model` ids
  // and has no models.dev key of its own. Its live catalog is still
  // authoritative; this only fills limits/efforts the catalog omits.
  'numes',
  // AMD Token Factory resells upstream labs (DeepSeek, Qwen, MiniCPM) under
  // their upstream ids with no models.dev key of its own.
  'radeon',
  // Runcrate resells upstream labs under their `org/model` ids and publishes no
  // models.dev catalog of its own.
  'runcrate',
  'commandcode',
  'github-models',
  // UnoRouter exposes a first-party catalog for its own models, but also routes
  // upstream ids such as `openai/gpt-*` and `anthropic/claude-*`.
  'unorouter',
  // Respan is an OpenAI-compatible gateway with no models.dev key of its own.
  'respan',
  // Token Harbor, Logfare and APInex resell upstream labs under upstream
  // model ids and publish no models.dev catalog of their own, so their
  // reasoning ladders and limits resolve through the cross-lab fallback.
  'tokenharbor',
  'logfare',
  'apinex',
  'gwarden',
  // Vyce AI is an OpenAI-compatible proxy over Claude, GPT, Gemini, DeepSeek
  // and other upstream labs, and its authenticated /v1/models publishes the
  // callable ids without context limits or a reasoning ladder. Without this
  // entry every Vyce model had an estimated window and no reasoning picker;
  // the cross-lab fallback resolves each id against its own lab's entry.
  'vyceai',
  // Cline resells Anthropic/OpenAI/Google/xAI/DeepSeek/Mistral/Qwen models
  // under OpenRouter-style `provider/model` ids and has no models.dev key of
  // its own, so its reasoning tiers and limits resolve through the cross-lab
  // fallback. This is what makes a newly-launched Cline model show a real
  // reasoning ladder without regenerating anything.
  'cline',
]);

/** Upstream labs searched (in order) for multi-lab gateways and BYO endpoints. */
const COMMON_LAB_KEYS = ['openai', 'anthropic', 'google', 'xai', 'deepseek', 'groq', 'mistral'];

/** Resolve the models.dev provider keys to look under for a Koryphaios
 *  provider. Custom (`custom:<slug>`) providers have no catalog entry of
 *  their own, so they resolve through their wire-format family — primary
 *  family first, then the other two, plus common labs (xAI/Grok, DeepSeek,
 *  Groq, Mistral, …) so a model served over an OpenAI-compatible BYO
 *  endpoint still matches its lab entry (e.g. `custom:experimental-labs` +
 *  `grok-4.6` → `xai`). Multi-lab gateways without their own key
 *  (GATEWAY_FALLBACK_PROVIDERS) resolve the same way. */
export function modelsDevKeysFor(providerName: string, kind?: string): string[] {
  if (providerName.startsWith('custom:')) {
    if (kind === 'anthropic')
      return ['anthropic', 'openai', 'google', 'xai', 'deepseek', 'groq', 'mistral'];
    if (kind === 'gemini')
      return ['google', 'openai', 'anthropic', 'xai', 'deepseek', 'groq', 'mistral'];
    return [...COMMON_LAB_KEYS];
  }
  // WorkBuddy (TokenHub gateway) is multi-lab: `tencent-tokenhub` is the only
  // home of the Hunyuan ids (hy3, hy4-preview), while the GLM/DeepSeek/Kimi/
  // MiniMax models it resells live under the upstream labs' keys. Order
  // matters — the first key that has a model id wins.
  if (providerName === 'workbuddy') {
    return ['tencent-tokenhub', 'tencent-coding-plan', 'zai', 'deepseek', 'moonshotai', 'minimax'];
  }
  // Multi-lab gateways without their own catalog key resolve through the
  // common upstream labs (Plan C); anything rarer falls through to the
  // full-catalog scan in applyModelsDevMetadata.
  if (GATEWAY_FALLBACK_PROVIDERS.has(providerName)) {
    const ownKey = PROVIDER_KEY[providerName];
    return ownKey ? [ownKey, ...COMMON_LAB_KEYS] : [...COMMON_LAB_KEYS];
  }
  const key = PROVIDER_KEY[providerName];
  return key ? [key] : [];
}

/** Broader mapping used for PRICING lookups. A miss here is not fatal:
 *  getModelsDevPricing falls back to a full-catalog scan by model id. */
const PRICING_PROVIDER_KEY: Record<string, string> = {
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'google',
  gemini: 'google',
  aistudio: 'google',
  vertexai: 'google',
  xai: 'xai',
  deepseek: 'deepseek',
  groq: 'groq',
  mistral: 'mistral',
  openrouter: 'openrouter',
  unorouter: 'unorouter',
  tokenrouter: 'tokenrouter',
  togetherai: 'togetherai',
  fireworks: 'fireworks-ai',
  moonshot: 'moonshotai',
  kimicode: 'moonshotai',
  zai: 'zai',
  cerebras: 'cerebras',
  deepinfra: 'deepinfra',
  minimax: 'minimax',
  nebius: 'nebius',
  opencodezen: 'opencode',
  opencodego: 'opencode-go',
};

interface ModelsDevEntry {
  id: string;
  reasoning?: boolean;
  reasoning_options?: Array<{ type: string; values?: string[]; max?: number }>;
  canonical_model_id?: string;
  limit?: { context?: number; output?: number };
  /** $ per million tokens, straight from models.dev. */
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
  /** Media the lab reports, e.g. modalities: { input: ["text", "image"] }. */
  modalities?: { input?: string[]; output?: string[] };
  /** True when the lab reports the model accepts a temperature request value. */
  temperature?: boolean;
}

let cache: Record<string, { models?: Record<string, ModelsDevEntry> }> | null = null;
let fetchedAt = 0;
let inflight = false;
let inflightPromise: Promise<void> | null = null;

/** Reset the models.dev cache. Test-only — prevents state leakage between
 *  test files that mock globalThis.fetch with different catalog payloads. */
export function __resetModelsDevCacheForTesting(): void {
  cache = null;
  fetchedAt = 0;
  inflight = false;
  inflightPromise = null;
}

/** Await a fresh-enough catalog (max ~5s) — for callers that need prices NOW. */
export async function warmModelsDevCache(): Promise<void> {
  kickRefresh();
  if (cache && Date.now() - fetchedAt < CACHE_TTL_MS) return;
  if (inflightPromise) {
    await Promise.race([inflightPromise, new Promise((r) => setTimeout(r, 5_000))]);
  }
}

/** Kick a background refresh of the models.dev catalog if stale. Safe to call
 *  from any provider's listModels() — non-blocking, idempotent within the TTL. */
export function refreshModelsDevCache(): void {
  kickRefresh();
}

/**
 * Refresh the models.dev catalog ignoring its TTL, for the adaptive background
 * scheduler. A newly launched model appears here well before the provider's own
 * `/models` endpoint reports it, so a 24h TTL would leave it without context
 * limits, reasoning tiers, or pricing for a full day. Still single-flight, so
 * concurrent callers share one request.
 */
export function forceModelsDevRefresh(): void {
  kickRefresh(true);
}

function kickRefresh(force = false): void {
  if (inflight) return;
  if (!force && cache && Date.now() - fetchedAt < CACHE_TTL_MS) return;
  inflight = true;
  inflightPromise = fetch(MODELS_DEV_URL)
    .then(async (res) => {
      if (!res.ok) throw new Error(`models.dev ${res.status}`);
      cache = (await res.json()) as typeof cache;
      fetchedAt = Date.now();
      providerLog.debug(
        { providers: Object.keys(cache ?? {}).length },
        'models.dev catalog refreshed',
      );
    })
    .catch((err) => {
      providerLog.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'models.dev refresh failed — capability enrichment unavailable',
      );
    })
    .finally(() => {
      inflight = false;
      inflightPromise = null;
    });
}

/** Map models.dev reasoning_options to Koryphaios reasoning levels. */
function levelsFromOptions(
  opts: Array<{ type: string; values?: string[] }> | undefined,
): string[] | undefined {
  if (!opts?.length) return undefined;
  const effort = opts.find((o) => o.type === 'effort');
  const hasToggle = opts.some((o) => o.type === 'toggle');
  if (effort?.values?.length) {
    // Toggleable + effort tiers → 'none' turns thinking off entirely. Effort
    // tiers may already include 'none' (some labs report it); never duplicate it.
    const values = effort.values;
    return hasToggle && !values.includes('none') ? ['none', ...values] : values;
  }
  if (hasToggle) return ['none', 'high']; // pure on/off thinking
  return undefined; // budget-only or always-on: no discrete tiers to offer
}

/**
 * Enrich a provider's model defs with models.dev capability data. Synchronous
 * against the cached catalog — callers get enriched defs once the background
 * refresh has populated it. Does NOT trigger a refresh itself; call
 * warmModelsDevCache() or rely on the provider's refreshModelsInBackground
 * (which calls applyModelsDevMetadata after live discovery) to populate it.
 *
 * `providerName` is the Koryphaios provider name. `keys` is the ordered list
 * of models.dev provider keys to look under (the first one that has the model
 * wins). Defaults to a single key from PROVIDER_KEY. Antigravity is the main
 * caller that needs a multi-key list: its CLI exposes `gemini-*` (google),
 * `claude-*` (anthropic) and `gpt-oss-*` (openai) under one subscription.
 */
/**
 * Map a `namespace/` prefix on a multi-vendor model id (OpenRouter-style, which
 * Cline and other gateways use) to that lab's models.dev provider key.
 *
 * A namespaced id already states which lab serves the model, so consulting that
 * lab first is both more accurate and cheaper than a blind full-catalog scan.
 * Without it, `anthropic/claude-sonnet-5.5` can match a gateway's own stale
 * entry for the same string and inherit the wrong reasoning tiers.
 * Returns null for an unknown or non-namespaced id so the caller falls back to
 * its existing lookup order.
 */
export function modelsDevLabKeyForNamespacedId(modelId: string): string | null {
  const slash = modelId.indexOf('/');
  if (slash <= 0) return null;
  const namespace = modelId.slice(0, slash).toLowerCase().replace(/^[~.]+/, '');
  if (!namespace || namespace.includes(' ')) return null;
  const key =
    {
      'x-ai': 'xai',
      'xai': 'xai',
      'z-ai': 'zai',
      zai: 'zai',
      zhipu: 'zai',
      'z-ai-org': 'zai',
      qwen: 'alibaba',
      alibaba: 'alibaba',
      moonshot: 'moonshotai',
      moonshotai: 'moonshotai',
      kimi: 'moonshotai',
      gemini: 'google',
      google: 'google',
      'meta-llama': 'meta-llama',
      mistralai: 'mistral',
      'mistral-ai': 'mistral',
      deepseek: 'deepseek',
      'bytedance-seed': 'bytedcenteseed',
      byteplus: 'bytedcenteseed',
    }[namespace] ?? namespace;
  // Only trust a namespace that is a real models.dev provider key. A
  // `stealth/…`-style namespace has no lab entry, so the caller must keep
  // scanning rather than conclude the model is unknown.
  return cache?.[key] ? key : null;
}

export function applyModelsDevMetadata(
  providerName: string,
  models: ModelDef[],
  keys?: string[],
): ModelDef[] {
  const configuredKeys = (
    keys && keys.length > 0 ? keys : PROVIDER_KEY[providerName] ? [PROVIDER_KEY[providerName]] : []
  ) as string[];
  if (configuredKeys.length === 0) return models;
  // Lazily built, per models.dev lab: a model id's own namespace can name a lab
  // that is not in the configured key list, so the index is memoized per key
  // rather than built once for the whole list.
  // Two views per lab: exact lower-cased ids, and an id-normalized one. Labs
  // write version separators inconsistently (`claude-sonnet-5.5` on a gateway,
  // `claude-sonnet-5-5` in the lab's own catalog), and those are the same model.
  const indexByKey = new Map<string, { exact: Map<string, ModelsDevEntry>; normalized: Map<string, ModelsDevEntry> }>();
  const normalizeEntryId = (value: string): string => value.toLowerCase().replace(/[._]+/g, '-');
  const indexFor = (key: string) => {
    const cached = indexByKey.get(key);
    if (cached) return cached;
    const exact = new Map<string, ModelsDevEntry>();
    const normalized = new Map<string, ModelsDevEntry>();
    for (const [k, v] of Object.entries(cache?.[key]?.models ?? {})) {
      const lk = k.toLowerCase();
      if (!exact.has(lk)) exact.set(lk, v);
      const nk = normalizeEntryId(k);
      if (!normalized.has(nk)) normalized.set(nk, v);
    }
    const built = { exact, normalized };
    indexByKey.set(key, built);
    return built;
  };

  // BYO endpoints and multi-lab gateways can serve any lab behind an
  // OpenAI-compatible wire format. When the family keys above miss, fall back
  // to a full-catalog scan so `custom:experimental-labs` + `grok-4.6` (or a
  // gateway-served Kimi/GLM id) still resolves its verified context instead
  // of warning every turn. Single-lab and local providers never reach this:
  // an id miss there stays honestly unknown rather than risking a cross-lab
  // misattribution (e.g. an Azure deployment name colliding with a lab slug).
  // A model id that names its own lab (`anthropic/claude-sonnet-5.5`) is as
  // authoritative as a single-lab provider: if that lab has no entry, the answer
  // is honestly unknown, never some other lab's or gateway's opinion of the same
  // string. This is the same rule that keeps local/self-hosted models out of the
  // cross-lab scan, and it is what stops `anthropic/…` inheriting a gateway's
  // stale reasoning tiers.
  const gatewayScan =
    providerName.startsWith('custom:') || GATEWAY_FALLBACK_PROVIDERS.has(providerName);
  const normalizeId = (value: string): string => value.toLowerCase().replace(/[._]+/g, '-');
  let fullCatalogByLower: Map<string, ModelsDevEntry> | null = null;
  let fullCatalogByNormalized: Map<string, ModelsDevEntry> | null = null;
  const ensureFullCatalog = (): void => {
    if (fullCatalogByLower) return;
    fullCatalogByLower = new Map<string, ModelsDevEntry>();
    fullCatalogByNormalized = new Map<string, ModelsDevEntry>();
    if (!cache) return;
    for (const prov of Object.values(cache)) {
      const entries = prov?.models;
      if (!entries) continue;
      for (const [k, v] of Object.entries(entries)) {
        const lk = k.toLowerCase();
        if (!fullCatalogByLower.has(lk)) fullCatalogByLower.set(lk, v);
        const nk = normalizeId(k);
        if (!fullCatalogByNormalized!.has(nk)) fullCatalogByNormalized!.set(nk, v);
        const entryId = typeof v?.id === 'string' ? v.id : '';
        if (entryId) {
          const entryLk = entryId.toLowerCase();
          if (!fullCatalogByLower.has(entryLk)) fullCatalogByLower.set(entryLk, v);
          const entryNk = normalizeId(entryId);
          if (!fullCatalogByNormalized!.has(entryNk)) fullCatalogByNormalized!.set(entryNk, v);
        }
      }
    }
  };

  return models.map((m) => {
    const rawId = m.apiModelId ?? m.id;
    // Strip the Koryphaios provider prefix (e.g. "opencodezen.claude-sonnet-4" → "claude-sonnet-4")
    const bare = rawId.replace(new RegExp(`^${providerName}\\.`), '');
    // A `namespace/model` id names the serving lab, so look under that lab
    // first. Without this the full-catalog scan can attribute a random
    // gateway's opinion of the same string to the model and report reasoning
    // tiers (or a context window) the real lab never claimed.
    const labKey = modelsDevLabKeyForNamespacedId(bare);
    const candidateKeys =
      labKey && !configuredKeys.includes(labKey) ? [labKey, ...configuredKeys] : configuredKeys;
    // Some CLI providers (antigravity, codex) report reasoning-level
    // suffixes that models.dev does not carry in the bare id (e.g.
    // "gemini-3.7-flash-high", "claude-opus-4-6-thinking"). Try stripping
    // known effort/variant suffixes so the family-level entry (e.g.
    // "gemini-3.7-flash") still gets the verified context.
    const variantSuffixes = /-(?:low|medium|high|xhigh|ultra|max|none|thinking|pro)$/i;
    const strippedVariant = variantSuffixes.test(bare) ? bare.replace(variantSuffixes, '') : '';
    // Route/variant qualifiers appended with a colon (OpenRouter-style
    // `claude-sonnet-5.5:batch`, `kimi-k3:free`) are the same underlying model
    // as the bare id, so the lab's entry still describes their limits and
    // reasoning tiers. Strip only as a last resort, and only when something
    // remains, so an exact lab entry for the qualified id always wins and a
    // bare id can never be invented.
    const colonVariant = bare.includes(':') ? bare.replace(/:[^/]+$/, '') : '';
    // Same, but with the vendor namespace removed first, so a lab-scoped
    // lookup can see it: `anthropic/claude-sonnet-5.5:batch` must be able to
    // reach the lab's own bare `claude-sonnet-5-5` entry.
    const lastSegment = bare.includes('/') ? bare.slice(bare.lastIndexOf('/') + 1) : '';
    const lastSegmentColon = lastSegment.includes(':') ? lastSegment.replace(/:[^/]+$/, '') : '';
    // Try: exact key, case-insensitive key, last segment after "/" (namespaced ids),
    // then the variant-stripped slug as a last-resort fallback.
    const candidates = [
      bare,
      bare.toLowerCase(),
      bare.includes('/') ? bare.split('/').pop()! : '',
      rawId,
      rawId.toLowerCase(),
      strippedVariant,
      strippedVariant.toLowerCase(),
      colonVariant,
      colonVariant.toLowerCase(),
      lastSegmentColon,
      lastSegmentColon.toLowerCase(),
    ].filter(Boolean);
    let e: ModelsDevEntry | undefined;
    outer: for (const key of candidateKeys) {
      const { exact, normalized } = indexFor(key);
      if (exact.size === 0) continue;
      // Exact ids across every candidate first, so a lab that really has
      // `x` always beats a normalized collision elsewhere in the same lab.
      for (const c of candidates) {
        const hit = exact.get(c.toLowerCase());
        if (hit) {
          e = hit;
          break outer;
        }
      }
      for (const c of candidates) {
        const hit = normalized.get(normalizeEntryId(c));
        if (hit) {
          e = hit;
          break outer;
        }
      }
    }
    // Unnamed ids on a multi-lab gateway still get the cross-lab scan; a model
    // that named its own lab does not (see `labKey` above).
    if (!e && gatewayScan && !labKey) {
      ensureFullCatalog();
      for (const c of candidates) {
        const hit =
          fullCatalogByLower?.get(c.toLowerCase()) ?? fullCatalogByNormalized?.get(normalizeId(c));
        if (hit) {
          e = hit;
          break;
        }
      }
    }
    if (!e) return m;
    // Some gateway catalogs (e.g. UnoRouter) publish thin stub entries that
    // carry `reasoning: true` and a `canonical_model_id` pointing at the
    // upstream lab, but no `reasoning_options` of their own. Inherit the
    // reasoning effort tiers (and reasoning flag) from that canonical entry so
    // the composer can actually offer a reasoning picker instead of silently
    // hiding it. Context/output limits still come from the route's own entry.
    let canonicalEntry: ModelsDevEntry | undefined;
    const canonicalId =
      typeof e.canonical_model_id === 'string' ? e.canonical_model_id.trim() : '';
    if (canonicalId) {
      const slash = canonicalId.indexOf('/');
      if (slash > 0) {
        const provKey = canonicalId.slice(0, slash).toLowerCase();
        const modelKey = canonicalId.slice(slash + 1);
        const providerBucket = cache?.[provKey]?.models;
        if (providerBucket) {
          canonicalEntry =
            providerBucket[modelKey] ??
            Object.values(providerBucket).find(
              (entry) => entry?.id?.toLowerCase() === modelKey.toLowerCase(),
            );
          if (!canonicalEntry) {
            const normalizedTarget = normalizeEntryId(modelKey);
            canonicalEntry = Object.values(providerBucket).find(
              (entry) => entry?.id && normalizeEntryId(entry.id) === normalizedTarget,
            );
          }
        }
      } else {
        // No provider prefix: scan every lab for a matching model id.
        if (cache) {
          for (const prov of Object.values(cache)) {
            const bucket = prov?.models;
            if (!bucket) continue;
            const hit =
              bucket[canonicalId] ??
              Object.values(bucket).find((entry) => entry?.id?.toLowerCase() === canonicalId.toLowerCase());
            if (hit) {
              canonicalEntry = hit;
              break;
            }
          }
        }
      }
    }
    const canonicalLevels = canonicalEntry ? levelsFromOptions(canonicalEntry.reasoning_options) : undefined;
    const canReason = e.reasoning === true || canonicalEntry?.reasoning === true;
    const levels = levelsFromOptions(e.reasoning_options) ?? canonicalLevels;
    const ctx = e.limit?.context;
    // Image input is additive-only: when the lab reports it, advertise it so
    // vision pickers and attachment flows include the model. When the lab is
    // silent (or says text-only), leave the fields unknown rather than
    // declaring false — a relay may still carry pixels, and an explicit false
    // makes the OpenAI path strip images up front.
    const imageInput =
      e.modalities?.input?.some((modality) => modality.toLowerCase() === 'image') === true;
    // Output modalities are the lab's own statement of what the model can
    // produce. They are the only evidence the image and video surfaces accept;
    // a model name is never enough.
    const outputModalities = e.modalities?.output?.length
      ? [...new Set(e.modalities.output.map((modality) => modality.trim().toLowerCase()))]
      : undefined;
    return {
      ...m,
      ...(canReason ? { canReason: true } : {}),
      // Fill-only: route-reported tiers and live-verified windows always beat
      // this third-party catalog (e.g. a gateway serving a model under a
      // smaller route limit than the lab's headline number). Without this, a
      // foreign window makes sessions compact far too late and die on the
      // route's real limit.
      ...(!m.reasoningLevels?.length && levels ? { reasoningLevels: levels } : {}),
      ...(!m.contextVerified && ctx && ctx > 0
        ? { contextWindow: ctx, contextVerified: true }
        : {}),
      ...(e.limit?.output && e.limit.output > 0 ? { maxOutputTokens: e.limit.output } : {}),
      ...(imageInput ? { vision: true, supportsAttachments: true } : {}),
      // Fill-only: a route that states its own output modalities is more
      // authoritative than the lab's catalog row for the same model.
      ...(!m.outputModalities?.length && outputModalities ? { outputModalities } : {}),
      // models.dev's `temperature: boolean` is the only user-tunable request
      // key the lab reports. Provider-reported `parameters` always win.
      ...(!m.parameters?.length && e.temperature === true
        ? { parameters: buildModelParameters(['temperature']) }
        : {}),
    };
  });
}

export interface ModelsDevPricing {
  /** $ per million input tokens */
  inPerM: number;
  /** $ per million output tokens */
  outPerM: number;
  cacheReadPerM?: number;
  cacheWritePerM?: number;
}

/** Live per-token pricing from models.dev for any known provider/model.
 *  Synchronous against the cached catalog (kicks a refresh); null when the
 *  catalog has no verified price — callers must NOT invent one. */
export function getModelsDevPricing(
  providerName: string,
  modelId: string,
): ModelsDevPricing | null {
  kickRefresh();
  if (!cache) return null;
  // Gateways expose upstream ids like "anthropic/claude-sonnet-4-6".
  const candidates = [modelId, modelId.includes('/') ? modelId.split('/').pop()! : ''].filter(
    Boolean,
  );
  const tryEntries = (entries?: Record<string, ModelsDevEntry>): ModelsDevPricing | null => {
    if (!entries) return null;
    for (const cand of candidates) {
      const low = cand.toLowerCase();
      const entry =
        entries[cand] ?? Object.values(entries).find((e) => e.id?.toLowerCase() === low);
      const c = entry?.cost;
      if (c && typeof c.input === 'number' && Number.isFinite(c.input) && c.input >= 0 &&
        typeof c.output === 'number' && Number.isFinite(c.output) && c.output >= 0) {
        return {
          inPerM: c.input,
          outPerM: c.output,
          cacheReadPerM: c.cache_read,
          cacheWritePerM: c.cache_write,
        };
      }
    }
    return null;
  };
  const key = PRICING_PROVIDER_KEY[providerName] ?? providerName;
  const entries = cache[key]?.models;
  const direct = tryEntries(entries);
  if (direct) return direct;
  // OpenRouter namespaces bare upstream IDs. Only accept an unambiguous
  // suffix match, never another provider's rate for a similarly named model.
  if (key === 'openrouter' && !modelId.includes('/') && entries) {
    const matches = Object.values(entries).filter((entry) =>
      entry.id?.toLowerCase().endsWith(`/${modelId.toLowerCase()}`),
    );
    if (matches.length === 1) return tryEntries({ [modelId]: matches[0] });
  }
  return null;
}
