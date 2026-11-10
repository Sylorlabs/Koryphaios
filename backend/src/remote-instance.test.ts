import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_COLLABORATION_POLICY } from '@koryphaios/shared';

const chat = {
  id: 'durable-chat',
  gitWorkspace: { path: '/remote/isolated-checkout' },
};
const create = mock(async () => chat);
const get = mock(async () => chat);
const update = mock(async () => chat);
const hostSession = mock(async (_id: string, _owner: string, _paths: string[], _name: string) => ({
  id: 'live-host',
  joinCode: 'ABCDEFGH',
  relayEnabled: true,
  policy: DEFAULT_COLLABORATION_POLICY,
}));
const updatePolicy = mock(async (_id: string, policy: object) => ({
  ...DEFAULT_COLLABORATION_POLICY,
  ...policy,
}));

mock.module('./context', () => ({
  getContext: () => ({
    sessions: { create, get, update },
    wsManager: { onSessionEvent: () => () => {} },
  }),
}));
mock.module('./collaboration/manager', () => ({
  collaborationManager: { hostSession, updatePolicy },
}));
const { startRemoteInstanceHost, stopRemoteInstanceHost } = await import('./remote-instance');

const variables = [
  'KORYPHAIOS_REMOTE_CONTROL',
  'KORYPHAIOS_REMOTE_CONTROL_STATE_FILE',
  'KORYPHAIOS_REMOTE_WORKSPACE',
  'RELAY_URL',
  'RELAY_HOST_SECRET',
] as const;
const previous = Object.fromEntries(variables.map((name) => [name, process.env[name]]));
let root: string;
let path: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'remote-host-test-'));
  path = join(root, 'state', 'remote-control.json');
  process.env.KORYPHAIOS_REMOTE_CONTROL = 'true';
  process.env.KORYPHAIOS_REMOTE_CONTROL_STATE_FILE = path;
  process.env.KORYPHAIOS_REMOTE_WORKSPACE = join(root, 'workspace');
  process.env.RELAY_URL = 'https://relay.example.invalid';
  process.env.RELAY_HOST_SECRET = 'test-relay-secret';
  create.mockClear();
  get.mockClear();
  hostSession.mockClear();
  updatePolicy.mockClear();
});

afterEach(async () => {
  await stopRemoteInstanceHost();
  for (const name of variables) {
    if (previous[name] === undefined) delete process.env[name];
    else process.env[name] = previous[name];
  }
  await rm(root, { recursive: true, force: true });
});

test('ordinary startup never creates a chat or contacts the relay', async () => {
  delete process.env.KORYPHAIOS_REMOTE_CONTROL;
  expect(await startRemoteInstanceHost()).toBeNull();
  expect(create).not.toHaveBeenCalled();
  expect(hostSession).not.toHaveBeenCalled();
});

test('missing relay configuration fails before creating state or a chat', async () => {
  delete process.env.RELAY_HOST_SECRET;
  await expect(startRemoteInstanceHost()).rejects.toThrow('requires RELAY_URL');
  expect(create).not.toHaveBeenCalled();
  expect(await Bun.file(path).exists()).toBe(false);
});

test('restart reuses the chat and records the actual isolated execution checkout privately', async () => {
  await startRemoteInstanceHost();
  await startRemoteInstanceHost();
  expect(create).toHaveBeenCalledTimes(1);
  expect(get).toHaveBeenCalledWith(chat.id);
  expect(hostSession.mock.calls[1]?.[2]).toEqual([chat.gitWorkspace.path]);
  const state = JSON.parse(await readFile(path, 'utf8'));
  expect(state.baseSessionId).toBe(chat.id);
  expect(state.workspacePath).toBe(chat.gitWorkspace.path);
  expect(state.joinCode).toBe('ABCDEFGH');
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(await readFile(path, 'utf8')).not.toContain('test-relay-secret');
});

test('relay failure clears the old code while retaining chat identity for retry', async () => {
  await startRemoteInstanceHost();
  hostSession.mockImplementationOnce(async () => ({
    id: 'failed-host',
    joinCode: 'legacy',
    relayEnabled: false,
    policy: DEFAULT_COLLABORATION_POLICY,
  }));
  await expect(startRemoteInstanceHost()).rejects.toThrow('live collaboration relay host');
  const state = JSON.parse(await readFile(path, 'utf8'));
  expect(state.joinCode).toBeNull();
  expect(state.baseSessionId).toBe(chat.id);
  expect(updatePolicy).toHaveBeenCalledTimes(1);
  await startRemoteInstanceHost();
  expect(create).toHaveBeenCalledTimes(1);
});
