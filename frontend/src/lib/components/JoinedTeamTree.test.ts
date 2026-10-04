import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
const { store } = vi.hoisted(() => ({ store: {
  joinedSessions: [{ sessionId: 'team-1', sessionName: 'Design review', hostName: 'Micah', tierId: 'viewer',
    sharedFolders: [{ id: 'workspace-1', name: 'koryphaios' }, { id: 'workspace-2', name: 'docs' }] }],
  activeJoinedSession: null,
  activeJoinedFolder: null,
  openJoinedSession: vi.fn(), leaveJoinedSession: vi.fn(),
} }));
vi.mock('$lib/stores/collaboration.svelte', () => ({ collaborationStore: store }));
import JoinedTeamTree from './JoinedTeamTree.svelte';

describe('host shared folders in the normal sidebar', () => {
  it('shows actual host and folder names and opens the selected hosted folder', async () => {
    render(JoinedTeamTree);
    expect(screen.getByText('Micah')).toBeTruthy();
    const folder = screen.getByRole('button', { name: 'Open shared folder koryphaios from Micah' });
    expect(screen.getByRole('button', { name: 'Open shared folder docs from Micah' })).toBeTruthy();
    await fireEvent.click(folder);
    expect(store.openJoinedSession).toHaveBeenCalledWith('team-1', 'workspace-1');
    await fireEvent.click(screen.getByRole('button', { name: 'Collapse Micah shared folders' }));
    expect(screen.queryByText('koryphaios')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Expand Micah shared folders' }));
    expect(screen.getByText('koryphaios')).toBeTruthy();
  });
});
