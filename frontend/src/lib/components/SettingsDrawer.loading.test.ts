// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SettingsDrawer from './SettingsDrawer.svelte';

/**
 * The drawer opens onto an empty pane that fills in over the network. These are
 * the guards for that transition: a placeholder stands in while the catalog
 * loads, panes that fetch on mount only load once opened, and the pane that did
 * load keeps its markup.
 */
function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

let pendingProviders: Array<() => void> = [];

// Every request goes through the shared auth preflight, so the stub has to
// satisfy it before any pane's own request reaches `fetch`.
function stubbedFetch(input: string | URL): Promise<Response> {
  const url = String(input);
  if (url.includes('/api/auth/session'))
    return Promise.resolve(jsonResponse({ ok: true, data: { bearerToken: 'test-token' } }));
  if (url.includes('/api/auth/me'))
    return Promise.resolve(jsonResponse({ ok: true, data: { user: { id: 'u1', name: 'Test' } } }));
  if (url.includes('/api/providers?') || url.endsWith('/api/providers')) {
    // Hold the provider catalog until the test releases it, so the placeholder
    // is observable.
    return new Promise<Response>((resolve) => {
      pendingProviders.push(() => resolve(jsonResponse({ ok: true, data: [] })));
    });
  }
  return Promise.resolve(jsonResponse({ ok: true, data: [] }));
}

beforeEach(() => {
  pendingProviders = [];
  vi.stubGlobal('fetch', vi.fn(stubbedFetch));
});

describe('Settings drawer loading', () => {
  it('holds the provider pane with placeholders until the catalog arrives', async () => {
    const { unmount } = render(SettingsDrawer, { open: true });

    const skeleton = await screen.findByText('Loading providers…');
    expect(skeleton).toBeTruthy();
    expect(skeleton.parentElement?.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
    // The empty state must not appear while a load is still in flight.
    expect(screen.queryByText('No providers found')).toBeNull();

    pendingProviders.forEach((release) => release());
    await waitFor(() => expect(screen.queryByText('Loading providers…')).toBeNull());
    expect(screen.getByText('No providers found')).toBeTruthy();

    unmount();
  });

  it('keeps the provider list once it has loaded', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL) => {
        const url = String(input);
        if (url.includes('/api/auth/session'))
          return Promise.resolve(jsonResponse({ ok: true, data: { bearerToken: 'test-token' } }));
        if (url.includes('/api/auth/me'))
          return Promise.resolve(
            jsonResponse({ ok: true, data: { user: { id: 'u1', name: 'Test' } } }),
          );
        if (url.includes('/api/providers'))
          return Promise.resolve(
            jsonResponse({
              ok: true,
              data: [
                {
                  name: 'openai',
                  label: 'OpenAI',
                  enabled: true,
                  connectionState: 'verified',
                  models: ['gpt-5'],
                  selectedModels: ['gpt-5'],
                  allAvailableModels: [],
                  accounts: [],
                },
              ],
            }),
          );
        return Promise.resolve(jsonResponse({ ok: true, data: [] }));
      }),
    );

    const { unmount } = render(SettingsDrawer, { open: true });

    expect(await screen.findByRole('button', { name: /OpenAI/ })).toBeTruthy();

    unmount();
  });

  it('mounts a settings pane when it is opened, not before', async () => {
    const fetchSpy = vi.mocked(globalThis.fetch);
    const { unmount } = render(SettingsDrawer, { open: true });

    // Providers is the landing pane, so its catalog is requested immediately.
    await waitFor(() =>
      expect(fetchSpy.mock.calls.some(([input]) => String(input).includes('/api/providers'))).toBe(
        true,
      ),
    );

    // Images fetches its catalog on mount. Rendering it with the drawer made
    // that request fire before the pane was ever opened.
    expect(fetchSpy.mock.calls.some(([input]) => String(input).includes('/api/images'))).toBe(
      false,
    );

    await fireEvent.click(screen.getByRole('button', { name: /Image capabilities/ }));

    await waitFor(() =>
      expect(fetchSpy.mock.calls.some(([input]) => String(input).includes('/api/images'))).toBe(
        true,
      ),
    );

    unmount();
  });

  it('keeps a mounted pane mounted while the user visits other settings', async () => {
    const fetchSpy = vi.mocked(globalThis.fetch);
    const { unmount } = render(SettingsDrawer, { open: true });

    await fireEvent.click(screen.getByRole('button', { name: /Image capabilities/ }));
    await waitFor(() =>
      expect(fetchSpy.mock.calls.some(([input]) => String(input).includes('/api/images'))).toBe(
        true,
      ),
    );
    const imageCallsAfterFirstVisit = fetchSpy.mock.calls.filter(([input]) =>
      String(input).includes('/api/images'),
    ).length;

    await fireEvent.click(screen.getByRole('button', { name: /Providers/ }));
    await fireEvent.click(screen.getByRole('button', { name: /Image capabilities/ }));

    // Re-entering the pane must not re-run its work from scratch.
    expect(
      fetchSpy.mock.calls.filter(([input]) => String(input).includes('/api/images')).length,
    ).toBe(imageCallsAfterFirstVisit);

    unmount();
  });
});
