import { formatUsd, formatUsdDelta, isZeroUsd } from './usd';

export interface CacheTurnReceipt {
  readTokens?: number | null;
  writeTokens?: number | null;
  costUsd?: number | null;
  savingsUsd?: number | null;
}

export interface CacheFabricStats {
  warmCandidates?: number;
  dispatches?: number;
  evidenceHits?: number;
  evidenceMisses?: number;
  waits?: number;
}

export interface DurableProviderRow {
  provider: string;
  requests: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  hitRate: number;
  savingsUsd: number;
  averageTtftMs: number | null;
  averageLatencyMs: number | null;
}

export interface ProviderCacheCard {
  provider: string;
  /** `null` when the provider has no cache activity worth reporting. */
  hitRateLabel: string | null;
  savingsLabel: string | null;
  ttftLabel: string | null;
  tooltip: string;
}

const MS = (value: number): string => `${Math.round(value)}ms`;

function compactTokens(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

/** Per-turn prompt-cache receipt. Only non-zero facts are rendered: a
 * `0 write` / `+$0.0000` fragment is noise, and the whole row disappears when
 * the turn had no cache activity at all. */
export function buildCacheReceiptLabel(receipt: CacheTurnReceipt): string | null {
  const read = Math.max(0, receipt.readTokens ?? 0);
  const write = Math.max(0, receipt.writeTokens ?? 0);
  const parts: string[] = [];
  if (read > 0) parts.push(`${compactTokens(read)} read from cache`);
  if (write > 0) parts.push(`${compactTokens(write)} written to cache`);
  if (!isZeroUsd(receipt.costUsd)) {
    parts.push(`${formatUsd(receipt.costUsd)} this turn`);
  }
  const savings = formatUsdDelta(receipt.savingsUsd);
  if (savings) {
    parts.push(`${savings} ${(receipt.savingsUsd ?? 0) < 0 ? 'cache premium' : 'saved by cache'}`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** Harness prompt-cache + evidence-cache health. `0/0 warm` and `0/4 hits`
 * describe a cache that has not produced anything, which is not information —
 * those ratios are omitted until something lands in the numerator. */
export function buildCacheFabricLabel(stats: CacheFabricStats): string | null {
  const dispatches = Math.max(0, stats.dispatches ?? 0);
  const warm = Math.max(0, stats.warmCandidates ?? 0);
  const hits = Math.max(0, stats.evidenceHits ?? 0);
  const misses = Math.max(0, stats.evidenceMisses ?? 0);
  const waits = Math.max(0, stats.waits ?? 0);
  const parts: string[] = [];
  if (dispatches > 0 && warm > 0) parts.push(`${warm}/${dispatches} warm`);
  if (hits > 0 && hits + misses > 0) parts.push(`${hits}/${hits + misses} hits`);
  if (waits > 0) parts.push(`${waits} duplicate reads served from memory`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** Durable (30d) provider cache scorecard rows.
 *
 * A provider is only worth a line when it actually did something: rows with
 * no cache read, no cache write, no hit rate and no dollar movement are
 * dropped entirely rather than rendered as `0% · +$0.000`. Within a surviving
 * row each metric is independently omitted when it is zero. */
export function buildProviderCacheCards(
  rows: readonly DurableProviderRow[] | null | undefined,
  limit = 4,
): ProviderCacheCard[] {
  return (rows ?? [])
    .filter(
      (row) =>
        row.requests > 0 &&
        (row.hitRate > 0 ||
          row.cacheReadTokens > 0 ||
          row.cacheWriteTokens > 0 ||
          !isZeroUsd(row.savingsUsd)),
    )
    .slice(0, Math.max(0, limit))
    .map((row) => {
      const hitRateLabel = row.hitRate > 0 ? `${Math.round(row.hitRate * 1000) / 10}% cache` : null;
      const savingsLabel = formatUsdDelta(row.savingsUsd);
      const ttftLabel =
        row.averageTtftMs !== null && Number.isFinite(row.averageTtftMs)
          ? `${MS(row.averageTtftMs)} to first token`
          : null;
      const tooltip = [
        row.provider,
        `${row.requests} requests`,
        `${compactTokens(row.cacheReadTokens)} cache-read tokens`,
        `${compactTokens(row.cacheWriteTokens)} cache-write tokens`,
        row.hitRate > 0
          ? `${Math.round(row.hitRate * 1000) / 10}% of input served from cache`
          : null,
        savingsLabel ? `${savingsLabel} versus sending every token fresh` : null,
        ttftLabel,
        row.averageLatencyMs !== null && Number.isFinite(row.averageLatencyMs)
          ? `${MS(row.averageLatencyMs)} total response time`
          : null,
      ]
        .filter((part): part is string => Boolean(part))
        .join(' · ');
      return { provider: row.provider, hitRateLabel, savingsLabel, ttftLabel, tooltip };
    });
}
