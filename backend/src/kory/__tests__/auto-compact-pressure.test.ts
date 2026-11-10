import { describe, expect, test } from 'bun:test';
import {
  evaluateAutoCompactPressure,
  type AutoCompactPressureInput,
} from '../auto-compact-pressure';

const base: AutoCompactPressureInput = {
  tokensIn: 170_000,
  tokensOut: 1_000,
  contextWindow: 200_000,
  contextKnown: true,
  usageKnown: true,
  thresholdPercent: 80,
  standingContextTokens: 40_000,
  reservedOutputTokens: 16_384,
};

describe('cache-aware automatic compaction pressure', () => {
  test('a warm standing prefix avoids an unnecessary threshold crossing', () => {
    expect(evaluateAutoCompactPressure(base)).toMatchObject({
      shouldCompact: true,
      reason: 'threshold',
    });
    expect(evaluateAutoCompactPressure({ ...base, cachedInputTokens: 130_000 })).toMatchObject({
      shouldCompact: false,
      reason: 'below_threshold',
      occupancyTokens: 171_000,
      pressureTokens: 150_000,
      cacheAllowanceTokens: 20_000,
    });
  });

  test('cached conversation and tool history still cross the threshold', () => {
    expect(
      evaluateAutoCompactPressure({
        ...base,
        standingContextTokens: 5_000,
        cachedInputTokens: 160_000,
      }),
    ).toMatchObject({ shouldCompact: true, pressureTokens: 165_000, cacheAllowanceTokens: 5_000 });
    expect(
      evaluateAutoCompactPressure({
        ...base,
        standingContextTokens: undefined,
        cachedInputTokens: 160_000,
      }),
    ).toMatchObject({ shouldCompact: true, cacheAllowanceTokens: 0 });
  });

  test('cache credit is bounded by the standing prefix, observed reads, and effective session budget', () => {
    for (const window of [100_000, 200_000, 1_000_000]) {
      for (const cached of [0, 5_000, 30_000, 80_000]) {
        const decision = evaluateAutoCompactPressure({
          ...base,
          contextWindow: window,
          tokensIn: 90_000,
          standingContextTokens: 70_000,
          cachedInputTokens: cached,
        });
        expect(decision.cacheAllowanceTokens).toBeLessThanOrEqual(window * 0.1);
        expect(decision.cacheAllowanceTokens).toBeLessThanOrEqual(cached);
        expect(decision.cacheAllowanceTokens).toBeLessThanOrEqual(70_000);
        expect(decision.occupancyTokens).toBe(91_000);
      }
    }
  });

  test('does not exempt the same skills twice through cache and skill allowances', () => {
    expect(
      evaluateAutoCompactPressure({
        ...base,
        skillTokens: 10_000,
        standingContextTokens: 30_000,
        cachedInputTokens: 15_000,
      }),
    ).toMatchObject({ pressureTokens: 155_000, cacheAllowanceTokens: 5_000 });
    expect(
      evaluateAutoCompactPressure({
        ...base,
        skillTokens: 10_000,
        standingContextTokens: 30_000,
        cachedInputTokens: 5_000,
      }),
    ).toMatchObject({ pressureTokens: 160_000, cacheAllowanceTokens: 0, shouldCompact: true });
  });

  test('physical headroom overrides warm cache and skill exemptions', () => {
    expect(
      evaluateAutoCompactPressure({
        ...base,
        tokensIn: 180_000,
        tokensOut: 5_000,
        standingContextTokens: 80_000,
        skillTokens: 30_000,
        cachedInputTokens: 160_000,
      }),
    ).toMatchObject({
      shouldCompact: true,
      reason: 'headroom',
      pressureTokens: 130_000,
      occupancyTokens: 185_000,
    });
  });

  test('reserves space for the next reply even with a high configured threshold', () => {
    expect(
      evaluateAutoCompactPressure({
        ...base,
        tokensIn: 175_000,
        tokensOut: 10_000,
        thresholdPercent: 99,
        cachedInputTokens: 170_000,
      }),
    ).toMatchObject({ shouldCompact: true, reason: 'headroom' });
    expect(
      evaluateAutoCompactPressure({
        ...base,
        tokensIn: 193_000,
        tokensOut: 0,
        thresholdPercent: 99,
        reservedOutputTokens: 0,
        cachedInputTokens: 190_000,
      }),
    ).toMatchObject({ shouldCompact: true, reason: 'headroom' });
  });

  test('does not repeatedly summarize tiny history to address a large re-injected prompt', () => {
    expect(
      evaluateAutoCompactPressure({
        ...base,
        tokensIn: 190_000,
        tokensOut: 100,
        standingContextTokens: 189_000,
        cachedInputTokens: 180_000,
      }),
    ).toMatchObject({ shouldCompact: false, reason: 'standing_context', reclaimableTokens: 1_100 });
  });

  test('unknown and cumulative CLI receipts cannot arm automatic compaction', () => {
    for (const override of [
      { usageKnown: false },
      { estimated: true },
      { contextKnown: false },
      { contextWindow: undefined },
      { contextWindow: 0 },
      { tokensIn: Number.NaN },
      { tokensOut: Number.POSITIVE_INFINITY },
    ]) {
      expect(
        evaluateAutoCompactPressure({ ...base, tokensIn: 195_000, ...override }),
      ).toMatchObject({ shouldCompact: false, reason: 'unverified' });
    }
  });

  test('cache metadata cannot add occupancy or hide pressure through an impossible receipt', () => {
    expect(evaluateAutoCompactPressure({ ...base, cachedInputTokens: 900_000 })).toMatchObject({
      shouldCompact: true,
      occupancyTokens: 171_000,
      cacheAllowanceTokens: 0,
    });
    expect(evaluateAutoCompactPressure({ ...base, cachedInputTokens: Number.NaN })).toMatchObject({
      shouldCompact: true,
      cacheAllowanceTokens: 0,
    });
  });

  test('user threshold changes still apply to ordinary conversation growth', () => {
    expect(
      evaluateAutoCompactPressure({ ...base, tokensIn: 140_000, thresholdPercent: 65 }),
    ).toMatchObject({ shouldCompact: true, reason: 'threshold' });
    expect(
      evaluateAutoCompactPressure({ ...base, tokensIn: 140_000, thresholdPercent: 85 }),
    ).toMatchObject({ shouldCompact: false, reason: 'below_threshold' });
  });
});
