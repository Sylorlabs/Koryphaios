import { fireEvent, render, screen } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const now = Date.now();

const mocks = vi.hoisted(() => ({
  sessionStore: {
    sessionsForProject: vi.fn((path: string) =>
      path === '/ws/with-chats'
        ? [
            { id: 's1', workingDirectory: path, updatedAt: Date.now() - 60_000 },
            { id: 's2', workingDirectory: path, updatedAt: Date.now() - 3_600_000 },
          ]
        : [],
    ),
  },
  projectStore: {
    workspaceRoot: '/ws' as string | null,
    workspaceProjects: [] as Array<{ path: string; name: string; modifiedAt: number }>,
  },
}));

vi.mock('$lib/stores/sessions.svelte', () => ({ sessionStore: mocks.sessionStore }));
vi.mock('$lib/stores/project.svelte', () => ({
  projectStore: mocks.projectStore,
  projectDisplayName: (path: string | null) => path?.split('/').at(-1) ?? '',
}));

import WorkspaceNewChat from './WorkspaceNewChat.svelte';

/** Folder cards are the buttons inside the "Workspace folders" list. */
function folderCards(): HTMLElement[] {
  const list = screen.queryByRole('list', { name: 'Workspace folders' });
  return list ? Array.from(list.querySelectorAll<HTMLElement>('button')) : [];
}

function renderPicker() {
  const onSelectFolder = vi.fn(async () => undefined);
  const onBrowseFolder = vi.fn();
  const onOpenWorkspace = vi.fn();
  const onNewProject = vi.fn();
  const result = render(WorkspaceNewChat, {
    props: { onSelectFolder, onBrowseFolder, onOpenWorkspace, onNewProject },
  });
  return { ...result, onSelectFolder, onBrowseFolder, onOpenWorkspace, onNewProject };
}

describe('WorkspaceNewChat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projectStore.workspaceRoot = '/ws';
    mocks.projectStore.workspaceProjects = [
      { path: '/ws/zeta', name: 'zeta', modifiedAt: now - 10 * 86_400_000 },
      { path: '/ws/with-chats', name: 'with-chats', modifiedAt: now - 30 * 86_400_000 },
      { path: '/ws/alpha', name: 'alpha', modifiedAt: now - 86_400_000 },
    ];
  });

  it('shows the workspace name and every folder, chatted folders first', () => {
    renderPicker();

    expect(screen.getByRole('heading', { name: 'New chat in ws' })).toBeVisible();
    const items = folderCards();
    expect(items.map((item) => item.getAttribute('title'))).toEqual([
      '/ws/with-chats',
      '/ws/alpha',
      '/ws/zeta',
    ]);
    expect(items[0]).toHaveTextContent('2 chats');
    expect(items[1]).toHaveTextContent('No chats yet');
  });

  it('selects a folder when its card is clicked', async () => {
    const { onSelectFolder } = renderPicker();

    await fireEvent.click(screen.getByRole('button', { name: /Start a new chat in alpha/ }));
    expect(onSelectFolder).toHaveBeenCalledWith('/ws/alpha');
  });

  it('filters folders by search and opens the first match on Enter', async () => {
    const { onSelectFolder } = renderPicker();
    const search = screen.getByRole('searchbox', { name: 'Search workspace folders' });

    await fireEvent.input(search, { target: { value: 'zet' } });
    expect(folderCards()).toHaveLength(1);
    expect(folderCards()[0]).toHaveTextContent('zeta');

    await fireEvent.keyDown(search, { key: 'Enter' });
    expect(onSelectFolder).toHaveBeenCalledWith('/ws/zeta');

    await fireEvent.input(search, { target: { value: 'nothing-here' } });
    expect(folderCards()).toHaveLength(0);
    expect(screen.getByText(/No folders match/)).toBeVisible();
  });

  it('offers the workspace root and the other entry points', async () => {
    const { onSelectFolder, onBrowseFolder, onOpenWorkspace, onNewProject } = renderPicker();

    await fireEvent.click(screen.getByRole('button', { name: /Start a new chat in ws itself/ }));
    expect(onSelectFolder).toHaveBeenCalledWith('/ws');

    await fireEvent.click(screen.getByRole('button', { name: /Browse other folder/ }));
    expect(onBrowseFolder).toHaveBeenCalledTimes(1);
    await fireEvent.click(screen.getByRole('button', { name: /New project/ }));
    expect(onNewProject).toHaveBeenCalledTimes(1);
    await fireEvent.click(screen.getByRole('button', { name: 'Switch workspace' }));
    expect(onOpenWorkspace).toHaveBeenCalledTimes(1);
  });

  it('never lists the workspace root itself as a folder card', () => {
    mocks.projectStore.workspaceProjects = [
      { path: '/ws', name: 'ws', modifiedAt: now },
      { path: '/ws/alpha', name: 'alpha', modifiedAt: now },
    ];
    renderPicker();

    expect(folderCards()).toHaveLength(1);
    expect(folderCards()[0]).toHaveTextContent('alpha');
  });
});
