import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
  ),
}));

vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false, version: '' }));
vi.mock('$lib/api.svelte', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('$lib/utils/api-url', () => ({ apiUrl: (path: string) => path }));
vi.mock('$lib/fonts', () => ({ loadFont: vi.fn(async () => undefined) }));

import { theme } from './theme.svelte';

describe('theme appearance persistence', () => {
  it('keeps primary and secondary custom accents in one persisted appearance model', async () => {
    localStorage.clear();
    mocks.apiFetch.mockClear();

    theme.setCustomAccent({ main: '#123456', hover: '#345678' });
    theme.setCustomSecondaryAccent({ main: '#ABCDEF', hover: '#CDEFFF' });

    await vi.waitFor(() => {
      expect(mocks.apiFetch).toHaveBeenCalledTimes(2);
    });

    const local = JSON.parse(localStorage.getItem('koryphaios-theme') ?? '{}');
    expect(local.customAccent).toEqual({ main: '#123456', hover: '#345678' });
    expect(local.customSecondaryAccent).toEqual({ main: '#ABCDEF', hover: '#CDEFFF' });

    const lastWrite = mocks.apiFetch.mock.calls.at(-1);
    expect(lastWrite?.[0]).toBe('/api/appearance');
    const body = JSON.parse(String(lastWrite?.[1]?.body));
    expect(body.accent).toBe('custom');
    expect(body.secondaryAccent).toBe('custom');
    expect(body.customAccent).toEqual({ main: '#123456', hover: '#345678' });
    expect(body.customSecondaryAccent).toEqual({ main: '#ABCDEF', hover: '#CDEFFF' });
  });
});
