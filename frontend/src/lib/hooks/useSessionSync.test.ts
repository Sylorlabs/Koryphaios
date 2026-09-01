import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
  activeSessionId: '',
  calls: [] as string[],
}));

const spies = vi.hoisted(() => ({
  activateSessionFeed: vi.fn((sessionId: string) => {
    state.calls.push(`activate:${sessionId}`);
    return 1;
  }),
  subscribeToSession: vi.fn((sessionId: string) => {
    state.calls.push(`subscribe:${sessionId}`);
  }),
  loadSessionMessages: vi.fn(async () => {
    state.calls.push('load');
  }),
  fetchMessages: vi.fn(async (sessionId: string) => {
    state.calls.push(`fetch:${sessionId}`);
    return [];
  }),
  finishSessionLoad: vi.fn(),
  addClientError: vi.fn(),
  loadAgentThreads: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('$lib/stores/websocket.svelte', () => ({
  wsStore: {
    get status() {
      return 'connected';
    },
    activateSessionFeed: spies.activateSessionFeed,
    subscribeToSession: spies.subscribeToSession,
    loadSessionMessages: spies.loadSessionMessages,
    finishSessionLoad: spies.finishSessionLoad,
    addClientError: spies.addClientError,
    loadAgentThreads: spies.loadAgentThreads,
  },
}));

vi.mock('$lib/stores/sessions.svelte', () => ({
  sessionStore: {
    get activeSessionId() {
      return state.activeSessionId;
    },
    fetchMessages: spies.fetchMessages,
  },
}));

vi.mock('$lib/stores/toast.svelte', () => ({
  toastStore: { error: spies.toastError },
}));

import SessionSyncHarness from './__fixtures__/SessionSyncHarness.svelte';

describe('useSessionSync', () => {
  beforeEach(() => {
    state.activeSessionId = 'session-1';
    state.calls.length = 0;
    vi.clearAllMocks();
  });

  afterEach(() => cleanup());

  test('activates the target feed before subscribing to its ordered replay', async () => {
    render(SessionSyncHarness);
    await waitFor(() => expect(state.calls).toContain('load'));

    expect(state.calls.indexOf('activate:session-1')).toBeLessThan(
      state.calls.indexOf('subscribe:session-1'),
    );
    expect(state.calls.indexOf('subscribe:session-1')).toBeLessThan(
      state.calls.indexOf('fetch:session-1'),
    );
    expect(spies.subscribeToSession).toHaveBeenCalledTimes(1);
  });
});
