import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MenuBar from './MenuBar.svelte';
import { setPlatformForTesting, type Platform } from '$lib/utils/platform';

const native = vi.hoisted(() => ({ invoke: vi.fn(), startDragging: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => native }));
vi.mock('$lib/stores/updater.svelte', () => ({ updater: { updateAvailable: false } }));

function menuBar() {
  return render(MenuBar, {
    showSidebar: true, showAgents: false, zenMode: false, projectName: null,
    activeAgents: [], recentProjects: [], onAction: vi.fn(),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('__TAURI_INTERNALS__', {});
  setPlatformForTesting('windows');
  native.invoke.mockResolvedValue(false);
});
afterEach(() => {
  cleanup();
  setPlatformForTesting(null);
  vi.unstubAllGlobals();
});

describe('MenuBar window controls', () => {
  it('uses native AppKit fullscreen on macOS and work-area zoom elsewhere', () => {
    const source = readFileSync(join(process.cwd(), 'src/lib/components/MenuBar.svelte'), 'utf8');

    expect(source).toContain("import { formatShortcut, isMac } from '$lib/utils/platform'");
    expect(source).toContain("invoke<boolean>('toggle_native_fullscreen')");
    expect(source).toContain("invoke<boolean>('toggle_maximize')");
    expect(source).toContain('gets its own Space and hides the');
  });

  it.each([
    ['mac', 'Enter full screen', 'Exit full screen', 'toggle_native_fullscreen'],
    ['windows', 'Maximize window', 'Restore window', 'toggle_maximize'],
    ['linux', 'Maximize window', 'Restore window', 'toggle_maximize'],
  ])('tracks OS expansion and restoration on %s', async (platform, enter, exit, command) => {
    setPlatformForTesting(platform as Platform);
    menuBar();
    await waitFor(() => expect(native.invoke).toHaveBeenCalledWith('is_window_expanded'));
    expect(screen.getByRole('button', { name: enter })).toBeInTheDocument();
    native.invoke.mockResolvedValue(true);
    await fireEvent.resize(window);
    await waitFor(() => expect(screen.getByRole('button', { name: exit })).toBeInTheDocument());
    native.invoke.mockResolvedValue(false);
    await fireEvent.focus(window);
    await waitFor(() => expect(screen.getByRole('button', { name: enter })).toBeInTheDocument());
    native.invoke.mockResolvedValue(true);
    await fireEvent.click(screen.getByRole('button', { name: enter }));
    expect(native.invoke).toHaveBeenCalledWith(command);
    await waitFor(() => expect(screen.getByRole('button', { name: exit })).toBeInTheDocument());
  });

  it('does not overwrite a completed toggle with an older startup query', async () => {
    let resolveInitial!: (value: boolean) => void;
    native.invoke.mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolveInitial = resolve; }));
    menuBar();
    await waitFor(() => expect(native.invoke).toHaveBeenCalledWith('is_window_expanded'));
    native.invoke.mockResolvedValue(true);
    await fireEvent.click(screen.getByRole('button', { name: 'Maximize window' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Restore window' })).toBeInTheDocument());
    resolveInitial(false);
    await tick();
    expect(screen.getByRole('button', { name: 'Restore window' })).toBeInTheDocument();
  });

  it('does not start window dragging from controls or secondary clicks', async () => {
    const { container } = menuBar();
    await fireEvent.mouseDown(screen.getByRole('button', { name: 'Maximize window' }), { button: 0 });
    await fireEvent.mouseDown(container.querySelector('header')!, { button: 2 });
    expect(native.startDragging).not.toHaveBeenCalled();
  });

  it('stops observing the window on unmount', async () => {
    const { unmount } = menuBar();
    await waitFor(() => expect(native.invoke).toHaveBeenCalledWith('is_window_expanded'));
    unmount();
    native.invoke.mockClear();
    await fireEvent.resize(window);
    await fireEvent.focus(window);
    expect(native.invoke).not.toHaveBeenCalled();
  });
});
