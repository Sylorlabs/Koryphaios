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
  feedStore: { resolveGlowClass: vi.fn(() => '') },
  getGroupedEntries: vi.fn(() => []),
}));
vi.mock('./run-state.svelte', () => ({
  runStateStore: {
    getAgentStatusForSession: vi.fn(() => 'idle'),
    isRunning: vi.fn(() => false),
    isWaiting: vi.fn(() => false),
  },
}));

import { apiFetch } from '$lib/api.svelte';
import { buildContextSegments } from '$lib/utils/context-segments';

type AgentsModule = typeof import('./agents.svelte');

/** A few turns of a real chat: ~6.1k of context, nearly all of it warm cache. */
const BREAKDOWN = { system: 3_900, memory: 300, skills: 200, tools: 1_100, chat: 500, output: 100 };
const USED = 6_100;

function priorTurn(agents: AgentsModule, sessionId: string) {
  agents.beginManagerContextPreview(sessionId, 'openai', 'gpt-5.5', 400_000);
  agents.updateUsage(sessionId, 'kory-manager', {
    agentId: 'kory-manager',
    model: 'gpt-5.5',
    provider: 'openai',
    tokensIn: 6_000,
    tokensOut: 100,
    tokensUsed: USED,
    usageKnown: true,
    contextWindow: 400_000,
    contextKnown: true,
    cachedInputTokens: 6_000,
    breakdown: BREAKDOWN,
  } as never);
}

async function freshPage(): Promise<AgentsModule> {
  vi.resetModules();
  return import('./agents.svelte');
}

describe('context meter on a model switch', () => {
  beforeEach(() => {
    sessionState.activeSessionId = `carry-${crypto.randomUUID()}`;
    localStorage.clear();
    vi.mocked(apiFetch).mockClear();
  });

  it('re-renders the prior breakdown against the new window immediately, as an estimate', async () => {
    const agents = await freshPage();
    const sessionId = sessionState.activeSessionId;
    priorTurn(agents, sessionId);
    // What the cache-break toast reads before the switch.
    expect(agents.getContextUsage().cachedInputTokens).toBe(6_000);

    agents.beginManagerContextPreview(sessionId, 'openai', 'gpt-5.6-sol', 1_050_000);

    const usage = agents.getContextUsage();
    expect(usage).toMatchObject({
      used: USED,
      max: 1_050_000,
      isReliable: true,
      estimated: true,
      carried: true,
      provider: 'openai',
      breakdown: BREAKDOWN,
    });
    // A new model is a new prompt-cache identity.
    expect(usage.cachedInputTokens).toBeUndefined();
    const segments = buildContextSegments(usage)!;
    expect(segments.map((segment) => segment.key)).toEqual([
      'system',
      'memory',
      'skills',
      'tools',
      'chat',
      'output',
    ]);
    expect(segments.reduce((sum, segment) => sum + segment.tokens, 0)).toBe(USED);
    expect(segments.reduce((sum, segment) => sum + segment.widthPercent, 0)).toBeCloseTo(
      (USED / 1_050_000) * 100,
    );
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('never lets the backend character estimate replace it with a tiny stale number', async () => {
    const agents = await freshPage();
    const sessionId = sessionState.activeSessionId;
    priorTurn(agents, sessionId);
    agents.beginManagerContextPreview(sessionId, 'openai', 'gpt-5.6-sol', 1_050_000);
    const revision = agents.agentStore.managerUsageRevision;

    // The backend fallback: message characters only, no composition.
    expect(
      agents.applyManagerContextPreview(sessionId, 'openai', 'gpt-5.6-sol', {
        provider: 'openai',
        model: 'gpt-5.6-sol',
        used: 16,
        contextWindow: 1_050_000,
        contextKnown: true,
        usageKnown: true,
        estimated: true,
      }),
    ).toBe(true);
    const usage = agents.getContextUsage();
    expect(usage.used).toBe(USED);
    expect(
      buildContextSegments(usage)!.find((segment) => segment.key === 'request'),
    ).toBeUndefined();
    // An estimate is not a measurement: it does not lock out the saved snapshot.
    expect(agents.agentStore.managerUsageRevision).toBe(revision);

    // The selected route's first real report replaces the estimate.
    agents.updateUsage(sessionId, 'kory-manager', {
      agentId: 'kory-manager',
      model: 'gpt-5.6-sol',
      provider: 'openai',
      tokensIn: 6_300,
      tokensOut: 80,
      tokensUsed: 6_380,
      usageKnown: true,
      contextWindow: 1_050_000,
      contextKnown: true,
      breakdown: BREAKDOWN,
    } as never);
    expect(agents.getContextUsage()).toMatchObject({ used: 6_380, estimated: false });
    expect(agents.getContextUsage().carried).toBeUndefined();
  });

  it('fills an empty bar from a saved snapshot of another route instead of waiting', async () => {
    const agents = await freshPage();
    const sessionId = sessionState.activeSessionId;
    agents.beginManagerContextPreview(sessionId, 'openai', 'gpt-5.6-sol', 1_050_000);
    expect(agents.getContextUsage().isReliable).toBe(false);
    expect(
      agents.seedManagerUsage(sessionId, {
        used: USED,
        max: 400_000,
        contextKnown: true,
        provider: 'openai',
        model: 'gpt-5.5',
        breakdown: BREAKDOWN,
      }),
    ).toBe(false);
    expect(agents.getContextUsage()).toMatchObject({
      used: USED,
      max: 1_050_000,
      estimated: true,
      carried: true,
    });
    // An exact snapshot for the selected route still wins afterwards.
    expect(
      agents.seedManagerUsage(sessionId, {
        used: 6_500,
        max: 1_050_000,
        contextKnown: true,
        provider: 'openai',
        model: 'gpt-5.6-sol',
        breakdown: BREAKDOWN,
      }),
    ).toBe(true);
    expect(agents.getContextUsage()).toMatchObject({ used: 6_500, estimated: false });
  });
});

describe('context meter first render', () => {
  beforeEach(() => {
    sessionState.activeSessionId = `first-${crypto.randomUUID()}`;
    localStorage.clear();
    vi.mocked(apiFetch).mockClear();
  });

  it('paints this device’s last reading for a reopened chat with no network', async () => {
    const sessionId = sessionState.activeSessionId;
    priorTurn(await freshPage(), sessionId);

    // A reload: a fresh store, nothing fetched yet, and no network at all.
    const agents = await freshPage();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    agents.beginManagerContextPreview(sessionId, 'openai', 'gpt-5.5', 400_000);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    expect(agents.getContextUsage()).toMatchObject({
      used: USED,
      max: 400_000,
      isReliable: true,
      estimated: true,
      carried: true,
      breakdown: BREAKDOWN,
    });
    expect(apiFetch).not.toHaveBeenCalled();

    // The authoritative saved snapshot replaces the local estimate.
    expect(
      agents.seedManagerUsage(sessionId, {
        used: 6_200,
        max: 400_000,
        contextKnown: true,
        provider: 'openai',
        model: 'gpt-5.5',
        breakdown: BREAKDOWN,
      }),
    ).toBe(true);
    expect(agents.getContextUsage()).toMatchObject({ used: 6_200, estimated: false });
  });

  it('rescales the last reading for a different model selected after reload', async () => {
    const sessionId = sessionState.activeSessionId;
    priorTurn(await freshPage(), sessionId);
    const agents = await freshPage();
    agents.beginManagerContextPreview(sessionId, 'openai', 'gpt-5.6-sol', 1_050_000);
    expect(agents.getContextUsage()).toMatchObject({ used: USED, max: 1_050_000, carried: true });
  });

  it('shows the last reading even before the new window is discovered', async () => {
    const sessionId = sessionState.activeSessionId;
    priorTurn(await freshPage(), sessionId);
    const agents = await freshPage();
    agents.beginManagerContextPreview(sessionId, 'codex', 'gpt-5.6-codex', undefined);
    expect(agents.getContextUsage()).toMatchObject({
      used: USED,
      max: 0,
      reason: 'context_unknown',
      carried: true,
    });
  });

  it('forgets the device snapshot when the chat branch changes or the chat is removed', async () => {
    const sessionId = sessionState.activeSessionId;
    const first = await freshPage();
    priorTurn(first, sessionId);
    first.invalidateManagerContextUsage(sessionId);
    const agents = await freshPage();
    agents.beginManagerContextPreview(sessionId, 'openai', 'gpt-5.5', 400_000);
    expect(agents.getContextUsage()).toMatchObject({ used: 0, isReliable: false });
  });

  it('keeps chats isolated: one chat’s reading never paints another', async () => {
    const sessionId = sessionState.activeSessionId;
    priorTurn(await freshPage(), sessionId);
    const agents = await freshPage();
    const other = `${sessionId}-other`;
    sessionState.activeSessionId = other;
    agents.beginManagerContextPreview(other, 'openai', 'gpt-5.5', 400_000);
    expect(agents.getContextUsage()).toMatchObject({ used: 0, isReliable: false });
  });
});
