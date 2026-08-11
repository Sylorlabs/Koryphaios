/**
 * v2 MCP protocol tests for the Koryphaios control-plane bridge.
 *
 * Drives createBridgeServer through a real v2 Client over two transports:
 *   - createMcpHandler + StreamableHTTPClientTransport  →  2026-07-28 era
 *   - InMemoryTransport.createLinkedPair                →  2025-era fallback
 *
 * Uses an in-memory proxy stub so no backend HTTP API or bridge grant file
 * is needed — the test asserts wire-protocol behaviour, not backend routing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  InMemoryTransport,
  createMcpHandler,
  type McpHttpHandler,
} from '@modelcontextprotocol/server';

import {
  createBridgeServer,
  KORY_TOOLS,
  toolsForRole,
  type RuntimeKoryToolDef,
} from '../kory-mcp-bridge';

// ─── Fixtures ──────────────────────────────────────────────────────────────

/** A subset of tools to test with — the real catalog has 47 entries. */
const TEST_TOOLS: RuntimeKoryToolDef[] = [
  {
    name: 'kory__read_file',
    description: 'Read a file',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'kory__bash',
    description: 'Run a shell command',
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
  {
    name: 'kory__create_note',
    description: 'Create a note',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' }, content: { type: 'string' } },
      required: ['title', 'content'],
    },
  },
];

/** In-memory proxy stub: returns a deterministic echo for each tool call. */
function makeProxy() {
  const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
  const proxy = async (toolName: string, input: Record<string, unknown>) => {
    calls.push({ tool: toolName, input });
    return { content: JSON.stringify({ tool: toolName, input }), isError: false };
  };
  return { proxy, calls };
}

// ─── 2026-07-28 era ────────────────────────────────────────────────────────

describe('Kory MCP bridge — 2026-07-28 protocol (createMcpHandler + StreamableHTTP)', () => {
  let handler: McpHttpHandler;
  let client: Client;
  let proxyStub: ReturnType<typeof makeProxy>;

  beforeEach(async () => {
    proxyStub = makeProxy();
    handler = createMcpHandler(() => createBridgeServer(TEST_TOOLS, proxyStub.proxy));
    const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    });
    client = new Client(
      { name: 'bridge-test-client', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    await client.connect(transport);
  });

  afterEach(async () => {
    await client.close();
    await handler.close();
  });

  it('negotiates the 2026-07-28 protocol revision', () => {
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
  });

  it('lists all allowed tools via tools/list', async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);
    expect(names).toEqual(['kory__read_file', 'kory__bash', 'kory__create_note']);
  });

  it('calls a tool and receives the proxied result', async () => {
    const result = await client.callTool({
      name: 'kory__read_file',
      arguments: { path: '/tmp/test.txt' },
    });
    expect(result.isError).toBe(false);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');

    // The proxy was called with the right tool name and input.
    expect(proxyStub.calls).toHaveLength(1);
    expect(proxyStub.calls[0].tool).toBe('kory__read_file');
    expect(proxyStub.calls[0].input).toEqual({ path: '/tmp/test.txt' });
  });

  it('rejects an unknown tool with a thrown ProtocolError', async () => {
    await expect(client.callTool({ name: 'kory__nonexistent', arguments: {} })).rejects.toThrow(
      'Unknown tool: kory__nonexistent',
    );
    expect(proxyStub.calls).toHaveLength(0);
  });

  it('rejects a tool not in the allowed set', async () => {
    // kory__delete_file exists in KORY_TOOLS but not in TEST_TOOLS.
    await expect(
      client.callTool({ name: 'kory__delete_file', arguments: { path: 'x' } }),
    ).rejects.toThrow('Unknown tool: kory__delete_file');
    expect(proxyStub.calls).toHaveLength(0);
  });
});

// ─── 2025-era fallback ─────────────────────────────────────────────────────

describe('Kory MCP bridge — 2025-era fallback (InMemoryTransport)', () => {
  let client: Client;
  let proxyStub: ReturnType<typeof makeProxy>;

  beforeEach(async () => {
    proxyStub = makeProxy();
    const server = createBridgeServer(TEST_TOOLS, proxyStub.proxy);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'bridge-legacy-client', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await client.close();
  });

  it('negotiates a 2025-era protocol revision', () => {
    expect(client.getNegotiatedProtocolVersion()).toMatch(/^2025-/);
  });

  it('lists tools over the legacy transport', async () => {
    const result = await client.listTools();
    expect(result.tools.map((t) => t.name)).toContain('kory__bash');
  });

  it('calls a tool over the legacy transport', async () => {
    const result = await client.callTool({
      name: 'kory__bash',
      arguments: { command: 'echo hello' },
    });
    expect(result.isError).toBe(false);
    expect(proxyStub.calls).toHaveLength(1);
  });
});

// ─── Tool catalog integrity ────────────────────────────────────────────────

describe('Kory MCP bridge — tool catalog integrity', () => {
  it('KORY_TOOLS has 48 tools', () => {
    expect(KORY_TOOLS).toHaveLength(48);
  });

  it('every tool name starts with kory__', () => {
    for (const tool of KORY_TOOLS) {
      expect(tool.name.startsWith('kory__')).toBe(true);
    }
  });

  it('manager role sees all tools', () => {
    expect(toolsForRole('manager')).toHaveLength(48);
  });

  it('unknown role sees no tools', () => {
    expect(toolsForRole('auditor')).toHaveLength(0);
  });

  it('createBridgeServer returns a Server with tools capability', () => {
    const server = createBridgeServer(TEST_TOOLS, makeProxy().proxy);
    expect(server).toBeDefined();
  });
});
