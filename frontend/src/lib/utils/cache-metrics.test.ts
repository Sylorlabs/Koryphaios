import { describe, expect, it } from 'vitest';
import {
  buildCacheFabricLabel,
  buildCacheReceiptLabel,
  buildProviderCacheCards,
  type DurableProviderRow,
} from './cache-metrics';

const providerRow = (over: Partial<DurableProviderRow> = {}): DurableProviderRow => ({
  provider: 'custom:unrouter',
  requests: 12,
  inputTokens: 30_000,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  hitRate: 0,
  savingsUsd: 0,
  averageTtftMs: null,
  averageLatencyMs: null,
  ...over,
});

describe('buildCacheReceiptLabel', () => {
  it('omits zero parts instead of printing 0 read / 0 write', () => {
    expect(buildCacheReceiptLabel({ readTokens: 139_000, writeTokens: 0 })).toBe(
      '139.0k read from cache',
    );
    expect(buildCacheReceiptLabel({ readTokens: 0, writeTokens: 2_400 })).toBe(
      '2.4k written to cache',
    );
  });

  it('hides the row entirely when the turn had no cache activity', () => {
    expect(buildCacheReceiptLabel({ readTokens: 0, writeTokens: 0 })).toBeNull();
    expect(buildCacheReceiptLabel({})).toBeNull();
    expect(
      buildCacheReceiptLabel({ readTokens: 0, writeTokens: 0, costUsd: 0, savingsUsd: 0 }),
    ).toBeNull();
  });

  it('caps prices at three decimals and drops zero prices', () => {
    expect(buildCacheReceiptLabel({ readTokens: 1000, costUsd: 0.01234 })).toBe(
      '1.0k read from cache · $0.012 this turn',
    );
    expect(buildCacheReceiptLabel({ readTokens: 1000, costUsd: 0 })).toBe('1.0k read from cache');
  });

  it('labels savings and cache premiums distinctly', () => {
    expect(buildCacheReceiptLabel({ readTokens: 1000, savingsUsd: 4.2 })).toBe(
      '1.0k read from cache · +$4.2 saved by cache',
    );
    expect(buildCacheReceiptLabel({ readTokens: 1000, savingsUsd: -0.25 })).toBe(
      '1.0k read from cache · -$0.25 cache premium',
    );
  });
});

describe('buildCacheFabricLabel', () => {
  it('drops the 0/0 placeholder when no dispatch has been observed', () => {
    expect(buildCacheFabricLabel({ warmCandidates: 0, dispatches: 0 })).toBeNull();
  });

  it('drops ratios whose numerator is zero', () => {
    expect(buildCacheFabricLabel({ dispatches: 4, evidenceHits: 0, evidenceMisses: 4 })).toBeNull();
    expect(
      buildCacheFabricLabel({
        warmCandidates: 3,
        dispatches: 4,
        evidenceHits: 0,
        evidenceMisses: 0,
      }),
    ).toBe('3/4 warm');
    expect(
      buildCacheFabricLabel({ dispatches: 4, evidenceHits: 2, evidenceMisses: 0, waits: 1 }),
    ).toBe('2/2 hits · 1 duplicate reads served from memory');
  });
});

describe('buildProviderCacheCards', () => {
  it('drops providers with nothing to report instead of showing 0% · +$0', () => {
    const cards = buildProviderCacheCards([
      providerRow({ provider: 'custom:tokenrouter' }),
      providerRow({
        provider: 'custom:unrouter',
        hitRate: 0.3261,
        savingsUsd: 6.4581,
        averageTtftMs: 15_502.4,
      }),
    ]);
    expect(cards.map((card) => card.provider)).toEqual(['custom:unrouter']);
  });

  it('omits zero metrics inside a surviving row', () => {
    const [card] = buildProviderCacheCards([
      providerRow({ cacheReadTokens: 9_800, hitRate: 0, averageTtftMs: null }),
    ]);
    expect(card.hitRateLabel).toBeNull();
    expect(card.savingsLabel).toBeNull();
    expect(card.ttftLabel).toBeNull();
    expect(card.tooltip).toContain('9.8k cache-read tokens');
  });

  it('keeps a provider that only paid a cache premium', () => {
    const [card] = buildProviderCacheCards([providerRow({ savingsUsd: -0.5 })]);
    expect(card.savingsLabel).toBe('-$0.5');
    expect(card.hitRateLabel).toBeNull();
  });

  it('ignores rows without requests and caps the list', () => {
    const rows = Array.from({ length: 6 }, (_, index) =>
      providerRow({
        provider: `p${index}`,
        hitRate: 0.5,
        requests: index === 0 ? 0 : index,
      }),
    );
    const cards = buildProviderCacheCards(rows, 4);
    expect(cards).toHaveLength(4);
    expect(cards.map((card) => card.provider)).not.toContain('p0');
  });

  it('tolerates a missing payload', () => {
    expect(buildProviderCacheCards(null)).toEqual([]);
    expect(buildProviderCacheCards(undefined)).toEqual([]);
  });

  it('caps savings at three decimals', () => {
    const [card] = buildProviderCacheCards([providerRow({ hitRate: 0.3261, savingsUsd: 6.4581 })]);
    expect(card.hitRateLabel).toBe('32.6% cache');
    expect(card.savingsLabel).toBe('+$6.458');
  });
});
