import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  sessionStore: { activeSessionId: 'session-1' },
}));

vi.mock('$lib/stores/websocket.svelte', () => ({
  wsStore: { sendMessage: mocks.sendMessage },
}));

vi.mock('$lib/stores/sessions.svelte', () => ({
  sessionStore: mocks.sessionStore,
}));

vi.mock('$lib/stores/toast.svelte', () => ({
  toastStore: { success: mocks.success, error: mocks.error },
}));

import GitConflictDialog from './GitConflictDialog.svelte';

describe('GitConflictDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sessionStore.activeSessionId = 'session-1';
  });

  it('keeps conflict recovery truthful, keyboard reachable, and non-destructive', async () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'Open conflict details';
    document.body.appendChild(trigger);
    trigger.focus();

    const onClose = vi.fn();
    const view = render(GitConflictDialog, {
      props: { conflicts: ['src/agent.ts', 'README.md'], onClose },
    });

    const dialog = screen.getByRole('dialog', { name: 'Merge needs attention' });
    await waitFor(() => expect(document.activeElement).toBe(dialog));
    expect(screen.getByText(/closing this message does not change the files/i)).toBeTruthy();
    expect(screen.getByText(/no file is changed by sending the request/i)).toBeTruthy();

    await fireEvent.click(screen.getByRole('button', { name: 'Send to Kory' }));

    expect(mocks.sendMessage).toHaveBeenCalledOnce();
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      'session-1',
      expect.stringContaining('- src/agent.ts\n- README.md'),
    );
    expect(mocks.success).toHaveBeenCalledWith('Conflict details sent to Kory');
    expect(onClose).toHaveBeenCalledOnce();

    view.unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('does not claim a request was sent when no active session exists', async () => {
    mocks.sessionStore.activeSessionId = '';
    const onClose = vi.fn();
    render(GitConflictDialog, { props: { conflicts: ['src/agent.ts'], onClose } });

    await fireEvent.click(screen.getByRole('button', { name: 'Send to Kory' }));

    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith('No active session to send conflicts to');
    expect(onClose).not.toHaveBeenCalled();
  });
});
