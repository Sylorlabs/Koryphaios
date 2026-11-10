import { describe, expect, it } from 'vitest';
import { buildContextSegments, contextCacheStatus } from './context-segments';
import { reconcileContextBreakdown } from '@koryphaios/shared';

const breakdown = { system: 100, memory: 20, skills: 10, tools: 30, chat: 40, output: 50 };
const usage = { used: 1_050, max: 10_000, isReliable: true, provider: 'openai', breakdown };

describe('context category accounting', () => {
  it('reconciles API tokenizer differences into known input categories while preserving output', () => {
    const segments = buildContextSegments(usage)!;
    expect(segments.map((s) => s.key)).toEqual([
      'system',
      'memory',
      'skills',
      'tools',
      'chat',
      'output',
    ]);
    expect(segments.find((s) => s.key === 'system')?.tokens).toBe(500);
    expect(segments.find((s) => s.key === 'output')?.tokens).toBe(50);
    expect(segments.reduce((sum, s) => sum + s.tokens, 0)).toBe(1_050);
    expect(segments.reduce((sum, s) => sum + s.widthPercent, 0)).toBeCloseTo(10.5);
  });

  it('attributes only the opaque CLI difference to runtime overhead, including older snapshots', () => {
    for (const provider of ['antigravity', 'codex', 'claude', 'cursor', 'devin', 'freebuff']) {
      const segments = buildContextSegments({ ...usage, provider })!;
      expect(segments.find((s) => s.key === 'cliHarness')).toMatchObject({
        label: 'CLI runtime overhead',
        tokens: 800,
      });
      expect(segments.reduce((sum, s) => sum + s.tokens, 0)).toBe(usage.used);
      expect(buildContextSegments({ ...usage, provider, breakdown: undefined })![0].label).toBe(
        'CLI runtime overhead',
      );
    }
  });

  it('accounts for small or overestimated inputs exactly without scaling generated output', () => {
    const segments = buildContextSegments({ ...usage, used: 53 })!;
    expect(segments.reduce((sum, s) => sum + s.tokens, 0)).toBe(53);
    expect(segments.find((s) => s.key === 'output')?.tokens).toBe(50);
    expect(buildContextSegments({ ...usage, breakdown: undefined })![0].label).toBe(
      'Request context',
    );
  });

  it('is stable when already reconciled backend breakdowns are restored', () => {
    for (const provider of ['antigravity', 'openai']) {
      const first = reconcileContextBreakdown(breakdown, usage.used, provider);
      expect(reconcileContextBreakdown(first, usage.used, provider)).toEqual(first);
    }
  });
});

describe('context cache overlap', () => {
  it('shows resident cache as a subset without adding it to the categories', () => {
    const cachedUsage = { ...usage, cachedInputTokens: 700, cacheWriteInputTokens: 100 };
    expect(contextCacheStatus(cachedUsage)).toMatchObject({ resident: 800, widthPercent: 8 });
    expect(contextCacheStatus(cachedUsage).label).toContain('included in total');
    expect(buildContextSegments(cachedUsage)!.reduce((sum, s) => sum + s.tokens, 0)).toBe(1_050);
  });

  it('does not paint cumulative CLI cache receipts as live context', () => {
    for (const override of [
      { estimated: true },
      { cachedInputTokens: 20_000 },
      { isReliable: false },
    ]) {
      const cache = contextCacheStatus({ ...usage, cachedInputTokens: 700, ...override });
      expect(cache.widthPercent).toBe(0);
      expect(cache.label).toContain('live context share not reported');
    }
    expect(contextCacheStatus(usage).label).toBe('');
  });
});
