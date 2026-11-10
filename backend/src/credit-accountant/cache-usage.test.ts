import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPromptCacheUsageSummary, getUsageEventsSince, initCreditDb, recordUsage } from './db';

describe('durable prompt cache usage accounting', () => {
  test('persists cache read/write tokens and net savings by provider', () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-cache-usage-'));
    initCreditDb(root);
    recordUsage('gpt-5.6', 'openai', 1_000, 50, 0.02, undefined, {
      cacheReadTokens: 800,
      cacheWriteTokens: 100,
      cacheSavingsUsd: 0.01,
      ttftMs: 120,
      latencyMs: 900,
    });
    recordUsage('claude-sonnet', 'anthropic', 2_000, 100, 0.04, undefined, {
      cacheReadTokens: 0,
      cacheWriteTokens: 500,
      cacheSavingsUsd: -0.002,
      ttftMs: 300,
      latencyMs: 1_500,
    });

    const summary = getPromptCacheUsageSummary(0);
    expect(summary.requests).toBe(2);
    expect(summary.inputTokens).toBe(3_000);
    expect(summary.cacheReadTokens).toBe(800);
    expect(summary.cacheWriteTokens).toBe(600);
    expect(summary.hitRate).toBeCloseTo(800 / 3_000, 10);
    expect(summary.savingsUsd).toBeCloseTo(0.008, 10);
    expect(summary.averageTtftMs).toBeCloseTo(210, 10);
    expect(summary.averageLatencyMs).toBeCloseTo(1_200, 10);
    expect(summary.byProvider.find((row) => row.provider === 'openai')).toMatchObject({
      requests: 1,
      inputTokens: 1_000,
      cacheReadTokens: 800,
      cacheWriteTokens: 100,
      hitRate: 0.8,
      savingsUsd: 0.01,
      averageTtftMs: 120,
      averageLatencyMs: 900,
    });
  });

  test('retains exact run revision provenance for usage events', () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-run-usage-'));
    initCreditDb(root);
    recordUsage('gpt-5.6', 'openai', 100, 10, 0.01, {
      sessionId: 'session-1',
      runRef: { sessionId: 'session-1', runId: 'run-1', revision: 4 },
    });
    expect(getUsageEventsSince(0).at(-1)?.runRef).toEqual({
      sessionId: 'session-1',
      runId: 'run-1',
      revision: 4,
    });
  });
});
