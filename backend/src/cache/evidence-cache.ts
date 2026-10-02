import { createHash } from 'node:crypto';
export interface EvidenceCacheKey {
  scope: string;
  operation: string;
  revision: string;
  variant?: string;
}
export interface EvidenceCacheStats {
  hits: number;
  misses: number;
  waits: number;
  loads: number;
  invalidations: number;
  evictions: number;
  size: number;
  inFlight: number;
}
interface Entry {
  value: unknown;
  expiresAt: number;
  generation: number;
}
interface LoadOptions<T> {
  ttlMs?: number;
  validate?: (value: T) => boolean | Promise<boolean>;
}
const hashKey = (key: EvidenceCacheKey): string =>
  createHash('sha256')
    .update(`${key.scope}\0${key.operation}\0${key.revision}\0${key.variant ?? ''}`)
    .digest('hex');
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  const r = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(r)
      .sort()
      .map((k) => [k, canonical(r[k])]),
  );
}
export function stableEvidenceVariant(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}
export class CrossAgentEvidenceCache {
  private readonly entries = new Map<string, Entry>();
  private readonly inFlight = new Map<string, { generation: number; promise: Promise<unknown> }>();
  private readonly scopeGeneration = new Map<string, number>();
  private readonly counters = {
    hits: 0,
    misses: 0,
    waits: 0,
    loads: 0,
    invalidations: 0,
    evictions: 0,
  };
  constructor(
    private readonly maxEntries = 512,
    private readonly defaultTtlMs = 10 * 60 * 1000,
  ) {}
  async getOrLoad<T>(
    key: EvidenceCacheKey,
    loader: () => Promise<T>,
    options: LoadOptions<T> = {},
  ): Promise<T> {
    const cacheKey = hashKey(key);
    const generation = this.scopeGeneration.get(key.scope) ?? 0;
    const existing = this.entries.get(cacheKey);
    const now = Date.now();
    if (existing && existing.expiresAt > now && existing.generation === generation) {
      this.counters.hits++;
      this.entries.delete(cacheKey);
      this.entries.set(cacheKey, existing);
      return existing.value as T;
    }
    if (existing) this.entries.delete(cacheKey);
    const pending = this.inFlight.get(cacheKey);
    if (pending?.generation === generation) {
      this.counters.waits++;
      return pending.promise as Promise<T>;
    }
    this.counters.misses++;
    const load: Promise<T> = (async () => {
      this.counters.loads++;
      const value = await loader();
      const valid = options.validate ? await options.validate(value) : true;
      const current = this.scopeGeneration.get(key.scope) ?? 0;
      if (valid && current === generation)
        this.set(cacheKey, {
          value,
          expiresAt: Date.now() + Math.max(1, options.ttlMs ?? this.defaultTtlMs),
          generation,
        });
      return value;
    })().finally(() => {
      const current = this.inFlight.get(cacheKey);
      if (current?.promise === load) this.inFlight.delete(cacheKey);
    });
    this.inFlight.set(cacheKey, { generation, promise: load });
    return load;
  }
  invalidateScope(scope: string): void {
    this.scopeGeneration.set(scope, (this.scopeGeneration.get(scope) ?? 0) + 1);
    this.counters.invalidations++;
  }
  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
    this.scopeGeneration.clear();
  }
  getStats(): EvidenceCacheStats {
    return { ...this.counters, size: this.entries.size, inFlight: this.inFlight.size };
  }
  private set(key: string, entry: Entry): void {
    if (this.entries.has(key)) this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.entries.delete(oldest);
      this.counters.evictions++;
    }
    this.entries.set(key, entry);
  }
}
export const crossAgentEvidenceCache = new CrossAgentEvidenceCache();
