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

interface ModelsDevEntry {
  id: string;
  reasoning?: boolean;
  reasoning_options?: Array<{ type: string; values?: string[]; max?: number }>;
  limit?: { context?: number; output?: number };
}

let cache: Record<string, { models?: Record<string, ModelsDevEntry> }> | null = null;
let fetchedAt = 0;
let inflight = false;

function kickRefresh(): void {
  if (inflight || (cache && Date.now() - fetchedAt < CACHE_TTL_MS)) return;
  inflight = true;
  void fetch(MODELS_DEV_URL)
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
