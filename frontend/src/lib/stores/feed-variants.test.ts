import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DisplayMessage, MessageDisplayBoundary } from '$lib/utils/message-variants';

const state = vi.hoisted(() => ({
  activeSessionId: '',
  boundary: undefined as MessageDisplayBoundary | undefined,
  apiFetch: vi.fn(),
  fetchMessages: vi.fn(),
}));

vi.mock('$lib/utils/api-url', () => ({ apiUrl: (path: string) => path }));
vi.mock('$lib/api.svelte', () => ({
  apiFetch: (path: string, init?: RequestInit) => state.apiFetch(path, init),
  parseJsonResponse: async (response: Response) => response.json(),
}));
vi.mock('$lib/stores/sessions.svelte', () => ({
  sessionStore: {
    get activeSessionId() {
      return state.activeSessionId;
    },
    getMessageDisplayBoundary: () => state.boundary,
    fetchMessages: (...args: unknown[]) => state.fetchMessages(...args),
  },
}));

import { feedStore } from './feed.svelte';

function message(
  id: string,
  role: 'user' | 'assistant',
  content: string,
  options: Partial<DisplayMessage> = {},
): DisplayMessage {
  return { id, role, content, createdAt: 100, ...options };
}

function ancillaryResponse(path: string): Response {
  if (path.includes('/timetravel')) {
    return new Response(JSON.stringify({ ok: true, data: { timeline: [] } }));
  }
  return new Response(JSON.stringify({ ok: true, lastUsage: null, data: [] }));
}

describe('feed response variant truth', () => {
  beforeEach(() => {
    state.activeSessionId = '';
    state.boundary = undefined;
    state.apiFetch.mockReset();
    state.fetchMessages.mockReset();
    state.apiFetch.mockImplementation((path: string) => Promise.resolve(ancillaryResponse(path)));
    feedStore.activateSessionFeed('');
    feedStore.clearFeed();
  });

  it('renders the authoritative active sibling and preserves every action identity', async () => {
    const sessionId = 'active-middle-variant';
    state.activeSessionId = sessionId;
    state.boundary = {
      activeMessageId: 'later-follow-up',
      conversationRevision: 9,
      providerConversationRevision: 4,
      authoritative: true,
    };
    feedStore.activateSessionFeed(sessionId);

    await feedStore.loadSessionMessages(sessionId, [
      message('prompt', 'user', 'question'),
      message('v0', 'assistant', 'zero', {
        provider: 'openai',
        model: 'gpt-zero',
        variantGroupId: 'group-1',
        variantIndex: 0,
      }),
      message('v2', 'assistant', 'two', {
        provider: 'google',
        model: 'gemini-two',
        variantGroupId: 'group-1',
        variantIndex: 2,
      }),
      message('v1', 'assistant', 'one', {
        provider: 'anthropic',
        model: 'claude-one',
        variantGroupId: 'group-1',
        variantIndex: 1,
        isActive: true,
      }),
    ]);

    const response = feedStore.feed.find((entry) => entry.type === 'content');
    expect(response).toMatchObject({
      id: 'hist-v1',
      text: 'one',
      metadata: {
        messageId: 'v1',
        model: 'claude-one',
        provider: 'anthropic',
        activeVariantId: 'v1',
        activeMessageId: 'later-follow-up',
        conversationRevision: 9,
        providerConversationRevision: 4,
        variantIdentityAuthoritative: true,
      },
    });
    expect(
      (response?.metadata?.responseVariants as Array<{ id: string; provider?: string }>).map(
        (variant) => [variant.id, variant.provider],
      ),
    ).toEqual([
      ['v0', 'openai'],
      ['v1', 'anthropic'],
      ['v2', 'google'],
    ]);
  });

  it('shows a stable legacy fallback without claiming it is the active branch', async () => {
    const sessionId = 'legacy-variants';
    state.activeSessionId = sessionId;
    feedStore.activateSessionFeed(sessionId);

    await feedStore.loadSessionMessages(sessionId, [
      message('prompt', 'user', 'question'),
      message('v2', 'assistant', 'two', {
        variantGroupId: 'group-1',
        variantIndex: 2,
      }),
      message('v0', 'assistant', 'zero', {
        variantGroupId: 'group-1',
        variantIndex: 0,
      }),
    ]);

    const response = feedStore.feed.find((entry) => entry.type === 'content');
    expect(response?.id).toBe('hist-v0');
    expect(response?.metadata?.variantIdentityAuthoritative).toBe(false);
    expect(response?.metadata?.activeVariantId).toBeNull();
  });

  it('keeps a persisted row visible after a failed delete request', async () => {
    const sessionId = 'failed-delete';
    state.activeSessionId = sessionId;
    feedStore.activateSessionFeed(sessionId);
    await feedStore.loadSessionMessages(sessionId, [message('m1', 'assistant', 'must remain')]);
    const entry = feedStore.feed.find((item) => item.id === 'hist-m1')!;
    state.apiFetch.mockImplementation((path: string) => {
      if (path.includes('/api/messages/')) {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: false, error: 'run is active' }), { status: 409 }),
        );
      }
      return Promise.resolve(ancillaryResponse(path));
    });

    await expect(feedStore.deleteEntry(entry, 'm1')).rejects.toThrow('run is active');
    expect(feedStore.feed.some((item) => item.id === 'hist-m1')).toBe(true);
    expect(state.fetchMessages).not.toHaveBeenCalled();
  });

  it('reloads authoritative history exactly once after durable deletion succeeds', async () => {
    const sessionId = 'successful-delete';
    state.activeSessionId = sessionId;
    feedStore.activateSessionFeed(sessionId);
    await feedStore.loadSessionMessages(sessionId, [
      message('prompt', 'user', 'question'),
      message('m1', 'assistant', 'remove me'),
    ]);
    const entry = feedStore.feed.find((item) => item.id === 'hist-m1')!;
    entry.metadata = {
      ...entry.metadata,
      eventEpoch: 9,
      sequenceStart: 41,
      sequenceEnd: 44,
    };
    state.apiFetch.mockImplementation((path: string) => {
      if (path.includes('/api/messages/')) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true })));
      }
      return Promise.resolve(ancillaryResponse(path));
    });
    state.fetchMessages.mockResolvedValue([message('prompt', 'user', 'question')]);

    await expect(feedStore.deleteEntry(entry, 'm1')).resolves.toBe(true);
    expect(state.fetchMessages).toHaveBeenCalledTimes(1);
    expect(feedStore.feed.some((item) => item.id === 'hist-m1')).toBe(false);
    const visibilityCall = state.apiFetch.mock.calls.find(([path]) =>
      String(path).includes('/feed/visibility'),
    ) as [string, RequestInit] | undefined;
    expect(visibilityCall).toBeDefined();
    expect(JSON.parse(String(visibilityCall?.[1].body))).toEqual({
      targets: expect.arrayContaining(['message:m1', 'event:9:41:44']),
      visibility: 'deleted',
    });
  });

  it('rehydrates explicit client errors while keeping a deleted ordered row out after reload', async () => {
    const sessionId = 'durable-feed-replay';
    state.activeSessionId = sessionId;
    state.apiFetch.mockImplementation((path: string) => {
      if (path === `/api/sessions/${sessionId}/feed`) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              data: {
                entries: [
                  {
                    id: 'client-error-replayed',
                    kind: 'client_error',
                    text: 'The browser could not restore a previous panel.',
                    timestamp: 150,
                  },
                ],
                tombstones: [{ targetKey: 'event:7:12:12', visibility: 'deleted' }],
              },
            }),
          ),
        );
      }
      return Promise.resolve(ancillaryResponse(path));
    });
    feedStore.activateSessionFeed(sessionId);
    feedStore.addFeedEntry({
      timestamp: 125,
      type: 'system',
      agentId: 'kory-manager',
      agentName: 'Kory',
      glowClass: '',
      text: 'Deleted operational row',
      metadata: { sessionId, eventEpoch: 7, sequenceStart: 12, sequenceEnd: 12 },
    });

    await feedStore.loadSessionMessages(sessionId, [message('m1', 'user', 'hello')]);

    expect(feedStore.feed.map((item) => item.id)).toEqual(
      expect.arrayContaining(['hist-m1', 'client-client-error-replayed']),
    );
    expect(feedStore.feed.some((item) => item.text === 'Deleted operational row')).toBe(false);
    expect(feedStore.feed.find((item) => item.id === 'client-client-error-replayed')?.text).toBe(
      'The browser could not restore a previous panel.',
    );
  });

  it('binds an accepted optimistic message to the server identity before durable feed actions run', async () => {
    const sessionId = 'optimistic-message-identity';
    state.activeSessionId = sessionId;
    feedStore.activateSessionFeed(sessionId);
    const optimisticId = feedStore.addUserMessage(sessionId, 'still saving');
    expect(optimisticId).toBeTruthy();
    feedStore.bindMessageIdentity(sessionId, optimisticId!, 'server-message-1');
    const optimistic = feedStore.feed.find((item) => item.id === optimisticId)!;
    expect(optimistic.metadata?.messageId).toBe('server-message-1');

    state.apiFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    await expect(feedStore.setUserEntryVisibility(optimistic, true)).resolves.toBe(true);
    const [, request] = state.apiFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(request.body))).toEqual({
      targets: ['message:server-message-1'],
      visibility: 'hidden',
    });
  });
});
