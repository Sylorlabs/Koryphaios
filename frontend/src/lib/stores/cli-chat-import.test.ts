import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock('$lib/api.svelte', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('$lib/utils/api-url', () => ({ apiUrl: (path: string) => path }));

import { cliChatImportStore } from './cli-chat-import.svelte';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function discovery(chatIds: string[]) {
  return {
    ok: true,
    data: {
      providers: [
        {
          id: 'claude',
          provider: 'claude',
          displayName: 'Claude Code',
          checked: true,
          storageFound: true,
          checkedPaths: ['/home/.claude'],
          chatCount: chatIds.length,
          projectCount: 1,
        },
      ],
      projects: [
        {
          projectPath: '/work/alpha',
          projectName: 'alpha',
          chatCount: chatIds.length,
          providers: [
            { provider: 'claude', displayName: 'Claude Code', chatCount: chatIds.length },
          ],
          latestUpdatedAt: 1,
          chats: chatIds.map((id) => ({
            id,
            externalId: id,
            provider: 'claude',
            providerDisplayName: 'Claude Code',
            projectPath: '/work/alpha',
            projectName: 'alpha',
            title: id,
            preview: id,
            messageCount: 2,
            createdAt: 1,
            updatedAt: 1,
            alreadyImported: false,
            sampleMessages: [],
          })),
        },
      ],
    },
  };
}

/** A discover response the test resolves by hand, to hold a scan in flight. */
function deferredResponse() {
  let resolve!: (res: Response) => void;
  const promise = new Promise<Response>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  mocks.apiFetch.mockReset();
  cliChatImportStore.reset();
});

describe('cliChatImportStore', () => {
  it('dedupes concurrent prefetch calls into one discovery request', async () => {
    const pending = deferredResponse();
    mocks.apiFetch.mockReturnValueOnce(pending.promise);

    const first = cliChatImportStore.prefetch();
    const second = cliChatImportStore.prefetch();
    const third = cliChatImportStore.refresh();
    expect(cliChatImportStore.loading).toBe(true);
    expect(cliChatImportStore.hasLoaded).toBe(false);
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/cli-chat-import/discover');

    pending.resolve(jsonResponse(discovery(['claude:a'])));
    await Promise.all([first, second, third]);

    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
    expect(cliChatImportStore.loading).toBe(false);
    expect(cliChatImportStore.loadedAt).not.toBeNull();
    expect(cliChatImportStore.providers.map((p) => p.provider)).toEqual(['claude']);
    expect(cliChatImportStore.projects[0].chats.map((c) => c.id)).toEqual(['claude:a']);
  });

  it('does not rescan on prefetch once loaded, but refresh() always refetches', async () => {
    mocks.apiFetch
      .mockResolvedValueOnce(jsonResponse(discovery(['claude:a'])))
      .mockResolvedValueOnce(jsonResponse(discovery(['claude:a', 'claude:b'])));

    await cliChatImportStore.prefetch();
    await cliChatImportStore.prefetch();
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);

    await cliChatImportStore.refresh();
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2);
    expect(cliChatImportStore.projects[0].chats.map((c) => c.id)).toEqual(['claude:a', 'claude:b']);
  });

  it('keeps the last good data and reports an error when a rescan fails', async () => {
    mocks.apiFetch
      .mockResolvedValueOnce(jsonResponse(discovery(['claude:a'])))
      .mockResolvedValueOnce(jsonResponse({ ok: false }, 500));

    await cliChatImportStore.prefetch();
    await cliChatImportStore.refresh();

    expect(cliChatImportStore.error).toBe('Discovery failed (500)');
    expect(cliChatImportStore.hasLoaded).toBe(true);
    expect(cliChatImportStore.projects[0].chats).toHaveLength(1);
  });

  it('allows a retry after a failed first discovery', async () => {
    mocks.apiFetch
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(jsonResponse(discovery(['claude:a'])));

    await cliChatImportStore.prefetch();
    expect(cliChatImportStore.error).toBe('offline');
    expect(cliChatImportStore.hasLoaded).toBe(false);

    await cliChatImportStore.prefetch();
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2);
    expect(cliChatImportStore.error).toBeNull();
    expect(cliChatImportStore.hasLoaded).toBe(true);
  });

  it('marks imported chats in the shared cache', async () => {
    mocks.apiFetch
      .mockResolvedValueOnce(jsonResponse(discovery(['claude:a', 'claude:b'])))
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          data: {
            importedCount: 1,
            alreadyImportedCount: 0,
            items: [{ chatId: 'claude:a', sessionId: 'sess-a', status: 'imported' }],
          },
        }),
      );

    await cliChatImportStore.prefetch();
    const result = await cliChatImportStore.importChats(['claude:a', 'claude:a']);

    expect(result.importedCount).toBe(1);
    expect(mocks.apiFetch).toHaveBeenLastCalledWith(
      '/api/cli-chat-import/import',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ chatIds: ['claude:a'] }) }),
    );
    const [a, b] = cliChatImportStore.projects[0].chats;
    expect(a).toMatchObject({ alreadyImported: true, importedSessionId: 'sess-a' });
    expect(b.alreadyImported).toBe(false);
  });
});
