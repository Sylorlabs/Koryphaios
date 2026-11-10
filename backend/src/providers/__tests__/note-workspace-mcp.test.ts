import { describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createBridgeServer, toolsForRole } from '../kory-mcp-bridge';
import { noteWorkspaceTools } from '../../tools/note-workspace';

describe('Notes workspace MCP interface', () => {
  test('advertises authoritative workspace schemas and rejects invalid calls before proxying', async () => {
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
    const definitions = noteWorkspaceTools.map((tool) => ({
      name: `kory__${tool.name}`,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
    const server = createBridgeServer(definitions, async (name, input) => {
      calls.push({ name, input });
      return { content: JSON.stringify({ revision: 2 }), isError: false };
    });
    const client = new Client({ name: 'notes-workspace-test', version: '1.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const catalog = await client.listTools();
      expect(catalog.tools.map((tool) => tool.name)).toEqual(definitions.map((tool) => tool.name));
      for (const args of [
        { noteId: 'board' },
        { noteId: 'board', expectedRevision: 0 },
        { noteId: 'board', expectedRevision: 1, projectRoot: '/foreign' },
      ]) {
        expect(
          (await client.callTool({ name: 'kory__patch_note_canvas', arguments: args })).isError,
        ).toBe(true);
      }
      expect(calls).toEqual([]);
      expect(
        (
          await client.callTool({
            name: 'kory__patch_note_canvas',
            arguments: { noteId: 'board', expectedRevision: 1, removeCardIds: ['card'] },
          })
        ).isError,
      ).toBe(false);
      expect(calls).toEqual([
        {
          name: 'kory__patch_note_canvas',
          input: { noteId: 'board', expectedRevision: 1, removeCardIds: ['card'] },
        },
      ]);
      const critic = toolsForRole('critic').map((tool) => tool.name);
      expect(critic).toContain('kory__read_note_canvas');
      expect(critic).toContain('kory__list_note_relationships');
      expect(critic).not.toContain('kory__patch_note_canvas');
      expect(critic).not.toContain('kory__review_note_relationship');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
