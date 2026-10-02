import { describe, expect, it } from 'vitest';
import { formatUsd, formatUsdDelta, isZeroUsd, USD_MAX_DECIMALS, USD_UNKNOWN } from './usd';

describe('formatUsd', () => {
  it('never prints more than the allowed decimals', () => {
    expect(formatUsd(6.4581)).toBe('$6.458');
    expect(formatUsd(0.00049)).toBe('$0');
    expect(formatUsd(1 / 3)).toBe(`$0.${'3'.repeat(USD_MAX_DECIMALS)}`);
  });

  it('drops trailing zeros and the decimal point', () => {
    expect(formatUsd(3.386)).toBe('$3.386');
    expect(formatUsd(3.4)).toBe('$3.4');
    expect(formatUsd(3)).toBe('$3');
    expect(formatUsd(13.326)).toBe('$13.326');
    expect(formatUsd(0.1 + 0.2)).toBe('$0.3');
  });

  it('renders zero as $0 rather than a padded string', () => {
    expect(formatUsd(0)).toBe('$0');
    expect(formatUsd(-0)).toBe('$0');
  });

  it('keeps the sign on real negatives and normalizes rounded ones', () => {
    expect(formatUsd(-0.5)).toBe('-$0.5');
    expect(formatUsd(-0.0001)).toBe('-$0');
  });

  it('marks unknown prices instead of guessing', () => {
    expect(formatUsd(null)).toBe(USD_UNKNOWN);
    expect(formatUsd(undefined)).toBe(USD_UNKNOWN);
    expect(formatUsd(Number.NaN)).toBe(USD_UNKNOWN);
    expect(formatUsd(Number.POSITIVE_INFINITY)).toBe(USD_UNKNOWN);
  });

  it('honours a custom decimal cap', () => {
    expect(formatUsd(1.23456, 2)).toBe('$1.23');
    expect(formatUsd(1.5, 0)).toBe('$2');
  });
});

describe('formatUsdDelta', () => {
  it('signs savings and premiums', () => {
    expect(formatUsdDelta(6.4581)).toBe('+$6.458');
    expect(formatUsdDelta(-0.25)).toBe('-$0.25');
  });

  it('omits deltas that round to nothing', () => {
    expect(formatUsdDelta(0)).toBeNull();
    expect(formatUsdDelta(-0)).toBeNull();
    expect(formatUsdDelta(0.0001)).toBeNull();
    expect(formatUsdDelta(null)).toBeNull();
    expect(formatUsdDelta(Number.NaN)).toBeNull();
  });
});

describe('isZeroUsd', () => {
  it('treats absent, non-finite and sub-precision values as zero', () => {
    expect(isZeroUsd(0)).toBe(true);
    expect(isZeroUsd(0.0004)).toBe(true);
    expect(isZeroUsd(null)).toBe(true);
    expect(isZeroUsd(undefined)).toBe(true);
    expect(isZeroUsd(Number.NaN)).toBe(true);
    expect(isZeroUsd(0.0006)).toBe(false);
    expect(isZeroUsd(-1.5)).toBe(false);
  });
});
