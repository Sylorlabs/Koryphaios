/** Cache affects the value of keeping a prefix, not its physical token size.
 * Never subtract all cache reads: cached conversation/tool history is still
 * reclaimable context and must count towards the user's threshold. */
export const MAX_AUTO_COMPACT_CACHE_ALLOWANCE = 0.1;
export const AUTO_COMPACT_HEADROOM_CEILING = 0.95;

export interface AutoCompactPressureInput {
  tokensIn: number;
  tokensOut: number;
  contextWindow?: number;
  contextKnown: boolean;
  usageKnown: boolean;
  estimated?: boolean;
  thresholdPercent: number;
  skillTokens?: number;
  /** Dispatch estimate of re-injected system/memory/skills/tool definitions,
   * reconciled down to the actual input count. Excludes chat and tool traffic. */
  standingContextTokens?: number;
  cachedInputTokens?: number;
  reservedOutputTokens?: number;
}

export interface AutoCompactPressure {
  shouldCompact: boolean;
  reason: 'unverified' | 'standing_context' | 'below_threshold' | 'threshold' | 'headroom';
  occupancyTokens: number;
  pressureTokens: number;
  cacheAllowanceTokens: number;
  reclaimableTokens: number;
}

const count = (value: number | undefined): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;

export function evaluateAutoCompactPressure(input: AutoCompactPressureInput): AutoCompactPressure {
  const tokensIn = count(input.tokensIn);
  const tokensOut = count(input.tokensOut);
  const window = count(input.contextWindow);
  const result: AutoCompactPressure = {
    shouldCompact: false,
    reason: 'unverified',
    occupancyTokens: tokensIn + tokensOut,
    pressureTokens: tokensIn,
    cacheAllowanceTokens: 0,
    reclaimableTokens: 0,
  };
  if (
    !input.usageKnown ||
    input.estimated ||
    !input.contextKnown ||
    window <= 0 ||
    tokensIn <= 0 ||
    !Number.isFinite(input.tokensIn) ||
    !Number.isFinite(input.tokensOut)
  )
    return result;

  const skillTokens = Math.min(tokensIn, count(input.skillTokens));
  const standingTokens = Math.min(
    tokensIn,
    Math.max(skillTokens, count(input.standingContextTokens)),
  );
  const cached = count(input.cachedInputTokens);
  // The existing skill exemption already covers skills. Only give additional
  // credit to confirmed cache reads within the estimated standing prefix, and
  // cap that credit at ten percentage points of the effective session window.
  // Impossible cache receipts get no credit; cache writes get none either.
  result.cacheAllowanceTokens =
    cached <= tokensIn
      ? Math.min(
          Math.max(0, Math.min(cached, standingTokens) - skillTokens),
          Math.floor(window * MAX_AUTO_COMPACT_CACHE_ALLOWANCE),
        )
      : 0;
  result.pressureTokens = tokensIn - skillTokens - result.cacheAllowanceTokens;
  result.reclaimableTokens = tokensIn - standingTokens + tokensOut;

  // Summarizing a nearly empty conversation cannot relieve a large prompt
  // which is re-injected on every request. Leave that case to prompt budgeting
  // instead of launching an expensive compaction loop for standing context.
  const minimumHistory = Math.min(4_096, Math.max(256, Math.floor(window * 0.01)));
  if (result.reclaimableTokens < minimumHistory) {
    result.reason = 'standing_context';
    return result;
  }

  const thresholdPercent = Number.isFinite(input.thresholdPercent)
    ? Math.max(10, Math.min(99, input.thresholdPercent))
    : 80;
  // Physical headroom has no cache or skill discount. Include the latest
  // output (next turn's history) and reserve room for another reply. A reserve
  // is capped for small windows so a large model default cannot consume them.
  const reserve = Math.min(count(input.reservedOutputTokens), Math.floor(window * 0.25));
  const hardLimit = Math.min(Math.floor(window * AUTO_COMPACT_HEADROOM_CEILING), window - reserve);
  if (result.occupancyTokens >= hardLimit) {
    result.shouldCompact = true;
    result.reason = 'headroom';
  } else if (result.pressureTokens >= (window * thresholdPercent) / 100) {
    result.shouldCompact = true;
    result.reason = 'threshold';
  } else {
    result.reason = 'below_threshold';
  }
  return result;
}
