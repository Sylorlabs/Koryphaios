import { describe, expect, it } from 'vitest';
import { estimateCacheBreakImpact, formatCompactTokens } from './cache-break-impact';

describe('cache break impact', () => {
  it('prices the fresh rebill and incremental premium from provider rates', () => {
    expect(estimateCacheBreakImpact(200_000, 10, 1)).toEqual({
      cachedTokens: 200_000,
      freshCostUsd: 2,
      cachedCostUsd: 0.2,
      incrementalCostUsd: 1.8,
    });
  });

  it('keeps unknown pricing unknown instead of inventing a dollar estimate', () => {
    expect(estimateCacheBreakImpact(125_000)).toEqual({
      cachedTokens: 125_000,
      freshCostUsd: undefined,
      cachedCostUsd: undefined,
      incrementalCostUsd: undefined,
    });
  });

  it('ignores empty cache evidence and formats large token counts compactly', () => {
    expect(estimateCacheBreakImpact(0, 10, 1)).toBeNull();
    expect(formatCompactTokens(199_200)).toBe('199.2k');
    expect(formatCompactTokens(1_250_000)).toBe('1.25M');
  });
});
