import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultComputerUseSettings } from '@koryphaios/shared';
import ComputerUseSettings from './ComputerUseSettings.svelte';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('$lib/api.svelte', () => ({
  apiFetch,
  parseJsonResponse: (response: Response) => response.json(),
}));
vi.mock('$lib/utils/api-url', () => ({ apiUrl: (path: string) => path }));

async function open(settings = defaultComputerUseSettings()) {
  const onchange = vi.fn().mockResolvedValue(true);
  const view = render(ComputerUseSettings, { settings, onchange });
  await fireEvent.click(screen.getByRole('button', { name: /Computer use App grants/ }));
  return { onchange, ...view };
}
async function choose(name: string, value: string) {
  await fireEvent.click(screen.getByRole('combobox', { name }));
  await fireEvent.click(screen.getByRole('option', { name: value }));
}
const respond = (data: unknown) =>
  new Response(JSON.stringify({ ok: true, data }), { status: 200 });

beforeEach(() => apiFetch.mockReset());
beforeEach(() => window.localStorage.removeItem('koryphaios-computer-use-safety-ack-v1'));
afterEach(cleanup);

describe('Computer-use settings', () => {
  it('starts available with no grants and never discovers apps on render or expansion', async () => {
    const { onchange } = await open();
    expect(
      screen.getByRole('switch', { name: 'Enable computer use' }).getAttribute('aria-checked'),
    ).toBe('true');
    expect(
      screen.getByText('No app grants. Agents cannot observe or control any app.'),
    ).toBeTruthy();
    expect(apiFetch).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole('switch', { name: 'Enable computer use' }));
    expect(onchange).toHaveBeenCalledWith(expect.objectContaining({ enabled: false, apps: [] }));
  });

  it('remembers the safety acknowledgement across openings', async () => {
    await open();
    await fireEvent.click(screen.getByRole('button', { name: 'I understand' }));
    expect(screen.queryByRole('complementary', { name: 'Computer use safety notice' })).toBeNull();
    expect(window.localStorage.getItem('koryphaios-computer-use-safety-ack-v1')).toBe('1');

    cleanup();
    await open();
    expect(screen.queryByRole('complementary', { name: 'Computer use safety notice' })).toBeNull();
  });

  it('edits preset and role gates independently, including YOLO', async () => {
    const settings = defaultComputerUseSettings();
    const { onchange } = await open(settings);
    await choose('Computer permission preset', 'YOLO');
    await choose('Observe windows · YOLO', 'Allow');
    expect(onchange).toHaveBeenLastCalledWith({
      ...settings,
      byTier: { ...settings.byTier, yolo: { ...settings.byTier.yolo, observe: 'allow' } },
    });
    await choose('Computer agent role', 'Manager');
    await choose('Observe windows · Manager', 'Block');
    expect(onchange).toHaveBeenLastCalledWith({
      ...settings,
      byRole: { ...settings.byRole, manager: { ...settings.byRole.manager, observe: 'block' } },
    });
    expect(settings.byTier.yolo.observe).toBe('allow');
  });

  it('allows approval-tier and Critic role customization while keeping unimplemented capabilities blocked', async () => {
    const settings = defaultComputerUseSettings();
    settings.byTier.ask.interact = 'allow';
    settings.byRole.critic.manageWindows = 'allow';
    const { container } = await open(settings);
    await choose('Computer permission preset', 'Ask');
    await choose('Computer agent role', 'Critic');
    for (const name of [
      'Semantic controls, pointer, typing & keys · Ask',
      'Focus windows · Critic',
      'Read clipboard · Ask',
    ]) {
      const control = screen.getByRole('combobox', { name }) as HTMLButtonElement;
      expect(control.disabled).toBe(name === 'Read clipboard · Ask');
      if (name === 'Read clipboard · Ask') expect(control.textContent).toContain('Block');
    }
    expect(
      (
        screen.getByRole('combobox', {
          name: 'Observe windows · Critic',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    expect(
      container.querySelector('select,input[type="checkbox"],input[type="number"]'),
    ).toBeNull();
  });

  it('checks status separately and displays honest platform limitations', async () => {
    await open();
    apiFetch.mockResolvedValueOnce(
      respond({
        platform: 'linux',
        available: false,
        capabilities: [],
        limitations: ['Wayland window capture is unsupported.'],
      }),
    );
    await fireEvent.click(screen.getByRole('button', { name: 'Check platform status' }));
    await screen.findByText('linux: Adapter unavailable');
    expect(screen.getByText('Wayland window capture is unsupported.')).toBeTruthy();
    expect(apiFetch).toHaveBeenCalledExactlyOnceWith('/api/v1/computer-use/status', {
      method: 'GET',
    });
  });

  it('explicitly discovers and deduplicates OS app identities; adding grants nothing', async () => {
    const { onchange } = await open();
    apiFetch.mockResolvedValueOnce(
      respond({
        targets: [
          { appId: 'com.example.editor', windowId: '1', title: 'Private document', pid: 42 },
          { appId: 'com.example.editor', windowId: '2', title: 'Other document', pid: 42 },
        ],
      }),
    );
    await fireEvent.click(screen.getByRole('button', { name: 'Discover running apps' }));
    await screen.findByRole('button', { name: 'Add app' });
    expect(apiFetch).toHaveBeenCalledExactlyOnceWith('/api/v1/computer-use/apps', {
      method: 'GET',
    });
    expect(screen.getAllByRole('button', { name: 'Add app' })).toHaveLength(1);
    expect(screen.queryByText('Private document')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Add app' }));
    expect(onchange).toHaveBeenCalledWith(
      expect.objectContaining({
        apps: [{ appId: 'com.example.editor', label: 'com.example.editor', capabilities: {} }],
      }),
    );
  });

  it('edits and removes a specific app grant without broadening other gates', async () => {
    const settings = defaultComputerUseSettings();
    settings.apps = [{ appId: 'com.example.editor', label: 'Editor', capabilities: {} }];
    const { onchange } = await open(settings);
    expect(
      screen.getByRole('combobox', { name: 'Observe windows · Editor' }).textContent,
    ).toContain('Block');
    await choose('Observe windows · Editor', 'Ask each action');
    expect(onchange).toHaveBeenLastCalledWith({
      ...settings,
      apps: [{ ...settings.apps[0], capabilities: { observe: 'ask' } }],
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Remove Editor grant' }));
    expect(onchange).toHaveBeenLastCalledWith({ ...settings, apps: [] });
  });

  it('can stop while disabled and does not claim delivered input was undone', async () => {
    const { onchange, rerender } = await open();
    const onstopped = vi.fn().mockResolvedValue(undefined);
    await rerender({ settings: defaultComputerUseSettings(), onchange, onstopped });
    apiFetch.mockResolvedValueOnce(respond({ cancelled: 1, enabled: false }));
    await fireEvent.click(screen.getByRole('button', { name: 'Stop computer actions' }));
    await screen.findByText(/Already-delivered input cannot be undone/);
    expect(apiFetch).toHaveBeenCalledExactlyOnceWith('/api/v1/computer-use/stop', {
      method: 'POST',
    });
    expect(onchange).not.toHaveBeenCalled();
    expect(onstopped).toHaveBeenCalledOnce();
  });

  it('keeps stop available while a settings save is in progress', async () => {
    const { rerender } = await open();
    await rerender({ settings: defaultComputerUseSettings(), saving: true, onchange: vi.fn() });
    expect(
      (screen.getByRole('switch', { name: 'Enable computer use' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('combobox', { name: 'Observe windows · Worker' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'Stop computer actions' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('rejects malformed status and app payloads instead of rendering false support', async () => {
    await open();
    apiFetch.mockResolvedValueOnce(respond({}));
    await fireEvent.click(screen.getByRole('button', { name: 'Check platform status' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('Invalid computer use status response'),
    );
    apiFetch.mockResolvedValueOnce(respond({ apps: [] }));
    await fireEvent.click(screen.getByRole('button', { name: 'Discover running apps' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        'Invalid computer use app discovery response',
      ),
    );
    expect(screen.queryByText('Discovered apps')).toBeNull();
  });

  it('surfaces API failures without reporting discovery or stop success', async () => {
    await open();
    apiFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: 'OS permission missing' }), { status: 403 }),
    );
    await fireEvent.click(screen.getByRole('button', { name: 'Discover running apps' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('OS permission missing'),
    );
    expect(screen.queryByText('Discovered apps')).toBeNull();
    apiFetch.mockRejectedValueOnce(new Error('Backend unavailable'));
    await fireEvent.click(screen.getByRole('button', { name: 'Stop computer actions' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Backend unavailable'));
    expect(screen.queryByText(/Stop requested/)).toBeNull();
  });
});
