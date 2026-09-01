import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  unsubscribeFromSession: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$lib/api.svelte', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('$lib/utils/api-url', () => ({ apiUrl: (path: string) => path }));
vi.mock('./toast.svelte', () => ({
  toastStore: {
    success: mocks.success,
    error: mocks.error,
  },
}));
vi.mock('./websocket.svelte', () => ({
  wsStore: { unsubscribeFromSession: mocks.unsubscribeFromSession },
}));
vi.mock('./project.svelte', () => ({
  projectStore: {
    workspaceRoot: null,
    currentPath: '/tmp/project',
    scope: 'project',
    setScope: vi.fn(),
  },
}));

import { sessionStore, type LifecycleSession } from './sessions.svelte';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function session(id: string, overrides: Partial<LifecycleSession> = {}): LifecycleSession {
  return {
    id,
    title: `Chat ${id}`,
    workingDirectory: '/tmp/project',
    messageCount: 2,
    totalTokensIn: 10,
    totalTokensOut: 20,
    totalCost: 0.01,
    version: 1,
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStore.seedDemoSessions([session('one'), session('two')], 'one');
});

describe('session archive lifecycle', () => {
  it('archives cleanly, rejects stale websocket resurrection, and exposes immediate Undo', async () => {
    const archived = session('one', {
      status: 'archived',
      archivedAt: 3_000,
      updatedAt: 2_000,
      version: 2,
    });
    mocks.apiFetch.mockResolvedValueOnce(response({ ok: true, data: archived }));

    await expect(sessionStore.archiveSession('one')).resolves.toBe(true);

    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/sessions/one/archive', { method: 'POST' });
    expect(sessionStore.sessions.map((item) => item.id)).toEqual(['two']);
    expect(sessionStore.archivedSessions.map((item) => item.id)).toEqual(['one']);
    expect(sessionStore.activeSessionId).toBe('two');
    expect(mocks.unsubscribeFromSession).toHaveBeenCalledWith('one');

    sessionStore.handleSessionUpdate(session('one', { title: 'Stale title', version: 1 }));
    expect(sessionStore.sessions.map((item) => item.id)).toEqual(['two']);
    expect(sessionStore.archivedSessions[0]?.title).toBe('Chat one');

    const archiveToastOptions = mocks.success.mock.calls.find(
      ([message]) => message === 'Chat archived',
    )?.[1] as { action?: () => void; actionLabel?: string } | undefined;
    expect(archiveToastOptions?.actionLabel).toBe('Undo');

    const restored = session('one', {
      status: 'active',
      updatedAt: 4_000,
      version: 3,
    });
    mocks.apiFetch.mockResolvedValueOnce(response({ ok: true, data: restored }));
    archiveToastOptions?.action?.();
    await vi.waitFor(() =>
      expect(sessionStore.sessions.some((item) => item.id === 'one')).toBe(true),
    );

    expect(mocks.apiFetch).toHaveBeenLastCalledWith('/api/sessions/one/restore', {
      method: 'POST',
    });
    expect(sessionStore.archivedSessions).toHaveLength(0);

    sessionStore.handleSessionUpdate(archived);
    expect(sessionStore.sessions.some((item) => item.id === 'one')).toBe(true);
    expect(sessionStore.archivedSessions).toHaveLength(0);
  });

  it('loads archived chats, renames them in place, and permanently removes them', async () => {
    const archived = session('old', {
      title: 'Old name',
      status: 'archived',
      archivedAt: 5_000,
      version: 2,
    });
    mocks.apiFetch.mockResolvedValueOnce(response({ ok: true, data: [archived] }));

    await expect(sessionStore.fetchArchivedSessions()).resolves.toBe(true);
    expect(sessionStore.archivedSessions.map((item) => item.title)).toEqual(['Old name']);

    const renamed = { ...archived, title: 'New name', version: 3 };
    mocks.apiFetch.mockResolvedValueOnce(response({ ok: true, data: renamed }));
    await expect(sessionStore.renameSession('old', 'New name')).resolves.toBe(true);
    expect(sessionStore.archivedSessions[0]?.title).toBe('New name');

    mocks.apiFetch.mockResolvedValueOnce(response({ ok: true }));
    await expect(sessionStore.deleteSession('old')).resolves.toBe(true);
    expect(sessionStore.archivedSessions).toHaveLength(0);
    expect(mocks.apiFetch.mock.calls.map(([url]) => url)).toEqual([
      '/api/sessions/archived',
      '/api/sessions/old',
      '/api/sessions/old',
    ]);
    expect(mocks.apiFetch.mock.calls[1]?.[1]).toMatchObject({ method: 'PATCH' });
    expect(mocks.apiFetch.mock.calls[2]?.[1]).toMatchObject({ method: 'DELETE' });
  });

  it('keeps an actionable archived-load error for Settings retry UI', async () => {
    mocks.apiFetch.mockResolvedValueOnce(
      response({ ok: false, error: 'Archive index unavailable' }, 503),
    );

    await expect(sessionStore.fetchArchivedSessions()).resolves.toBe(false);
    expect(sessionStore.archivedError).toBe('Archive index unavailable');
    expect(sessionStore.archivedLoading).toBe(false);
  });
});
