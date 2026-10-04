import { afterEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import {
  createKoryBridgeGrantLease,
  signedBridgeHeadersFromFile,
  verifySignedBridgeRequest,
} from '../bridge-grant';
import { BRIDGE_CATALOG_TIMEOUT_MS, BRIDGE_EXECUTE_TIMEOUT_MS } from '../kory-mcp-bridge';
import {
  createFreebuffBridgeRelay,
  FREEBUFF_RELAY_BODY_LIMIT,
  prepareFreebuffBridge,
} from '../freebuff-bridge-runtime';

const CATALOG = '/api/v1/mcp-bridge/catalog';
const EXECUTE = '/api/v1/mcp-bridge/execute';
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function fixture() {
  const session = `bridge-stage-${crypto.randomUUID()}`;
  const lease = createKoryBridgeGrantLease(session, 'critic');
  cleanup.push(() => lease.cleanup());
  const grant = lease.grant(['mcp:catalog', 'mcp:execute']);
  const calls: Array<{ path: string; body: any; headers: Headers }> = [];
  let mode = 'normal';
  const backend = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const body = await request.json();
      const verified = verifySignedBridgeRequest(
        request.headers,
        'mcp',
        request.method,
        path,
        body,
      );
      if (!verified || body.sessionId !== verified.sessionId || body.role !== verified.role)
        return new Response('Unauthorized', { status: 401 });
      calls.push({ path, body, headers: request.headers });
      if (mode === 'reject') return new Response('Unavailable', { status: 503 });
      if (mode === 'redirect')
        return new Response(null, {
          status: 302,
          headers: { location: `${backend.url}must-not-follow` },
        });
      if (mode === 'malformed') return Response.json({ tools: 'invalid' });
      if (mode === 'oversized') return new Response('x'.repeat(16 * 1024 * 1024 + 1));
      if (path === CATALOG)
        return Response.json({
          tools:
            mode === 'empty'
              ? []
              : [
                  {
                    name: 'kory__synthetic_echo',
                    description: 'Synthetic permissioned tool',
                    inputSchema: {
                      type: 'object',
                      properties: { text: { type: 'string' } },
                      required: ['text'],
                      additionalProperties: false,
                    },
                  },
                ],
        });
      return Response.json({ output: `critic:${body.input.text}`, isError: false });
    },
  });
  cleanup.push(() => backend.stop(true));
  return {
    grant,
    session,
    calls,
    backend,
    setMode: (value: string) => {
      mode = value;
    },
    body: { sessionId: session, role: 'critic' },
    headers(path = CATALOG, body: unknown = { sessionId: session, role: 'critic' }) {
      return {
        'content-type': 'application/json',
        ...signedBridgeHeadersFromFile(grant.path, 'mcp', 'POST', path, body),
      };
    },
  };
}

async function relayFixture() {
  const f = fixture();
  const relay = await createFreebuffBridgeRelay({
    backendUrl: f.backend.url.origin,
    grantId: f.grant.grantId,
  });
  cleanup.push(() => relay.cleanup());
  return {
    ...f,
    relay,
    request: (path = CATALOG, options: RequestInit = {}) =>
      fetch(`${relay.url}${path}`, {
        method: 'POST',
        body: JSON.stringify(f.body),
        headers: {
          ...f.headers(path === EXECUTE ? EXECUTE : CATALOG),
          'x-kory-bridge-relay': relay.token,
        },
        ...options,
      }),
  };
}

describe('Freebuff fixed-route authenticated relay', () => {
  it('requires the per-turn token and all signed headers before reaching loopback', async () => {
    const f = await relayFixture();
    expect((await f.request(CATALOG, { headers: f.headers() })).status).toBe(401);
    expect(
      (await f.request(CATALOG, { headers: { ...f.headers(), 'x-kory-bridge-relay': 'wrong' } }))
        .status,
    ).toBe(401);
    expect(
      (
        await f.request(CATALOG, {
          headers: { 'content-type': 'application/json', 'x-kory-bridge-relay': f.relay.token },
        })
      ).status,
    ).toBe(401);
    expect(f.calls).toHaveLength(0);
    expect((await f.request()).status).toBe(200);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].headers.has('x-kory-bridge-relay')).toBe(false);
    const body = { ...f.body, toolName: 'synthetic_echo', input: { text: 'relay' } };
    const executed = await f.request(EXECUTE, {
      body: JSON.stringify(body),
      headers: { ...f.headers(EXECUTE, body), 'x-kory-bridge-relay': f.relay.token },
    });
    expect(await executed.json()).toEqual({ output: 'critic:relay', isError: false });
  });

  it('permits only exact POST catalog/execute, not arbitrary backend routes or URL aliases', async () => {
    const f = await relayFixture();
    for (const path of [
      '/api/v1/sessions',
      '/api/v1/mcp-bridge/hooks/pre-tool',
      `${CATALOG}?x=1`,
      `${CATALOG}/`,
      '/api/v1/mcp-bridge/%63atalog',
    ]) {
      expect((await f.request(path)).status).toBe(404);
    }
    expect((await f.request(CATALOG, { method: 'GET', body: undefined })).status).toBe(404);
    expect(f.calls).toHaveLength(0);
  });

  it('preserves backend grant scope, signatures and replay protection without forwarding unrelated credentials', async () => {
    const f = await relayFixture();
    const headers = {
      ...f.headers(),
      'x-kory-bridge-relay': f.relay.token,
      authorization: 'synthetic-unrelated',
      cookie: 'synthetic=secret',
    };
    expect((await f.request(CATALOG, { headers })).status).toBe(200);
    expect(f.calls[0].headers.has('authorization')).toBe(false);
    expect(f.calls[0].headers.has('cookie')).toBe(false);
    expect((await f.request(CATALOG, { headers })).status).toBe(401);
    expect(
      (await f.request(CATALOG, { body: JSON.stringify({ ...f.body, role: 'manager' }) })).status,
    ).toBe(401);
    const forgedBody = { ...f.body, sessionId: 'another-session' };
    expect(
      (
        await f.request(CATALOG, {
          body: JSON.stringify(forgedBody),
          headers: { ...f.headers(CATALOG, forgedBody), 'x-kory-bridge-relay': f.relay.token },
        })
      ).status,
    ).toBe(401);
    const otherLease = createKoryBridgeGrantLease('another', 'manager');
    cleanup.push(() => otherLease.cleanup());
    const other = otherLease.grant(['mcp:catalog']);
    expect(
      (
        await f.request(CATALOG, {
          headers: {
            ...signedBridgeHeadersFromFile(other.path, 'mcp', 'POST', CATALOG, f.body),
            'content-type': 'application/json',
            'x-kory-bridge-relay': f.relay.token,
          },
        })
      ).status,
    ).toBe(401);
    expect(f.calls).toHaveLength(1);
  });

  it('rejects oversized and malformed request bodies; refuses upstream redirects', async () => {
    const f = await relayFixture();
    expect(
      (await f.request(CATALOG, { body: 'x'.repeat(FREEBUFF_RELAY_BODY_LIMIT + 1) })).status,
    ).toBe(413);
    expect((await f.request(CATALOG, { body: '{bad' })).status).toBe(400);
    expect(f.calls).toHaveLength(0);
    f.setMode('redirect');
    expect((await f.request()).status).toBe(502);
    expect(f.calls).toHaveLength(1);
    f.setMode('oversized');
    expect((await f.request()).status).toBe(502);
    expect(f.calls).toHaveLength(2);
  });

  it('rejects remote upstreams and shuts down on cancellation', async () => {
    for (const backendUrl of [
      'https://127.0.0.1:3001',
      'http://example.com',
      'http://127.0.0.1:3001/path',
      'http://user:pass@localhost:3001',
    ]) {
      await expect(createFreebuffBridgeRelay({ backendUrl, grantId: 'synthetic' })).rejects.toThrow(
        'fixed loopback',
      );
    }
    const signal = new AbortController();
    const relay = await createFreebuffBridgeRelay({
      backendUrl: 'http://127.0.0.1:1',
      grantId: 'synthetic',
      signal: signal.signal,
    });
    signal.abort();
    await relay.cleanup();
    await expect(fetch(relay.url)).rejects.toThrow();
  });

  it('keeps approval execution longer than catalog readiness but bounded by the grant lifetime', () => {
    expect(BRIDGE_CATALOG_TIMEOUT_MS).toBe(30_000);
    expect(BRIDGE_EXECUTE_TIMEOUT_MS).toBeGreaterThan(BRIDGE_CATALOG_TIMEOUT_MS);
    expect(BRIDGE_EXECUTE_TIMEOUT_MS).toBeLessThanOrEqual(10 * 60_000);
  });
});

async function stagedFixture(runtimeKind: 'native' | 'docker' = 'native') {
  const f = fixture();
  const root = mkdtempSync(join(tmpdir(), 'kory-staged-bridge-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const prepared = await prepareFreebuffBridge({
    runRoot: root,
    bunBinary: process.execPath,
    runtimeKind,
    servers: [
      {
        name: 'kory',
        command: 'unused-host-runtime',
        args: ['/host/project/never-mounted.ts'],
        transport: 'stdio',
        env: { KORY_BACKEND_URL: f.backend.url.origin, KORY_BRIDGE_AUTH_FILE: f.grant.path },
      },
    ],
  });
  cleanup.push(() => prepared.cleanup());
  return { ...f, prepared, root };
}

async function probe(f: Awaited<ReturnType<typeof stagedFixture>>) {
  const child = Bun.spawn([process.execPath, ...f.prepared.probeArgs], {
    cwd: f.root,
    env: { HOME: f.root, PATH: '/usr/bin:/bin' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  cleanup.push(() => {
    child.kill();
  });
  return {
    code: await child.exited,
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
  };
}

describe('standalone staged bridge and real stdio MCP', () => {
  it('bundles all runtime dependencies, performs a signed probe, then negotiates tools/list and tools/call', async () => {
    const f = await stagedFixture();
    expect(readdirSync(join(f.root, 'bridge')).sort()).toEqual([
      'environment.json',
      'grant.json',
      'kory-mcp-bridge.js',
      'run.js',
    ]);
    for (const name of readdirSync(join(f.root, 'bridge')))
      expect(statSync(join(f.root, 'bridge', name)).mode & 0o077).toBe(0);
    const result = await probe(f);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ready: true, toolCount: 1 });
    expect(existsSync(f.prepared.readyPath)).toBe(false);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: f.prepared.servers[0].args,
      cwd: f.root,
      env: { HOME: f.root, PATH: '/usr/bin:/bin' },
      stderr: 'pipe',
    });
    const client = new Client(
      { name: 'staged-test', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    cleanup.push(() => client.close());
    await client.connect(transport);
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['kory__synthetic_echo']);
    const call = await client.callTool({
      name: 'kory__synthetic_echo',
      arguments: { text: 'safe fixture' },
    });
    expect(call.isError).toBe(false);
    expect(call.content).toEqual([{ type: 'text', text: 'critic:safe fixture' }]);
    expect(f.calls.at(-1)?.body.role).toBe('critic');
    expect(JSON.parse(readFileSync(f.prepared.readyPath, 'utf8'))).toEqual({
      ready: true,
      toolCount: 1,
    });
    const invalid = await client.callTool({ name: 'kory__synthetic_echo', arguments: { text: 7 } });
    expect(invalid.isError).toBe(true);
    expect(f.calls.at(-1)?.body.input.text).toBe('safe fixture');
    await client.close();
  }, 20_000);

  it('stages private Docker relay configuration and forwards the optional relay header from the real bundle', async () => {
    const f = await stagedFixture('docker');
    const configPath = join(f.root, 'bridge', 'environment.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(config.KORY_BACKEND_URL).toContain('host.docker.internal');
    expect(config.KORY_BRIDGE_RELAY_TOKEN).toHaveLength(43);
    expect(f.prepared.servers[0].env).toEqual({});
    expect(f.prepared.servers[0].args.join(' ')).not.toContain(config.KORY_BRIDGE_RELAY_TOKEN);
    // This subprocess is host-native; actual Docker networking is separately
    // exercised below. Only the private fixture URL is translated to loopback.
    config.KORY_BACKEND_URL = config.KORY_BACKEND_URL.replace('host.docker.internal', '127.0.0.1');
    writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    const result = await probe(f);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ready: true, toolCount: 1 });
    expect(f.calls).toHaveLength(1);
    await f.prepared.cleanup();
    await f.prepared.cleanup();
    expect(existsSync(join(f.root, 'bridge'))).toBe(false);
    await expect(fetch(config.KORY_BACKEND_URL)).rejects.toThrow();
  }, 20_000);

  it('distinguishes authenticated empty catalog from unavailable/malformed catalogs', async () => {
    const f = await stagedFixture();
    f.setMode('empty');
    const empty = await probe(f);
    expect(empty.code).toBe(0);
    expect(JSON.parse(empty.stdout)).toEqual({ ready: true, toolCount: 0 });
    for (const mode of ['reject', 'malformed', 'redirect']) {
      f.setMode(mode);
      const rejected = await probe(f);
      expect(rejected.code).not.toBe(0);
      expect(rejected.stdout).toBe('');
      expect(rejected.stderr).not.toContain(f.grant.grantId);
    }
    f.backend.stop(true);
    expect((await probe(f)).code).not.toBe(0);
    rmSync(join(f.root, 'bridge', 'grant.json'));
    const unauthorized = await probe(f);
    expect(unauthorized.code).not.toBe(0);
    expect(unauthorized.stdout).toBe('');
    expect(existsSync(f.prepared.readyPath)).toBe(false);
  }, 20_000);

  it.skipIf(process.env.KORY_TEST_DOCKER_BRIDGE !== '1' || process.platform !== 'darwin')(
    'runs the staged MCP handshake inside mandatory Docker bubblewrap with only the disposable root mounted',
    async () => {
      const { createFreebuffTurnRuntime } = await import('../freebuff-runtime');
      const f = fixture();
      // Colima shares HOME, not macOS /private/var/folders; this fresh subtree
      // contains only synthetic authorization and is the sole mounted root.
      const parent = join(homedir(), '.koryphaios', 'freebuff-runs');
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      const root = mkdtempSync(join(realpathSync(parent), 'bridge-synthetic-'));
      cleanup.push(() => rmSync(root, { recursive: true, force: true }));
      for (const name of ['home', 'workspace', 'tmp']) mkdirSync(join(root, name), { mode: 0o700 });
      const runtime = await createFreebuffTurnRuntime({
        runRoot: root,
        runHome: join(root, 'home'),
        workspace: join(root, 'workspace'),
        privateTmp: join(root, 'tmp'),
        allowNetwork: true,
      });
      cleanup.push(() => runtime.cleanup());
      const prepared = await prepareFreebuffBridge({
        runRoot: root,
        runtimeKind: runtime.kind,
        hostGateway: runtime.hostGateway,
        bunBinary: runtime.bunBinary,
        servers: [
          {
            name: 'kory',
            command: 'unused',
            args: [],
            transport: 'stdio',
            env: { KORY_BACKEND_URL: f.backend.url.origin, KORY_BRIDGE_AUTH_FILE: f.grant.path },
          },
        ],
      });
      cleanup.push(() => prepared.cleanup());
      const ready = JSON.parse(
        await runtime.exec(runtime.bunBinary, prepared.probeArgs, { timeout: 35_000 }),
      );
      expect(ready).toEqual({ ready: true, toolCount: 1 });
      const script = join(root, 'synthetic-handshake.js');
      writeFileSync(
        script,
        `
const child = Bun.spawn(${JSON.stringify([runtime.bunBinary, ...prepared.servers[0].args])}, {stdin:'pipe',stdout:'pipe',stderr:'pipe'});
const deadline = setTimeout(() => { child.kill(); process.exit(2); }, 30000);
const reader = child.stdout.getReader(); const decoder = new TextDecoder(); let buffer = '';
const send = (message) => child.stdin.write(JSON.stringify({jsonrpc:'2.0', ...message})+'\\n');
async function receive(id) { for (;;) { const index=buffer.indexOf('\\n'); if(index>=0) { const line=buffer.slice(0,index); buffer=buffer.slice(index+1); if(!line.trim()) continue; const value=JSON.parse(line); if(value.id===id) { if(value.error) throw Error('MCP request failed'); return value.result; } } else { const part=await reader.read(); if(part.done) throw Error('MCP closed early'); buffer+=decoder.decode(part.value,{stream:true}); } } }
try {
 send({id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'synthetic-isolated',version:'1'}}});
 const init=await receive(1); send({method:'notifications/initialized'});
 send({id:2,method:'tools/list',params:{}}); const tools=await receive(2);
 send({id:3,method:'tools/call',params:{name:'kory__synthetic_echo',arguments:{text:'isolated'}}}); const call=await receive(3);
 console.log(JSON.stringify({version:init.protocolVersion,tools:tools.tools.map(t=>t.name),call}));
} finally { clearTimeout(deadline); child.kill(); await child.exited; }
`,
        { mode: 0o600 },
      );
      const result = JSON.parse(
        await runtime.exec(runtime.bunBinary, [script], { timeout: 35_000 }),
      );
      expect(result.version).toMatch(/^2025-/);
      expect(result.tools).toEqual(['kory__synthetic_echo']);
      expect(result.call.content).toEqual([{ type: 'text', text: 'critic:isolated' }]);
      expect(f.calls.at(-1)?.body.role).toBe('critic');
    },
    120_000,
  );

  it.skipIf(process.env.KORY_TEST_DOCKER_BRIDGE !== '1')(
    'probes actual Docker-to-host relay with synthetic grant only (no mounts or credentials)',
    async () => {
      const f = await relayFixture();
      const url = f.relay.url.replace('127.0.0.1', 'host.docker.internal') + CATALOG;
      const headers: Record<string, string> = {
        ...f.headers(),
        'x-kory-bridge-relay': f.relay.token,
      };
      delete headers['content-type'];
      headers['Content-Type'] = 'application/json';
      const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;
      const command = `wget -q -T 10 -O - ${Object.entries(headers)
        .map(([key, value]) => `--header=${quote(`${key}: ${value}`)}`)
        .join(' ')} --post-data=${quote(JSON.stringify(f.body))} ${quote(url)}\n`;
      const child = Bun.spawn(
        [
          'docker',
          'run',
          '--rm',
          '-i',
          '--read-only',
          '--cap-drop=ALL',
          '--security-opt=no-new-privileges',
          'alpine:3.20',
          'sh',
        ],
        { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      );
      cleanup.push(() => {
        child.kill();
      });
      child.stdin.write(command);
      child.stdin.end();
      const output = await new Response(child.stdout).text();
      const errors = await new Response(child.stderr).text();
      if ((await child.exited) !== 0)
        throw new Error(`Synthetic Docker relay probe failed: ${errors}`);
      expect(errors).toBe('');
      expect(JSON.parse(output).tools[0].name).toBe('kory__synthetic_echo');
      expect(f.calls).toHaveLength(1);
    },
    30_000,
  );
});
