import { describe, expect, test } from 'bun:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { InMemoryTransport, createMcpHandler } from '@modelcontextprotocol/server';
import { createBridgeServer, KORY_TOOLS } from '../kory-mcp-bridge';

const NAME = 'kory__retrieve_note_context';

describe('associative retrieval MCP bridge schema', () => {
  for (const transportKind of ['modern-http', 'legacy-memory'] as const) {
    test(`advertises and validates bounded read-only retrieval over ${transportKind}`, async () => {
      const definition = KORY_TOOLS.find((tool) => tool.name === NAME)!;
      expect(definition).toBeDefined();
      const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
      const proxy = async (name: string, input: Record<string, unknown>) => {
        calls.push({ name, input });
        return { content: JSON.stringify({ notes: [], truncated: false }), isError: false };
      };
      const handler =
        transportKind === 'modern-http'
          ? createMcpHandler(() => createBridgeServer([definition], proxy))
          : undefined;
      const server = handler ? undefined : createBridgeServer([definition], proxy);
      const client = new Client(
        { name: 'note-context-test', version: '1.0' },
        {
          versionNegotiation: { mode: 'auto' },
        },
      );
      try {
        if (handler) {
          await client.connect(
            new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
              fetch: (url, init) => handler.fetch(new Request(url, init)),
            }),
          );
        } else {
          const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
          await Promise.all([server!.connect(serverTransport), client.connect(clientTransport)]);
        }
        const catalog = await client.listTools();
        expect(catalog.tools.map((tool) => tool.name)).toEqual([NAME]);
        expect(catalog.tools[0].inputSchema).toMatchObject({
          required: ['query'],
          additionalProperties: false,
        });
        for (const input of [
          {},
          { query: '' },
          { query: 'x'.repeat(2001) },
          { query: 'design', maxHops: 3 },
          { query: 'design', maxChars: 16001 },
          { query: 'design', limit: 13 },
          { query: 'design', limit: 1.5 },
          { query: 'design', seedIds: Array.from({ length: 9 }, (_, index) => `note-${index}`) },
          { query: 'design', projectRoot: '/another-project' },
          { query: 'design', createLinks: true },
        ]) {
          const result = await client.callTool({ name: NAME, arguments: input });
          expect(result.isError).toBe(true);
        }
        expect(calls).toEqual([]);
        const input = { query: 'design', maxHops: 1, limit: 4, maxChars: 2048, semantic: false };
        const result = await client.callTool({ name: NAME, arguments: input });
        expect(result.isError).toBe(false);
        expect(calls).toEqual([{ name: NAME, input }]);
        expect(result.content).toContainEqual({
          type: 'text',
          text: JSON.stringify({ notes: [], truncated: false }),
        });
      } finally {
        await client.close();
        await handler?.close();
        await server?.close();
      }
    });
  }
});
