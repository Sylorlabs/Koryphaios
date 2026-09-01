// Cline model capability catalog lookup.
//
// The Cline npm package ships with a bundled catalog (@cline/llms) containing
// hundreds of OpenRouter-model entries with real `contextWindow` values for
// every model the Cline CLI's picker can route to. The user's own Cline home
// additionally keeps a synced `data/cache/openrouter_models.json` with the
// same per-model shape. Cline has no headless model-catalog command (the
// `config` command requires a TTY), so these two caches are the only way to
// learn the real context limit for the model the Cline CLI will actually run.
//
// Resolution order (first match wins):
//   1. The user's own `~/.cline/data/cache/openrouter_models.json` (always
//      present on a Cline 3.x install that has authenticated once) — most
//      accurate because it reflects THIS install's negotiated context limits.
//   2. The bundled `@cline/llms` catalog (resolved relative to the `cline`
//      binary on PATH) — covers everything the bundled picker can show, so
//      even uninstalled/uncached models get real context limits.
//
// The catalog is purely a lookup table; `ClineProvider.refreshModels` still
// only ever returns the configured model from `providers.json` — catalog
// metadata just enriches that one entry.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import type { ModelDef } from '@koryphaios/shared';
import { providerLog } from '../logger';

export interface ClineModelMeta {
  /** Real model id as it would be passed to the Cline CLI's underlying API. */
  id: string;
  /** Display name from the catalog. */
  name?: string;
  /** Effective context window in tokens. */
  contextWindow?: number;
  /** Max output tokens. */
  maxOutputTokens?: number;
}

interface OpenRouterCacheEntry {
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
}

interface LlmsCatalogEntry {
  id?: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
}

function asPositiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (value < 1024) return undefined;
  return Math.floor(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Parse the user-side OpenRouter cache (~/.cline/data/cache/openrouter_models.json). */
export function parseClineOpenRouterCache(raw: string): Map<string, ClineModelMeta> {
  const out = new Map<string, ClineModelMeta>();
  if (!raw || !raw.trim()) return out;
  let parsed: Record<string, OpenRouterCacheEntry> | null = null;
  try {
    parsed = JSON.parse(raw) as Record<string, OpenRouterCacheEntry>;
  } catch (err: unknown) {
    providerLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'cline: failed to parse openrouter_models.json',
    );
    return out;
  }
  if (!parsed || typeof parsed !== 'object') return out;
  for (const [id, entry] of Object.entries(parsed)) {
    if (!entry || typeof entry !== 'object') continue;
    const meta: ClineModelMeta = {
      id,
      ...(asString(entry.name) ? { name: entry.name } : {}),
      ...(asPositiveInt(entry.contextWindow)
        ? { contextWindow: asPositiveInt(entry.contextWindow) }
        : {}),
      ...(asPositiveInt(entry.maxTokens)
        ? { maxOutputTokens: asPositiveInt(entry.maxTokens) }
        : {}),
    };
    if (meta.contextWindow || meta.maxOutputTokens || meta.name) out.set(id, meta);
  }
  return out;
}

function readUserOpenRouterCache(): Map<string, ClineModelMeta> {
  const home = homedir();
  if (!home) return new Map();
  // Cline 3.x default config root is ~/.cline; the cache lives under
  // data/cache. Older installs may sit under different roots but the
  // canonical location has been stable since 2.x.
  const path = join(home, '.cline', 'data', 'cache', 'openrouter_models.json');
  if (!existsSync(path)) return new Map();
  try {
    return parseClineOpenRouterCache(readFileSync(path, 'utf8'));
  } catch (err: unknown) {
    providerLog.debug(
      { err: err instanceof Error ? err.message : String(err), path },
      'cline: failed to read openrouter_models.json',
    );
    return new Map();
  }
}

/** Resolve the absolute path of the `cline` binary on PATH. */
export function resolveClineBinary(): string | null {
  try {
    const out = execFileSync('which', ['cline'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 4_000,
    });
    const bin = out.trim().split('\n')[0]?.trim();
    if (!bin) return null;
    // Follow symlinks so the walk below finds the actual install root
    // (e.g. /home/.../node_modules/cline/bin/cline, not /home/.../bin/cline
    // which is just a shim pointing at node_modules/cline/bin/cline).
    return realpathSync(bin);
  } catch (err: unknown) {
    providerLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'cline: which cline failed',
    );
    return null;
  }
}

/** The bundled @cline/llms catalog (shipped inside the cline npm package).
 *  Resolved by walking up from the `cline` binary to the closest
 *  `node_modules/@cline/llms/dist/models.js`. The published cline package
 *  ships this exact module at this path. */
export function resolveClineLlmsCatalogPath(): string | null {
  const bin = resolveClineBinary();
  if (!bin) return null;
  // The binary lives at <root>/bin/cline. Walk up the directory tree until
  // we find a node_modules/@cline/llms/dist/models.js. We cap the walk at
  // 6 levels so a strange install layout can't cause an infinite loop.
  let dir = dirname(bin);
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'node_modules', '@cline', 'llms', 'dist', 'models.js');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function getClineProviderModelIds(): string[] {
  const catalog = loadClineLlmsCatalog();
  if (!catalog) return [];
  return Object.keys(catalog.models);
}

export function getAllClineCatalogModels(): Map<string, ClineModelMeta> {
  const out = new Map<string, ClineModelMeta>();
  const userCache = readUserOpenRouterCache();
  for (const [id, meta] of userCache) out.set(id, meta);
  if (out.size === 0) {
    const llms = loadClineLlmsCatalog();
    if (llms) {
      for (const [id, entry] of Object.entries(llms.models)) {
        if (!out.has(id)) {
          out.set(id, {
            id,
            ...(entry.name ? { name: entry.name } : {}),
            ...(asPositiveInt(entry.contextWindow)
              ? { contextWindow: asPositiveInt(entry.contextWindow) }
              : {}),
            ...(asPositiveInt(entry.maxTokens)
              ? { maxOutputTokens: asPositiveInt(entry.maxTokens) }
              : {}),
          });
        }
      }
    }
  }
  return out;
}

/** Lazy require of the bundled @cline/llms catalog. Returns null when the
 *  catalog is not installed (Cline not on PATH or shipped without the
 *  package). All callers should treat the result as advisory — never
 *  invent metadata when the catalog is missing.
 *
 *  Resolution: `getProviderCollectionSync('cline')` is the Cline-specific
 *  picker (287 models). Fallback is the flattened `getGeneratedProviderModels()`
 *  registry. */
export function loadClineLlmsCatalog(): { models: Record<string, LlmsCatalogEntry> } | null {
  const path = resolveClineLlmsCatalogPath();
  if (!path) return null;
  try {
    const req = createRequire(join(path, '..', '..', '..'));
    const mod = req(path) as Record<string, unknown> | null;
    if (!mod) return null;
    const coll = mod['getProviderCollectionSync'];
    if (typeof coll === 'function') {
      try {
        const c = (coll as (p: string) => unknown)('cline') as {
          models?: Record<string, LlmsCatalogEntry> | LlmsCatalogEntry[];
        } | null;
        if (c?.models) {
          const models = Array.isArray(c.models)
            ? Object.fromEntries(c.models.map((m) => [m.id ?? '', m]))
            : c.models;
          if (Object.keys(models).length > 0) return { models };
        }
      } catch (err: unknown) {
        providerLog.debug(
          { err: err instanceof Error ? err.message : String(err) },
          'cline: getProviderCollectionSync threw',
        );
      }
    }
    const gen = mod['getGeneratedProviderModels'];
    if (typeof gen === 'function') {
      try {
        const out = (gen as () => unknown)();
        if (out && typeof out === 'object') {
          const flat: Record<string, LlmsCatalogEntry> = {};
          for (const providerEntry of Object.values(out as Record<string, unknown>)) {
            if (!providerEntry || typeof providerEntry !== 'object') continue;
            for (const [id, def] of Object.entries(providerEntry as Record<string, unknown>)) {
              if (id && def && typeof def === 'object' && !flat[id]) {
                flat[id] = def as LlmsCatalogEntry;
              }
            }
          }
          if (Object.keys(flat).length > 0) return { models: flat };
        }
      } catch (err: unknown) {
        providerLog.debug(
          { err: err instanceof Error ? err.message : String(err) },
          'cline: getGeneratedProviderModels threw',
        );
      }
    }
    return null;
  } catch (err: unknown) {
    providerLog.debug(
      { err: err instanceof Error ? err.message : String(err), path },
      'cline: failed to require @cline/llms',
    );
    return null;
  }
}

/** Look up a Cline model id in both caches. The user-side cache wins because
 *  it reflects THIS install's negotiated limits. */
export function lookupClineModelMeta(modelId: string): ClineModelMeta | null {
  if (!modelId) return null;
  const fromUser = readUserOpenRouterCache().get(modelId);
  if (fromUser) return fromUser;
  const catalog = loadClineLlmsCatalog();
  if (catalog) {
    const entry = catalog.models[modelId];
    if (entry) {
      return {
        id: modelId,
        ...(asString(entry.name) ? { name: entry.name } : {}),
        ...(asPositiveInt(entry.contextWindow)
          ? { contextWindow: asPositiveInt(entry.contextWindow) }
          : {}),
        ...(asPositiveInt(entry.maxTokens)
          ? { maxOutputTokens: asPositiveInt(entry.maxTokens) }
          : {}),
      };
    }
  }
  return null;
}

/** Apply a real catalog lookup onto a Cline `ModelDef` so the picker
 *  shows the real context limit instead of a blank bar. */
export function enrichClineModel(model: ModelDef): ModelDef {
  const key = model.apiModelId ?? model.id;
  if (!key) return model;
  const meta = lookupClineModelMeta(key);
  if (!meta) return model;
  const next: ModelDef = { ...model };
  if (meta.contextWindow && meta.contextWindow > 0) {
    next.contextWindow = meta.contextWindow;
    next.contextVerified = true;
  }
  if (meta.maxOutputTokens && meta.maxOutputTokens > 0) {
    next.maxOutputTokens = meta.maxOutputTokens;
  }
  if (meta.name && !model.name) next.name = meta.name;
  return next;
}
