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

import {
  agentStore,
  applyManagerContextPreview,
  beginManagerContextPreview,
  bindManagerSession,
  getContextUsage,
  invalidateManagerContextUsage,
  seedManagerUsage,
  updateUsage,
} from './agents.svelte';
import { notifySessionRemoved } from './session-removal';
import { apiFetch, parseJsonResponse } from '$lib/api.svelte';

const BREAKDOWN = {
  system: 3_000,
  memory: 8_000,
  skills: 1_000,
  tools: 4_000,
  chat: 5_000,
  output: 250,
};

function liveUsage(overrides: Record<string, unknown> = {}) {
  return {
    agentId: 'kory-manager',
    model: 'minimax-m3',
    provider: 'openai',
    tokensIn: 120_000,
    tokensOut: 900,
    tokensUsed: 120_900,
    usageKnown: true,
    contextWindow: 262_144,
    contextKnown: true,
    breakdown: BREAKDOWN,
    ...overrides,
  } as never;
}

function manager() {
  const state = agentStore.getAgent(sessionState.activeSessionId, 'kory-manager');
  if (!state) throw new Error('manager state is unavailable');
  return state;
}

describe('context window denominator stability', () => {
  beforeEach(() => {
    sessionState.activeSessionId = `ctx-stability-${crypto.randomUUID()}`;
  });

  it('treats legacy Antigravity receipts as estimates rather than measured window occupancy', () => {
    const sessionId = sessionState.activeSessionId;
    beginManagerContextPreview(sessionId, 'antigravity', 'minimax-m3', 262_144);
    updateUsage(sessionId, 'kory-manager', liveUsage({ provider: 'antigravity', cachedInputTokens: 100_000 }));
    expect(getContextUsage()).toMatchObject({
      used: 120_900,
      max: 262_144,
      estimated: true,
      cachedInputTokens: 100_000,
    });
  });

  it('a planning estimate that cannot resolve a window never erases a verified one', () => {
    const sessionId = sessionState.activeSessionId;
    beginManagerContextPreview(sessionId, 'openai', 'minimax-m3', 262_144);
    updateUsage(sessionId, 'kory-manager', liveUsage());
    expect(getContextUsage()).toMatchObject({ used: 120_900, max: 262_144, isReliable: true });

    // The manager emits a chars/4 estimate at every turn start and every
    // tool-loop dispatch. While background provider discovery has not landed,
    // that estimate carries contextKnown:false. It previously zeroed the
    // denominator, so the bar flipped to "model window not reported" for the
    // whole turn and then snapped back.
    updateUsage(sessionId, 'kory-manager', liveUsage({
        tokensIn: 400_000,
        tokensOut: 0,
        tokensUsed: 400_000,
        usageKnown: false,
        contextWindow: undefined,
        contextKnown: false,
        breakdown: undefined,
      }));

    expect(manager()).toMatchObject({ contextMax: 262_144, contextKnown: true });
    expect(getContextUsage()).toMatchObject({ used: 120_900, max: 262_144, isReliable: true });
  });

  it('clears occupancy when the active response branch changes but keeps the model window', () => {
    const sessionId = sessionState.activeSessionId;
    beginManagerContextPreview(sessionId, 'openai', 'minimax-m3', 262_144);
    updateUsage(sessionId, 'kory-manager', liveUsage());

    invalidateManagerContextUsage(sessionId);

    expect(manager()).toMatchObject({
      contextMax: 262_144,
      contextKnown: true,
      hasUsageData: false,
      tokensUsed: 0,
    });
    expect(getContextUsage()).toMatchObject({ used: 0, max: 262_144, isReliable: false });
  });

  it('a planning estimate may still establish a window it does know', () => {
    const sessionId = sessionState.activeSessionId;
    beginManagerContextPreview(sessionId, 'openai', 'minimax-m3', undefined);
    expect(manager()).toMatchObject({ contextMax: 0, contextKnown: false });

    // Provider discovery landed between the picker render and the turn.
    updateUsage(sessionId, 'kory-manager', liveUsage({ usageKnown: false, tokensUsed: 0, tokensIn: 0, tokensOut: 0 }));

    expect(manager()).toMatchObject({ contextMax: 262_144, contextKnown: true });
    // Still no occupancy from a non-authoritative event.
    expect(manager().hasUsageData).toBe(false);
  });

  it('an authoritative report with an unknown window does clear the denominator', () => {
    const sessionId = sessionState.activeSessionId;
    beginManagerContextPreview(sessionId, 'openai', 'minimax-m3', 262_144);
    updateUsage(sessionId, 'kory-manager', liveUsage());

    // A real provider report that says "I have no window" is authoritative and
    // must be honored, otherwise the bar would claim a window the provider
    // never reported.
    updateUsage(sessionId, 'kory-manager', liveUsage({ contextWindow: undefined, contextKnown: false }));

    expect(manager()).toMatchObject({ contextMax: 0, contextKnown: false });
    expect(getContextUsage()).toMatchObject({ reason: 'context_unknown', isReliable: false });
  });

  it('keeps the estimate out of occupancy while preserving the last verified total', () => {
    const sessionId = sessionState.activeSessionId;
    beginManagerContextPreview(sessionId, 'openai', 'minimax-m3', 262_144);
    updateUsage(sessionId, 'kory-manager', liveUsage());

    updateUsage(sessionId, 'kory-manager', liveUsage({ usageKnown: false, tokensIn: 400_000, tokensOut: 0, tokensUsed: 400_000 }));

    expect(getContextUsage()).toMatchObject({ used: 120_900, max: 262_144, isReliable: true });
  });

  it('keeps usage and the model window while the same model catalog temporarily has no metadata', () => {
    const sessionId = sessionState.activeSessionId;
    beginManagerContextPreview(sessionId, 'openai', 'minimax-m3', 262_144);
    updateUsage(sessionId, 'kory-manager', liveUsage());

    beginManagerContextPreview(sessionId, 'openai', 'minimax-m3', undefined);
    expect(getContextUsage()).toMatchObject({
      used: 120_900,
      max: 262_144,
      isReliable: true,
      breakdown: BREAKDOWN,
    });
  });

  it.each([undefined, { usageKnown: false, contextKnown: false }])(
    'keeps verified context when a same-route preview returns missing telemetry: %j',
    (preview) => {
      const sessionId = sessionState.activeSessionId;
      beginManagerContextPreview(sessionId, 'openai', 'minimax-m3', 262_144);
      updateUsage(sessionId, 'kory-manager', liveUsage());
      // This is a new preview issued after the live report, rather than a stale
      // request. The absent data itself must not revoke the previous reading.
      beginManagerContextPreview(sessionId, 'openai', 'minimax-m3', undefined);
      expect(applyManagerContextPreview(sessionId, 'openai', 'minimax-m3', preview)).toBe(true);
      expect(getContextUsage()).toMatchObject({
        used: 120_900,
        max: 262_144,
        isReliable: true,
        breakdown: BREAKDOWN,
      });
    },
  );
});

describe('model preview freshness', () => {
  beforeEach(() => {
    sessionState.activeSessionId = `ctx-preview-${crypto.randomUUID()}`;
  });

  it('refuses a preview that resolves after a newer live usage report', () => {
    const sessionId = sessionState.activeSessionId;
    // Composer pins the selection and issues its preview request...
    beginManagerContextPreview(sessionId, 'openai', 'minimax-m3', 262_144);

    // ...a real provider report lands while the request is in flight...
    updateUsage(sessionId, 'kory-manager', liveUsage());
    expect(getContextUsage()).toMatchObject({ used: 120_900 });

    // ...and only then does the preview response arrive. It describes an
    // earlier snapshot of the conversation, so applying it rolled the meter
    // backwards (or blanked it via clearManagerUsage when the boundary had
    // since advanced).
    const applied = applyManagerContextPreview(sessionId, 'openai', 'minimax-m3', {
      used: 20_000,
      contextWindow: 262_144,
      contextKnown: true,
      usageKnown: true,
      breakdown: BREAKDOWN,
    });

    expect(applied).toBe(false);
    expect(getContextUsage()).toMatchObject({ used: 120_900, max: 262_144, isReliable: true });
  });

  it('refuses a stale preview that would blank a verified total', () => {
    const sessionId = sessionState.activeSessionId;
    beginManagerContextPreview(sessionId, 'openai', 'minimax-m3', 262_144);
    updateUsage(sessionId, 'kory-manager', liveUsage());

    // usageKnown:false used to mean "clear everything", which made a delayed
    // HTTP response wipe a perfectly good live reading.
    const applied = applyManagerContextPreview(sessionId, 'openai', 'minimax-m3', {
      contextWindow: 262_144,
      contextKnown: true,
      usageKnown: false,
    });

    expect(applied).toBe(false);
    expect(getContextUsage()).toMatchObject({ used: 120_900, isReliable: true });
  });

  it('still applies a preview when nothing newer has landed', () => {
    const sessionId = sessionState.activeSessionId;
    beginManagerContextPreview(sessionId, 'openai', 'minimax-m3', 262_144);

    expect(
      applyManagerContextPreview(sessionId, 'openai', 'minimax-m3', {
        used: 20_000,
        contextWindow: 262_144,
        contextKnown: true,
        usageKnown: true,
        breakdown: BREAKDOWN,
      }),
    ).toBe(true);
    expect(getContextUsage()).toMatchObject({ used: 20_000, max: 262_144, isReliable: true });
  });

  it('a preview supersedes an earlier preview from the same request', () => {
    const sessionId = sessionState.activeSessionId;
    beginManagerContextPreview(sessionId, 'openai', 'minimax-m3', 262_144);
    expect(
      applyManagerContextPreview(sessionId, 'openai', 'minimax-m3', {
        used: 20_000,
        contextWindow: 262_144,
        contextKnown: true,
        usageKnown: true,
      }),
    ).toBe(true);
    expect(
      applyManagerContextPreview(sessionId, 'openai', 'minimax-m3', {
        used: 30_000,
        contextWindow: 262_144,
        contextKnown: true,
        usageKnown: true,
      }),
    ).toBe(true);
    expect(getContextUsage()).toMatchObject({ used: 30_000 });
  });

  it('a durable seed also supersedes an in-flight preview', () => {
    const sessionId = sessionState.activeSessionId;
    beginManagerContextPreview(sessionId, 'openai', 'minimax-m3', 262_144);

    expect(
      seedManagerUsage(sessionId, {
        used: 90_000,
        max: 262_144,
        contextKnown: true,
        provider: 'openai',
        model: 'minimax-m3',
      }),
    ).toBe(true);

    const applied = applyManagerContextPreview(sessionId, 'openai', 'minimax-m3', {
      used: 20_000,
      contextWindow: 262_144,
      contextKnown: true,
      usageKnown: true,
    });
    expect(applied).toBe(false);
    expect(getContextUsage()).toMatchObject({ used: 90_000, isReliable: true });
  });
});

describe('manager session binding', () => {
  beforeEach(() => {
    sessionState.activeSessionId = `ctx-binding-${crypto.randomUUID()}`;
  });

  it('binds the manager to a session that has never run a turn', () => {
    const sessionId = sessionState.activeSessionId;
    // Reproduces opening a chat whose durable snapshot exists but whose
    // manager binding only ever moved on a kory.thought event. Nothing had
    // run yet, so getContextUsage() could not find the manager at all.
    expect(getContextUsage()).toMatchObject({ reason: 'usage_unknown', isReliable: false });

    bindManagerSession(sessionId);
    expect(manager().sessionId).toBe(sessionId);

    // Now the composer's pinned selection and the live report both land.
    beginManagerContextPreview(sessionId, 'openai', 'minimax-m3', 262_144);
    expect(
      seedManagerUsage(sessionId, {
        used: 75_000,
        max: 262_144,
        contextKnown: true,
        provider: 'openai',
        model: 'minimax-m3',
      }),
    ).toBe(true);
    expect(getContextUsage()).toMatchObject({ used: 75_000, max: 262_144, isReliable: true });
  });

  it('does not discard a selection that already names the bound session', () => {
    const first = sessionState.activeSessionId;
    beginManagerContextPreview(first, 'openai', 'minimax-m3', 262_144);
    updateUsage(first, 'kory-manager', liveUsage());
    expect(getContextUsage()).toMatchObject({ used: 120_900 });

    // The feed activation and the composer's preview effect race on a session
    // switch. Clearing the selection after the composer pinned it left every
    // later stream.usage failing the provenance guard until the user touched
    // the model picker.
    bindManagerSession(first);
    updateUsage(first, 'kory-manager', liveUsage({ tokensIn: 130_000, tokensOut: 900, tokensUsed: 130_900 }));

    expect(getContextUsage()).toMatchObject({ used: 130_900, isReliable: true });
  });

  it('clears a selection that names a different session', () => {
    const first = sessionState.activeSessionId;
    beginManagerContextPreview(first, 'openai', 'minimax-m3', 262_144);
    updateUsage(first, 'kory-manager', liveUsage());

    const second = `${first}-next`;
    sessionState.activeSessionId = second;
    bindManagerSession(second);

    expect(manager()).toMatchObject({
      sessionId: second,
      hasUsageData: false,
      contextMax: 0,
      contextKnown: false,
    });
    // A late event for the previous session must not repopulate it.
    updateUsage(first, 'kory-manager', liveUsage());
    expect(getContextUsage()).toMatchObject({ isReliable: false });
  });

  it.each(['feed-first', 'composer-first'])(
    'restores the target chat context immediately when returning to it (%s)',
    (order) => {
      const first = sessionState.activeSessionId;
      beginManagerContextPreview(first, 'openai', 'minimax-m3', 262_144);
      updateUsage(first, 'kory-manager', liveUsage());
      const second = `${first}-other`;
      sessionState.activeSessionId = second;
      bindManagerSession(second);
      beginManagerContextPreview(second, 'anthropic', 'claude-sonnet-4-6', 200_000);
      seedManagerUsage(second, {
        used: 30_000,
        max: 200_000,
        contextKnown: true,
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
      });

      sessionState.activeSessionId = first;
      if (order === 'feed-first') bindManagerSession(first);
      beginManagerContextPreview(first, 'openai', 'minimax-m3', undefined);
      bindManagerSession(first);
      expect(getContextUsage()).toMatchObject({
        used: 120_900,
        max: 262_144,
        isReliable: true,
        provider: 'openai',
        breakdown: BREAKDOWN,
      });
    },
  );

  it('does not restore cached occupancy from a discarded background branch', () => {
    const first = sessionState.activeSessionId;
    beginManagerContextPreview(first, 'openai', 'minimax-m3', 262_144);
    updateUsage(first, 'kory-manager', liveUsage());
    sessionState.activeSessionId = `${first}-other`;
    bindManagerSession(sessionState.activeSessionId);
    invalidateManagerContextUsage(first);

    sessionState.activeSessionId = first;
    bindManagerSession(first);
    expect(getContextUsage()).toMatchObject({ used: 0, max: 262_144, isReliable: false });
  });

  it('forgets cached context when its chat is removed', () => {
    const sessionId = sessionState.activeSessionId;
    beginManagerContextPreview(sessionId, 'openai', 'minimax-m3', 262_144);
    updateUsage(sessionId, 'kory-manager', liveUsage());
    notifySessionRemoved(sessionId);
    bindManagerSession(`${sessionId}-other`);
    bindManagerSession(sessionId);
    expect(getContextUsage()).toMatchObject({ used: 0, max: 0, isReliable: false });
  });

  it('restores an Antigravity receipt that replayed before the composer pinned its selection', () => {
    const sessionId = sessionState.activeSessionId;
    agentStore.clearManagerContextPreview(sessionId);
    updateUsage(sessionId, 'kory-manager', liveUsage({ provider: 'antigravity', estimated: true }));
    // Pending telemetry is not displayed before its route has been checked.
    expect(getContextUsage()).toMatchObject({ used: 0, isReliable: false });
    beginManagerContextPreview(sessionId, 'antigravity', 'minimax-m3', 262_144);
    expect(getContextUsage()).toMatchObject({ used: 120_900, max: 262_144, estimated: true });
  });

  it('does not adopt pending replay for a different selected route or a discarded branch', () => {
    const sessionId = sessionState.activeSessionId;
    agentStore.clearManagerContextPreview(sessionId);
    updateUsage(sessionId, 'kory-manager', liveUsage({ provider: 'antigravity' }));
    beginManagerContextPreview(sessionId, 'openai', 'minimax-m3', 262_144);
    expect(getContextUsage()).toMatchObject({ used: 0, isReliable: false });

    agentStore.clearManagerContextPreview(sessionId);
    updateUsage(sessionId, 'kory-manager', liveUsage({ provider: 'antigravity' }));
    invalidateManagerContextUsage(sessionId);
    beginManagerContextPreview(sessionId, 'antigravity', 'minimax-m3', 262_144);
    expect(getContextUsage()).toMatchObject({ used: 0, isReliable: false });
  });

  it('saved agent threads cannot replace the selected manager route or its context composition', async () => {
    const sessionId = sessionState.activeSessionId;
    beginManagerContextPreview(sessionId, 'antigravity', 'minimax-m3', 262_144);
    updateUsage(sessionId, 'kory-manager', liveUsage({ provider: 'antigravity', cachedInputTokens: 100_000 }));
    vi.mocked(apiFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseJsonResponse).mockResolvedValue({ ok: true, data: [{
      agent: { ...manager().identity, provider: 'google', model: 'old-model' }, status: 'idle',
    }] });
    await agentStore.loadAgentThreads(sessionId);
    expect(manager().identity).toMatchObject({ provider: 'antigravity', model: 'minimax-m3' });
    // A catalog refresh requests the same selection again. It must not look
    // like a model switch just because an old thread identity loaded.
    beginManagerContextPreview(sessionId, 'antigravity', 'minimax-m3', 262_144);
    expect(getContextUsage()).toMatchObject({
      used: 120_900, max: 262_144, breakdown: BREAKDOWN, cachedInputTokens: 100_000,
    });
  });
});
