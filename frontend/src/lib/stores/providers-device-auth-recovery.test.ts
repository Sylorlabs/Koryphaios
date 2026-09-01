import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const apiFetch = vi.fn();

vi.mock('$lib/api.svelte', () => ({
  apiFetch,
  parseJsonResponse: async <T>(response: Response): Promise<T> => response.json() as Promise<T>,
}));

vi.mock('./toast.svelte', () => ({
  toastStore: {
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn() }));

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('device auth renderer recovery', () => {
  beforeEach(() => {
    vi.resetModules();
    apiFetch.mockReset();
    sessionStorage.clear();
    localStorage.clear();
  });

  afterEach(async () => {
    const { providersStore } = await import('./providers.svelte');
    providersStore.destroy();
  });

  test('reload resumes an unexpired Copilot device code through the existing poll endpoint', async () => {
    sessionStorage.setItem(
      'koryphaios-device-auth-recovery-v1',
      JSON.stringify({
        copilot: {
          deviceAuthId: 'device-auth-1',
          deviceCode: 'device-code',
          userCode: 'ABCD-EFGH',
          verificationUri: 'https://github.com/login/device',
          expiresAt: Date.now() + 60_000,
          intervalMs: 5_000,
        },
      }),
    );

    apiFetch.mockImplementation((url: string) => {
      if (url.includes('/copilot/auth/poll')) {
        return Promise.resolve(json({ ok: true, data: { status: 'authorization_pending' } }));
      }
      return Promise.resolve(json({ ok: true, data: [{ name: 'copilot', authenticated: false }] }));
    });

    const { providersStore } = await import('./providers.svelte');
    await providersStore.loadProvidersFromApi();

    await vi.waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/providers/copilot/auth/poll'),
        expect.objectContaining({ method: 'POST' }),
      );
    });
    expect(providersStore.copilotDeviceAuth?.deviceCode).toBe('device-code');
    expect(providersStore.browserAuthPending.copilot).toBe(true);
    expect(localStorage.length).toBe(0);
  });
});
