export interface CacheBreakImpact {
  cachedTokens: number;
  freshCostUsd?: number;
  cachedCostUsd?: number;
  incrementalCostUsd?: number;
}

/** Estimate the input-cost consequence of invalidating a provider-reported
 * warm prefix. Unknown prices stay unknown rather than being guessed. */
export function estimateCacheBreakImpact(
  cachedTokens: number,
  freshInputPerMillion?: number,
  cachedInputPerMillion?: number,
): CacheBreakImpact | null {
  const tokens = Math.max(0, Math.floor(cachedTokens));
  if (tokens === 0) return null;

  const freshCostUsd =
    freshInputPerMillion !== undefined && Number.isFinite(freshInputPerMillion)
      ? (tokens / 1_000_000) * Math.max(0, freshInputPerMillion)
      : undefined;
  const cachedCostUsd =
    cachedInputPerMillion !== undefined && Number.isFinite(cachedInputPerMillion)
      ? (tokens / 1_000_000) * Math.max(0, cachedInputPerMillion)
      : undefined;
  const incrementalCostUsd =
    freshCostUsd !== undefined && cachedCostUsd !== undefined
      ? Math.max(0, freshCostUsd - cachedCostUsd)
      : undefined;

  return { cachedTokens: tokens, freshCostUsd, cachedCostUsd, incrementalCostUsd };
}

export function formatCompactTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2).replace(/\.00$/, '')}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(tokens);
}
