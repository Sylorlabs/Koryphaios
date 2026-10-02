import { beforeEach, describe, expect, it, vi } from 'vitest';

const sessionState = vi.hoisted(() => ({ activeSessionId: '' }));

vi.mock('./sessions.svelte', () => ({
  sessionStore: {
    get activeSessionId() {
      return sessionState.activeSessionId;
    },
  },
}));
vi.mock('$lib/utils/api-url', () => ({ apiUrl: (path: string) => path }));
vi.mock('$lib/api.svelte', () => ({
  apiFetch: vi.fn(),
  parseJsonResponse: vi.fn(),
}));
vi.mock('./feed.svelte', () => ({
  feedStore: {
    resolveGlowClass: vi.fn(() => ''),
  },
  getGroupedEntries: vi.fn(() => []),
}));
vi.mock('./run-state.svelte', () => ({
  runStateStore: {
    getAgentStatusForSession: vi.fn(() => 'idle'),
    isRunning: vi.fn(() => false),
    isWaiting: vi.fn(() => false),
  },
}));

import {
  agentStore,
  applyManagerContextPreview,
  beginManagerContextPreview,
  clearManagerContextPreview,
  getContextUsage,
  removeAgent,
  seedManagerUsage,
  setManagerSessionId,
  spawnAgent,
  updateUsage,
} from './agents.svelte';

const CLI_BREAKDOWN = {
  system: 1_200,
  memory: 10_200,
  skills: 800,
  tools: 0,
  chat: 1_200,
  output: 700,
};
const API_BREAKDOWN = {
  system: 3_000,
  memory: 8_000,
  skills: 1_000,
  tools: 4_000,
  chat: 5_000,
  output: 250,
};

function manager() {
  const state = agentStore.agents.get('kory-manager');
  if (!state) throw new Error('manager state is unavailable');
  return state;
}

describe('manager context preview provider transitions', () => {
  beforeEach(() => {
    sessionState.activeSessionId = `context-preview-${crypto.randomUUID()}`;
  });

  it('surfaces live prompt-cache receipt metrics for the selected manager route', () => {
    const sessionId = sessionState.activeSessionId;
    beginManagerContextPreview(sessionId, 'openai', 'gpt-5.6', 262_144);
    updateUsage(
      'kory-manager',
      {
        agentId: 'kory-manager',
        model: 'gpt-5.6',
        provider: 'openai',
        tokensIn: 20_000,
        tokensOut: 250,
        tokensUsed: 20_250,
        usageKnown: true,
        contextWindow: 262_144,
        contextKnown: true,
        cachedInputTokens: 12_000,
        cacheWriteInputTokens: 3_000,
        estimatedCostUsd: 0.0123,
        cacheSavingsUsd: 0.0042,
        breakdown: API_BREAKDOWN,
      },
      sessionId,
    );

    expect(getContextUsage()).toMatchObject({
      cachedInputTokens: 12_000,
      cacheWriteInputTokens: 3_000,
      estimatedCostUsd: 0.0123,
      cacheSavingsUsd: 0.0042,
    });

    beginManagerContextPreview(sessionId, 'anthropic', 'claude-sonnet-4-6', 200_000);
    expect(getContextUsage().cacheWriteInputTokens).toBeUndefined();
    expect(getContextUsage().estimatedCostUsd).toBeUndefined();
    expect(getContextUsage().cacheSavingsUsd).toBeUndefined();
  });

  it('clears CLI-only usage immediately when the same session switches to an API provider', () => {
    const sessionId = sessionState.activeSessionId;
    beginManagerContextPreview(sessionId, 'codex', 'gpt-5.6-codex', 1_000_000);
    expect(
      applyManagerContextPreview(sessionId, 'codex', 'gpt-5.6-codex', {
        used: 211_700,
        contextWindow: 1_000_000,
        contextKnown: true,
        usageKnown: true,
        cachedInputTokens: 199_200,
        breakdown: CLI_BREAKDOWN,
      }),
    ).toBe(true);

    expect(getContextUsage()).toMatchObject({
      used: 211_700,
      max: 1_000_000,
      isReliable: true,
      provider: 'codex',
      cachedInputTokens: 199_200,
      breakdown: CLI_BREAKDOWN,
    });

    beginManagerContextPreview(sessionId, 'openai', 'minimax-m3', 262_144);

    expect(manager()).toMatchObject({
      sessionId,
      tokensUsed: 0,
      contextMax: 262_144,
      contextKnown: true,
      hasUsageData: false,
    });
    expect(manager().contextBreakdown).toBeUndefined();
    expect(manager().cachedInputTokens).toBeUndefined();
    expect(getContextUsage()).toMatchObject({
      used: 0,
      max: 262_144,
      isReliable: false,
      reason: 'usage_unknown',
    });
  });

  it('rejects startup replay and archive usage until an exact model selection is pinned', () => {
    const sessionId = sessionState.activeSessionId;
    clearManagerContextPreview(sessionId);

    updateUsage(
      'kory-manager',
      {
        agentId: 'kory-manager',
        model: 'gpt-5.6-codex',
        provider: 'codex',
        tokensIn: 211_000,
        tokensOut: 700,
        tokensUsed: 211_700,
        usageKnown: true,
        contextWindow: 1_000_000,
        contextKnown: true,
        breakdown: CLI_BREAKDOWN,
      },
      sessionId,
    );
    expect(
      seedManagerUsage(sessionId, {
        used: 211_700,
        max: 1_000_000,
        contextKnown: true,
        provider: 'codex',
        model: 'gpt-5.6-codex',
        breakdown: CLI_BREAKDOWN,
      }),
    ).toBe(false);

    expect(manager()).toMatchObject({
      sessionId,
      tokensUsed: 0,
      contextMax: 0,
      contextKnown: false,
      hasUsageData: false,
    });
    expect(manager().contextBreakdown).toBeUndefined();
  });

  it('never lets a worker restore provider usage while the selected manager awaits a report', () => {
    const sessionId = sessionState.activeSessionId;
    beginManagerContextPreview(sessionId, 'openai', 'minimax-m3', 262_144);
    spawnAgent(
      {
        id: 'codex-worker',
        name: 'Codex worker',
        role: 'coder',
        model: 'gpt-5.6-codex',
        provider: 'codex',
        domain: 'backend',
        glowColor: '#fff',
      },
      'work',
      sessionId,
    );
    updateUsage(
      'codex-worker',
      {
        agentId: 'codex-worker',
        model: 'gpt-5.6-codex',
        provider: 'codex',
        tokensIn: 211_000,
        tokensOut: 700,
        tokensUsed: 211_700,
        usageKnown: true,
        contextWindow: 1_000_000,
        contextKnown: true,
        breakdown: CLI_BREAKDOWN,
      },
      sessionId,
    );

    expect(getContextUsage()).toMatchObject({
      used: 0,
      max: 262_144,
      isReliable: false,
      reason: 'usage_unknown',
      provider: 'openai',
    });
    expect(getContextUsage().breakdown).toBeUndefined();
    removeAgent('codex-worker');
  });

  it('clears exact telemetry when manager ownership moves to another session', () => {
    const firstSessionId = sessionState.activeSessionId;
    beginManagerContextPreview(firstSessionId, 'codex', 'gpt-5.6-codex', 1_000_000);
    applyManagerContextPreview(firstSessionId, 'codex', 'gpt-5.6-codex', {
      used: 211_700,
      contextWindow: 1_000_000,
      contextKnown: true,
      usageKnown: true,
      breakdown: CLI_BREAKDOWN,
    });

    const nextSessionId = `${firstSessionId}-next`;
    sessionState.activeSessionId = nextSessionId;
    setManagerSessionId(nextSessionId);

    expect(manager()).toMatchObject({
      sessionId: nextSessionId,
      tokensUsed: 0,
      contextMax: 0,
      contextKnown: false,
      hasUsageData: false,
    });
    expect(manager().contextBreakdown).toBeUndefined();
  });

  it('clamps an impossible cumulative total to the window and marks it estimated', () => {
    const sessionId = sessionState.activeSessionId;
    beginManagerContextPreview(sessionId, 'codex', 'gpt-5.6-codex', 285_000);

    updateUsage(
      'kory-manager',
      {
        agentId: 'kory-manager',
        model: 'gpt-5.6-codex',
        provider: 'codex',
        tokensIn: 860_300,
        tokensOut: 700,
        tokensUsed: 861_000,
        usageKnown: true,
        estimated: true,
        contextWindow: 285_000,
        contextKnown: true,
        breakdown: CLI_BREAKDOWN,
      },
      sessionId,
    );

    // The meter must never render 860.3k / 285.0k.
    expect(manager()).toMatchObject({
      tokensUsed: 285_000,
      contextMax: 285_000,
      usageEstimated: true,
    });
    expect(getContextUsage()).toMatchObject({
      used: 285_000,
      max: 285_000,
      percent: 100,
      isReliable: true,
      estimated: true,
    });
  });

  it('rejects delayed previews and remains provenance-safe across CLI to API to CLI', () => {
    const sessionId = sessionState.activeSessionId;
    beginManagerContextPreview(sessionId, 'codex', 'gpt-5.6-codex', 1_000_000);
    beginManagerContextPreview(sessionId, 'openai', 'minimax-m3', 262_144);

    expect(
      seedManagerUsage(sessionId, {
        used: 211_700,
        max: 1_000_000,
        contextKnown: true,
        provider: 'codex',
        model: 'gpt-5.6-codex',
        cachedInputTokens: 199_200,
        breakdown: CLI_BREAKDOWN,
      }),
    ).toBe(false);
    expect(
      seedManagerUsage(sessionId, {
        used: 211_700,
        max: 1_000_000,
        contextKnown: true,
        breakdown: CLI_BREAKDOWN,
      }),
    ).toBe(false);
    expect(
      seedManagerUsage(`${sessionId}-old`, {
        used: 20_000,
        max: 262_144,
        contextKnown: true,
        provider: 'openai',
        model: 'minimax-m3',
        breakdown: API_BREAKDOWN,
      }),
    ).toBe(false);
    expect(manager()).toMatchObject({
      sessionId,
      identity: { provider: 'openai', model: 'minimax-m3' },
      tokensUsed: 0,
      contextMax: 262_144,
      hasUsageData: false,
    });
    expect(manager().contextBreakdown).toBeUndefined();
    expect(manager().cachedInputTokens).toBeUndefined();

    updateUsage(
      'kory-manager',
      {
        agentId: 'kory-manager',
        model: 'gpt-5.6-codex',
        provider: 'codex',
        tokensIn: 211_000,
        tokensOut: 700,
        tokensUsed: 211_700,
        usageKnown: true,
        cachedInputTokens: 199_200,
        contextWindow: 1_000_000,
        contextKnown: true,
        breakdown: CLI_BREAKDOWN,
      },
      sessionId,
    );
    expect(manager()).toMatchObject({
      identity: { provider: 'openai', model: 'minimax-m3' },
      tokensUsed: 0,
      contextMax: 262_144,
      hasUsageData: false,
    });
    expect(manager().contextBreakdown).toBeUndefined();
    expect(manager().cachedInputTokens).toBeUndefined();

    expect(
      applyManagerContextPreview(sessionId, 'codex', 'gpt-5.6-codex', {
        used: 211_700,
        contextWindow: 1_000_000,
        contextKnown: true,
        usageKnown: true,
        cachedInputTokens: 199_200,
        breakdown: CLI_BREAKDOWN,
      }),
    ).toBe(false);
    expect(manager()).toMatchObject({
      identity: { provider: 'openai', model: 'minimax-m3' },
      tokensUsed: 0,
      contextMax: 262_144,
      hasUsageData: false,
    });

    expect(
      applyManagerContextPreview(sessionId, 'openai', 'minimax-m3', {
        contextWindow: 262_144,
        contextKnown: true,
        usageKnown: false,
      }),
    ).toBe(true);
    expect(manager().contextBreakdown).toBeUndefined();
    expect(manager().cachedInputTokens).toBeUndefined();

    expect(
      applyManagerContextPreview(sessionId, 'openai', 'minimax-m3', {
        used: 20_000,
        contextWindow: 262_144,
        contextKnown: true,
        usageKnown: true,
        breakdown: API_BREAKDOWN,
      }),
    ).toBe(true);
    expect(getContextUsage()).toMatchObject({
      used: 20_000,
      max: 262_144,
      isReliable: true,
      provider: 'openai',
      breakdown: API_BREAKDOWN,
    });
    expect(getContextUsage().cachedInputTokens).toBe(0);

    // A non-authoritative event — the manager emits one at every turn start
    // and before every tool-loop dispatch — must neither be adopted as a total
    // nor destroy the last verified one. The 400k figure mirrors the real
    // chars/4 planning estimate, which runs ~10x above the actual total.
    updateUsage(
      'kory-manager',
      {
        agentId: 'kory-manager',
        model: 'minimax-m3',
        provider: 'openai',
        tokensIn: 400_000,
        tokensOut: 0,
        tokensUsed: 400_000,
        usageKnown: false,
        contextWindow: 262_144,
        contextKnown: true,
        breakdown: API_BREAKDOWN,
        cachedInputTokens: 10_000,
      },
      sessionId,
    );
    expect(manager()).toMatchObject({
      tokensUsed: 20_000,
      contextMax: 262_144,
      contextKnown: true,
      hasUsageData: true,
    });
    expect(getContextUsage()).toMatchObject({ used: 20_000, isReliable: true });
    expect(manager().cachedInputTokens).toBe(0);

    beginManagerContextPreview(sessionId, 'codex', 'gpt-5.6-codex', 1_000_000);
    expect(manager().contextBreakdown).toBeUndefined();
    expect(manager().cachedInputTokens).toBeUndefined();
    expect(
      applyManagerContextPreview(sessionId, 'codex', 'gpt-5.6-codex', {
        used: 211_700,
        contextWindow: 1_000_000,
        contextKnown: true,
        usageKnown: true,
        cachedInputTokens: 199_200,
        breakdown: CLI_BREAKDOWN,
      }),
    ).toBe(true);
    expect(getContextUsage()).toMatchObject({
      used: 211_700,
      max: 1_000_000,
      isReliable: true,
      provider: 'codex',
      cachedInputTokens: 199_200,
      breakdown: CLI_BREAKDOWN,
    });

    expect(
      applyManagerContextPreview(sessionId, 'openai', 'minimax-m3', {
        used: 20_000,
        contextWindow: 262_144,
        contextKnown: true,
        usageKnown: true,
        breakdown: API_BREAKDOWN,
      }),
    ).toBe(false);
    expect(manager().identity).toMatchObject({ provider: 'codex', model: 'gpt-5.6-codex' });
  });
});
