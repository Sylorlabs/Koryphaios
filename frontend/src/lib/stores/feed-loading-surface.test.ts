import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DisplayMessage } from '$lib/utils/message-variants';

const state = vi.hoisted(() => ({
  activeSessionId: '',
  apiFetch: vi.fn(),
}));

vi.mock('$lib/utils/api-url', () => ({ apiUrl: (path: string) => path }));
vi.mock('$lib/api.svelte', () => ({
  apiFetch: (path: string, init?: RequestInit, timeoutMs?: number) =>
    state.apiFetch(path, init, timeoutMs),
  parseJsonResponse: async (response: Response) => response.json(),
}));
vi.mock('$lib/stores/sessions.svelte', () => ({
  sessionStore: {
    get activeSessionId() {
      return state.activeSessionId;
    },
    getMessageDisplayBoundary: () => undefined,
    getMessagePageInfo: () => undefined,
    fetchMessages: vi.fn(async () => [] as DisplayMessage[]),
    copyMessageDisplayMetadata: vi.fn(),
  },
}));

import { feedStore } from './feed.svelte';

describe('replay bursts', () => {
  it('covers only the replayed chat and ends after a quiet beat', () => {
    vi.useFakeTimers();
    try {
      feedStore.noteReplayBurst('session-a');
      expect(feedStore.isReplayingSession('session-a')).toBe(true);
      expect(feedStore.isReplayingSession('session-b')).toBe(false);
      expect(feedStore.isReplayingSession('')).toBe(false);

      // Continuously arriving events keep the burst alive.
      vi.advanceTimersByTime(179);
      feedStore.noteReplayBurst('session-a');
      vi.advanceTimersByTime(179);
      expect(feedStore.isReplayingSession('session-a')).toBe(true);

      vi.advanceTimersByTime(1);
      expect(feedStore.isReplayingSession('session-a')).toBe(false);

      feedStore.noteReplayBurst('session-a');
      feedStore.endReplayBurst();
      expect(feedStore.isReplayingSession('session-a')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Lane = {
  timeline: ReturnType<typeof deferred<Response>>;
  context: ReturnType<typeof deferred<Response>>;
};

function lane(): Lane {
  return { timeline: deferred<Response>(), context: deferred<Response>() };
}

const MESSAGES: DisplayMessage[] = [
  { id: 'm1', role: 'user', content: 'question', createdAt: 100 },
  { id: 'm2', role: 'assistant', content: 'answer', createdAt: 200 },
];

function archivedTool(id: string) {
  return {
    id,
    ts: 50,
    kind: 'tool',
    label: `Read ${id}`,
    content: 'file contents',
    isError: false,
    prunedForAgent: false,
  };
}

function install(current: () => Lane) {
  state.apiFetch.mockImplementation((path: string) => {
    if (path.includes('/timetravel')) return current().timeline.promise;
    if (path.includes('/context')) return current().context.promise;
    // Feed persistence is on the critical path and must resolve immediately.
    return Promise.resolve(json({ ok: true, data: { entries: [] } }));
  });
}

async function waitForTextPage() {
  await vi.waitFor(() => {
    expect(feedStore.feed.some((entry) => entry.id === 'hist-m2')).toBe(true);
  });
}

describe('chat loading surface', () => {
  beforeEach(() => {
    state.activeSessionId = '';
    state.apiFetch.mockReset();
    feedStore.activateSessionFeed('');
    feedStore.clearFeed(feedStore.sessionId);
  });

  it('reveals the text page without waiting for archived tool rows', async () => {
    const sessionId = 'loading-gate-full';
    state.activeSessionId = sessionId;
    const pending = lane();
    install(() => pending);
    feedStore.activateSessionFeed(sessionId);
    expect(feedStore.isLoadingSession).toBe(true);

    const loading = feedStore.loadSessionMessages(sessionId, MESSAGES);
    await waitForTextPage();

    // Opening a chat is a text read, not an enrichment read. The surface must be
    // gone as soon as the text page is committed; archived tool rows merge
    // afterwards without holding the reader behind a spinner.
    expect(feedStore.isLoadingSession).toBe(false);
    expect(feedStore.feed.some((entry) => entry.id === 'arch-tool-1')).toBe(false);

    pending.timeline.resolve(json({ ok: true, data: { timeline: [] } }));
    pending.context.resolve(
      json({ ok: true, lastUsage: null, data: [archivedTool('tool-1')] }),
    );
    await loading;

    expect(feedStore.isLoadingSession).toBe(false);
    expect(feedStore.feed.some((entry) => entry.id === 'arch-tool-1')).toBe(true);
  });

  it('releases the surface when an enrichment lane fails', async () => {
    const sessionId = 'loading-gate-failed';
    state.activeSessionId = sessionId;
    const pending = lane();
    install(() => pending);
    feedStore.activateSessionFeed(sessionId);

    const loading = feedStore.loadSessionMessages(sessionId, MESSAGES);
    await waitForTextPage();
    pending.timeline.resolve(json({ ok: true, data: { timeline: [] } }));
    pending.context.reject(new Error('context endpoint unavailable'));
    await loading;

    expect(feedStore.isLoadingSession).toBe(false);
  });

  it('does not let a superseded load clear the newer load\'s spinner', async () => {
    const sessionId = 'loading-gate-race';
    state.activeSessionId = sessionId;
    const first = lane();
    const second = lane();
    let current = first;
    install(() => current);
    feedStore.activateSessionFeed(sessionId);

    const older = feedStore.loadSessionMessages(sessionId, MESSAGES);
    await vi.waitFor(() => {
      expect(state.apiFetch.mock.calls.filter(([path]) => path.includes('/timetravel'))).toHaveLength(1);
    });
    current = second;
    const newer = feedStore.loadSessionMessages(sessionId, MESSAGES);
    await vi.waitFor(() => {
      expect(state.apiFetch.mock.calls.filter(([path]) => path.includes('/timetravel'))).toHaveLength(2);
    });

    // The newer load reveals at its own text commit; that is the instant-open
    // contract, not a leak. What must not happen is the superseded load
    // releasing or re-owning the surface afterwards.
    await newer;
    const afterNewer = feedStore.isLoadingSession;

    first.timeline.resolve(json({ ok: true, data: { timeline: [] } }));
    first.context.resolve(json({ ok: true, lastUsage: null, data: [] }));
    await older;

    // A superseded load cannot change the surface the newest load settled.
    expect(feedStore.isLoadingSession).toBe(afterNewer);
    expect(feedStore.feed.some((entry) => entry.id === 'hist-m2')).toBe(true);
  });

  it('bounds the wait when an enrichment lane never answers', async () => {
    vi.useFakeTimers();
    try {
      const sessionId = 'loading-gate-timeout';
      state.activeSessionId = sessionId;
      const pending = lane();
      install(() => pending);
      feedStore.activateSessionFeed(sessionId);

      const loading = feedStore.loadSessionMessages(sessionId, MESSAGES);
      await vi.advanceTimersByTimeAsync(3_100);
      await loading;

      expect(feedStore.isLoadingSession).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
