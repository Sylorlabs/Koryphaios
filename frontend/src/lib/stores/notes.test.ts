import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock('$lib/api.svelte', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('$lib/utils/api-url', () => ({ apiUrl: (path: string) => path }));
vi.mock('$lib/demo.svelte', () => ({ isDemoMode: false }));

import { notesStore } from './notes.svelte';
import { projectStore } from './project.svelte';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function note(id: string, title: string) {
  return {
    id,
    title,
    content: `${title} body`,
    folderPath: '/',
    tags: [],
    pinned: false,
    includeInContext: false,
    format: 'markdown',
    revision: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    outlinks: [],
    backlinks: [],
    attachments: [],
  };
}

beforeEach(() => {
  notesStore.isPanelOpen = false;
  projectStore.setProject('/notes-project-a');
  notesStore.beginProjectTransition();
  void notesStore.setSearchQuery('');
  void notesStore.selectFolder('/');
  mocks.apiFetch.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  notesStore.isPanelOpen = false;
  projectStore.setProject(null);
  notesStore.beginProjectTransition();
});

describe('Notes request identity guards', () => {
  it('keeps existing notes interactive while a large first index runs in the background', async () => {
    mocks.apiFetch
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          data: [note('existing', 'Existing note')],
          meta: { projectSync: { state: 'running' } },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          data: [note('existing', 'Existing note'), note('new', 'Indexed note')],
          meta: { projectSync: { state: 'complete', discovered: 2 } },
        }),
      );

    expect(await notesStore.fetchNotes()).toBe(true);
    expect(notesStore.notes.map(({ id }) => id)).toEqual(['existing']);
    expect(notesStore.isIndexing).toBe(true);
    expect(notesStore.isLoading).toBe(false);

    expect(await notesStore.fetchNotes()).toBe(true);
    expect(notesStore.notes.map(({ id }) => id)).toEqual(['existing', 'new']);
    expect(notesStore.isIndexing).toBe(false);
  });

  it('keeps a partial project index usable and clears the warning after a complete scan', async () => {
    mocks.apiFetch
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          data: [note('kept', 'Preserved note')],
          meta: {
            projectSync: {
              state: 'partial',
              discovered: 5000,
              error: 'The scan limit was reached; existing entries were preserved.',
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          data: [note('kept', 'Preserved note')],
          meta: { projectSync: { state: 'complete', discovered: 5000 } },
        }),
      );

    expect(await notesStore.fetchNotes()).toBe(true);
    expect(notesStore.notes).toHaveLength(1);
    expect(notesStore.error).toBeNull();
    expect(notesStore.failedOperation).toBeNull();
    expect(notesStore.indexWarning).toContain('scan limit was reached');

    expect(await notesStore.fetchNotes()).toBe(true);
    expect(notesStore.indexWarning).toBeNull();
  });

  it('keeps the complete catalog while folder and full-text search only change the visible view', async () => {
    const alpha = { ...note('alpha', 'Alpha'), content: '', folderPath: '/plans' };
    const beta = { ...note('beta', 'Beta'), content: '', folderPath: '/research' };
    const hydratedBeta = {
      ...beta,
      content: 'A phrase found only inside the complete document body',
    };
    mocks.apiFetch
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: [alpha, beta], meta: {} }))
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, data: [hydratedBeta], meta: { truncated: true, limit: 50 } }),
      );

    expect(await notesStore.fetchNotes('/plans', 'ignored-server-filter')).toBe(true);
    expect(mocks.apiFetch).toHaveBeenNthCalledWith(1, '/api/notes');
    expect(notesStore.catalog.map(({ id }) => id).sort()).toEqual(['alpha', 'beta']);

    await notesStore.setSearchQuery('complete document body');
    expect(mocks.apiFetch).toHaveBeenNthCalledWith(
      2,
      '/api/notes/search?q=complete%20document%20body',
    );
    expect(notesStore.catalog.map(({ id }) => id).sort()).toEqual(['alpha', 'beta']);
    expect(notesStore.visibleNotes.map(({ id }) => id)).toEqual(['beta']);
    expect(notesStore.catalog.find(({ id }) => id === 'beta')?.content).toContain(
      'complete document body',
    );
    expect(notesStore.searchResultsTruncated).toBe(true);
    expect(notesStore.searchResultLimit).toBe(50);

    const callsBeforeFolderChange = mocks.apiFetch.mock.calls.length;
    await notesStore.selectFolder('/research');
    expect(mocks.apiFetch).toHaveBeenCalledTimes(callsBeforeFolderChange);
    expect(notesStore.catalog).toHaveLength(2);
    expect(notesStore.visibleNotes.map(({ id }) => id)).toEqual(['beta']);
  });

  it('does not blank the existing catalog during a background refresh', async () => {
    let resolveRefresh!: (response: Response) => void;
    mocks.apiFetch.mockResolvedValueOnce(
      jsonResponse({ ok: true, data: [note('kept', 'Kept')], meta: {} }),
    );
    expect(await notesStore.fetchNotes()).toBe(true);

    mocks.apiFetch.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const refresh = notesStore.fetchNotes(undefined, undefined, { background: true });
    expect(notesStore.isLoading).toBe(false);
    expect(notesStore.notes.map(({ id }) => id)).toEqual(['kept']);

    resolveRefresh(jsonResponse({ ok: true, data: [note('newer', 'Newer')], meta: {} }));
    expect(await refresh).toBe(true);
    expect(notesStore.notes.map(({ id }) => id)).toEqual(['newer']);
  });

  it('consumes an exactly correlated origin autosave without any realtime refetch', async () => {
    mocks.apiFetch.mockImplementation((url: string) => {
      if (url === '/api/notes') {
        return Promise.resolve(jsonResponse({ ok: true, data: [note('mine', 'Mine')], meta: {} }));
      }
      if (url === '/api/notes/graph') {
        return Promise.resolve(jsonResponse({ ok: true, data: { nodes: [], edges: [] } }));
      }
      if (url === '/api/notes/folders') {
        return Promise.resolve(jsonResponse({ ok: true, data: [] }));
      }
      throw new Error(`Unexpected bootstrap request: ${url}`);
    });
    notesStore.isPanelOpen = true;
    await vi.waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledTimes(3));
    mocks.apiFetch.mockReset();
    vi.useFakeTimers();

    const updated = { ...note('mine', 'Mine'), content: 'saved body', revision: 2 };
    mocks.apiFetch.mockImplementation(
      async (url: string, init?: { headers?: Record<string, string> }) => {
        if (url !== '/api/notes/mine') throw new Error(`Unexpected realtime refetch: ${url}`);
        const headers = init?.headers ?? {};
        expect(headers['x-kory-client-id']).toMatch(/^notes-client-/);
        expect(headers['x-kory-mutation-id']).toMatch(/^notes-mutation-/);
        notesStore.handleRealtimeUpdate({
          action: 'update',
          noteId: 'mine',
          clientId: headers['x-kory-client-id'],
          mutationId: headers['x-kory-mutation-id'],
        });
        return jsonResponse({ ok: true, data: updated });
      },
    );

    expect(
      await notesStore.updateNote('mine', { content: 'saved body', expectedRevision: 1 }),
    ).toEqual(updated);
    await vi.advanceTimersByTimeAsync(500);
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
    expect(notesStore.notes.find(({ id }) => id === 'mine')?.revision).toBe(2);
  });

  it('coalesces remote updates and preserves the open note behind conflict resolution', async () => {
    mocks.apiFetch.mockImplementation((url: string) => {
      if (url === '/api/notes') {
        return Promise.resolve(
          jsonResponse({ ok: true, data: [note('remote', 'Remote')], meta: {} }),
        );
      }
      if (url === '/api/notes/graph') {
        return Promise.resolve(jsonResponse({ ok: true, data: { nodes: [], edges: [] } }));
      }
      if (url === '/api/notes/folders') {
        return Promise.resolve(jsonResponse({ ok: true, data: [] }));
      }
      throw new Error(`Unexpected bootstrap request: ${url}`);
    });
    notesStore.isPanelOpen = true;
    await vi.waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledTimes(3));

    mocks.apiFetch.mockReset();
    mocks.apiFetch.mockResolvedValueOnce(
      jsonResponse({ ok: true, data: note('remote', 'Remote') }),
    );
    expect(await notesStore.fetchNote('remote')).toBe(true);
    expect(notesStore.currentNote?.revision).toBe(1);

    mocks.apiFetch.mockReset();
    const remoteRevision = {
      ...note('remote', 'Remote'),
      content: 'changed elsewhere',
      revision: 2,
    };
    mocks.apiFetch.mockImplementation((url: string) => {
      if (url === '/api/notes/remote') {
        return Promise.resolve(jsonResponse({ ok: true, data: remoteRevision }));
      }
      if (url === '/api/notes/graph') {
        return Promise.resolve(jsonResponse({ ok: true, data: { nodes: [], edges: [] } }));
      }
      throw new Error(`Unexpected coalesced request: ${url}`);
    });
    vi.useFakeTimers();

    notesStore.handleRealtimeUpdate({ action: 'update', noteId: 'remote' });
    notesStore.handleRealtimeUpdate({ action: 'update', noteId: 'remote' });
    notesStore.handleRealtimeUpdate({ action: 'link', noteId: 'remote' });
    await vi.advanceTimersByTimeAsync(200);

    expect(mocks.apiFetch.mock.calls.map(([url]) => url)).toEqual([
      '/api/notes/remote',
      '/api/notes/graph',
    ]);
    expect(notesStore.currentNote?.revision).toBe(1);
    expect(notesStore.conflict).toMatchObject({
      noteId: 'remote',
      remote: { revision: 2, content: 'changed elsewhere' },
    });
    expect(notesStore.catalog.find(({ id }) => id === 'remote')?.revision).toBe(2);
  });

  it('defers remote refreshes while Notes is closed and reconciles once on open', async () => {
    notesStore.handleRealtimeUpdate({ action: 'update', noteId: 'elsewhere' });
    expect(notesStore.hasDeferredRealtimeRefresh).toBe(true);
    expect(mocks.apiFetch).not.toHaveBeenCalled();

    mocks.apiFetch.mockImplementation((url: string) => {
      if (url === '/api/notes') {
        return Promise.resolve(
          jsonResponse({ ok: true, data: [note('elsewhere', 'Elsewhere')], meta: {} }),
        );
      }
      if (url === '/api/notes/graph') {
        return Promise.resolve(jsonResponse({ ok: true, data: { nodes: [], edges: [] } }));
      }
      if (url === '/api/notes/folders') {
        return Promise.resolve(jsonResponse({ ok: true, data: [] }));
      }
      throw new Error(`Unexpected reopen request: ${url}`);
    });
    notesStore.isPanelOpen = true;
    await notesStore.refreshOpenPanel();

    expect(mocks.apiFetch.mock.calls.map(([url]) => url).sort()).toEqual(
      ['/api/notes', '/api/notes/folders', '/api/notes/graph'].sort(),
    );
    expect(notesStore.hasDeferredRealtimeRefresh).toBe(false);
  });

  it('does not let a slow note response replace the newer editor selection', async () => {
    let resolveSlow!: (response: Response) => void;
    const slowResponse = new Promise<Response>((resolve) => {
      resolveSlow = resolve;
    });
    mocks.apiFetch
      .mockImplementationOnce(() => slowResponse)
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: note('new', 'Newest') }));

    const slow = notesStore.fetchNote('old');
    const latest = notesStore.fetchNote('new');
    expect(await latest).toBe(true);
    resolveSlow(jsonResponse({ ok: true, data: note('old', 'Stale') }));
    expect(await slow).toBe(false);

    expect(notesStore.currentNote?.id).toBe('new');
    expect(notesStore.currentNote?.title).toBe('Newest');
  });

  it('invalidates an in-flight list when the project changes', async () => {
    let resolveOldProject!: (response: Response) => void;
    const oldProjectResponse = new Promise<Response>((resolve) => {
      resolveOldProject = resolve;
    });
    mocks.apiFetch
      .mockImplementationOnce(() => oldProjectResponse)
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, data: [note('project-b', 'Project B')], meta: {} }),
      );

    const oldLoad = notesStore.fetchNotes();
    projectStore.setProject('/notes-project-b');
    notesStore.beginProjectTransition();
    expect(await notesStore.fetchNotes()).toBe(true);
    resolveOldProject(jsonResponse({ ok: true, data: [note('project-a', 'Project A')], meta: {} }));
    expect(await oldLoad).toBe(false);

    expect(notesStore.notes.map((entry) => entry.id)).toEqual(['project-b']);
  });

  it('preserves the authoritative deleted-source reason for conflict recovery', async () => {
    mocks.apiFetch.mockResolvedValueOnce(
      jsonResponse({ ok: true, data: note('source-note', 'Source note') }),
    );
    expect(await notesStore.fetchNote('source-note')).toBe(true);

    mocks.apiFetch.mockResolvedValueOnce(
      jsonResponse(
        {
          ok: false,
          code: 'CONFLICT',
          error: 'Source document removed',
          details: { sourceDeleted: true, currentRevision: 1 },
        },
        409,
      ),
    );
    mocks.apiFetch.mockResolvedValueOnce(
      jsonResponse({ ok: true, data: note('source-note', 'Source note') }),
    );

    expect(
      await notesStore.updateNote('source-note', {
        content: 'Local recovery draft',
        expectedRevision: 1,
      }),
    ).toBeNull();
    expect(notesStore.conflict).toMatchObject({
      noteId: 'source-note',
      sourceDeleted: true,
      remote: { revision: 1 },
    });
  });
});

describe('Notes recovery and history', () => {
  it('lists project trash and restores a note with exact mutation correlation', async () => {
    const trashed = {
      ...note('trashed', 'Recover me'),
      format: 'markdown' as const,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      trashedAt: new Date(1000),
      trashReason: 'user' as const,
    };
    const restored = { ...note('trashed', 'Recover me'), revision: 2 };
    mocks.apiFetch
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: [trashed] }))
      .mockImplementationOnce(
        async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
          expect(url).toBe('/api/notes/trashed/restore');
          expect(init?.headers?.['x-kory-client-id']).toMatch(/^notes-client-/);
          expect(init?.headers?.['x-kory-mutation-id']).toMatch(/^notes-mutation-/);
          expect(JSON.parse(init?.body ?? '{}')).toEqual({ expectedRevision: 1 });
          return jsonResponse({ ok: true, data: restored });
        },
      );

    expect(await notesStore.listTrashedNotes()).toEqual([trashed]);
    expect(await notesStore.restoreTrashedNote(trashed)).toEqual(restored);
    expect(notesStore.catalog.find(({ id }) => id === 'trashed')).toMatchObject({ revision: 2 });
  });

  it('loads immutable history and restores a snapshot as a new revision', async () => {
    const summary = {
      noteId: 'history',
      revision: 1,
      operation: 'create' as const,
      title: 'History',
      folderPath: '/',
      tags: [],
      pinned: false,
      includeInContext: false,
      format: 'markdown' as const,
      contentBytes: 8,
      noteCreatedAt: new Date(0),
      noteUpdatedAt: new Date(0),
      createdAt: new Date(0),
    };
    const snapshot = { ...summary, content: 'original' };
    const restored = { ...note('history', 'History'), content: 'original', revision: 3 };
    mocks.apiFetch
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: [summary] }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: snapshot }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: restored }));

    expect(await notesStore.listNoteRevisions('history')).toEqual([summary]);
    expect(await notesStore.getNoteRevision('history', 1)).toEqual(snapshot);
    expect(await notesStore.restoreNoteRevision('history', 1, 2)).toEqual(restored);
    expect(mocks.apiFetch).toHaveBeenNthCalledWith(
      3,
      '/api/notes/history/revisions/1/restore',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ expectedRevision: 2 }),
      }),
    );
  });
});
