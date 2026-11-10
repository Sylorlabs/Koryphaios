import { describe, expect, it, vi } from 'vitest';

vi.mock('./sessions.svelte', () => ({
  sessionStore: { activeSessionId: 'sess1' },
}));
vi.mock('$lib/utils/api-url', () => ({ apiUrl: (path: string) => path }));
vi.mock('$lib/api.svelte', () => ({
  apiFetch: vi.fn(),
  parseJsonResponse: vi.fn(),
}));
vi.mock('./feed.svelte', () => ({
  feedStore: {
    resolveGlowClass: vi.fn(() => ''),
    nextFeedId: vi.fn((prefix: string) => `${prefix}-test-1`),
    visibleEntriesForSession: vi.fn((_sessionId: string, entries: unknown[]) => entries),
  },
  getGroupedEntries: vi.fn((entries: unknown[]) => entries),
}));
vi.mock('./run-state.svelte', () => ({
  runStateStore: {
    getAgentStatusForSession: vi.fn(() => 'idle'),
    isRunning: vi.fn(() => false),
    isWaiting: vi.fn(() => false),
  },
}));

import { agentStore } from './agents.svelte';
import type { FeedEntry } from '$lib/types';

function thinkingRow(agentId: string, startedAt: number): Omit<FeedEntry, 'id'> {
  return {
    timestamp: startedAt,
    type: 'thinking',
    agentId,
    agentName: 'Worker',
    glowClass: '',
    text: 'considering…',
    thinkingStartedAt: startedAt,
  };
}

describe('finalizeThreadThinking', () => {
  it('freezes live thread thinking with the server-timestamp duration', () => {
    agentStore.upsertAgentThreadEntry('fin-basic', 'worker-1', thinkingRow('worker-1', 1000));
    agentStore.finalizeThreadThinking('fin-basic', 'worker-1', 4600);

    const entries = agentStore.getAgentThreadEntries('fin-basic', 'worker-1');
    expect(entries).toHaveLength(1);
    expect(entries[0].thinkingFinalized).toBe(true);
    expect(entries[0].durationMs).toBe(3600);
  });

  it('only finalizes the matching session and agent', () => {
    agentStore.upsertAgentThreadEntry('fin-scope', 'worker-1', thinkingRow('worker-1', 1000));
    agentStore.upsertAgentThreadEntry('fin-scope', 'worker-2', thinkingRow('worker-2', 2000));
    agentStore.upsertAgentThreadEntry('fin-other', 'worker-1', thinkingRow('worker-1', 3000));

    agentStore.finalizeThreadThinking('fin-scope', 'worker-1', 5000);

    expect(agentStore.getAgentThreadEntries('fin-scope', 'worker-1')[0].thinkingFinalized).toBe(
      true,
    );
    expect(
      agentStore.getAgentThreadEntries('fin-scope', 'worker-2')[0].thinkingFinalized,
    ).toBeUndefined();
    expect(
      agentStore.getAgentThreadEntries('fin-other', 'worker-1')[0].thinkingFinalized,
    ).toBeUndefined();
  });

  it('finalizes everything when no filter is given (error/stop path)', () => {
    agentStore.upsertAgentThreadEntry('fin-all', 'worker-1', thinkingRow('worker-1', 1000));
    agentStore.finalizeThreadThinking('fin-all', undefined, 2500);

    const entries = agentStore.getAgentThreadEntries('fin-all', 'worker-1');
    expect(entries[0].thinkingFinalized).toBe(true);
    expect(entries[0].durationMs).toBe(1500);
  });

  it('never shrinks an existing duration', () => {
    agentStore.upsertAgentThreadEntry('fin-peak', 'worker-1', {
      ...thinkingRow('worker-1', 1000),
      durationMs: 9000,
    });
    agentStore.finalizeThreadThinking('fin-peak', 'worker-1', 2000);

    const entries = agentStore.getAgentThreadEntries('fin-peak', 'worker-1');
    expect(entries[0].thinkingFinalized).toBe(true);
    expect(entries[0].durationMs).toBe(9000);
  });

  it('leaves already-finalized entries untouched', () => {
    agentStore.upsertAgentThreadEntry('fin-done', 'worker-1', {
      ...thinkingRow('worker-1', 1000),
      durationMs: 500,
      thinkingFinalized: true,
    });
    agentStore.finalizeThreadThinking('fin-done', 'worker-1', 99999);

    const entries = agentStore.getAgentThreadEntries('fin-done', 'worker-1');
    expect(entries[0].durationMs).toBe(500);
    expect(entries[0].thinkingFinalized).toBe(true);
  });
});
