import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const archivedChat = {
  id: 'archived-1',
  title: 'Archived architecture',
  workingDirectory: '/tmp/kory-project',
  messageCount: 12,
  totalTokensIn: 100,
  totalTokensOut: 80,
  totalCost: 0.2,
  version: 2,
  status: 'archived' as const,
  archivedAt: new Date('2026-08-20T12:00:00Z').getTime(),
  createdAt: new Date('2026-08-01T12:00:00Z').getTime(),
  updatedAt: new Date('2026-08-19T12:00:00Z').getTime(),
};

const mocks = vi.hoisted(() => ({
  sessionStore: {
    archivedSessions: [] as (typeof archivedChat)[],
    archivedLoading: false,
    archivedError: null as string | null,
    fetchArchivedSessions: vi.fn(async () => true),
    restoreSession: vi.fn(async () => true),
    renameSession: vi.fn(async () => true),
    deleteSession: vi.fn(async () => true),
  },
}));

vi.mock('$lib/stores/sessions.svelte', () => ({ sessionStore: mocks.sessionStore }));
vi.mock('$lib/stores/project.svelte', () => ({
  projectDisplayName: (path: string) => path.split('/').at(-1) ?? path,
}));

import ArchivedChatsSettings from './ArchivedChatsSettings.svelte';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sessionStore.archivedSessions = [archivedChat];
  mocks.sessionStore.archivedLoading = false;
  mocks.sessionStore.archivedError = null;
});

afterEach(() => cleanup());

describe('ArchivedChatsSettings', () => {
  it('shows precise metadata and visible restore, rename, and delete actions', async () => {
    render(ArchivedChatsSettings);

    expect(screen.getByRole('heading', { name: 'Archived chats' })).toBeVisible();
    expect(screen.getByRole('searchbox', { name: 'Search archived chats' })).toBeVisible();
    expect(screen.getByText('Archived architecture')).toBeVisible();
    expect(screen.getByText('kory-project')).toBeVisible();
    expect(screen.getByText(/Updated/)).toBeVisible();
    expect(
      screen.getByTitle(
        new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
          archivedChat.archivedAt,
        ),
      ),
    ).toBeVisible();
    expect(screen.getByText('12 messages')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Restore Archived architecture' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Rename Archived architecture' })).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Delete Archived architecture permanently' }),
    ).toBeVisible();
    await waitFor(() => expect(mocks.sessionStore.fetchArchivedSessions).toHaveBeenCalledOnce());
  });

  it('validates inline rename, restores without confirmation, and confirms permanent deletion', async () => {
    render(ArchivedChatsSettings);

    await fireEvent.click(screen.getByRole('button', { name: 'Rename Archived architecture' }));
    const titleInput = screen.getByRole('textbox', { name: 'Rename Archived architecture' });
    await fireEvent.input(titleInput, { target: { value: '   ' } });
    await fireEvent.click(
      screen.getByRole('button', { name: 'Save renamed chat Archived architecture' }),
    );
    expect(screen.getByText('Chat name cannot be empty.')).toBeVisible();
    expect(mocks.sessionStore.renameSession).not.toHaveBeenCalled();

    await fireEvent.input(titleInput, { target: { value: 'Recovered architecture' } });
    await fireEvent.click(
      screen.getByRole('button', { name: 'Save renamed chat Archived architecture' }),
    );
    await waitFor(() =>
      expect(mocks.sessionStore.renameSession).toHaveBeenCalledWith(
        'archived-1',
        'Recovered architecture',
      ),
    );

    await fireEvent.click(screen.getByRole('button', { name: 'Restore Archived architecture' }));
    expect(mocks.sessionStore.restoreSession).toHaveBeenCalledWith('archived-1');
    expect(screen.queryByRole('alertdialog')).toBeNull();

    await fireEvent.click(
      screen.getByRole('button', { name: 'Delete Archived architecture permanently' }),
    );
    expect(screen.getByRole('alertdialog')).toBeVisible();
    expect(
      screen.getByRole('heading', { name: 'Permanently delete archived chat?' }),
    ).toBeVisible();
    await fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));
    await waitFor(() =>
      expect(mocks.sessionStore.deleteSession).toHaveBeenCalledWith('archived-1'),
    );
  });

  it('shows a truthful load error with a retry action', async () => {
    mocks.sessionStore.archivedSessions = [];
    mocks.sessionStore.archivedError = 'Archive index unavailable';
    render(ArchivedChatsSettings);

    expect(screen.getByRole('alert')).toHaveTextContent('Archive index unavailable');
    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(mocks.sessionStore.fetchArchivedSessions).toHaveBeenCalledTimes(2);
  });

  it('keeps stale rows visible while making a failed refresh explicit', () => {
    mocks.sessionStore.archivedError = 'Refresh timed out';
    render(ArchivedChatsSettings);

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Refresh timed out The last loaded results are still shown below.',
    );
    expect(screen.getByText('Archived architecture')).toBeVisible();
  });
});
