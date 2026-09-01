import { describe, expect, it, vi } from 'vitest';

// Reproduction harness for reasoning-trace loss across app relaunch/reload.
// The app relaunch path is: WS connect -> subscribe_session -> server replays
// the ordered event log (including stream.thinking) -> history fetch replaces
// the feed. These tests drive the real feed store through that sequence.

const mocks = { apiFetch: vi.fn() };
vi.mock('$lib/api.svelte', () => ({
  apiFetch: (path: unknown) => mocks.apiFetch(path),
  parseJsonResponse: (res: unknown) => res,
}));
vi.mock('$lib/utils/api-url', () => ({ apiUrl: (path: string) => path }));

const sessionState = { activeId: '' };
vi.mock('$lib/stores/sessions.svelte', () => ({
  sessionStore: {
    get activeSessionId() {
      return sessionState.activeId;
    },
    set activeSessionId(value: string) {
      sessionState.activeId = value;
    },
  },
}));

import { feedStore } from './feed.svelte';
import { isImmediateOrderedErrorDuplicate } from '$lib/utils/run-failure-feed';

function mockAncillaryEmpty(): void {
  mocks.apiFetch.mockImplementation((path: string) => {
    if (path.includes('/timetravel')) {
      return Promise.resolve({ ok: true, data: { timeline: [] } });
    }
    if (path.includes('/context')) {
      return Promise.resolve({ ok: true, lastUsage: null, data: [] });
    }
    return Promise.resolve({ ok: true, data: [] });
  });
}

const REPLAY_META = {
  sessionId: 'sess1',
  eventEpoch: 1,
  sequenceStart: 29,
  sequenceEnd: 37,
  replayed: true,
};

describe('reasoning traces survive relaunch/reload', () => {
  it('keeps replayed reasoning before its persisted answer when database timestamps are coarse', async () => {
    mockAncillaryEmpty();
    const sessionId = 'causal-order';
    sessionState.activeId = sessionId;
    feedStore.activateSessionFeed(sessionId);

    // The ordered event log says reasoning happened before the answer, but a
    // terminal history write can round the assistant timestamp earlier than
    // the replayed event timestamps. The live answer is deduplicated during
    // reload, so it must first transfer its canonical anchor to history.
    feedStore.accumulateFeedEntry({
      timestamp: 5_000,
      type: 'thinking',
      agentId: 'kory-manager',
      agentName: 'Kory',
      glowClass: 'glow-kory',
      text: 'Reasoning summary from the replay.',
      metadata: {
        sessionId,
        eventEpoch: 7,
        sequenceStart: 29,
        sequenceEnd: 37,
        replayed: true,
      },
    });
    feedStore.accumulateFeedEntry({
      timestamp: 5_100,
      type: 'content',
      agentId: 'kory-manager',
      agentName: 'Kory',
      glowClass: 'glow-kory',
      text: 'Final answer text.',
      metadata: {
        sessionId,
        eventEpoch: 7,
        sequenceStart: 38,
        sequenceEnd: 56,
        replayed: true,
      },
    });

    const ok = await feedStore.loadSessionMessages(sessionId, [
      { id: 'm1', role: 'user', content: 'hello', createdAt: 100 },
      // Deliberately earlier than replayed reasoning: this is the production
      // timestamp precision mismatch that previously inverted the turn.
      { id: 'm2', role: 'assistant', content: 'Final answer text.', createdAt: 200 },
    ]);

    expect(ok).toBe(true);
    expect(feedStore.feed.map((entry) => entry.type)).toEqual([
      'user_message',
      'thinking',
      'content',
    ]);
    const persistedAnswer = feedStore.feed.find((entry) => entry.id === 'hist-m2');
    expect(persistedAnswer?.metadata?.eventEpoch).toBe(7);
    expect(persistedAnswer?.metadata?.sequenceStart).toBe(38);
  });

  it('keeps replayed thinking entries when the history refresh lands after the replay burst', async () => {
    mockAncillaryEmpty();
    sessionState.activeId = 'sess1';
    feedStore.activateSessionFeed('sess1');

    // Simulate the server replaying the ordered event log for the session:
    // reasoning first, then the answer text.
    feedStore.accumulateFeedEntry({
      timestamp: 100,
      type: 'thinking',
      agentId: 'kory-manager',
      agentName: 'Kory',
      glowClass: 'glow-kory',
      text: 'Let me think about this problem deeply before answering.',
      metadata: { ...REPLAY_META },
    });
    feedStore.accumulateFeedEntry({
      timestamp: 200,
      type: 'content',
      agentId: 'kory-manager',
      agentName: 'Kory',
      glowClass: 'glow-kory',
      text: 'Final answer text.',
      metadata: {
        sessionId: 'sess1',
        eventEpoch: 1,
        sequenceStart: 38,
        sequenceEnd: 56,
        replayed: true,
      },
    });

    const ok = await feedStore.loadSessionMessages('sess1', [
      { id: 'm1', role: 'user', content: 'hello', createdAt: 50 },
      { id: 'm2', role: 'assistant', content: 'Final answer text.', createdAt: 300 },
    ]);

    expect(ok).toBe(true);
    const thinking = feedStore.feed.filter((e) => e.type === 'thinking');
    expect(thinking).toHaveLength(1);
    expect(thinking[0]?.text).toContain('think about this problem deeply');
  });

  it('keeps thinking entries that arrive after the history refresh committed', async () => {
    mockAncillaryEmpty();
    const sessionId = 'late-replay';
    sessionState.activeId = sessionId;
    feedStore.activateSessionFeed(sessionId);

    const ok = await feedStore.loadSessionMessages(sessionId, [
      { id: 'm1', role: 'user', content: 'hello', createdAt: 50 },
      { id: 'm2', role: 'assistant', content: 'Final answer text.', createdAt: 300 },
    ]);
    expect(ok).toBe(true);

    // Late replay chunk (page refreshed mid-replay).
    feedStore.accumulateFeedEntry({
      timestamp: 100,
      type: 'thinking',
      agentId: 'kory-manager',
      agentName: 'Kory',
      glowClass: 'glow-kory',
      text: 'Late replayed reasoning chunk.',
      metadata: { ...REPLAY_META, sessionId },
    });

    const thinking = feedStore.feed.filter((e) => e.type === 'thinking');
    expect(thinking).toHaveLength(1);
  });

  it('keeps a replayed backend error across repeated message-history refreshes', async () => {
    mockAncillaryEmpty();
    const sessionId = 'error-reload';
    const errorText =
      'The selected model has not reported image-input support; choose an image-capable model.';
    const messages = [
      { id: 'm1', role: 'user', content: 'test', createdAt: 100 },
      { id: 'm2', role: 'assistant', content: 'Earlier answer.', createdAt: 200 },
    ];
    sessionState.activeId = sessionId;
    feedStore.activateSessionFeed(sessionId);

    feedStore.addFeedEntry({
      timestamp: 300,
      type: 'error',
      agentId: '',
      agentName: '',
      glowClass: '',
      text: errorText,
      metadata: {
        sessionId,
        source: 'backend',
        eventEpoch: 1,
        sequenceStart: 48,
        sequenceEnd: 48,
        replayed: true,
      },
    });

    expect(await feedStore.loadSessionMessages(sessionId, messages)).toBe(true);
    // A replayed historical `agent.status: done` used to launch another load;
    // once the first load committed the error ID as base state, that second
    // load silently replaced the error with message-only history.
    expect(await feedStore.loadSessionMessages(sessionId, messages)).toBe(true);

    const errors = feedStore.feed.filter((entry) => entry.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.text).toBe(errorText);
    expect(errors[0]?.metadata?.source).toBe('backend');
    expect(errors[0]?.metadata?.sequenceStart).toBe(48);
  });

  it('does not dedupe a matching error whose timestamp moved backwards', () => {
    const sessionId = 'error-timestamp-order';
    const errorText = 'The provider failed.';
    sessionState.activeId = sessionId;
    feedStore.activateSessionFeed(sessionId);
    feedStore.clearFeed();
    feedStore.addFeedEntry({
      timestamp: 5_000,
      type: 'error',
      agentId: '',
      agentName: '',
      glowClass: '',
      text: errorText,
    });

    expect(feedStore.isDuplicateError(errorText, 4_999)).toBe(false);
    expect(feedStore.isDuplicateError(errorText, 5_000)).toBe(true);
    expect(feedStore.isDuplicateError(errorText, 7_999)).toBe(true);
    expect(feedStore.isDuplicateError(errorText, 8_000)).toBe(false);
  });

  it('keeps a replayed backend error that arrives while ancillary history is loading', async () => {
    const sessionId = 'error-during-ancillary';
    const errorText = 'A durable provider error arrived during context enrichment.';
    let resolveContext!: (value: { ok: boolean; lastUsage: null; data: never[] }) => void;
    const contextResponse = new Promise<{ ok: boolean; lastUsage: null; data: never[] }>(
      (resolve) => {
        resolveContext = resolve;
      },
    );
    mocks.apiFetch.mockImplementation((path: string) => {
      if (path.includes('/timetravel')) {
        return Promise.resolve({ ok: true, data: { timeline: [] } });
      }
      if (path.includes('/context')) return contextResponse;
      return Promise.resolve({ ok: true, data: [] });
    });
    sessionState.activeId = sessionId;
    feedStore.activateSessionFeed(sessionId);

    const loading = feedStore.loadSessionMessages(sessionId, [
      { id: 'm1', role: 'user', content: 'test', createdAt: 100 },
    ]);

    // loadSessionMessages has committed text history and is awaiting the
    // slower context/timeline lane. A long ordered replay can deliver its
    // terminal error during exactly this window.
    feedStore.addFeedEntry({
      timestamp: 200,
      type: 'error',
      agentId: '',
      agentName: '',
      glowClass: '',
      text: errorText,
      metadata: {
        sessionId,
        source: 'backend',
        eventEpoch: 1,
        sequenceStart: 60,
        sequenceEnd: 60,
        replayed: true,
      },
    });
    resolveContext({ ok: true, lastUsage: null, data: [] });

    expect(await loading).toBe(true);
    expect(feedStore.feed.filter((entry) => entry.text === errorText)).toHaveLength(1);
  });

  it('caches a durable background-session error until that session is opened', async () => {
    mockAncillaryEmpty();
    const backgroundSessionId = 'background-error';
    const errorText = 'Background provider failed while this session was not visible.';
    sessionState.activeId = 'foreground-session';
    feedStore.activateSessionFeed('foreground-session');

    feedStore.addFeedEntryForSession(backgroundSessionId, {
      timestamp: 500,
      type: 'error',
      agentId: '',
      agentName: '',
      glowClass: '',
      text: errorText,
      metadata: {
        sessionId: backgroundSessionId,
        source: 'backend',
        eventEpoch: 2,
        sequenceStart: 9,
        sequenceEnd: 9,
      },
    });
    expect(feedStore.feed.some((entry) => entry.text === errorText)).toBe(false);

    sessionState.activeId = backgroundSessionId;
    feedStore.activateSessionFeed(backgroundSessionId);
    expect(feedStore.feed.filter((entry) => entry.text === errorText)).toHaveLength(1);
    expect(
      await feedStore.loadSessionMessages(backgroundSessionId, [
        { id: 'm1', role: 'user', content: 'test', createdAt: 100 },
      ]),
    ).toBe(true);
    expect(feedStore.feed.filter((entry) => entry.text === errorText)).toHaveLength(1);
  });

  it('exposes the cached background tail for adjacent failure-pair dedupe', () => {
    const backgroundSessionId = 'background-paired-error';
    sessionState.activeId = 'foreground-paired-error';
    feedStore.activateSessionFeed('foreground-paired-error');
    feedStore.addFeedEntryForSession(backgroundSessionId, {
      timestamp: 500,
      type: 'error',
      agentId: '',
      agentName: '',
      glowClass: '',
      text: 'No configured provider can run the selected model.',
      metadata: {
        sessionId: backgroundSessionId,
        source: 'backend',
        sourceEvent: 'system.error',
        eventEpoch: 4,
        sequenceStart: 20,
        sequenceEnd: 20,
      },
    });

    const terminalRunState = {
      type: 'run.state',
      sessionId: backgroundSessionId,
      timestamp: 800,
      epoch: 4,
      sequence: 21,
      payload: {},
    } as const;
    expect(
      isImmediateOrderedErrorDuplicate(
        feedStore.lastEntryForSession(backgroundSessionId),
        terminalRunState,
        'provider_unavailable',
      ),
    ).toBe(true);
    expect(feedStore.feed).toHaveLength(0);
  });

  it('drops operational rows from a discarded rewind branch before rebuilding history', async () => {
    mockAncillaryEmpty();
    const sessionId = 'rewritten-session';
    sessionState.activeId = sessionId;
    feedStore.activateSessionFeed(sessionId);
    feedStore.addFeedEntry({
      timestamp: 200,
      type: 'error',
      agentId: '',
      agentName: '',
      glowClass: '',
      text: 'Failure from the branch that will be discarded.',
      metadata: { sessionId, eventEpoch: 1, sequenceStart: 8, sequenceEnd: 8 },
    });

    feedStore.resetSessionFeed(sessionId);
    expect(feedStore.feed).toHaveLength(0);
    expect(
      await feedStore.loadSessionMessages(sessionId, [
        { id: 'kept', role: 'user', content: 'Retained boundary', createdAt: 100 },
      ]),
    ).toBe(true);

    expect(feedStore.feed.map((entry) => entry.text)).toEqual(['Retained boundary']);
  });

  it('invalidates a history load generation from before the timeline rewrite', async () => {
    mockAncillaryEmpty();
    const sessionId = 'rewrite-generation-race';
    sessionState.activeId = sessionId;
    const staleGeneration = feedStore.activateSessionFeed(sessionId);
    const rewriteGeneration = feedStore.resetSessionFeed(sessionId);

    expect(rewriteGeneration).toBeGreaterThan(staleGeneration);
    expect(
      await feedStore.loadSessionMessages(
        sessionId,
        [{ id: 'discarded', role: 'assistant', content: 'Old branch', createdAt: 100 }],
        { generation: staleGeneration },
      ),
    ).toBe(false);
    expect(
      await feedStore.loadSessionMessages(
        sessionId,
        [{ id: 'retained', role: 'user', content: 'New branch', createdAt: 200 }],
        { generation: rewriteGeneration },
      ),
    ).toBe(true);
    expect(feedStore.feed.map((entry) => entry.text)).toEqual(['New branch']);
  });

  it('clears a background session cache when another client rewrites its timeline', () => {
    const sessionId = 'background-rewrite-cache';
    sessionState.activeId = 'foreground-during-rewrite';
    feedStore.activateSessionFeed('foreground-during-rewrite');
    feedStore.addFeedEntryForSession(sessionId, {
      timestamp: 100,
      type: 'error',
      agentId: '',
      agentName: '',
      glowClass: '',
      text: 'Discarded background branch failure',
      metadata: { sessionId, eventEpoch: 1, sequenceStart: 8, sequenceEnd: 8 },
    });

    feedStore.resetSessionFeed(sessionId);
    sessionState.activeId = sessionId;
    feedStore.activateSessionFeed(sessionId);

    expect(feedStore.feed).toEqual([]);
  });

  it('restores an archived failed tool result as failed', async () => {
    const sessionId = 'archived-tool-error';
    mocks.apiFetch.mockImplementation((path: string) => {
      if (path.includes('/timetravel')) {
        return Promise.resolve({ ok: true, data: { timeline: [] } });
      }
      if (path.includes('/context')) {
        return Promise.resolve({
          ok: true,
          lastUsage: null,
          data: [
            {
              id: 'cx_7',
              ts: 200,
              kind: 'terminal',
              label: 'bash failing-command',
              content: 'command failed with exit code 1',
              isError: true,
              prunedForAgent: false,
            },
          ],
        });
      }
      return Promise.resolve({ ok: true, data: [] });
    });
    sessionState.activeId = sessionId;
    feedStore.activateSessionFeed(sessionId);

    expect(
      await feedStore.loadSessionMessages(sessionId, [
        { id: 'm1', role: 'user', content: 'run it', createdAt: 100 },
      ]),
    ).toBe(true);

    const archived = feedStore.feed.find((entry) => entry.id === 'arch-cx_7');
    const toolResult = archived?.metadata?.toolResult as
      { isError?: boolean; output?: string } | undefined;
    expect(archived?.type).toBe('tool_result');
    expect(toolResult?.isError).toBe(true);
    expect(toolResult?.output).toContain('exit code 1');
  });
});
