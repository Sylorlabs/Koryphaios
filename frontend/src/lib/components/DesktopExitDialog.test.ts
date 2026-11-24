import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DesktopExitDialog from './DesktopExitDialog.svelte';

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  runStates: new Map<string, { phase: string; activeAgents: Set<string> }>(),
  unlisten: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('$lib/stores/run-state.svelte', () => ({
  runStateStore: {
    get states() {
      return native.runStates;
    },
  },
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, callback: (event: { payload: unknown }) => void) => {
    native.listeners.set(name, callback);
    return native.unlisten;
  }),
}));

async function open(reason = 'close', id = 1) {
  native.invoke.mockImplementation(async (command: string) =>
    command === 'get_desktop_exit_request' ? { id, reason } : undefined,
  );
  render(DesktopExitDialog);
  await screen.findByRole('alertdialog');
}

describe('desktop exit choices', () => {
  beforeEach(() => {
    native.invoke.mockReset();
    native.listeners.clear();
    native.runStates.clear();
    native.runStates.set('active-session', {
      phase: 'streaming',
      activeAgents: new Set(['kory-manager']),
    });
    native.unlisten.mockClear();
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
  });

  it('offers three close choices, focuses Cancel, and sends the background action', async () => {
    await open();
    expect(screen.getAllByRole('button')).toHaveLength(3);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Quit anyway' })).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Run in background' }));
    expect(native.invoke).toHaveBeenCalledWith('resolve_desktop_exit', {
      id: 1,
      choice: 'background',
    });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('presents a close request the shell sent and acknowledges it', async () => {
    native.runStates.clear();
    native.invoke.mockImplementation(async (command: string) =>
      command === 'get_desktop_exit_request' ? null : undefined,
    );
    render(DesktopExitDialog);
    await waitFor(() => expect(native.listeners.has('desktop://exit-requested')).toBe(true));

    native.listeners.get('desktop://exit-requested')?.({
      payload: { id: 7, reason: 'close' },
    });

    expect(await screen.findByRole('alertdialog')).toBeTruthy();
    expect(native.invoke).toHaveBeenCalledWith('acknowledge_desktop_exit', { id: 7 });
    // The webview never decides on its own; quitting waits for a user choice.
    expect(native.invoke).not.toHaveBeenCalledWith('resolve_desktop_exit', expect.anything());
  });

  it('does not second-guess the shell from webview run state', async () => {
    native.runStates.clear();
    native.runStates.set('linked-linux-chat', {
      phase: 'streaming',
      activeAgents: new Set(['kory-manager']),
    });
    native.invoke.mockImplementation(async (command: string) =>
      command === 'get_desktop_exit_request' ? null : undefined,
    );
    render(DesktopExitDialog);
    await waitFor(() => expect(native.listeners.has('desktop://exit-requested')).toBe(true));

    native.listeners.get('desktop://exit-requested')?.({
      payload: { id: 8, reason: 'close' },
    });

    expect(await screen.findByRole('alertdialog')).toBeTruthy();
    expect(native.invoke).toHaveBeenCalledWith('acknowledge_desktop_exit', { id: 8 });
  });

  it('keeps the prompt when a worker is active even if the manager phase is terminal', async () => {
    native.runStates.set('worker-session', {
      phase: 'done',
      activeAgents: new Set(['worker-1']),
    });
    await open();
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(native.invoke).not.toHaveBeenCalledWith('resolve_desktop_exit', {
      id: 1,
      choice: 'proceed',
    });
  });

  it('offers only Restart anyway and Cancel during a restart', async () => {
    await open('restart');
    expect(screen.getAllByRole('button')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Run in background' })).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Restart anyway' }));
    expect(native.invoke).toHaveBeenCalledWith('resolve_desktop_exit', {
      id: 1,
      choice: 'proceed',
    });
  });

  it('cancels with Escape and traps keyboard focus inside the dialog', async () => {
    await open('restart');
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    await fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Restart anyway' }));
    await fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(native.invoke).toHaveBeenCalledWith('resolve_desktop_exit', { id: 1, choice: 'cancel' });
  });

  it('replaces a close request with the OS request instead of leaving background available', async () => {
    await open();
    native.listeners.get('desktop://exit-requested')?.({ payload: { id: 2, reason: 'restart' } });
    await screen.findByRole('button', { name: 'Restart anyway' });
    expect(screen.queryByRole('button', { name: 'Run in background' })).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(native.invoke).toHaveBeenCalledWith('resolve_desktop_exit', { id: 2, choice: 'cancel' });
  });

  it('keeps the dialog open with a retryable error when quitting fails', async () => {
    await open();
    native.invoke.mockRejectedValueOnce(new Error('Could not stop the background service.'));
    await fireEvent.click(screen.getByRole('button', { name: 'Quit anyway' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not stop the background service.',
    );
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).not.toBeDisabled();
  });

  it('dismisses an OS-cancelled request and ignores older close events', async () => {
    await open('restart', 2);
    native.listeners.get('desktop://exit-requested')?.({ payload: { id: 1, reason: 'close' } });
    expect(screen.queryByRole('button', { name: 'Run in background' })).toBeNull();
    native.listeners.get('desktop://exit-cancelled')?.({ payload: null });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(
      native.invoke.mock.calls.filter(([command]) => command === 'resolve_desktop_exit'),
    ).toHaveLength(0);
  });

  it('ignores duplicate clicks while an action is pending', async () => {
    await open();
    let finish!: () => void;
    native.invoke.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const button = screen.getByRole('button', { name: 'Quit anyway' });
    await fireEvent.click(button);
    await fireEvent.click(button);
    expect(
      native.invoke.mock.calls.filter(([command]) => command === 'resolve_desktop_exit'),
    ).toHaveLength(1);
    finish();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });
});
