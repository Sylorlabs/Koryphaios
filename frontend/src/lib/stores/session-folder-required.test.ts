import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  error: vi.fn(),
  project: { currentPath: null as string | null, workspaceRoot: null, scope: 'all' },
}));
vi.mock('$lib/api.svelte', () => ({ apiFetch: mocks.fetch }));
vi.mock('$lib/utils/api-url', () => ({ apiUrl: (path: string) => path }));
vi.mock('./project.svelte', () => ({ projectStore: mocks.project }));
vi.mock('./toast.svelte', () => ({ toastStore: { error: mocks.error } }));
vi.mock('./websocket.svelte', () => ({ wsStore: {} }));
import { sessionStore } from './sessions.svelte';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.project.currentPath = null;
  mocks.fetch.mockImplementation(async (_url, options) => {
    const body = JSON.parse(options.body);
    return new Response(
      JSON.stringify({
        ok: true,
        data: { id: 'folder-chat', title: body.title, workingDirectory: body.workingDirectory },
      }),
    );
  });
});

test('a new chat without a selected folder never submits a creation request', async () => {
  expect(await sessionStore.newChat()).toBeNull();
  expect(await sessionStore.createSession()).toBeNull();
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(mocks.error).toHaveBeenCalledWith('Choose a project folder before starting a chat');
});

test('new chat uses the selected project and an explicit folder takes precedence', async () => {
  mocks.project.currentPath = '/projects/current';
  expect(await sessionStore.newChat()).toBe('folder-chat');
  expect(JSON.parse(mocks.fetch.mock.calls[0]![1].body).workingDirectory).toBe('/projects/current');
  await sessionStore.createSession({ workingDirectory: '/projects/chosen' });
  expect(JSON.parse(mocks.fetch.mock.calls[1]![1].body).workingDirectory).toBe('/projects/chosen');
});

test('coalesces overlapping session-list refreshes', async () => {
  let resolveList!: (response: Response) => void;
  mocks.fetch.mockImplementationOnce(
    () => new Promise<Response>((resolve) => (resolveList = resolve)),
  );

  const first = sessionStore.fetchSessions();
  const second = sessionStore.fetchSessions();
  await Promise.resolve();

  expect(mocks.fetch).toHaveBeenCalledTimes(1);
  resolveList(new Response(JSON.stringify({ ok: true, data: [] })));
  await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
});
