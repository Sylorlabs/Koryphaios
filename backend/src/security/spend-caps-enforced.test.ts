import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_ENFORCED_CAPS,
  findSpendCapViolation,
  mergeEnforcedCaps,
  type SpendWindowSnapshot,
} from './spend-caps-enforced';

const emptySnapshot: SpendWindowSnapshot = {
  sessionHourCents: 0,
  sessionDayCents: 0,
  globalHourCents: 0,
  globalDayCents: 0,
};

describe('enforced spend-cap contract', () => {
  it('stops the next request when recorded session-hour spend reaches its cap', () => {
    const caps = {
      ...DEFAULT_ENFORCED_CAPS,
      perRequestCents: 0,
      sessionHourlyCents: 200,
      sessionDailyCents: 0,
      globalHourlyCents: 0,
      globalDailyCents: 0,
    };
    const violation = findSpendCapViolation(caps, {
      ...emptySnapshot,
      sessionHourCents: 200,
    });
    expect(violation).toEqual({
      capType: 'session_hourly',
      currentSpend: 200,
      limit: 200,
      reason: 'Session hourly spend limit reached ($2.00 / $2.00)',
    });
  });

  it('evaluates real hourly and daily windows independently', () => {
    const caps = {
      ...DEFAULT_ENFORCED_CAPS,
      perRequestCents: 0,
      sessionHourlyCents: 0,
      sessionDailyCents: 0,
      globalHourlyCents: 500,
      globalDailyCents: 2_000,
    };
    expect(
      findSpendCapViolation(caps, { ...emptySnapshot, globalHourCents: 499, globalDayCents: 2_000 })
        ?.capType,
    ).toBe('global_daily');
    expect(
      findSpendCapViolation(caps, { ...emptySnapshot, globalHourCents: 500, globalDayCents: 700 })
        ?.capType,
    ).toBe('global_hourly');
  });

  it('rejects invalid API-bypass values and normalizes notification thresholds', () => {
    expect(() => mergeEnforcedCaps(DEFAULT_ENFORCED_CAPS, { sessionHourlyCents: -1 })).toThrow(
      'sessionHourlyCents',
    );
    expect(() => mergeEnforcedCaps(DEFAULT_ENFORCED_CAPS, { globalDailyCents: 2.5 })).toThrow(
      'globalDailyCents',
    );
    expect(
      mergeEnforcedCaps(DEFAULT_ENFORCED_CAPS, { notifyAtPercent: [95, 80, 95] }).notifyAtPercent,
    ).toEqual([80, 95]);
  });

  it('does not use the per-request cap without an authoritative estimate', () => {
    const caps = { ...DEFAULT_ENFORCED_CAPS, perRequestCents: 1 };
    expect(findSpendCapViolation(caps, emptySnapshot, 0)).toBeNull();
    expect(findSpendCapViolation(caps, emptySnapshot, 1)?.capType).toBe('per_request');
  });
});
