import { describe, expect, it } from 'vitest';
import {
  estimateFreebuffHoursLeft,
  freebuffBaseRate,
  freebuffHoursFromFreebucks,
  freebuffRateMultiplier,
} from './freebuff-pricing';

describe('freebuffBaseRate', () => {
  it('uses the cheapest live model rate as the 1x baseline', () => {
    expect(freebuffBaseRate({ free: 5, fast: 25, large: 50 })).toBe(5);
    expect(freebuffBaseRate({ only: 12 })).toBe(12);
  });

  it('ignores free and invalid rows instead of treating them as the baseline', () => {
    expect(freebuffBaseRate({ free: 0, paid: 6 })).toBe(6);
    expect(freebuffBaseRate({ free: 0 })).toBeUndefined();
    expect(freebuffBaseRate({ bad: Number.NaN, negative: -2 })).toBeUndefined();
    expect(freebuffBaseRate(undefined)).toBeUndefined();
  });
});

describe('freebuffHoursFromFreebucks', () => {
  it('converts the provider allowance at the live baseline rate', () => {
    expect(freebuffHoursFromFreebucks(150, 5)).toBe(30);
    expect(freebuffHoursFromFreebucks(60, 5)).toBe(12);
    expect(freebuffHoursFromFreebucks(0, 5)).toBe(0);
  });

  it('never invents hours without a rate', () => {
    expect(freebuffHoursFromFreebucks(150, undefined)).toBeUndefined();
    expect(freebuffHoursFromFreebucks(150, 0)).toBeUndefined();
    expect(freebuffHoursFromFreebucks(undefined, 5)).toBeUndefined();
    expect(freebuffHoursFromFreebucks(-1, 5)).toBeUndefined();
  });
});

describe('freebuffRateMultiplier', () => {
  it('expresses a model rate as a multiple of the 1x baseline', () => {
    expect(freebuffRateMultiplier(5, 5)).toBe(1);
    expect(freebuffRateMultiplier(25, 5)).toBe(5);
    expect(freebuffRateMultiplier(50, 5)).toBe(10);
    // A free row stays 0x even before a paid baseline is known.
    expect(freebuffRateMultiplier(0, 5)).toBe(0);
    expect(freebuffRateMultiplier(0, undefined)).toBe(0);
  });

  it('rejects missing or invalid inputs', () => {
    expect(freebuffRateMultiplier(25, undefined)).toBeUndefined();
    expect(freebuffRateMultiplier(undefined, 5)).toBeUndefined();
    expect(freebuffRateMultiplier(-5, 5)).toBeUndefined();
    expect(freebuffRateMultiplier(25, 0)).toBeUndefined();
  });
});

describe('estimateFreebuffHoursLeft', () => {
  it('converts daily Freebucks using the selected model rate', () => {
    expect(estimateFreebuffHoursLeft(30, 1)).toBe(30);
    expect(estimateFreebuffHoursLeft(30, 3)).toBe(10);
    expect(estimateFreebuffHoursLeft(5, 0.5)).toBe(10);
    expect(estimateFreebuffHoursLeft(150, 7)).toBeCloseTo(150 / 7);
  });

  it('preserves a zero allowance and rejects missing or invalid multipliers', () => {
    expect(estimateFreebuffHoursLeft(0, 1)).toBe(0);
    expect(estimateFreebuffHoursLeft(undefined, 1)).toBeUndefined();
    expect(estimateFreebuffHoursLeft(30, undefined)).toBeUndefined();
    expect(estimateFreebuffHoursLeft(30, 0)).toBeUndefined();
    expect(estimateFreebuffHoursLeft(-1, 1)).toBeUndefined();
  });
});
