// Cross-OS encrypted transport smoke probe. This is not a provider generation test.
import { hostname, platform, tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DeviceRelay } from '../relay/devices';
import { DeviceClient, makeDeviceIdentity } from '../shared/src/device-client';
import { deviceDigest, type LinkedDevice } from '../shared/src/devices';

const [mode, pathOrPeer, code] = process.argv.slice(2);
const os =
  ({ darwin: 'macOS', linux: 'Linux', win32: 'Windows' } as Record<string, string>)[platform()] ??
  platform();
if (mode === 'identity') {
  if (!pathOrPeer) throw new Error('Supply an owner-only temporary identity file');
  const keys = await makeDeviceIdentity(hostname(), os, 'desktop');
  writeFileSync(pathOrPeer, JSON.stringify(keys), { mode: 0o600, flag: 'wx' });
  console.log(keys.identity.id);
} else if (mode === 'host') {
  if (!pathOrPeer || !/^[a-f0-9]{64}$/.test(pathOrPeer))
    throw new Error('Supply the test client public fingerprint obtained over SSH');
  const relay = new DeviceRelay();
  const server = Bun.serve<any>({
    hostname: '127.0.0.1',
    port: Number(process.env.PROBE_RELAY_PORT ?? 18081),
    fetch: async (req, srv) =>
      (await relay.fetch(req, srv)) ?? new Response('Not found', { status: 404 }),
    websocket: {
      open: (ws) => relay.open(ws),
      message: (ws, message) => relay.message(ws, message),
      close: (ws) => relay.close(ws),
    },
  });
  const root = mkdtempSync(join(tmpdir(), 'kory-device-probe-'));
  mkdirSync(join(root, 'project'));
  const keys = await makeDeviceIdentity(hostname(), os, 'desktop');
  const peers: LinkedDevice[] = [];
  const workspaceId = await deviceDigest(`${keys.identity.id}:${root}`);
  const client = new DeviceClient({
    relayUrl: `http://127.0.0.1:${server.port}`,
    ...keys,
    peers: () => peers,
    onPairRequest: (request) => {
      if (request.id !== pathOrPeer) return;
      console.log(JSON.stringify({ check: request.check, peer: request.identity.os }));
      // The operator explicitly pinned this one test identity over SSH.
      void client.decidePair(request.id, true).catch(console.error);
    },
    onPaired: async (identity) => {
      peers.push({ ...identity, online: true, linkedAt: Date.now(), allowAgents: false });
    },
    onRequest: async (_peer, operation, input) => {
      if (operation === 'identity') return keys.identity;
      if (operation === 'workspaces')
        return [{ id: workspaceId, name: 'project', displayPath: join(root, 'project') }];
      if (operation === 'folders' && input.workspaceId === workspaceId) return [];
      throw new Error('Unsupported probe operation or foreign workspace');
    },
  });
  const stop = () => {
    client.stop();
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  setTimeout(stop, 90_000);
  await client.connect();
  console.log(JSON.stringify(await client.invite()));
} else if (mode === 'client') {
  if (!pathOrPeer || !code || !process.env.PROBE_RELAY_URL)
    throw new Error(
      'Usage: PROBE_RELAY_URL=http://127.0.0.1:<tunnel> bun scripts/probe-linked-devices.ts client <identity-file> <code>',
    );
  const keys = JSON.parse(readFileSync(pathOrPeer, 'utf8'));
  const peers: LinkedDevice[] = [];
  const client = new DeviceClient({
    relayUrl: process.env.PROBE_RELAY_URL,
    ...keys,
    peers: () => peers,
    onPairRequest: () => {},
    onPaired: async (identity) => {
      peers.push({ ...identity, online: true, linkedAt: Date.now(), allowAgents: false });
    },
    onRequest: async () => null,
  });
  try {
    await client.connect();
    const pairing = await client.pair(code);
    for (let i = 0; !peers.length && i < 100; i++) await Bun.sleep(100);
    if (!peers.length) throw new Error('Host approval timed out');
    const identity = await client.rpc(pairing.identity.id, 'identity');
    const workspaces = await client.rpc(pairing.identity.id, 'workspaces');
    await client.rpc(pairing.identity.id, 'folders', { workspaceId: workspaces[0].id });
    let foreignRejected = false;
    try {
      await client.rpc(pairing.identity.id, 'folders', {
        workspaceId: 'C:\\Users\\Someone\\project',
      });
    } catch {
      foreignRejected = true;
    }
    if (!foreignRejected) throw new Error('Foreign path was accepted');
    console.log(
      JSON.stringify(
        {
          paired: true,
          check: pairing.check,
          clientOS: os,
          hostOS: identity.os,
          opaqueWorkspace: workspaces[0].id,
          foreignPathRejected: foreignRejected,
        },
        null,
        2,
      ),
    );
  } finally {
    client.stop();
  }
} else
  throw new Error(
    'Usage: probe-linked-devices.ts identity <file>|host <expected-client-id>|client <identity-file> <code>',
  );
