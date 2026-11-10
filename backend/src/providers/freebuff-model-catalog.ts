import { statSync } from 'node:fs';
import { join } from 'node:path';
import { withFreebuffAuthToken } from './freebuff-credentials';
import {
  FREEBUFF_CATALOG_MODEL_PREFIX,
  freebuffCatalogKeyFromModelId,
  type FreebuffBundledModel,
} from './freebuff-bundled-catalog';

export interface FreebuffAccountModel extends FreebuffBundledModel {
  /** Backend-only evidence for root-model verification. Never serialize to ModelDef or logs. */
  handle: string;
}
export interface FreebuffAccountCatalog {
  models: FreebuffAccountModel[];
  refreshAt: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown, max = 256): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max &&
    !/[\x00-\x1f\x7f]/.test(value);
}
function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Native 0.2.16 protocol 1. Only account-accessible, already-open picker rows
 * become selectable models. Capabilities come from these rows, never names or
 * bundled fallbacks. Extra account data and catalog fetch IDs are discarded. */
export function parseFreebuffAccountCatalog(value: unknown): FreebuffAccountCatalog {
  const invalid = () => new Error('Freebuff returned an invalid account model catalog');
  if (!record(value) || value.protocol !== 1 || !text(value.version) ||
    !timestamp(value.issuedAt) || !timestamp(value.refreshAt) ||
    !Array.isArray(value.rows) || value.rows.length > 512) throw invalid();
  const keys = new Set<string>();
  const models: FreebuffAccountModel[] = [];
  for (const row of value.rows) {
    if (!record(row) || !text(row.key, 64) ||
      !freebuffCatalogKeyFromModelId(`${FREEBUFF_CATALOG_MODEL_PREFIX}${row.key}`) ||
      keys.has(row.key) || !text(row.handle, 4096) || !text(row.displayName) ||
      typeof row.multimodal !== 'boolean' || !['open', 'locked'].includes(String(row.access)) ||
      typeof row.sortOrder !== 'number' || !Number.isFinite(row.sortOrder) ||
      (row.opensAt !== undefined && !timestamp(row.opensAt)) ||
      (row.contextWindow !== undefined &&
        (!Number.isSafeInteger(row.contextWindow) || Number(row.contextWindow) <= 0)) ||
      (row.efforts !== undefined && (!Array.isArray(row.efforts) || row.efforts.length > 16 ||
        row.efforts.some((effort) => !text(effort, 32))))) throw invalid();
    keys.add(row.key);
    // Matches the CLI's cY filter: opensAt is compared with the catalog's issuedAt.
    if (row.access !== 'open' || (typeof row.opensAt === 'number' && row.opensAt > value.issuedAt))
      continue;
    models.push({
      id: `${FREEBUFF_CATALOG_MODEL_PREFIX}${row.key}`,
      name: row.displayName,
      handle: row.handle,
      multimodal: row.multimodal,
      ...(typeof row.contextWindow === 'number' ? { contextWindow: row.contextWindow } : {}),
      ...(Array.isArray(row.efforts) && row.efforts.length
        ? { reasoningLevels: [...new Set(row.efforts as string[])] } : {}),
    });
  }
  return { models, refreshAt: value.refreshAt };
}

export interface FreebuffModelCatalogDependencies {
  fetch: typeof fetch;
  withToken: typeof withFreebuffAuthToken;
  now: () => number;
}
const TTL_MS = 5 * 60_000;
const FAILURE_TTL_MS = 30_000;
const cache = new Map<string, {
  revision: string;
  expiresAt: number;
  value?: FreebuffAccountCatalog;
  inFlight?: Promise<FreebuffAccountCatalog>;
}>();

/** One read-only authenticated GET using exactly the CLI-owned credential.
 * No session admission, device registration, model generation or handle mutation.
 * Failures are negative-cached; stale entitlements are never advertised. */
export async function getFreebuffModelCatalog(
  profileDir: string,
  force = false,
  dependencies: FreebuffModelCatalogDependencies = {
    fetch,
    withToken: withFreebuffAuthToken,
    now: Date.now,
  },
): Promise<FreebuffAccountCatalog> {
  const failure = () => new Error('Freebuff account models could not be refreshed. Check the CLI login and refresh models.');
  let revision: string;
  try {
    const metadata = statSync(join(profileDir, 'credentials.json'));
    revision = `${metadata.ino}:${metadata.size}:${metadata.mtimeMs}`;
  } catch {
    cache.delete(profileDir);
    throw failure();
  }
  const previous = cache.get(profileDir);
  const state = previous?.revision === revision ? previous : { revision, expiresAt: 0 };
  if (state.inFlight) return state.inFlight;
  if (!force && dependencies.now() < state.expiresAt) {
    if (state.value) return state.value;
    throw failure();
  }
  const signal = AbortSignal.timeout(65_000); // Includes bounded Keychain consent.
  state.inFlight = dependencies.withToken(profileDir, async (token) => {
    const response = await dependencies.fetch('https://www.codebuff.com/api/v1/freebuff/models', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, 'x-freebuff-catalog-protocol': '1' },
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    if (!response.ok) throw failure();
    return parseFreebuffAccountCatalog(await response.json());
  }, signal).then((value) => {
    state.value = value;
    state.expiresAt = dependencies.now() + Math.min(TTL_MS,
      Math.max(10_000, value.refreshAt - dependencies.now()));
    return value;
  }).catch(() => {
    state.value = undefined;
    state.expiresAt = dependencies.now() + FAILURE_TTL_MS;
    throw failure(); // Never expose response bodies, headers, handles or child errors.
  }).finally(() => { state.inFlight = undefined; });
  cache.set(profileDir, state);
  return state.inFlight;
}

export function resetFreebuffModelCatalogCacheForTests(): void {
  cache.clear();
}
