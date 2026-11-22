import { describe, expect, it } from 'bun:test';
import { coarenaBalanceFrom, crowllmBalanceFrom } from './provider-balances';

describe('Coarena account usage', () => {
  it('reports the wallet and today’s allowance from the real endpoint shapes', () => {
    const balance = coarenaBalanceFrom(
      {
        object: 'credits',
        plan: 'free',
        balance_usd: 12.8,
        held_usd: 0.3,
        available_usd: 12.5,
        free_daily_usd: 5,
      },
      {
        data: {
          free: true,
          usd_per_day: 5,
          requests_per_minute_key: 30,
          requests_per_minute_account: 30,
          concurrency: 2,
          today: {
            used_usd: 1.2,
            held_usd: 0.3,
            left_usd: 3.5,
            requests: 12,
            resets_at: 1_794_700_800_000,
          },
        },
      },
    );

    expect(balance).toMatchObject({
      provider: 'coarena',
      availableUsd: 12.5,
      usedUsd: 1.2,
      plan: 'free',
      // (1.2 spent + 0.3 held) / 5 daily allowance.
      allowanceUsedPercent: 30,
      allowanceResetsAt: 1_794_700_800_000,
    });
    expect(balance.detail).toContain('$5.00/day');
    expect(balance.detail).toContain('30 req/min');
    expect(balance.detail).toContain('2 concurrent');
  });

  it('shows the daily allowance for a free account instead of a $0 wallet', () => {
    const balance = coarenaBalanceFrom(
      { object: 'credits', plan: 'free', balance_usd: 0, held_usd: 0, available_usd: 0 },
      {
        data: {
          free: true,
          usd_per_day: 5,
          today: { used_usd: 1.5, held_usd: 0, left_usd: 3.5, resets_at: 1_794_700_800_000 },
        },
      },
    );

    expect(balance.availableUsd).toBeNull();
    expect(balance.allowanceUsedPercent).toBe(30);
    expect(balance.detail).toContain('$5.00/day');
  });

  it('keeps a real zero wallet balance and never invents usage it did not receive', () => {
    const balance = coarenaBalanceFrom(
      { object: 'credits', plan: 'suspended', balance_usd: 0, held_usd: 0, available_usd: 0 },
      undefined,
    );

    expect(balance.availableUsd).toBe(0);
    expect(balance.plan).toBe('suspended');
    expect(balance.usedUsd).toBeUndefined();
    expect(balance.allowanceUsedPercent).toBeUndefined();
  });
});

describe('CrowLLM account usage', () => {
  it('uses explicit balance and usage fields when the billing routes expose them', () => {
    const balance = crowllmBalanceFrom(
      { available_usd: 7.5, plan: 'starter' },
      { total_usage: 250, total_usage_usd: 2.5 },
    );

    expect(balance).toMatchObject({
      provider: 'crowllm',
      availableUsd: 7.5,
      usedUsd: 2.5,
      plan: 'starter',
    });
    expect(balance.detail).toContain('$2.50 used this period');
  });

  it('reports a spend-cap percentage without inventing a wallet balance', () => {
    const balance = crowllmBalanceFrom(
      { hard_limit_usd: 10, system_hard_limit_usd: 20 },
      { total_usage: 250 },
    );

    expect(balance.availableUsd).toBeNull();
    expect(balance.usedUsd).toBe(2.5);
    expect(balance.allowanceUsedPercent).toBe(25);
    expect(balance.detail).toContain('$10.00 spend cap');
  });
});
