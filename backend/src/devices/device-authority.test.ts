import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DeviceService } from './service';
import { setDeviceWorkbenchHandler } from './workbench';
import { makeDeviceIdentity } from '@koryphaios/shared/src/device-client';
import type { LinkedDevice } from '@koryphaios/shared/src/devices';
import { setContext, type AppContext } from '../context';
import { WorkspaceNavigationStore } from '../stores/workspace-navigation-store';
import { getDb } from '../db';
import { getOrderedEventLog } from '../ws/ordered-event-log';
import type { WSMessage } from '@koryphaios/shared';
import { ControlLinkedDeviceTool, ListLinkedDevicesTool } from '../tools/devices';
import { toolApprovalQueue } from '../tools/approval-queue';
import type { ToolContext } from '../tools/registry';

let root: string;
let service: DeviceService;
let peer: LinkedDevice;
let creations = 0;
let prompts = 0;
const previous = process.env.KORYPHAIOS_REMOTE_WORKSPACE;
beforeEach(async () => {
  creations = 0;
  prompts = 0;
  root = mkdtempSync(join(tmpdir(), 'device-authority-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  process.env.KORYPHAIOS_REMOTE_WORKSPACE = workspace;
  service = new DeviceService(join(root, 'state'), '');
  await service.initialize();
  service.stop();
  const remote = await makeDeviceIdentity('Other desktop', 'Windows', 'desktop');
  peer = { ...remote.identity, linkedAt: Date.now(), online: true, allowAgents: false };
  const path = join(root, 'state', '.koryphaios', 'linked-devices.json');
  const state = JSON.parse(readFileSync(path, 'utf8'));
  state.peers = [peer];
  writeFileSync(path, JSON.stringify(state));
  service = new DeviceService(join(root, 'state'), '');
  await service.initialize();
  setDeviceWorkbenchHandler(() => Response.json({ ok: true, data: { target: true } }));
  setContext({
    sessions: {
      create: async () => {
        creations++;
        return { id: `chat-${creations}`, title: 'New chat', workingDirectory: workspace };
      },
      getActive: async (id: string) => ({ id, title: 'Chat', workingDirectory: workspace }),
    },
    kory: {
      startSessionTurn: async () => {
        prompts++;
        return { accepted: true, runId: 'run', completion: Promise.resolve() };
      },
    },
    wsManager: { onSessionEvent: () => () => {} },
  } as unknown as AppContext);
});
afterEach(() => {
  setDeviceWorkbenchHandler(undefined);
  service.stop();
  rmSync(root, { recursive: true, force: true });
  if (previous === undefined) delete process.env.KORYPHAIOS_REMOTE_WORKSPACE;
  else process.env.KORYPHAIOS_REMOTE_WORKSPACE = previous;
  new WorkspaceNavigationStore(getDb()).clear();
});

test('mutating command claims survive restart and private state has owner-only permissions', async () => {
  const id = crypto.randomUUID();
  const input = { workspaceId: service.workspaces()[0]!.id };
  await service.execute(peer, 'create_chat', input, 'user', id);
  expect(creations).toBe(1);
  service.stop();
  service = new DeviceService(join(root, 'state'), '');
  await service.initialize();
  await expect(service.execute(peer, 'create_chat', input, 'user', id)).rejects.toThrow(
    'already received',
  );
  expect(creations).toBe(1);
  expect(statSync(join(root, 'state', '.koryphaios', 'linked-devices.json')).mode & 0o777).toBe(
    0o600,
  );
  expect(statSync(join(root, 'state', '.koryphaios')).mode & 0o777).toBe(0o700);
});
test('inbound and outbound agent grants are independently off, and agents cannot approve decisions', async () => {
  await expect(
    service.execute(peer, 'workspaces', {}, 'agent', crypto.randomUUID()),
  ).rejects.toThrow('remote-agent access');
  await expect(service.rpc(peer.id, 'workspaces', {}, 'agent')).rejects.toThrow('not been enabled');
  service.grants(peer.id, true, false);
  expect(await service.execute(peer, 'workspaces', {}, 'agent', crypto.randomUUID())).toHaveLength(
    1,
  );
  await expect(service.rpc(peer.id, 'workspaces', {}, 'agent')).rejects.toThrow('not been enabled');
  for (const operation of ['answer', 'review', 'permission'])
    await expect(
      service.execute(peer, operation, { sessionId: 'chat' }, 'agent', crypto.randomUUID()),
    ).rejects.toThrow('Agents cannot approve');
  service.grants(peer.id, false, true);
  await expect(
    service.execute(peer, 'workspaces', {}, 'agent', crypto.randomUUID()),
  ).rejects.toThrow('remote-agent access');
});

test('user permission responses settle the target queue and map abstract decisions to target options', async () => {
  const pending = toolApprovalQueue.request(
    {
      sessionId: 'chat',
      agentId: 'worker',
      callerRole: 'worker',
      workingDirectory: join(root, 'workspace'),
    } as ToolContext,
    { id: 'call', name: 'bash', input: { command: 'bun test' } },
    'Run tests',
    ['Allow once', 'Reject'],
  );
  const permission = toolApprovalQueue.list('chat')[0]!;
  const result = await service.execute(
    peer,
    'permission',
    { sessionId: 'chat', permissionId: permission.id, selection: 'granted' },
    'user',
    crypto.randomUUID(),
  );
  expect(result).toEqual({ responded: true, permissionId: permission.id });
  await expect(pending).resolves.toBe('Allow once');
});
test('unlink rejects stale peer references before commands execute', async () => {
  await service.unlink(peer.id);
  await expect(
    service.execute(
      peer,
      'prompt',
      { sessionId: 'chat', content: 'change files' },
      'user',
      crypto.randomUUID(),
    ),
  ).rejects.toThrow('revoked');
  expect(prompts).toBe(0);
});

test('remote open snapshot captures its replay boundary before asynchronous reads', async () => {
  let releaseRecent!: (messages: unknown[]) => void;
  let notifyRecent!: () => void;
  const enteredRecent = new Promise<void>((resolve) => {
    notifyRecent = resolve;
  });
  const pendingRecent = new Promise<unknown[]>((resolve) => {
    releaseRecent = resolve;
  });
  const workspace = join(root, 'workspace');
  setContext({
    sessions: {
      getActive: async (id: string) => ({ id, title: 'Chat', workingDirectory: workspace }),
    },
    messages: {
      getRecent: async () => {
        notifyRecent();
        return pendingRecent;
      },
    },
    runs: { get: () => undefined },
    wsManager: { onSessionEvent: () => () => {} },
  } as unknown as AppContext);
  const boundary = { epoch: 3, latestSequence: 8 };
  const cursor = spyOn(getOrderedEventLog(), 'getCursor').mockReturnValue(boundary);
  try {
    const request = service.execute(
      peer,
      'open_chat',
      { sessionId: 'chat-a' },
      'user',
      crypto.randomUUID(),
    );
    await enteredRecent;
    const capturedBeforeMessages = cursor.mock.calls.length;
    releaseRecent([]);
    const result = await request;
    expect(capturedBeforeMessages).toBe(1);
    expect(result.eventCursor).toEqual(boundary);
  } finally {
    releaseRecent([]);
    cursor.mockRestore();
  }
});

test('invalid relay configuration preserves the active state and disabling persists across restart', async () => {
  const identity = service.status().local!.id;
  await expect(service.configureRelay('http://example.com')).rejects.toThrow('requires HTTPS');
  expect(service.status().peers).toHaveLength(1);
  await service.configureRelay('');
  service.stop();
  service = new DeviceService(join(root, 'state'), 'https://configured-relay.example.com');
  await service.initialize();
  expect(service.status().relayUrl).toBeNull();
  expect(service.status().connected).toBe(false);
  expect(service.status().local?.id).toBe(identity);
  expect(service.status().peers).toHaveLength(1);
});
test('activated-device access is enabled by default, persists, and blocks remote user RPC when disabled', async () => {
  expect(service.status().accountWideDeviceAccess).toBe(true);
  service.configureAccountWideDeviceAccess(false);
  expect(service.status().accountWideDeviceAccess).toBe(false);
  await expect(service.rpc(peer.id, 'workspaces', {}, 'user')).rejects.toThrow(
    'Access across linked devices is disabled',
  );

  service.stop();
  service = new DeviceService(join(root, 'state'), '');
  await service.initialize();
  expect(service.status().accountWideDeviceAccess).toBe(false);
  service.configureAccountWideDeviceAccess(true);
  expect(service.status().accountWideDeviceAccess).toBe(true);
});
test('mobile forwarding cannot bypass durable command deduplication', async () => {
  const mobile = { ...peer, kind: 'mobile' as const };
  const path = join(root, 'state', '.koryphaios', 'linked-devices.json');
  service.stop();
  const state = JSON.parse(readFileSync(path, 'utf8'));
  state.peers = [mobile];
  writeFileSync(path, JSON.stringify(state));
  service = new DeviceService(join(root, 'state'), '');
  await service.initialize();
  let calls = 0;
  service.rpc = async () => {
    calls++;
    return { accepted: true };
  };
  const id = crypto.randomUUID();
  const input = {
    deviceId: 'target',
    operation: 'prompt',
    input: { sessionId: 'chat', content: 'hello' },
  };
  await service.execute(mobile, 'forward', input, 'user', id);
  await expect(service.execute(mobile, 'forward', input, 'user', id)).rejects.toThrow(
    'already received',
  );
  expect(calls).toBe(1);
});
test('linked-device tools deny workers and plan-mode writes before reaching the target', async () => {
  const call = {
    id: 'call',
    name: 'control_linked_device',
    input: { deviceId: peer.id, operation: 'prompt', input: { content: 'write' } },
  };
  expect(
    (
      await new ControlLinkedDeviceTool().run(
        { callerRole: 'worker', sessionId: 'chat' } as ToolContext,
        call,
      )
    ).isError,
  ).toBe(true);
  expect(
    (
      await new ListLinkedDevicesTool().run(
        { callerRole: 'worker', sessionId: 'chat' } as ToolContext,
        { id: 'list', name: 'list_linked_devices', input: {} },
      )
    ).isError,
  ).toBe(true);
  const result = await new ControlLinkedDeviceTool().run(
    {
      callerRole: 'manager',
      sessionId: 'chat',
      permissionPolicy: { mode: 'guarded', interactionMode: 'plan' },
    } as ToolContext,
    call,
  );
  expect(result.isError).toBe(true);
  expect(result.output).toContain('Planning mode');
  expect(prompts).toBe(0);
});

test('user folder browsing reaches nested local folders with peer-bound handles and remembers only the chosen project', async () => {
  const outside = join(realpathSync(root), 'outside');
  const nested = join(outside, 'nested');
  mkdirSync(nested, { recursive: true });
  let createdRoot = '';
  setContext({
    sessions: {
      create: async (_user: string, title: string, _model: unknown, workingDirectory: string) => {
        createdRoot = workingDirectory;
        return { id: 'chosen-chat', title, workingDirectory };
      },
      getActive: async () => ({
        id: 'chosen-chat',
        title: 'New chat',
        workingDirectory: createdRoot,
      }),
    },
    wsManager: { onSessionEvent: () => () => {} },
  } as unknown as AppContext);
  const browse = (workspaceId: string) =>
    service.execute(peer, 'browse_folders', { workspaceId }, 'user', crypto.randomUUID());
  const initial = await browse(service.workspaces()[0]!.id);
  const parent = await browse(initial.parent.id);
  const outsideListing = await browse(parent.folders.find((f: any) => f.name === 'outside').id);
  const chosen = await browse(outsideListing.folders.find((f: any) => f.name === 'nested').id);
  expect(chosen.current.displayPath).toBe(nested);
  expect(service.workspaces()).toHaveLength(1);
  await expect(
    service.execute(
      null,
      'create_chat',
      { workspaceId: chosen.current.id },
      'user',
      crypto.randomUUID(),
    ),
  ).rejects.toThrow('unavailable');
  service.grants(peer.id, true, false);
  await expect(
    service.execute(peer, 'browse_folders', {}, 'agent', crypto.randomUUID()),
  ).rejects.toThrow('Only users');
  await expect(
    service.execute(
      peer,
      'create_chat',
      { workspaceId: chosen.current.id },
      'agent',
      crypto.randomUUID(),
    ),
  ).rejects.toThrow('Only users');
  await expect(browse('C:\\Users\\Other\\project')).rejects.toThrow('unavailable');
  await expect(
    service.execute(peer, 'create_chat', {}, 'user', crypto.randomUUID()),
  ).rejects.toThrow('Select a workspace');
  await service.execute(
    peer,
    'create_chat',
    { workspaceId: chosen.current.id },
    'user',
    crypto.randomUUID(),
  );
  expect(createdRoot).toBe(nested);
  expect(service.workspaces().some((folder) => folder.displayPath === nested)).toBe(true);
  expect(service.workspaces().some((folder) => folder.displayPath === outside)).toBe(false);
  const remembered = service.workspaces().find((folder) => folder.displayPath === nested)!;
  service.stop();
  service = new DeviceService(join(root, 'state'), '');
  await service.initialize();
  expect(service.workspaces().some((folder) => folder.id === remembered.id)).toBe(true);
  await service.execute(
    peer,
    'close_chat',
    { sessionId: 'chosen-chat' },
    'user',
    crypto.randomUUID(),
  );
});

test('linked mobile workbench is user-only and revocation invalidates the controller immediately', async () => {
  const mobile = { ...peer, kind: 'mobile' as const };
  const path = join(root, 'state', '.koryphaios', 'linked-devices.json');
  service.stop();
  const state = JSON.parse(readFileSync(path, 'utf8'));
  state.peers = [mobile];
  writeFileSync(path, JSON.stringify(state));
  service = new DeviceService(join(root, 'state'), '');
  await service.initialize();

  await expect(
    service.execute(mobile, 'workbench', { path: '/api/appearance' }, 'user', crypto.randomUUID()),
  ).resolves.toMatchObject({ status: 200 });

  service.grants(mobile.id, true, false);
  await expect(
    service.execute(mobile, 'workbench', { path: '/api/appearance' }, 'agent', crypto.randomUUID()),
  ).rejects.toThrow('Only a linked user');

  await service.unlink(mobile.id);
  await expect(
    service.execute(mobile, 'workbench', { path: '/api/appearance' }, 'user', crypto.randomUUID()),
  ).rejects.toThrow('revoked');
});

test('events replay: a cursor below the prune mark gets the history_pruned marker first and replays from the mark without an epoch change', async () => {
  const log = getOrderedEventLog();
  const cursor = spyOn(log, 'getCursor').mockReturnValue({ epoch: 2, latestSequence: 150 });
  const mark = spyOn(log, 'getPruneMark').mockReturnValue({ epoch: 2, sequence: 100 });
  const retained = {
    type: 'stream.delta',
    sessionId: 'chat-a',
    epoch: 2,
    sequence: 101,
    timestamp: 1,
    payload: null,
  } as unknown as WSMessage;
  const getAfter = spyOn(log, 'getAfter').mockReturnValue([retained]);
  try {
    for (const from of [
      { epoch: 2, sequence: 40 },
      { epoch: 1, sequence: 500 },
    ]) {
      getAfter.mockClear();
      const result = (await service.execute(
        peer,
        'events',
        { sessionId: 'chat-a', ...from },
        'user',
        crypto.randomUUID(),
      )) as Array<Record<string, unknown>>;
      expect(getAfter).toHaveBeenCalledWith('chat-a', 2, 100, 100);
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        type: 'session.history_pruned',
        sessionId: 'chat-a',
        epoch: 2,
        payload: { epoch: 2, throughSequence: 100 },
      });
      expect(result[0]).not.toHaveProperty('sequence');
      expect(result[1]).toMatchObject({ sequence: 101, epoch: 2, replayed: true });
    }
  } finally {
    cursor.mockRestore();
    mark.mockRestore();
    getAfter.mockRestore();
  }
});

test('events replay: a cursor at or above the prune mark replays unchanged with no marker', async () => {
  const log = getOrderedEventLog();
  const cursor = spyOn(log, 'getCursor').mockReturnValue({ epoch: 2, latestSequence: 150 });
  const mark = spyOn(log, 'getPruneMark').mockReturnValue({ epoch: 2, sequence: 100 });
  const getAfter = spyOn(log, 'getAfter').mockReturnValue([]);
  try {
    const result = await service.execute(
      peer,
      'events',
      { sessionId: 'chat-a', epoch: 2, sequence: 120 },
      'user',
      crypto.randomUUID(),
    );
    expect(getAfter).toHaveBeenCalledWith('chat-a', 2, 120, 100);
    expect(result).toEqual([]);
  } finally {
    cursor.mockRestore();
    mark.mockRestore();
    getAfter.mockRestore();
  }
});
