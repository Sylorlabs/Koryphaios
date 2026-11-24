import { describe, expect, test } from 'bun:test';
import {
  CLI_HARNESS_ESTIMATE_CEILING_TOKENS,
  CLI_HARNESS_ESTIMATE_FLOOR_TOKENS,
  boundOpaqueCumulativeOccupancy,
  reconcileContextBreakdown,
} from './context-accounting';

const breakdown = {
  system: 4_000,
  memory: 500,
  skills: 500,
  tools: 1_000,
  chat: 2_000,
  output: 300,
};
const measured = 8_000;

describe('boundOpaqueCumulativeOccupancy', () => {
  test('leaves exact per-request CLI occupancy and every non-CLI provider untouched', () => {
    expect(boundOpaqueCumulativeOccupancy(breakdown, 250_000, 'codex', false)).toEqual({
      used: 250_000,
      harnessCapped: false,
    });
    for (const provider of ['openai', 'anthropic', 'google', undefined]) {
      expect(boundOpaqueCumulativeOccupancy(breakdown, 250_000, provider, true)).toEqual({
        used: 250_000,
        harnessCapped: false,
      });
    }
  });

  test('caps the CLI harness of a cumulative total to what Kory measured, inside the 8k-48k band', () => {
    const bounded = boundOpaqueCumulativeOccupancy(breakdown, 250_000, 'codex', true);
    expect(bounded.harnessCapped).toBe(true);
    expect(bounded.harnessCap).toBe(measured);
    expect(bounded.used).toBe(measured + measured + breakdown.output);
    const segments = reconcileContextBreakdown(breakdown, bounded.used, 'codex');
    expect(segments.cliHarness).toBe(measured);

    const large = { ...breakdown, chat: 200_000 };
    const big = boundOpaqueCumulativeOccupancy(large, 1_000_000, 'claude', true);
    expect(big.harnessCap).toBe(CLI_HARNESS_ESTIMATE_CEILING_TOKENS);

    const tiny = { system: 100, memory: 0, skills: 0, tools: 0, chat: 16, output: 0 };
    expect(boundOpaqueCumulativeOccupancy(tiny, 90_000, 'devin', true).harnessCap).toBe(
      CLI_HARNESS_ESTIMATE_FLOOR_TOKENS,
    );
  });

  test('does not cap a plausible remainder or invent one without a measured breakdown', () => {
    expect(boundOpaqueCumulativeOccupancy(breakdown, 14_000, 'codex', true)).toEqual({
      used: 14_000,
      harnessCapped: false,
    });
    expect(boundOpaqueCumulativeOccupancy(undefined, 250_000, 'codex', true)).toEqual({
      used: 250_000,
      harnessCapped: false,
    });
  });
});

describe('reconcileContextBreakdown (unchanged semantics)', () => {
  test('API remainder stays request context; CLI remainder stays runtime overhead', () => {
    expect(reconcileContextBreakdown(breakdown, 20_000, 'openai').request).toBeUndefined();
    expect(reconcileContextBreakdown(breakdown, 20_000, 'codex').cliHarness).toBe(
      20_000 - 300 - measured,
    );
  });
});
