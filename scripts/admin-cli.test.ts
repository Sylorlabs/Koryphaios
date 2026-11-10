import { afterEach, beforeEach, expect, test } from 'bun:test';
import { runAdminCli } from './admin-cli';

const ID = 'a'.repeat(64);
let server: ReturnType<typeof Bun.serve>;
let calls: Array<{ path: string; method: string; body: any; project: string | null }>;
let output: string[];
let incoming: boolean;
let outgoing: boolean;
const env = {};
beforeEach(() => {
  calls = [];
  output = [];
  incoming = false;
  outgoing = true;
  const status = () => ({
    local: {
      id: 'local',
      name: 'My Mac',
      os: 'macOS',
      publicKey: { x: 'public' },
      privateKey: 'should-never-print',
    },
    relayUrl: 'https://relay.example.com',
    connected: true,
    error: null,
    peers: [
      {
        id: ID,
        name: 'VPS',
        os: 'Linux',
        online: true,
        allowAgents: incoming,
        agentRouting: outgoing,
      },
    ],
    requests: [
      {
        id: ID,
        identity: { name: 'VPS', os: 'Linux' },
        check: '123 456',
        expiresAt: Date.now() + 600000,
      },
    ],
    pendingPairIds: [],
  });
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      const body =
        req.method === 'GET' || req.method === 'DELETE' ? null : await req.json().catch(() => null);
      calls.push({
        path,
        method: req.method,
        body,
        project: req.headers.get('X-Koryphaios-Project'),
      });
      if (path === '/api/health')
        return Response.json({ ok: true, data: { id: 'koryphaios', version: 'test' } });
      if (path === '/api/auth/session' && req.method === 'POST')
        return Response.json({ ok: true, data: { bearerToken: 'Bearer secret-test-token' } });
      if (req.headers.get('authorization') !== 'Bearer secret-test-token')
        return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
      if (path === '/api/auth/session') return Response.json({ ok: true });
      if (path === '/api/devices') return Response.json({ ok: true, data: status() });
      if (path === '/api/devices/decision') return Response.json({ ok: true, data: status() });
      if (path.endsWith('/grants')) {
        incoming = body.allowAgents;
        outgoing = body.agentRouting;
        return Response.json({ ok: true, data: status() });
      }
      if (path === '/api/agent/settings')
        return Response.json({
          ok: true,
          data: {
            permissionMode: body?.permissionMode ?? 'guarded',
            computerUse: { secret: 'never-print' },
          },
        });
      if (path === '/api/devices/pair')
        return Response.json({
          ok: true,
          data: {
            identity: { id: ID, name: 'VPS', os: 'Linux', publicKey: 'never-print' },
            check: '123 456',
          },
        });
      if (path === '/api/devices/pairing')
        return Response.json({
          ok: true,
          data: {
            code: 'ABCDE-FGHJK-LMNPQ-RSTUV',
            expiresAt: Date.now() + 600000,
            qrUrl: 'koryphaios://link-device?v=1&relay=https%3A%2F%2Frelay.example.com&code=test',
          },
        });
      if (path === '/api/devices/relay') return Response.json({ ok: true, data: status() });
      if (path === '/api/workspace/open')
        return Response.json({ ok: true, data: { workspaceRoot: body.root } });
      if (path === '/api/providers/openai/refresh')
        return Response.json({
          ok: true,
          status: { connectionState: 'verified' },
          verification: { success: true },
        });
      return Response.json(
        { ok: false, error: 'Probe failed', correlationId: 'test-reference' },
        { status: 500 },
      );
    },
  });
});
afterEach(() => server.stop(true));
const run = (...args: string[]) =>
  runAdminCli(['--port', String(server.port), ...args], {
    env,
    write: (text) => output.push(text),
  });

test('both sides can create, enter and approve pairing codes entirely through the CLI', async () => {
  await run('devices', 'invite');
  expect(JSON.parse(output[0]!).code).toBe('ABCDE-FGHJK-LMNPQ-RSTUV');
  await run('devices', 'pair', 'ABCDE-FGHJK-LMNPQ-RSTUV');
  expect(JSON.parse(output[1]!).check).toBe('123 456');
  await run('devices', 'pending');
  expect(JSON.parse(output[2]!).requests[0].id).toBe(ID);
  await run('devices', 'approve', ID, '--check', '123 456');
  expect(calls.find((c) => c.path === '/api/devices/decision')?.body).toEqual({
    id: ID,
    approved: true,
  });
  expect(calls.filter((c) => c.path === '/api/auth/session' && c.method === 'DELETE')).toHaveLength(
    4,
  );
  expect(output.join('')).not.toContain('secret-test-token');
  expect(output.join('')).not.toContain('never-print');
});
test('mismatched check never sends approval and still revokes the API session', async () => {
  await expect(run('devices', 'approve', ID, '--check', '999999')).rejects.toThrow(
    'does not match',
  );
  expect(calls.some((c) => c.path === '/api/devices/decision')).toBe(false);
  expect(calls.at(-1)?.method).toBe('DELETE');
});
test('changes one directional grant while preserving the other', async () => {
  await run('devices', 'grants', ID, '--incoming', 'on');
  expect(incoming).toBe(true);
  expect(outgoing).toBe(true);
  await run('devices', 'grants', ID, '--outgoing', 'off');
  expect(incoming).toBe(true);
  expect(outgoing).toBe(false);
});
test('setting changes are scoped, validated, and use the real API', async () => {
  await run('--project', '/srv/project', 'config', 'set', 'agent.permissionMode', 'ask');
  expect(calls.find((c) => c.method === 'PUT')).toMatchObject({
    path: '/api/agent/settings',
    project: '/srv/project',
    body: { permissionMode: 'ask' },
  });
  await run('config', 'set', 'device.relay', 'https://relay.example.com/');
  expect(calls.find((c) => c.path === '/api/devices/relay')?.body).toEqual({
    url: 'https://relay.example.com',
  });
  await expect(run('config', 'set', 'agent.permissionMode', 'invented')).rejects.toThrow(
    'must be one of',
  );
  await run('config', 'show');
  expect(output.join('')).not.toContain('never-print');
});
test('status hides pairing checks, auth/private state, and configuration stays non-secret', async () => {
  await run('status');
  expect(output[0]).not.toContain('123 456');
  expect(output[0]).not.toContain('privateKey');
  expect(output[0]).not.toContain('publicKey');
  expect(output[0]).not.toContain('should-never-print');
});
test('refuses internet API targets, unknown commands, unsafe relay URLs, and malformed flags before any connection', async () => {
  for (const args of [
    ['--url', 'https://example.com', 'status'],
    ['devices', 'prompt', ID, 'write files'],
    ['config', 'set', 'apiKey', 'secret'],
    ['config', 'set', 'device.relay', 'http://remote.example.com'],
    ['--port', '0', 'status'],
    ['devices', 'approve', ID],
    ['devices', 'grants', ID, '--incoming', 'maybe'],
  ])
    await expect(runAdminCli(args, { env, write: (text) => output.push(text) })).rejects.toThrow();
  expect(calls).toHaveLength(0);
});
test('workspace paths are submitted unchanged for interpretation by the target instance', async () => {
  await run('workspace', 'open', 'C:\\Users\\Me\\workspace');
  expect(calls.find((c) => c.path === '/api/workspace/open')?.body.root).toBe(
    'C:\\Users\\Me\\workspace',
  );
});
test('API failures are actionable and revoke authentication', async () => {
  await expect(run('devices', 'unlink', ID)).rejects.toThrow(
    'Probe failed (reference test-reference)',
  );
  expect(calls.at(-1)).toMatchObject({ path: '/api/auth/session', method: 'DELETE' });
});
test('provider refresh uses a non-generating probe and handles top-level API status', async () => {
  await run('providers', 'refresh', 'openai');
  expect(calls.find((c) => c.path === '/api/providers/openai/refresh')?.body).toEqual({
    runtimeCheck: false,
  });
  expect(JSON.parse(output[0]!)).toMatchObject({
    refreshed: 'openai',
    verified: true,
    connectionState: 'verified',
  });
});
