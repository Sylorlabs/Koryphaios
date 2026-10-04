import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ sessionId: 'a', fetch: vi.fn(), toast: vi.fn() }));
vi.mock('$lib/api.svelte', () => ({ apiFetch: (...args: unknown[]) => mocks.fetch(...args) }));
vi.mock('$lib/utils/api-url', () => ({ apiUrl: (path: string) => path }));
vi.mock('$lib/demo-flags', () => ({ isDemoMode: false }));
vi.mock('./sessions.svelte', () => ({
  sessionStore: {
    get activeSessionId() {
      return mocks.sessionId;
    },
    sessions: [
      { id: 'a', workingDirectory: '/source', gitWorkspace: { path: '/a' } },
      { id: 'b', workingDirectory: '/source', gitWorkspace: { path: '/b' } },
    ],
  },
}));
vi.mock('./project.svelte', () => ({ projectStore: { requestPath: '/source' } }));
vi.mock('./websocket.svelte', () => ({ wsStore: {} }));
vi.mock('./toast.svelte', () => ({
  toastStore: { success: mocks.toast, warning: mocks.toast, error: mocks.toast },
}));
import { gitStore } from './git.svelte';

function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const response = (data: unknown) => new Response(JSON.stringify(data));

beforeEach(() => {
  mocks.fetch.mockReset();
  mocks.toast.mockReset();
  mocks.sessionId = 'reset';
  gitStore.resetForContext();
  mocks.sessionId = 'a';
  gitStore.resetForContext();
});

describe('session-scoped Git UI state', () => {
  it('drops a late status response after switching chats in the same project', async () => {
    const old = deferred();
    mocks.fetch.mockReturnValueOnce(old.promise);
    const pending = gitStore.refreshStatus();
    mocks.sessionId = 'b';
    gitStore.resetForContext();
    mocks.fetch.mockResolvedValueOnce(response({ ok: true, data: { isRepo: false, branch: 'b' } }));
    await gitStore.refreshStatus();
    old.resolve(
      response({ ok: true, data: { isRepo: true, branch: 'a', status: [{ path: 'a.txt' }] } }),
    );
    await pending;
    expect(gitStore.state.branch).toBe('b');
    expect(gitStore.state.status).toEqual([]);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it('does not load fallback file content from the new chat for an old diff', async () => {
    const old = deferred();
    mocks.fetch.mockReturnValueOnce(old.promise);
    const pending = gitStore.loadDiff('a.txt', false);
    mocks.sessionId = 'b';
    gitStore.resetForContext();
    old.resolve(response({ ok: true, data: { diff: '' } }));
    await pending;
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(gitStore.state.currentFileContent).toBeNull();
    expect(gitStore.state.selectedFile).toBeNull();
  });

  it('does not publish old merge conflicts or refresh the new chat after an old mutation', async () => {
    const old = deferred();
    mocks.fetch.mockReturnValueOnce(old.promise);
    const pending = gitStore.merge('feature');
    mocks.sessionId = 'b';
    gitStore.resetForContext();
    old.resolve(response({ ok: false, data: { hasConflicts: true, conflicts: ['old.txt'] } }));
    await pending;
    expect(gitStore.state.conflicts).toEqual([]);
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not reopen a closed diff after its request finishes', async () => {
    const old = deferred();
    mocks.fetch.mockReturnValueOnce(old.promise);
    const pending = gitStore.loadDiff('a.txt', false);
    gitStore.closeDiff();
    old.resolve(response({ ok: true, data: { diff: 'old diff' } }));
    await pending;
    expect(gitStore.state.currentDiff).toBeNull();
  });
});
