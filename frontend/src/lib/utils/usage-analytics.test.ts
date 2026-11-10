import { describe, expect, it } from 'vitest';
import {
  buildUsageChartGeometry,
  deriveUsageWindowView,
} from './usage-analytics';

describe('usage-analytics', () => {
  it('synthesizes T3-style usage analytics from legacy billingCredits and cliUsage', () => {
    const now = 1_760_000_000_000;
    const credits = {
      ok: true,
      totalSpendCents: 213,
      hasKnownSpend: true,
      byProvider: [
        {
          name: 'openai',
          tokensIn: 500_000,
          tokensOut: 120_000,
          spendCents: 213,
          subscription: false,
          models: [
            {
              model: 'gpt-6-sol',
              tokensIn: 500_000,
              tokensOut: 120_000,
              spendCents: 213,
              hasKnownCost: true,
            },
          ],
        },
      ],
      cliUsage: [
        {
          provider: 'antigravity',
          windows: [{ period: '24h', tokensIn: 60_000, tokensOut: 28_600 }],
          byModel: [
            { model: 'gemini-4-argon-trial', tokensIn: 40_000, tokensOut: 19_000 },
            { model: 'gemini-4-argon-medium', tokensIn: 20_000, tokensOut: 9_500 },
          ],
        },
      ],
    };

    const view = deriveUsageWindowView(credits, '24h', 'all', now);

    expect(view.totalSpendUsd).toBeCloseTo(2.13);
    expect(view.totals.processedTokens).toBe(708_600);
    expect(view.byProvider.map((p) => p.name)).toEqual(['openai', 'antigravity']);
    expect(view.byProvider[0]?.sharePercent).toBeCloseTo(100);
    expect(view.byProvider[1]?.spendUsd).toBe(0);
    expect(view.byModel.map((m) => m.model)).toEqual([
      'gpt-6-sol',
      'gemini-4-argon-trial',
      'gemini-4-argon-medium',
    ]);
    expect(view.byModel[0]?.hasKnownCost).toBe(true);
    expect(view.byModel[1]?.hasKnownCost).toBe(false);
    expect(
      view.costByType.inputUsd + view.costByType.cacheReadUsd + view.costByType.outputUsd,
    ).toBeCloseTo(2.13);
  });

  it('builds smooth monotone cubic spline geometry with 4 Y-axis ticks', () => {
    const view = deriveUsageWindowView(
      {
        byProvider: [{ name: 'openai', tokensIn: 300_000, tokensOut: 80_000, spendUsd: 1.38 }],
      },
      '24h',
      'all',
      1_760_000_000_000,
    );
    const chart = buildUsageChartGeometry(view.series, 'cost');

    expect(chart.yTicks).toHaveLength(4);
    expect(chart.yTicks[0]?.label).toBe('$1.50');
    expect(chart.yTicks[3]?.label).toBe('0');
    expect(chart.linePath).toContain('M ');
    expect(chart.linePath).toContain(' C ');
    expect(chart.areaPath).toContain(' Z');
  });
});
