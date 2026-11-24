import { afterEach, expect, test } from 'bun:test';
import { DeviceRelay } from '../../../relay/devices';
import { DeviceClient, makeDeviceIdentity } from '@koryphaios/shared/src/device-client';
import {
  openDeviceMessage,
  sealDeviceMessage,
  type LinkedDevice,
} from '@koryphaios/shared/src/devices';

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});
async function wait(predicate: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error('Device event timed out');
}
function relay() {
  const router = new DeviceRelay();
  const server = Bun.serve<any>({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (req, srv) =>
      (await router.fetch(req, srv)) ?? new Response('Not found', { status: 404 }),
    websocket: {
      open: (ws) => router.open(ws),
      message: (ws, message) => router.message(ws, message),
      close: (ws) => router.close(ws),
    },
  });
  stops.push(() => server.stop(true));
  return `http://127.0.0.1:${server.port}`;
}

test('encrypted envelopes reject substitution, tampering, wrong recipients, and expired messages', async () => {
  const a = await makeDeviceIdentity('Work Mac', 'macOS', 'desktop');
  const b = await makeDeviceIdentity('Build Linux', 'Linux', 'desktop');
  const attacker = await makeDeviceIdentity('Attacker', 'Windows', 'desktop');
  const body = { type: 'request', operation: 'prompt', content: 'private project instructions' };
  const envelope = await sealDeviceMessage(a.privateKey, b.identity, a.identity.id, body);
  expect(envelope.ciphertext).not.toContain('private project');
  expect(await openDeviceMessage(b.privateKey, a.identity, b.identity.id, envelope)).toEqual(body);
  await expect(
    openDeviceMessage(b.privateKey, attacker.identity, b.identity.id, envelope),
  ).rejects.toThrow();
  await expect(
    openDeviceMessage(b.privateKey, a.identity, attacker.identity.id, envelope),
  ).rejects.toThrow();
  await expect(
    openDeviceMessage(b.privateKey, a.identity, b.identity.id, {
      ...envelope,
      ciphertext: envelope.ciphertext.replace(/^./, envelope.ciphertext[0] === 'A' ? 'B' : 'A'),
    }),
  ).rejects.toThrow();
  await expect(
    openDeviceMessage(
      b.privateKey,
      a.identity,
      b.identity.id,
      envelope,
      envelope.timestamp + 121_000,
    ),
  ).rejects.toThrow();
});

test('code pairing requires matching commit/reveal verification and explicit host consent; unlink removes authority', async () => {
  const url = relay();
  const a = await makeDeviceIdentity('Work Mac', 'macOS', 'desktop');
  const b = await makeDeviceIdentity('Build Linux', 'Linux', 'desktop');
  const aPeers: LinkedDevice[] = [];
  const bPeers: LinkedDevice[] = [];
  const approvals: any[] = [];
  let executions = 0;
  const host = new DeviceClient({
    relayUrl: url,
    ...a,
    peers: () => aPeers,
    onPairRequest: (r) => approvals.push(r),
    onPaired: async (identity) => {
      aPeers.push({ ...identity, linkedAt: Date.now(), online: true, allowAgents: false });
    },
    onRequest: async () => {
      executions++;
      return { os: 'macOS', workspaceId: 'opaque-host-id' };
    },
  });
  const guest = new DeviceClient({
    relayUrl: url,
    ...b,
    peers: () => bPeers,
    onPairRequest: () => {},
    onPaired: async (identity) => {
      bPeers.push({ ...identity, linkedAt: Date.now(), online: true, allowAgents: false });
    },
    onRequest: async () => null,
  });
  stops.push(
    () => host.stop(),
    () => guest.stop(),
  );
  await host.connect();
  await guest.connect();
  const invite = await host.invite();
  expect(invite.code.replace(/-/g, '')).toHaveLength(20);
  // Knowing a host's public identity or a code cannot execute a command.
  await guest.send(a.identity, {
    type: 'request',
    requestId: crypto.randomUUID(),
    operation: 'prompt',
    input: { content: 'unauthorized' },
  });
  await Bun.sleep(30);
  expect(executions).toBe(0);
  const pairing = await guest.pair(invite.code);
  await wait(() => approvals.length === 1);
  expect(pairing.check).toBe(approvals[0].check);
  expect(aPeers).toHaveLength(0);
  expect(bPeers).toHaveLength(0);
  await host.decidePair(b.identity.id, true);
  await wait(() => bPeers.length === 1);
  expect(await guest.rpc(a.identity.id, 'workspaces')).toEqual({
    os: 'macOS',
    workspaceId: 'opaque-host-id',
  });
  expect(executions).toBe(1);
  // The same signed/encrypted frame cannot execute twice, even concurrently.
  const replay = await sealDeviceMessage(b.privateKey, a.identity, b.identity.id, {
    type: 'request',
    requestId: crypto.randomUUID(),
    operation: 'workspaces',
    input: {},
  });
  const receive = (host as unknown as { receive: (raw: string) => Promise<void> }).receive.bind(
    host,
  );
  const raw = JSON.stringify({ type: 'envelope', identity: b.identity, envelope: replay });
  await Promise.all([receive(raw), receive(raw)]);
  await wait(() => executions === 2);
  aPeers.splice(0);
  await guest.send(a.identity, {
    type: 'request',
    requestId: crypto.randomUUID(),
    operation: 'prompt',
    input: { content: 'revoked' },
  });
  await Bun.sleep(40);
  expect(executions).toBe(2);
  await expect(guest.pair(invite.code)).rejects.toThrow('expired');
});

test('cancelling an invitation invalidates even an already verified approval candidate', async () => {
  const url = relay();
  const a = await makeDeviceIdentity('Host', 'Linux', 'desktop');
  const b = await makeDeviceIdentity('Guest', 'Windows', 'desktop');
  const requests: any[] = [];
  let linked = 0;
  const host = new DeviceClient({
    relayUrl: url,
    ...a,
    peers: () => [],
    onPairRequest: (r) => requests.push(r),
    onPaired: async () => {
      linked++;
    },
    onRequest: async () => null,
  });
  const guest = new DeviceClient({
    relayUrl: url,
    ...b,
    peers: () => [],
    onPairRequest: () => {},
    onPaired: async () => {
      linked++;
    },
    onRequest: async () => null,
  });
  stops.push(
    () => host.stop(),
    () => guest.stop(),
  );
  await Promise.all([host.connect(), host.connect(), guest.connect()]);
  const invite = await host.invite();
  await guest.pair(invite.code);
  await wait(() => requests.length === 1);
  await host.stopInvite();
  await expect(host.decidePair(b.identity.id, true)).rejects.toThrow('expired');
  expect(linked).toBe(0);
});

test('the relay reveals no device list and rate-limits code lookup', async () => {
  const url = relay();
  const response = await fetch(`${url}/devices/list`);
  expect(response.status).toBe(401);
  for (let i = 0; i < 10; i++)
    await fetch(`${url}/devices/pair/lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hash: 'a'.repeat(64) }),
    });
  const limited = await fetch(`${url}/devices/pair/lookup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hash: 'b'.repeat(64) }),
  });
  expect(limited.status).toBe(429);
});

test('a mobile gateway can await another desktop without blocking encrypted response delivery', async () => {
  const url = relay();
  const hostKeys = await makeDeviceIdentity('Gateway', 'macOS', 'desktop');
  const targetKeys = await makeDeviceIdentity('Target', 'Linux', 'desktop');
  const mobileKeys = await makeDeviceIdentity('Phone', 'iOS', 'mobile');
  const peer = (identity: any): LinkedDevice => ({
    ...identity,
    online: true,
    linkedAt: Date.now(),
    allowAgents: false,
  });
  const gateway: DeviceClient = new DeviceClient({
    relayUrl: url,
    ...hostKeys,
    peers: () => [peer(targetKeys.identity), peer(mobileKeys.identity)],
    onPairRequest: () => {},
    onPaired: async () => {},
    onRequest: async (_peer, operation, input): Promise<unknown> => {
      if (operation !== 'forward') throw new Error('Unsupported');
      return gateway.rpc(targetKeys.identity.id, String(input.operation));
    },
  });
  const target = new DeviceClient({
    relayUrl: url,
    ...targetKeys,
    peers: () => [peer(hostKeys.identity)],
    onPairRequest: () => {},
    onPaired: async () => {},
    onRequest: async () => ({ workspace: 'linux-owned-id' }),
  });
  const mobile = new DeviceClient({
    relayUrl: url,
    ...mobileKeys,
    peers: () => [peer(hostKeys.identity)],
    onPairRequest: () => {},
    onPaired: async () => {},
    onRequest: async () => null,
  });
  stops.push(
    () => gateway.stop(),
    () => target.stop(),
    () => mobile.stop(),
  );
  await Promise.all([gateway.connect(), target.connect(), mobile.connect()]);
  expect(await mobile.rpc(hostKeys.identity.id, 'forward', { operation: 'workspaces' })).toEqual({
    workspace: 'linux-owned-id',
  });
});

test('linked devices chunk encrypted RPC payloads larger than one device envelope in both directions', async () => {
  const url = relay();
  const hostKeys = await makeDeviceIdentity('Host', 'macOS', 'desktop');
  const mobileKeys = await makeDeviceIdentity('Phone', 'iOS', 'mobile');
  const peer = (identity: any): LinkedDevice => ({
    ...identity,
    online: true,
    linkedAt: Date.now(),
    allowAgents: false,
  });
  const host = new DeviceClient({
    relayUrl: url,
    ...hostKeys,
    peers: () => [peer(mobileKeys.identity)],
    onPairRequest: () => {},
    onPaired: async () => {},
    onRequest: async (_peer, operation, input) => {
      if (operation !== 'echo') throw new Error('Unsupported');
      return { payload: input.payload };
    },
  });
  const mobile = new DeviceClient({
    relayUrl: url,
    ...mobileKeys,
    peers: () => [peer(hostKeys.identity)],
    onPairRequest: () => {},
    onPaired: async () => {},
    onRequest: async () => null,
  });
  stops.push(
    () => host.stop(),
    () => mobile.stop(),
  );
  await Promise.all([host.connect(), mobile.connect()]);
  const payload = 'linked-payload-'.repeat(180_000);
  const response = await mobile.rpc(
    hostKeys.identity.id,
    'echo',
    { payload },
    'user',
    undefined,
    10_000,
  );
  expect(response.payload).toBe(payload);
});
