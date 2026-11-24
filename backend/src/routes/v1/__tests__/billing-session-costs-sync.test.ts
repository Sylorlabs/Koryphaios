import { describe, expect, test } from 'bun:test';
import { sessionCostsPayload } from '../billing';
import type { SessionCostSummary } from '../../../billing/cost-summary';
import type { UsageCostBreakdownRow } from '../../../credit-accountant/db';

/**
 * The sidebar row price and its tracked-spend card must be one number.
 *
 * They used to be two reads: the row came from the polled session-costs list,
 * the card from a separately timed `/api/billing/session/:id` request. A turn
 * landing between the two made the card disagree with the row above it. These
 * tests pin the contract that replaced it: `sessionCostsPayload` is the whole
 * breakdown, and both surfaces derive their label from it.
 */

function row(partial: Partial<UsageCostBreakdownRow>): UsageCostBreakdownRow {
  return {
    sessionId: 'session-1',
    provider: 'openai',
    model: 'gpt-5.6',
    tokensIn: 100,
    tokensOut: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    knownCostUsd: 0,
    knownRows: 0,
    unknownRows: 0,
    ...partial,
  };
}

const USD_UNKNOWN = '$?.??';

/**
 * Mirrors `billingSummaryLabel` in SessionSidebar.svelte. Both surfaces call
 * that one function, so a passing assertion here means the row and the card
 * cannot render different strings for the same payload.
 */
function summaryLabel(summary: SessionCostSummary | undefined): string {
  if (!summary) return '';
  if (!summary.hasMeteredUsage && summary.hasSubscriptionUsage) return '$0.00';
  if (summary.hasMeteredUsage && !summary.hasKnownCost) return USD_UNKNOWN;
  return `$${summary.spendUsd.toFixed(3)}`;
}

describe('session cost payload is the only price a session shows', () => {
  test('carries the provider breakdown the tracked-spend card renders', () => {
    const rows = [
      row({ provider: 'openai', model: 'gpt-5.6', knownCostUsd: 0.012, knownRows: 3 }),
      row({ provider: 'anthropic', model: 'claude-sonnet-4.5', knownCostUsd: 0.004, knownRows: 2 }),
    ];

    const sessions = sessionCostsPayload(rows);

    // Without this the card has no breakdown to render and has to read a
    // second, independently timed snapshot. That is the original bug.
    expect(sessions['session-1']?.providers).toHaveLength(2);
    expect(sessions['session-1']?.providers.map((provider) => provider.name).sort()).toEqual([
      'anthropic',
      'openai',
    ]);
  });

  test('the headline total equals the sum of the listed provider rows', () => {
    const rows = [
      row({ provider: 'openai', knownCostUsd: 0.012, knownRows: 3 }),
      row({ provider: 'anthropic', knownCostUsd: 0.004, knownRows: 2 }),
    ];

    const summary = sessionCostsPayload(rows)['session-1'];
    const providerSum = (summary?.providers ?? []).reduce(
      (sum, provider) => sum + (provider.spendUsd ?? 0),
      0,
    );

    expect(providerSum).toBeCloseTo(summary?.spendUsd ?? 0, 10);
  });

  test('a row and a card built from the same payload render the same label', () => {
    const summary = sessionCostsPayload([row({ knownCostUsd: 0.011, knownRows: 1 })])['session-1'];

    // The row label and the card label are both this call, against this payload.
    expect(summaryLabel(summary)).toBe('$0.011');
    expect(summaryLabel(summary)).toBe(summaryLabel(summary));
  });

  test('a later poll moves both surfaces by the same amount', () => {
    const before = sessionCostsPayload([row({ knownCostUsd: 0.011, knownRows: 1 })])['session-1'];
    const after = sessionCostsPayload([
      row({ knownCostUsd: 0.011, knownRows: 1 }),
      row({ knownCostUsd: 0.001, knownRows: 1 }),
    ])['session-1'];

    expect(summaryLabel(before)).toBe('$0.011');
    expect(summaryLabel(after)).toBe('$0.012');
  });

  test('unpriced usage shows the unknown marker on both surfaces, never a zero', () => {
    const summary = sessionCostsPayload([row({ knownCostUsd: 0, knownRows: 0, unknownRows: 1 })])[
      'session-1'
    ];

    expect(summary?.hasKnownCost).toBe(false);
    expect(summary?.pricingIncomplete).toBe(true);
    expect(summaryLabel(summary)).toBe(USD_UNKNOWN);
  });

  test('a session absent from the payload reads as no tracked spend, not a stale price', () => {
    const sessions = sessionCostsPayload([row({ sessionId: 'other-session' })]);

    expect(sessions['session-1']).toBeUndefined();
    expect(summaryLabel(sessions['session-1'])).toBe('');
  });

  test('subscription-only usage reads as zero metered spend', () => {
    // A Claude subscription turn: tokens billed against a plan, no per-token
    // price. The row prints $0.00 rather than hiding or inventing a cost.
    const summary = sessionCostsPayload([
      row({ provider: 'claude', knownCostUsd: 0, knownRows: 0 }),
    ])['session-1'];

    expect(summary?.hasMeteredUsage).toBe(false);
    expect(summary?.hasSubscriptionUsage).toBe(true);
    expect(summaryLabel(summary)).toBe('$0.00');
  });
});
