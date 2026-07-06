// models.dev enrichment — opencode's public model catalog (the same data the
// opencode client uses) exposes per-model reasoning support, reasoning options
// (effort tiers / toggle / budget) and real context limits for OpenCode Zen
// and OpenCode Go. Their /v1/models endpoints return bare ids only, so this is
// the authoritative capability source for those providers.

import type { ModelDef } from '@koryphaios/shared';
import { providerLog } from '../logger';

const MODELS_DEV_URL = 'https://models.dev/api.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Koryphaios provider name → models.dev provider key. */
const PROVIDER_KEY: Record<string, string> = {
  opencodezen: 'opencode',
  opencodego: 'opencode-go',
};

/** Broader mapping used for PRICING lookups (capability enrichment stays
 *  scoped to the opencode providers above). */
const PRICING_PROVIDER_KEY: Record<string, string> = {
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'google',
  gemini: 'google',
  xai: 'xai',
  deepseek: 'deepseek',
  groq: 'groq',
  mistral: 'mistral',
  openrouter: 'openrouter',
  togetherai: 'togetherai',
  fireworks: 'fireworks-ai',
  moonshot: 'moonshot',
  kimicode: 'moonshot',
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
  limit?: { context?: number; output?: number };
  /** $ per million tokens, straight from models.dev. */
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
}

let cache: Record<string, { models?: Record<string, ModelsDevEntry> }> | null = null;
let fetchedAt = 0;
let inflight = false;
let inflightPromise: Promise<void> | null = null;

/** Await a fresh-enough catalog (max ~5s) — for callers that need prices NOW. */
export async function warmModelsDevCache(): Promise<void> {
  kickRefresh();
  if (cache && Date.now() - fetchedAt < CACHE_TTL_MS) return;
  if (inflightPromise) {
    await Promise.race([inflightPromise, new Promise((r) => setTimeout(r, 5_000))]);
  }
}

function kickRefresh(): void {
  if (inflight || (cache && Date.now() - fetchedAt < CACHE_TTL_MS)) return;
  inflight = true;
  inflightPromise = fetch(MODELS_DEV_URL)
    .then(async (res) => {
      if (!res.ok) throw new Error(`models.dev ${res.status}`);
      cache = (await res.json()) as typeof cache;
      fetchedAt = Date.now();
      providerLog.debug({ providers: Object.keys(cache ?? {}).length }, 'models.dev catalog refreshed');
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
    // Toggleable + effort tiers → 'none' turns thinking off entirely.
    return hasToggle ? ['none', ...effort.values] : effort.values;
  }
  if (hasToggle) return ['none', 'high']; // pure on/off thinking
  return undefined; // budget-only or always-on: no discrete tiers to offer
}

/**
 * Enrich a provider's model defs with models.dev capability data. Synchronous
 * (uses the cached catalog) and kicks a background refresh — callers get
 * enriched defs from the second listModels() call onward.
 */
export function applyModelsDevMetadata(providerName: string, models: ModelDef[]): ModelDef[] {
  const key = PROVIDER_KEY[providerName];
  if (!key) return models;
  kickRefresh();
  const entries = cache?.[key]?.models;
  if (!entries) return models;
  return models.map((m) => {
    const bare = (m.apiModelId ?? m.id).replace(new RegExp(`^${providerName}\\.`), '');
    const e = entries[bare];
    if (!e) return m;
    const levels = levelsFromOptions(e.reasoning_options);
    const ctx = e.limit?.context;
    return {
      ...m,
      ...(e.reasoning === true ? { canReason: true } : {}),
      ...(levels ? { reasoningLevels: levels } : {}),
      ...(ctx && ctx > 0 ? { contextWindow: ctx, contextVerified: true } : {}),
      ...(e.limit?.output && e.limit.output > 0 ? { maxOutputTokens: e.limit.output } : {}),
    };
  });
}


export interface ModelsDevPricing {
  /** $ per million input tokens */
  inPerM: number;
  /** $ per million output tokens */
  outPerM: number;
  cacheReadPerM?: number;
}

/** Live per-token pricing from models.dev for any known provider/model.
 *  Synchronous against the cached catalog (kicks a refresh); null when the
 *  catalog has no verified price — callers must NOT invent one. */
export function getModelsDevPricing(providerName: string, modelId: string): ModelsDevPricing | null {
  kickRefresh();
  if (!cache) return null;
  // Gateways expose upstream ids like "anthropic/claude-sonnet-4-6".
  const candidates = [modelId, modelId.includes('/') ? modelId.split('/').pop()! : ''].filter(Boolean);
  const tryEntries = (entries?: Record<string, ModelsDevEntry>): ModelsDevPricing | null => {
    if (!entries) return null;
    for (const cand of candidates) {
      const low = cand.toLowerCase();
      const entry = entries[cand] ?? Object.values(entries).find((e) => e.id?.toLowerCase() === low);
      const c = entry?.cost;
      if (c && typeof c.input === 'number' && typeof c.output === 'number') {
        return { inPerM: c.input, outPerM: c.output, cacheReadPerM: c.cache_read };
      }
    }
    return null;
  };
  const key = PRICING_PROVIDER_KEY[providerName];
  const direct = key ? tryEntries(cache[key]?.models) : null;
  if (direct) return direct;
  for (const prov of Object.values(cache)) {
    const hit = tryEntries(prov?.models);
    if (hit) return hit;
  }
  return null;
}
