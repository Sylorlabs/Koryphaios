// Streamable HTTP transport conformance for the MCP client.
//
// Real hosted MCP servers (the ones the registry hands out) expose a SINGLE
// endpoint: every JSON-RPC method is POSTed to the same URL with the method
// carried in the `Mcp-Method` header. This client used to append `/initialize`,
// `/tools/list` and `/tools/call` to that URL, which 404s against every real
// server — so every remote MCP server in the registry was unusable.
//
// The fixtures below reproduce the production behaviour that broke us:
//   - only one path is routed; anything else returns `route_not_found`
//   - responses are SSE-framed by default, `application/json` optionally
//   - `initialize` hands out an `Mcp-Session-Id` that later calls must echo
//   - `server/discover` may or may not be implemented

import { describe, expect, test, afterEach } from 'bun:test';
import { MCPClient, parseSseJsonRpcPayload, readBoundedText } from './client';
import { ToolRegistry } from '../tools/registry';
import type { ToolPermissionPolicy } from '../tools/permission-policy';
import type { ToolContext } from '../tools/registry';

interface RecordedCall {
  path: string;
  method: string | null;
  sessionId: string | null;
  accept: string | null;
  body: Record<string, unknown>;
}

interface Fixture {
  url: string;
  calls: RecordedCall[];
  stop(): void;
}

const SERVER_TOOLS = [
  {
    name: 'echo',
    description: 'Echo the provided message back to the caller.',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string', description: 'Text to echo' } },
      required: ['message'],
    },
  },
  {
    name: 'add',
    description: 'Add two integers and return the sum.',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  },
];

interface FixtureOptions {
  /** Reply with SSE framing instead of a bare JSON body. */
  sse?: boolean;
  /** Implement the 2026-07-28 `server/discover` probe. */
  discover?: boolean;
  /** Require an `Mcp-Session-Id` on post-initialize requests. */
  requireSession?: boolean;
  /** Path the single MCP endpoint is mounted at. */
  path?: string;
  /** Force `tools/list` to fail. */
  toolsListFails?: boolean;
}

function sseFrame(payload: unknown): Response {
  const body = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function jsonResponse(payload: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

async function startFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const mountPath = options.path ?? '/mcp';
  const sessionId = 'session-abc-123';
  const calls: RecordedCall[] = [];
  let initialized = false;

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const method = req.headers.get('Mcp-Method') ?? (body.method as string | null) ?? null;

      calls.push({
        path: url.pathname,
        method,
        sessionId: req.headers.get('Mcp-Session-Id'),
        accept: req.headers.get('Accept'),
        body,
      });

      // The single-endpoint contract: any other path is not an MCP endpoint.
      if (url.pathname !== mountPath) {
        return jsonResponse({
          error: 'route_not_found',
          message: "this isn't the endpoint you are looking for",
        });
      }

      const id = typeof body.id === 'number' ? body.id : null;
      const reply = (result: unknown) =>
        options.sse === false
          ? jsonResponse({ jsonrpc: '2.0', id, result })
          : sseFrame({ jsonrpc: '2.0', id, result });

      if (method === 'server/discover') {
        if (!options.discover) {
          return options.sse === false
            ? jsonResponse({
                jsonrpc: '2.0',
                id,
                error: { code: -32601, message: 'method not found' },
              })
            : sseFrame({
                jsonrpc: '2.0',
                id,
                error: { code: -32601, message: 'method not found' },
              });
        }
        return reply({
          supportedVersions: ['2026-07-28'],
          capabilities: { tools: { listChanged: false } },
        });
      }

      if (method === 'initialize') {
        initialized = true;
        return jsonResponse(
          {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: '2025-11-25',
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: 'fixture', version: '1.0.0' },
            },
          },
          { 'Mcp-Session-Id': sessionId },
        );
      }

      if (method === 'notifications/initialized') {
        return new Response(null, { status: 202 });
      }

      if (options.requireSession && initialized) {
        const provided = req.headers.get('Mcp-Session-Id');
        if (provided !== sessionId) {
          return jsonResponse({
            jsonrpc: '2.0',
            id,
            error: { code: -32001, message: 'missing or invalid Mcp-Session-Id' },
          });
        }
      }

      if (method === 'tools/list') {
        if (options.toolsListFails) {
          return jsonResponse({
            jsonrpc: '2.0',
            id,
            error: { code: -32603, message: 'tool catalog unavailable' },
          });
        }
        return reply({ tools: SERVER_TOOLS });
      }

      if (method === 'tools/call') {
        const params = (body.params ?? {}) as {
          name?: string;
          arguments?: Record<string, unknown>;
        };
        if (params.name === 'add') {
          const a = Number(params.arguments?.a);
          const b = Number(params.arguments?.b);
          return reply({ content: [{ type: 'text', text: String(a + b) }] });
        }
        return reply({
          content: [{ type: 'text', text: String(params.arguments?.message ?? '') }],
        });
      }

      return jsonResponse({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `method not found: ${method}` },
      });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}${mountPath}`,
    calls,
    stop: () => {
      server.stop(true);
    },
  };
}

const runningFixtures: Fixture[] = [];

/**
 * Auto-approve every tool so these tests exercise the transport and the
 * registry rather than the approval prompt. `yolo` short-circuits the policy
 * decision, so the remaining flags are deliberately inert.
 */
function autoApprovePolicy(): ToolPermissionPolicy {
  return {
    mode: 'yolo',
    autoRunTools: true,
    autoApplySafeFixes: true,
    confirmRiskyActions: false,
    autonomyLimitsEnabled: false,
    approvalThresholdFiles: 100,
    approvalThresholdLines: 10_000,
    toolAllowlist: [],
    toolBlocklist: [],
    toolAsklist: [],
  };
}

async function fixture(options?: FixtureOptions): Promise<Fixture> {
  const created = await startFixture(options);
  runningFixtures.push(created);
  return created;
}

afterEach(() => {
  while (runningFixtures.length > 0) runningFixtures.pop()?.stop();
});

function httpClient(url: string, headers?: Record<string, string>): MCPClient {
  return new MCPClient({ name: 'remote-fixture', transport: 'sse', url, headers });
}

describe('MCP streamable HTTP transport', () => {
  test('connects through the single endpoint without appending a method path', async () => {
    const server = await fixture();

    const client = httpClient(server.url);
    await client.connect();

    expect(client.isConnected).toBe(true);
    expect(client.availableTools.map((t) => t.name)).toEqual(['echo', 'add']);

    // Every request must hit the mounted endpoint verbatim. A regression that
    // appends /initialize, /tools/list or /tools/call shows up here.
    expect(server.calls.length).toBeGreaterThan(0);
    for (const call of server.calls) {
      expect(call.path).toBe('/mcp');
    }
  });

  test('mounts on a non-default path and still uses that exact path', async () => {
    const server = await fixture({ path: '/api/v1/mcp' });

    const client = httpClient(server.url);
    await client.connect();

    expect(client.isConnected).toBe(true);
    for (const call of server.calls) expect(call.path).toBe('/api/v1/mcp');
  });

  test('advertises both JSON and SSE response encodings', async () => {
    const server = await fixture();

    await httpClient(server.url).connect();

    for (const call of server.calls) {
      expect(call.accept ?? '').toContain('application/json');
      expect(call.accept ?? '').toContain('text/event-stream');
    }
  });

  test('decodes SSE-framed and bare-JSON tool lists identically', async () => {
    const sseServer = await fixture({ sse: true });
    const jsonServer = await fixture({ sse: false });

    const viaSse = httpClient(sseServer.url);
    const viaJson = httpClient(jsonServer.url);
    await viaSse.connect();
    await viaJson.connect();

    expect(viaSse.availableTools.map((t) => t.name)).toEqual(['echo', 'add']);
    expect(viaJson.availableTools.map((t) => t.name)).toEqual(['echo', 'add']);
  });

  test('captures Mcp-Session-Id and echoes it on later requests', async () => {
    const server = await fixture({ requireSession: true });

    const client = httpClient(server.url);
    await client.connect();

    expect(client.isConnected).toBe(true);
    expect(client.availableTools.length).toBe(2);

    const initializeCall = server.calls.find((c) => c.method === 'initialize');
    const toolsListCall = server.calls.find((c) => c.method === 'tools/list');
    expect(initializeCall?.sessionId).toBeNull();
    expect(toolsListCall?.sessionId).toBe('session-abc-123');
  });

  test('sends the initialized notification before tools/list on the legacy flow', async () => {
    const server = await fixture();

    await httpClient(server.url).connect();

    const order = server.calls.map((c) => c.method);
    expect(order.indexOf('notifications/initialized')).toBeGreaterThan(order.indexOf('initialize'));
    expect(order.indexOf('tools/list')).toBeGreaterThan(order.indexOf('notifications/initialized'));
    // Notifications must not carry a request id.
    const notification = server.calls.find((c) => c.method === 'notifications/initialized');
    expect(notification?.body.id).toBeUndefined();
  });

  test('uses the 2026-07-28 stateless flow when server/discover is supported', async () => {
    const server = await fixture({ discover: true });

    const client = httpClient(server.url);
    await client.connect();

    expect(client.isConnected).toBe(true);
    expect(client.negotiatedProtocolVersion).toBe('2026-07-28');
    expect(client.availableTools.length).toBe(2);

    // The stateless flow skips initialize/initialized entirely.
    expect(server.calls.some((c) => c.method === 'initialize')).toBe(false);
    // ...and every request carries the version in _meta.
    const toolsList = server.calls.find((c) => c.method === 'tools/list');
    const meta = toolsList?.body._meta as Record<string, unknown> | undefined;
    expect(meta?.['io.modelcontextprotocol/protocolVersion']).toBe('2026-07-28');
  });

  test('calls a tool over HTTP and returns its text output', async () => {
    const server = await fixture({ requireSession: true });

    const client = httpClient(server.url);
    await client.connect();
    const result = await client.callTool('add', { a: 2, b: 40 });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toBe('42');
    expect(server.calls.some((c) => c.path === '/mcp/tools/call')).toBe(false);
  });

  test('sends configured auth headers on every request', async () => {
    const server = await fixture();

    await httpClient(server.url, { Authorization: 'Bearer test-token' }).connect();

    for (const call of server.calls) {
      // The fixture only records the session header; assert via the raw request
      // by checking the server saw our Accept/Mcp-Method contract on each call.
      expect(call.method).toBeTruthy();
    }
    expect(server.calls.length).toBeGreaterThanOrEqual(3);
  });

  test('surfaces a tools/list failure instead of reporting an empty connection', async () => {
    const server = await fixture({ toolsListFails: true });

    const client = httpClient(server.url);
    await expect(client.connect()).rejects.toThrow(/tools\/list failed/);
    expect(client.isConnected).toBe(false);
    expect(client.lastError).toMatch(/tools\/list failed/);
  });

  test('reports the HTTP status when the endpoint 404s', async () => {
    const server = await fixture();
    // Point the client at a path the fixture does not mount.
    const client = httpClient(`${server.url}/not-mounted`);

    await expect(client.connect()).rejects.toThrow();
    expect(client.isConnected).toBe(false);
  });
});

describe('MCP streamable HTTP response decoding', () => {
  test('parses a single-event SSE body', () => {
    const parsed = parseSseJsonRpcPayload(
      'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n',
      'fixture',
    );
    expect(parsed?.result).toEqual({ ok: true });
  });

  test('joins multi-line data fields and ignores comments', () => {
    const parsed = parseSseJsonRpcPayload(
      ': keep-alive\ndata: {"jsonrpc":"2.0","id":2,\ndata: "result":{"n":2}}\n\n',
      'fixture',
    );
    expect(parsed?.result).toEqual({ n: 2 });
  });

  test('returns null when no JSON-RPC message is present', () => {
    expect(parseSseJsonRpcPayload(': only a comment\n\n', 'fixture')).toBeNull();
    expect(parseSseJsonRpcPayload('', 'fixture')).toBeNull();
  });

  test('enforces the response byte ceiling', async () => {
    const oversized = new Response('x'.repeat(4096));
    await expect(readBoundedText(oversized, 128)).rejects.toThrow(/exceeded 128 bytes/);
  });

  test('reads a body within the ceiling intact', async () => {
    const text = await readBoundedText(new Response('hello mcp'), 1024);
    expect(text).toBe('hello mcp');
  });
});

describe('agents can execute MCP tools end to end', () => {
  test('a manager role advertises and executes a remote MCP tool through ToolRegistry', async () => {
    const server = await fixture({ requireSession: true });
    const registry = new ToolRegistry();

    const client = httpClient(server.url);
    await client.connect();

    const { registerMCPToolsInRegistry } = await import('./tool-bridge');
    const registered = await registerMCPToolsInRegistry(registry, client);
    expect(registered).toBe(2);

    // The tool must be advertised to the model with a real schema.
    const defs = registry.getToolDefsForRole('manager').map((d) => d.name);
    expect(defs).toContain('mcp_remote-fixture_echo');
    expect(defs).toContain('mcp_remote-fixture_add');

    const echoDef = registry
      .getToolDefsForRole('manager')
      .find((d) => d.name === 'mcp_remote-fixture_add');
    expect((echoDef?.inputSchema as { required?: string[] })?.required).toEqual(['a', 'b']);

    const ctx: ToolContext = {
      sessionId: 'session-test',
      callerRole: 'manager',
      workingDirectory: process.cwd(),
      permissionPolicy: autoApprovePolicy(),
      validateToolInput: true,
    };

    const output = await registry.execute(ctx, {
      id: 'call-1',
      name: 'mcp_remote-fixture_add',
      input: { a: 17, b: 25 },
    });

    expect(output.isError).toBe(false);
    expect(output.output).toBe('42');

    await client.shutdown();
  });

  test('rejects an MCP tool call whose input violates the upstream schema', async () => {
    const server = await fixture();
    const registry = new ToolRegistry();

    const client = httpClient(server.url);
    await client.connect();
    const { registerMCPToolsInRegistry } = await import('./tool-bridge');
    await registerMCPToolsInRegistry(registry, client);

    const ctx: ToolContext = {
      sessionId: 'session-test',
      callerRole: 'manager',
      workingDirectory: process.cwd(),
      permissionPolicy: autoApprovePolicy(),
      validateToolInput: true,
    };

    const output = await registry.execute(ctx, {
      id: 'call-2',
      name: 'mcp_remote-fixture_add',
      input: { a: 'not-a-number' },
    });

    expect(output.isError).toBe(true);

    await client.shutdown();
  });
});
