import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  session: true,
  sessionId: 'chat-a',
  project: '/repo',
  authenticate: undefined as undefined | (() => Promise<boolean>),
}));

vi.mock('$lib/stores/auth.svelte', () => ({
  authStore: {
    get token() {
      return 'Bearer test';
    },
    ensureSession: () => state.authenticate?.() ?? Promise.resolve(state.session),
  },
}));
vi.mock('$lib/demo-flags', () => ({ isDemoMode: false }));
vi.mock('$lib/demo-api', () => ({ demoFetch: vi.fn() }));
vi.mock('$lib/stores/project.svelte', () => ({
  projectStore: {
    get requestPath() {
      return state.project;
    },
  },
}));

vi.mock('$lib/stores/sessions.svelte', () => ({
  sessionStore: {
    get activeSessionId() {
      return state.sessionId;
    },
    get sessions() {
      return [
        { id: 'chat-a', workingDirectory: '/source-a', gitWorkspace: { path: '/checkout-a' } },
      ];
    },
  },
}));

import { apiFetch } from './api.svelte';

function lastRequest(): RequestInit {
  return (fetchMock.mock.calls.at(-1)?.[1] ?? {}) as RequestInit;
}

const fetchMock = vi.fn(
  async (_url: string | URL | Request, _init?: RequestInit) => new Response('{}', { status: 200 }),
);

describe('apiFetch body content type', () => {
  beforeEach(() => {
    state.session = true;
    state.sessionId = 'chat-a';
    state.project = '/repo';
    state.authenticate = undefined;
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('defaults a string body to JSON so schema-validated routes accept it', async () => {
    await apiFetch('/api/sessions/s1/rewind/preview', {
      method: 'POST',
      body: JSON.stringify({ hash: 'abc123' }),
    });
    const headers = new Headers(lastRequest().headers);
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('never overrides a caller-supplied content type', async () => {
    await apiFetch('/api/sessions/s1/context/a1/visibility', {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.kory+json' },
      body: JSON.stringify({ hiddenFromAgent: true }),
    });
    expect(new Headers(lastRequest().headers).get('Content-Type')).toBe(
      'application/vnd.kory+json',
    );
  });

  it('leaves FormData bodies to the runtime boundary', async () => {
    const form = new FormData();
    form.append('file', new Blob(['x']), 'x.txt');
    await apiFetch('/api/notes', { method: 'PUT', body: form });
    expect(new Headers(lastRequest().headers).get('Content-Type')).toBeNull();
  });

  it('captures session and source project before authentication yields', async () => {
    let finish!: (value: boolean) => void;
    state.authenticate = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const request = apiFetch('/api/git/stage', { method: 'POST', body: '{}' });
    state.sessionId = 'chat-b';
    state.project = '/source-b';
    finish(true);
    await request;
    const headers = new Headers(lastRequest().headers);
    expect(headers.get('X-Koryphaios-Session')).toBe('chat-a');
    expect(headers.get('X-Koryphaios-Project')).toBe('/source-a');
  });

  it('preserves explicit routing headers', async () => {
    await apiFetch('/api/git/status', {
      headers: { 'X-Koryphaios-Session': 'explicit', 'X-Koryphaios-Project': '/explicit-source' },
    });
    const headers = new Headers(lastRequest().headers);
    expect(headers.get('X-Koryphaios-Session')).toBe('explicit');
    expect(headers.get('X-Koryphaios-Project')).toBe('/explicit-source');
  });

  it('does not synthesize a raw project path beside an explicitly pinned session', async () => {
    state.project = '/projects/项目/🚀';
    await apiFetch('/api/git/chat', {
      headers: { 'X-Koryphaios-Session': 'chat-a' },
    });
    const headers = new Headers(lastRequest().headers);
    expect(headers.get('X-Koryphaios-Session')).toBe('chat-a');
    expect(headers.get('X-Koryphaios-Project')).toBeNull();
  });

  it('adds no content type when there is no body', async () => {
    await apiFetch('/api/sessions');
    expect(new Headers(lastRequest().headers).get('Content-Type')).toBeNull();
  });
});
