import { describe, expect, test } from 'bun:test';
import type { UsageCostBreakdownRow } from '../credit-accountant/db';
import { summarizeBillingSpend, summarizeSessionCosts } from './cost-summary';

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
});
