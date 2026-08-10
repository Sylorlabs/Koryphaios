import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sessionStore: {
    activeSessionId: 'session-active',
    sessions: [
      { id: 'session-active', title: 'Active session' },
      { id: 'session-other', title: 'Other session' },
    ],
  },
  wsStore: {
    pendingPermissions: [] as Array<{
      id: string;
      sessionId: string;
      toolName: string;
      action: string;
      description: string;
      path?: string;
      createdAt: number;
    }>,
    respondToPermission: vi.fn(),
  },
}));

vi.mock('$lib/stores/sessions.svelte', () => ({ sessionStore: mocks.sessionStore }));
vi.mock('$lib/stores/websocket.svelte', () => ({ wsStore: mocks.wsStore }));

import PermissionDialog from './PermissionDialog.svelte';

function permission(id: string, toolName = 'bash') {
  return {
    id,
    sessionId: 'session-active',
    toolName,
    action: 'execute',
    description: toolName === 'bash' ? 'Run the focused test suite' : 'Read package.json',
    path: '/tmp/project',
    createdAt: Date.now(),
  };
}

describe('PermissionDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sessionStore.activeSessionId = 'session-active';
    mocks.wsStore.pendingPermissions = [permission('permission-1')];
  });

  it('labels the modal, starts on the safe action, and wires explicit approve and deny choices', async () => {
    const { container } = render(PermissionDialog);
    const dialog = screen.getByRole('dialog', { name: 'Tool approval required' });
    expect(dialog.getAttribute('aria-describedby')).toBe('permission-dialog-description');
    expect(document.getElementById('permission-dialog-description')?.textContent).toContain(
      'Escape safely denies',
    );
    expect(container.querySelector('button button, [role="button"] button')).toBeNull();

    const deny = screen.getByRole('button', { name: 'Deny bash' });
    await waitFor(() => expect(document.activeElement).toBe(deny));
    await fireEvent.click(screen.getByRole('button', { name: 'Approve bash' }));
    expect(mocks.wsStore.respondToPermission).toHaveBeenCalledWith('permission-1', true);

    await fireEvent.click(deny);
    expect(mocks.wsStore.respondToPermission).toHaveBeenCalledWith('permission-1', false);
  });

  it('denies every visible request on Escape and traps Tab within the dialog', async () => {
    mocks.wsStore.pendingPermissions = [
      permission('permission-1'),
      permission('permission-2', 'read_file'),
    ];
    render(PermissionDialog);

    const dialog = screen.getByRole('dialog', { name: 'Tool approval required' });
    const firstDeny = screen.getByRole('button', { name: 'Deny bash' });
    await waitFor(() => expect(document.activeElement).toBe(firstDeny));

    const approveAll = screen.getByRole('button', { name: 'Approve all (2)' });
    approveAll.focus();
    await fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(firstDeny);

    await fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(mocks.wsStore.respondToPermission).toHaveBeenCalledWith('permission-1', false);
    expect(mocks.wsStore.respondToPermission).toHaveBeenCalledWith('permission-2', false);
    expect(mocks.wsStore.respondToPermission).not.toHaveBeenCalledWith(expect.any(String), true);
  });
});
