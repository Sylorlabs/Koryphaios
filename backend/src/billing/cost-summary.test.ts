import { describe, expect, test } from 'bun:test';
import type { CreditUsageEventRow, UsageCostBreakdownRow } from '../credit-accountant/db';
import {
  summarizeBillingSpend,
  summarizeSessionCosts,
  summarizeUsageAnalytics,
} from './cost-summary';

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

function eventRow(partial: Partial<CreditUsageEventRow>, now = 1_760_000_000_000): CreditUsageEventRow {
  return {
    ts: now - 30 * 60 * 1_000,
    sessionId: 'session-1',
    provider: 'openai',
    model: 'gpt-5.6',
    tokensIn: 500_000,
    tokensOut: 120_000,
    cacheReadTokens: 100_000,
    cacheWriteTokens: 0,
    cacheSavingsUsd: 0.18,
    costUsd: 2.13,
    costKnown: true,
    ...partial,
  };
}

describe('billing cost summaries', () => {
  test('treats an empty ledger as unknown rather than confirmed zero spend', () => {
    const summary = summarizeBillingSpend([]);

    expect(summary.totalSpendUsd).toBe(0);
    expect(summary.hasKnownSpend).toBe(false);
    expect(summary.pricingIncomplete).toBe(false);
  });

  test('keeps known spend while flagging later unknown-priced usage', () => {
    const summary = summarizeBillingSpend([
      row({ knownCostUsd: 1.1119, knownRows: 1 }),
      row({ model: 'gpt-new', knownCostUsd: 0, unknownRows: 1 }),
    ]);

    expect(summary.totalSpendUsd).toBeCloseTo(1.1119);
    expect(summary.totalSpendCents).toBe(111);
    expect(summary.hasKnownSpend).toBe(true);
    expect(summary.pricingIncomplete).toBe(true);
    expect(summary.byProvider[0]?.hasKnownCost).toBe(true);
    expect(summary.byProvider[0]?.pricingIncomplete).toBe(true);
  });

  test('distinguishes confirmed zero from unknown price', () => {
    const confirmedZero = summarizeBillingSpend([row({ knownRows: 1 })]);
    const unknown = summarizeBillingSpend([row({ unknownRows: 1 })]);

    expect(confirmedZero.totalSpendUsd).toBe(0);
    expect(confirmedZero.hasKnownSpend).toBe(true);
    expect(confirmedZero.pricingIncomplete).toBe(false);
    expect(unknown.totalSpendUsd).toBe(0);
    expect(unknown.hasKnownSpend).toBe(false);
    expect(unknown.pricingIncomplete).toBe(true);
  });

  test('never adds subscription usage to tracked API spend', () => {
    const rows = [
      row({
        provider: 'codex',
        model: 'unmapped-subscription-model',
        knownCostUsd: 9.99,
        knownRows: 1,
      }),
      row({ provider: 'openai', knownCostUsd: 0.4242, knownRows: 1 }),
    ];
    const billing = summarizeBillingSpend(rows);
    const sessions = summarizeSessionCosts(rows);

    expect(billing.totalSpendUsd).toBeCloseTo(0.4242);
    expect(billing.byProvider.map((provider) => provider.name)).toEqual(['openai']);
    expect(sessions['session-1']?.spendUsd).toBeCloseTo(0.4242);
    expect(sessions['session-1']?.hasSubscriptionUsage).toBe(true);
    expect(
      sessions['session-1']?.providers.find((provider) => provider.name === 'codex')?.spendUsd,
    ).toBeNull();
  });

  test('session summaries keep known spend visible when some metered usage is unpriced', () => {
    const sessions = summarizeSessionCosts([
      row({ knownCostUsd: 0.75, knownRows: 1 }),
      row({ model: 'gpt-future', unknownRows: 1 }),
    ]);

    expect(sessions['session-1']?.spendUsd).toBeCloseTo(0.75);
    expect(sessions['session-1']?.hasKnownCost).toBe(true);
    expect(sessions['session-1']?.pricingIncomplete).toBe(true);
  });

  test('computes windowed analytics with hourly/daily series, cost-by-type, and subscription rows', () => {
    const now = 1_760_000_000_000;
    const analytics = summarizeUsageAnalytics(
      [
        eventRow(
          {
            sessionId: 'session-1',
            provider: 'openai',
            model: 'gpt-6-sol',
            tokensIn: 500_000,
            tokensOut: 120_000,
            cacheReadTokens: 98_600,
            cacheSavingsUsd: 0.18,
            costUsd: 2.13,
            costKnown: true,
          },
          now,
        ),
        eventRow(
          {
            sessionId: 'session-2',
            provider: 'antigravity',
            model: 'gemini-4-argon-medium',
            tokensIn: 60_000,
            tokensOut: 28_600,
            cacheReadTokens: 0,
            cacheSavingsUsd: 0,
            costUsd: 0,
            costKnown: true,
          },
          now,
        ),
      ],
      now,
    );

    const w24 = analytics.windows['24h'];
    expect(w24.granularity).toBe('hour');
    expect(w24.series.length).toBe(24);
    expect(w24.totalSpendUsd).toBeCloseTo(2.13);
    expect(w24.sessionCount).toBe(2);
    expect(w24.totals.processedTokens).toBe(708_600);
    expect(w24.totals.cachedInputTokens).toBe(98_600);
    expect(w24.totals.uncachedInputTokens).toBe(461_400);
    expect(w24.totals.outputTokens).toBe(148_600);
    expect(w24.totals.cacheSavingsUsd).toBeCloseTo(0.18);
    expect(
      w24.costByType.inputUsd + w24.costByType.cacheReadUsd + w24.costByType.outputUsd,
    ).toBeCloseTo(2.13);

    expect(w24.byProvider.map((p) => p.name)).toEqual(['openai', 'antigravity']);
    expect(w24.byProvider[0]?.sharePercent).toBeCloseTo(100);
    expect(w24.byProvider[1]?.spendUsd).toBe(0);
    expect(w24.byProvider[1]?.subscription).toBe(true);

    expect(w24.byModel[0]?.model).toBe('gpt-6-sol');
    expect(w24.byModel[0]?.hasKnownCost).toBe(true);
    expect(w24.byModel[1]?.model).toBe('gemini-4-argon-medium');
    expect(w24.byModel[1]?.hasKnownCost).toBe(false);
    expect(w24.byModel[1]?.spendUsd).toBeNull();
  });
});
