// Idempotent send: every send carries a clientMessageId; a dropped connection
// is retried with the SAME id (the server ledger replays the first result),
// and HTTP answers are never retried.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock('./sessions.svelte', () => ({
  sessionStore: {
    activeSessionId: 'send-1',
    getMessageDisplayBoundary: () => undefined,
    getMessagePageInfo: () => undefined,
    fetchMessages: vi.fn(),
    fetchSessions: vi.fn(async () => undefined),
  },
}));
vi.mock('./auth.svelte', () => ({ authStore: { ensureSession: async () => true, token: 't' } }));
vi.mock('$lib/utils/api-url', () => ({
  apiUrl: (path: string) => path,
  getWsUrl: () => 'ws://x/ws',
}));
vi.mock('$lib/api.svelte', () => ({
  apiFetch: (path: string, init?: RequestInit) => state.apiFetch(path, init),
  parseJsonResponse: async (response: Response) => response.json(),
}));
vi.mock('./providers.svelte', () => ({ providersStore: {}, loadProvidersFromApi: vi.fn() }));
vi.mock('./notes.svelte', () => ({ notesStore: {} }));
vi.mock('./goals.svelte', () => ({ goalStore: {} }));
vi.mock('./checklists.svelte', () => ({ checklistStore: {} }));

import { wsStore } from './websocket.svelte';
import { feedStore } from './feed.svelte';

const ok = (messageId: string) =>
  new Response(
    JSON.stringify({ ok: true, data: { status: 'processing', runId: 'r1', messageId } }),
  );

function postedBodies() {
  return state.apiFetch.mock.calls
    .filter(([path, init]) => path === '/api/messages' && init?.method === 'POST')
    .map(([, init]) => JSON.parse(String(init.body)) as { clientMessageId?: string });
}

describe('idempotent send', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    state.apiFetch.mockReset();
    // Anything other than the queued send responses (client-error reports,
    // session refreshes) gets a harmless ok body.
    state.apiFetch.mockImplementation(async () => new Response(JSON.stringify({ ok: true })));
    feedStore.activateSessionFeed('send-1');
  });
  afterEach(() => vi.useRealTimers());

  it('retries a dropped connection with the same clientMessageId and adopts the server id', async () => {
    state.apiFetch
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(ok('server-msg-1'));
    const sent = wsStore.sendMessage('send-1', 'hello');
    await vi.runAllTimersAsync();
    expect(await sent).toBe(true);
    const bodies = postedBodies();
    expect(bodies).toHaveLength(2);
    expect(bodies[0].clientMessageId).toMatch(/^cm_[0-9a-f]{32}$/);
    expect(bodies[1].clientMessageId).toBe(bodies[0].clientMessageId);
    const users = feedStore.feed.filter((row) => row.type === 'user_message');
    expect(users).toHaveLength(1);
  });

  it('never retries an HTTP answer, and each new send gets a new id', async () => {
    state.apiFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: 'busy' }), { status: 409 }),
    );
    const first = wsStore.sendMessage('send-1', 'one');
    await vi.runAllTimersAsync();
    expect(await first).toBe(false);
    state.apiFetch.mockResolvedValueOnce(ok('server-msg-2'));
    const second = wsStore.sendMessage('send-1', 'two');
    await vi.runAllTimersAsync();
    expect(await second).toBe(true);
    const bodies = postedBodies();
    expect(bodies).toHaveLength(2);
    expect(bodies[1].clientMessageId).not.toBe(bodies[0].clientMessageId);
  });
});
