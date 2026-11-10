import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apiFetch, toast, copyText, reloadProviders } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
  copyText: vi.fn(async () => {}),
  reloadProviders: vi.fn(async () => {}),
}));
vi.mock('$lib/api.svelte', () => ({
  apiFetch,
  parseJsonResponse: (response: Response) => response.json(),
}));
vi.mock('$lib/stores/toast.svelte', () => ({ toastStore: toast }));
vi.mock('$lib/utils/clipboard', () => ({ copyText }));
vi.mock('$lib/stores/providers.svelte', () => ({ loadProvidersFromApi: reloadProviders }));
vi.mock('$lib/stores/collaboration.svelte', () => ({ collaborationStore: { activeCollab: null } }));
vi.mock('./icons/ProviderIcon.svelte', async () => ({
  default: (await import('lucide-svelte/icons/circle')).default,
}));
import ModelSharingPanel from './ModelSharingPanel.svelte';
beforeEach(() => vi.clearAllMocks());

describe('team shared-model selection persistence', () => {
  it('shares models through a dedicated action without starting or joining a session', async () => {
    const inviteUrl = 'https://relay.example/join?token=model-only-invite';
    const joinCode = 'ABCDEFGH';
    apiFetch.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url.endsWith('/providers/sharing/start'))
        return Response.json({ ok: true, data: { inviteUrl, joinCode, hostName: 'Friends PC' } });
      if (options?.method === 'POST') return Response.json({ ok: true });
      if (url.endsWith('/providers/shared'))
        return Response.json({
          ok: true,
          data: {
            shared: ['openai'],
            sharedModels: { openai: ['alpha'] },
            candidates: [
              {
                provider: 'openai',
                label: 'OpenAI',
                available: true,
                agentic: false,
                risk: 'ok',
                reason: 'API provider',
                modelCount: 1,
                models: [{ id: 'alpha', name: 'Alpha' }],
              },
            ],
          },
        });
      return Response.json({ ok: true, data: null });
    });
    render(ModelSharingPanel, { props: { hostName: 'Micah' } });
    await fireEvent.input(screen.getByRole('textbox', { name: 'Host name' }), {
      target: { value: 'Friends PC' },
    });
    await fireEvent.click(await screen.findByRole('button', { name: 'Share models' }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith(joinCode));
    expect(
      (screen.getByRole('textbox', { name: 'Model-sharing code' }) as HTMLInputElement).value,
    ).toBe(joinCode);
    expect(screen.getByText("Friends PC's model-sharing code")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop sharing' })).toBeTruthy();
    const start = apiFetch.mock.calls.find(([url]) => url.endsWith('/providers/sharing/start'));
    expect(JSON.parse(start?.[1].body)).toEqual({ hostName: 'Friends PC' });
    expect(
      apiFetch.mock.calls.some(
        ([url]) => url.endsWith('/host/start') || url.endsWith('/collab/join'),
      ),
    ).toBe(false);
    await fireEvent.click(screen.getByRole('button', { name: 'Stop sharing' }));
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: 'Model-sharing code' })).toBeNull(),
    );
  });

  it('restores the active host name and code when reopening settings', async () => {
    apiFetch.mockImplementation(async (url: string) =>
      Response.json({
        ok: true,
        data: url.endsWith('/providers/sharing')
          ? { active: true, hostName: 'Study group', joinCode: 'JKLMNPQR' }
          : null,
      }),
    );
    render(ModelSharingPanel);
    const code = await screen.findByRole('textbox', { name: 'Model-sharing code' });
    expect((code as HTMLInputElement).value).toBe('JKLMNPQR');
    expect((screen.getByRole('textbox', { name: 'Host name' }) as HTMLInputElement).value).toBe(
      'Study group',
    );
  });

  it('connects using a code and reloads the named models for the recipient picker', async () => {
    let connected = false;
    apiFetch.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url.endsWith('/providers/connect')) {
        connected = true;
        return Response.json({ ok: true, data: { hostName: 'Study group' } });
      }
      return Response.json({
        ok: true,
        data: url.endsWith('/providers/remote-status')
          ? { connected, hostName: connected ? 'Study group' : null, catalog: { providers: [] } }
          : null,
      });
    });
    render(ModelSharingPanel);
    await fireEvent.input(screen.getByRole('textbox', { name: 'Host model-sharing code' }), {
      target: { value: 'JKLMNPQR' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Use shared models' }));
    expect(await screen.findByText('Connected to Study group')).toBeTruthy();
    expect(reloadProviders).toHaveBeenCalledOnce();
    const connection = apiFetch.mock.calls.find(([url]) => url.endsWith('/providers/connect'));
    expect(JSON.parse(connection?.[1].body)).toEqual({ joinCode: 'JKLMNPQR' });
  });

  it('keeps selection in a dialog and persists only confirmed models to the sharing API', async () => {
    apiFetch.mockImplementation(async (_url: string, options?: RequestInit) => {
      if (options?.method === 'POST') return Response.json({ ok: true });
      if (_url.endsWith('/providers/shared'))
        return Response.json({
          ok: true,
          data: {
            shared: ['openai'],
            sharedModels: { openai: ['alpha', 'beta'] },
            candidates: [
              {
                provider: 'openai',
                label: 'OpenAI',
                available: true,
                agentic: false,
                risk: 'ok',
                reason: 'API provider',
                modelCount: 2,
                models: [
                  { id: 'alpha', name: 'Alpha' },
                  { id: 'beta', name: 'Beta' },
                ],
              },
            ],
          },
        });
      return Response.json({ ok: true, data: null });
    });
    render(ModelSharingPanel);
    const configure = await screen.findByRole('button', { name: 'Configure models for OpenAI' });
    expect(screen.queryByRole('checkbox')).toBeNull();
    await fireEvent.click(configure);
    await fireEvent.click(screen.getByRole('checkbox', { name: 'Beta' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await fireEvent.click(configure);
    expect(screen.getByRole('checkbox', { name: 'Beta' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    await fireEvent.click(screen.getByRole('checkbox', { name: 'Beta' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(apiFetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0);
    await fireEvent.click(screen.getByRole('button', { name: 'Save shared providers' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Shared providers updated'));
    const saved = apiFetch.mock.calls.find(([, options]) => options?.method === 'POST');
    expect(JSON.parse(saved?.[1].body)).toEqual({
      providers: ['openai'],
      models: { openai: ['alpha'] },
    });
  });
});
