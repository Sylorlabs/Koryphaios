import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ session: true }));

vi.mock('$lib/stores/auth.svelte', () => ({
  authStore: {
    get token() {
      return 'Bearer test';
    },
    ensureSession: () => Promise.resolve(state.session),
  },
}));
vi.mock('$lib/demo-flags', () => ({ isDemoMode: false }));
vi.mock('$lib/demo-api', () => ({ demoFetch: vi.fn() }));
vi.mock('$lib/stores/project.svelte', () => ({
  projectStore: {
    get requestPath() {
      return '/repo';
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

  it('adds no content type when there is no body', async () => {
    await apiFetch('/api/sessions');
    expect(new Headers(lastRequest().headers).get('Content-Type')).toBeNull();
  });
});
