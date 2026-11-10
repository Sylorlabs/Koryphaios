import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/svelte';
import type { WSMessage } from '@koryphaios/shared';

// Invariant 4: no chat's events, agent state or reasoning clocks may leak into
// another chat, and a session-scoped event without its identity changes nothing.

const state = vi.hoisted(() => ({ activeSessionId: '' }));
const run = vi.hoisted(() => ({ applyEvent: vi.fn(() => true) }));

vi.mock('./sessions.svelte', () => ({
  sessionStore: {
    get activeSessionId() {
      return state.activeSessionId;
    },
    getMessageDisplayBoundary: () => undefined,
  },
}));
vi.mock('./auth.svelte', () => ({
  authStore: { ensureSession: async () => true, token: 'test-token' },
}));
vi.mock('$lib/utils/api-url', () => ({
  apiUrl: (path: string) => path,
  getWsUrl: () => 'ws://localhost/ws',
}));
vi.mock('$lib/api.svelte', () => ({ apiFetch: vi.fn(), parseJsonResponse: vi.fn() }));
vi.mock('./run-state.svelte', () => ({
  runStateStore: {
    applyEvent: run.applyEvent,
    getAgentStatusForSession: () => 'idle',
    isRunning: () => false,
    isWaiting: () => false,
    isBusy: () => false,
    states: new Map(),
  },
}));
vi.mock('./providers.svelte', () => ({ providersStore: {}, loadProvidersFromApi: vi.fn() }));
vi.mock('./notes.svelte', () => ({ notesStore: {} }));
vi.mock('./goals.svelte', () => ({ goalStore: {} }));
vi.mock('./checklists.svelte', () => ({ checklistStore: {} }));

import { wsStore } from './websocket.svelte';
import { feedStore } from './feed.svelte';
import { agentStore } from './agents.svelte';

const A = 'iso-session-a';
const B = 'iso-session-b';
const MANAGER = 'kory-manager';

class TestWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 0;
  onmessage: ((event: MessageEvent) => void) | null = null;
  close = vi.fn();
  send = vi.fn();
}

/** Deliver one realtime event. A missing sessionId is serialised as absent. */
function receive(
  type: WSMessage['type'],
  payload: unknown,
  sequence: number,
  sessionId: string | undefined,
) {
  wsStore.connection!.onmessage!(
    new MessageEvent('message', {
      data: JSON.stringify({
        type,
        payload,
        ...(sessionId ? { sessionId } : {}),
        timestamp: sequence * 100,
        epoch: 1,
        sequence,
      }),
    }),
  );
}

function feedTexts(): string[] {
  return feedStore.feed.map((entry) => entry.text);
}

describe('session identity is required, never defaulted', () => {
  beforeEach(async () => {
    run.applyEvent.mockClear();
    state.activeSessionId = A;
    feedStore.activateSessionFeed(A);
    vi.stubGlobal('WebSocket', TestWebSocket);
    wsStore.connect();
    await waitFor(() => expect(wsStore.connection).toBeTruthy());
  });

  afterEach(() => {
    wsStore.disconnect();
    vi.unstubAllGlobals();
  });

  it('a stream.delta with no sessionId changes no feed, agent or run state', () => {
    const before = feedStore.feed.length;

    receive('stream.delta', { agentId: MANAGER, content: 'orphan text' }, 1, undefined);
    receive('stream.thinking', { agentId: MANAGER, thinking: 'orphan thought' }, 2, undefined);
    receive('agent.status', { agentId: MANAGER, status: 'streaming' }, 3, undefined);

    expect(run.applyEvent).not.toHaveBeenCalled();
    expect(feedStore.feed).toHaveLength(before);
    expect(feedTexts()).not.toContain('orphan text');
    expect(agentStore.getAgent(A, MANAGER)?.content ?? '').toBe('');
    expect(agentStore.getAgent(A, MANAGER)?.thinking ?? '').toBe('');
    expect(agentStore.getAgent(A, MANAGER)?.status ?? 'idle').toBe('idle');
    expect(agentStore.agents.size).toBe(0);
  });

  it('two sessions streaming kory-manager keep separate agent state and rows', () => {
    receive('stream.delta', { agentId: MANAGER, content: 'alpha reply' }, 1, A);
    receive('stream.thinking', { agentId: MANAGER, thinking: 'alpha thinking' }, 2, A);
    receive('stream.delta', { agentId: MANAGER, content: 'beta reply' }, 1, B);
    receive('stream.thinking', { agentId: MANAGER, thinking: 'beta thinking' }, 2, B);

    expect(agentStore.getAgent(A, MANAGER)).toMatchObject({
      sessionId: A,
      content: 'alpha reply',
      thinking: 'alpha thinking',
    });
    expect(agentStore.getAgent(B, MANAGER)).toMatchObject({
      sessionId: B,
      content: 'beta reply',
      thinking: 'beta thinking',
    });

    // Background traffic for B never alters the visible chat's rows.
    expect(feedTexts()).toContain('alpha reply');
    expect(feedTexts()).not.toContain('beta reply');

    // B's streamed rows are kept in B's own thread lane, which is what its
    // agent drilldown shows. The visible transcript of A never receives them.
    const bThread = agentStore.getAgentThreadEntries(B, MANAGER).map((row) => row.text);
    expect(bThread).toContain('beta reply');
    expect(bThread).not.toContain('alpha reply');
    expect(agentStore.getAgentThreadEntries(A, MANAGER).map((row) => row.text)).not.toContain(
      'beta reply',
    );

    // Displaying B shows B's record, and A's content is not visible in it.
    feedStore.activateSessionFeed(B);
    state.activeSessionId = B;
    expect(feedTexts()).not.toContain('alpha reply');
    expect(agentStore.getAgent(B, MANAGER)?.content).toBe('beta reply');
  });

  it('thinking start times for the same agentId in two sessions are independent', () => {
    expect(feedStore.beginThinking(A, MANAGER, 1_000)).toBe(1_000);
    expect(feedStore.beginThinking(B, MANAGER, 5_000)).toBe(5_000);

    expect(feedStore.getThinkingStart(A, MANAGER, 9_999)).toBe(1_000);
    expect(feedStore.getThinkingStart(B, MANAGER, 9_999)).toBe(5_000);
  });

  it('a duplicate event is ignored identically for the displayed and a background session', () => {
    const row = (sessionId: string) => ({
      timestamp: 700,
      type: 'system' as const,
      agentId: 'system',
      agentName: '',
      glowClass: '',
      text: 'session notice',
      metadata: { sessionId, eventEpoch: 1, sequenceStart: 7, sequenceEnd: 7 },
    });

    // Displayed session: the replay is dropped.
    feedStore.addFeedEntryForSession(A, row(A));
    feedStore.addFeedEntryForSession(A, row(A));
    expect(feedTexts().filter((t) => t === 'session notice')).toHaveLength(1);

    // Background session: the same replay is dropped in its cached lane too.
    feedStore.addFeedEntryForSession(B, row(B));
    feedStore.addFeedEntryForSession(B, row(B));
    feedStore.activateSessionFeed(B);
    state.activeSessionId = B;
    expect(feedTexts().filter((t) => t === 'session notice')).toHaveLength(1);
  });
});
