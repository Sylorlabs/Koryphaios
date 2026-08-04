import { describe, expect, test } from 'bun:test';
import { collectResourceBudgetSnapshot } from './resource-budget';

describe('agent resource budget snapshot', () => {
  test('contains only provider-reported balances and quota state', async () => {
    const snapshot = await collectResourceBudgetSnapshot(
      { openrouter: { apiKey: 'secret-never-returned' }, codex: {} },
      {
        getBalances: async () => [
          { provider: 'openrouter', availableUsd: 0, usedUsd: 12, fetchedAt: 100 },
        ],
        getCliUsage: async () => [
          {
            provider: 'codex',
            available: true,
            attribution: 'account',
            planType: 'plus',
            windows: [],
            dailyUsage: [],
            quotas: [{ label: 'five hour', usedPercent: 91, resetsAt: 500, windowMinutes: 300 }],
            byModel: [],
            updatedAt: 200,
          },
        ],
        getSubscriptions: () => [],
      },
    );
    expect(snapshot.entries.find((entry) => entry.provider === 'openrouter')?.state).toBe('exhausted');
    expect(snapshot.entries.find((entry) => entry.provider === 'codex')?.state).toBe('low');
    expect(snapshot.entries.find((entry) => entry.provider === 'codex')?.usedPercent).toBe(91);
    expect(JSON.stringify(snapshot)).not.toContain('secret-never-returned');
    expect(snapshot.limitations.join(' ')).toContain('Missing providers are unknown');
    expect(snapshot.limitations.join(' ')).toContain('not inferred');
  });

  test('times out to explicit unknown limitations instead of fabricated zeroes', async () => {
    const never = new Promise<never>(() => {});
    const snapshot = await collectResourceBudgetSnapshot({}, {
      getBalances: () => never,
      getCliUsage: () => never,
      getSubscriptions: () => [],
      timeoutMs: 5,
    });
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.limitations.some((value) => value.includes('bounded collection window'))).toBe(true);
  });
});
