import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { tick } from 'svelte';

const mocks = vi.hoisted(() => ({
  status: {
    local: { id: 'local', name: 'My Mac', os: 'macOS' },
    peers: [
      { id: 'windows', name: 'Windows desktop', os: 'Windows', kind: 'desktop', online: true },
      { id: 'linux', name: 'Linux desktop', os: 'Linux', kind: 'desktop', online: true },
    ],
  },
  workspaces: vi.fn(),
  browseFolders: vi.fn(),
  rpc: vi.fn(),
  openChat: vi.fn(),
  closeCreator: vi.fn(),
  closeJoinedSession: vi.fn(),
  creatorMode: 'chat' as 'chat' | 'project' | 'workspace',
}));
vi.mock('$lib/stores/devices.svelte', () => ({
  deviceStore: {
    createOpen: true,
    ...mocks,
    get status() {
      return mocks.status;
    },
    get creatorMode() {
      return mocks.creatorMode;
    },
  },
}));
vi.mock('$lib/stores/sessions.svelte', () => ({ sessionStore: { fetchSessions: vi.fn() } }));
vi.mock('$lib/stores/collaboration.svelte', () => ({
  collaborationStore: { closeJoinedSession: mocks.closeJoinedSession },
}));
import DeviceNewChat from './DeviceNewChat.svelte';
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.status.peers = [
    { id: 'windows', name: 'Windows desktop', os: 'Windows', kind: 'desktop', online: true },
    { id: 'linux', name: 'Linux desktop', os: 'Linux', kind: 'desktop', online: true },
  ];
  mocks.creatorMode = 'chat';
});

test('hides the desktop chooser when this is the only desktop', async () => {
  mocks.status.peers = [];
  mocks.workspaces.mockResolvedValue([]);
  mocks.rpc.mockResolvedValue([]);

  render(DeviceNewChat);

  expect(screen.queryByRole('complementary', { name: 'Choose a device' })).toBeNull();
  await screen.findByRole('button', { name: 'Choose a local folder' });
});

test('switching devices during discovery cannot create a chat with another OS’s workspace or raw path', async () => {
  let finishWindows!: (roots: unknown[]) => void;
  const windows = new Promise((resolve) => {
    finishWindows = resolve;
  });
  mocks.workspaces.mockImplementation((id) =>
    id === 'windows'
      ? windows
      : Promise.resolve([
          { id: 'linux-workspace', name: 'Linux project', displayPath: '/srv/project' },
        ]),
  );
  mocks.rpc.mockImplementation(async (id, operation) =>
    operation === 'sessions'
      ? []
      : {
          id: 'remote-chat',
          title: 'New chat',
          deviceId: id,
          deviceName: 'Linux desktop',
          workspaceName: 'Linux project',
        },
  );
  render(DeviceNewChat);
  await fireEvent.click(await screen.findByRole('button', { name: /Windows desktop/ }));
  await fireEvent.click(screen.getByRole('button', { name: /Linux desktop/ }));
  await screen.findByRole('button', { name: /Linux project \/srv\/project/ });
  finishWindows([
    { id: 'windows-workspace', name: 'Windows project', displayPath: 'C:\\Users\\Me\\project' },
  ]);
  await tick();
  expect(screen.queryByText('Windows project')).toBeNull();
  await fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
  await waitFor(() => expect(mocks.openChat).toHaveBeenCalled());
  expect(mocks.rpc).toHaveBeenCalledWith('linux', 'create_chat', {
    workspaceId: 'linux-workspace',
  });
  expect(mocks.rpc).not.toHaveBeenCalledWith('windows', 'create_chat', expect.anything());
  expect(mocks.closeCreator).toHaveBeenCalledOnce();
});

test('Escape cancels the new-chat dialog without creating or switching chats', async () => {
  render(DeviceNewChat);
  const dialog = await screen.findByRole('dialog');
  await fireEvent(dialog, new Event('cancel'));
  expect(mocks.closeCreator).toHaveBeenCalledOnce();
  expect(mocks.openChat).not.toHaveBeenCalled();
  expect(mocks.rpc).not.toHaveBeenCalled();
});

test('every desktop offers folder browsing and a nested folder is explicitly chosen before creation', async () => {
  mocks.workspaces.mockResolvedValue([]);
  mocks.rpc.mockImplementation(async (id, operation) =>
    operation === 'sessions'
      ? []
      : { id: 'chat', deviceId: id, title: 'New chat', workspaceName: 'Project' },
  );
  const home = { id: 'browse:home', name: 'Me', displayPath: 'C:\\Users\\Me' };
  const project = { id: 'browse:project', name: 'Project', displayPath: 'C:\\Users\\Me\\Project' };
  mocks.browseFolders.mockImplementation(async (_id, folderId) =>
    folderId === project.id
      ? { current: project, parent: home, folders: [] }
      : { current: home, parent: null, folders: [project] },
  );
  render(DeviceNewChat);
  await fireEvent.click(screen.getByRole('button', { name: /My Mac/ }));
  await screen.findByRole('button', { name: 'Choose a local folder' });
  expect(screen.queryByText('Start a chat without a folder')).toBeNull();
  await fireEvent.click(screen.getByRole('button', { name: /Windows desktop/ }));
  await fireEvent.click(
    await screen.findByRole('button', { name: 'Choose a local folder on Windows desktop' }),
  );
  await fireEvent.click(
    await screen.findByRole('button', { name: /Project C:\\Users\\Me\\Project/ }),
  );
  await screen.findByRole('button', { name: 'Up one folder' });
  expect(mocks.rpc).not.toHaveBeenCalledWith('windows', 'create_chat', expect.anything());
  await fireEvent.click(screen.getByRole('button', { name: 'New chat in Project' }));
  await waitFor(() => expect(mocks.openChat).toHaveBeenCalled());
  expect(mocks.browseFolders).toHaveBeenCalledWith('windows', project.id);
  expect(mocks.rpc).toHaveBeenCalledWith('windows', 'create_chat', { workspaceId: project.id });
});

test('switching desktops discards an in-flight folder browser response', async () => {
  mocks.workspaces.mockResolvedValue([]);
  mocks.rpc.mockResolvedValue([]);
  let finish!: (value: unknown) => void;
  mocks.browseFolders.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  render(DeviceNewChat);
  await fireEvent.click(screen.getByRole('button', { name: /Windows desktop/ }));
  await fireEvent.click(
    await screen.findByRole('button', { name: 'Choose a local folder on Windows desktop' }),
  );
  await fireEvent.click(screen.getByRole('button', { name: /Linux desktop/ }));
  await screen.findByRole('button', { name: 'Choose a local folder on Linux desktop' });
  finish({
    current: { id: 'wrong-device', name: 'Windows folder', displayPath: 'C:\\project' },
    parent: null,
    folders: [],
  });
  await tick();
  expect(screen.queryByText('Windows folder')).toBeNull();
  expect(screen.queryByRole('button', { name: /New chat in/ })).toBeNull();
});

test('project and workspace modes use the native in-app folder finder', async () => {
  mocks.creatorMode = 'project';
  const home = { id: 'browse:home', name: 'Me', displayPath: '/Users/me' };
  const project = { id: 'browse:project', name: 'Project', displayPath: '/Users/me/Project' };
  mocks.browseFolders.mockImplementation(async (_id, folderId) =>
    folderId === project.id
      ? { current: project, parent: home, folders: [] }
      : { current: home, parent: null, folders: [project] },
  );
  const onSelectFolder = vi.fn(async () => undefined);

  render(DeviceNewChat, { props: { onSelectFolder } });

  await screen.findByRole('button', { name: /Project \/Users\/me\/Project/ });
  await fireEvent.click(screen.getByRole('button', { name: /Project \/Users\/me\/Project/ }));
  await fireEvent.click(await screen.findByRole('button', { name: 'Choose project' }));

  expect(onSelectFolder).toHaveBeenCalledWith('/Users/me/Project', 'project');
  expect(mocks.browseFolders).toHaveBeenCalledWith('local', 'browse:project');
});
