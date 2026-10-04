import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { DEFAULT_NOTE_TOOL_PERMISSIONS } from '@koryphaios/shared';
import { DEFAULT_AGENT_SETTINGS } from '../agent-settings';
import { getContext, setContext } from '../context';
import { initDb } from '../db';
import { createNote } from '../notes/notes-service';
import { saveNotesAgentPermissions, saveNotesSettings } from '../notes/notes-settings';
import { createBridgeServer } from '../providers/kory-mcp-bridge';
import { retrieveNoteContextTool } from '../tools/notes';
import { resolveToolPermissionPolicy } from '../tools/permission-policy';
import { ToolRegistry, type ToolContext } from '../tools/registry';
import { handleMcpRequest } from './koryphaios-mcp-endpoint';

let root: string;
let foreignRoot: string;
let registry: ToolRegistry;
let priorContext: ReturnType<typeof getContext> | undefined;
let callNumber = 0;
beforeAll(async () => {
  await initDb();
  try {
    priorContext = getContext();
  } catch {
    /* no bootstrap in isolated tests */
  }
});
afterAll(() => {
  if (priorContext) setContext(priorContext);
});
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kory-context-invocation-'));
  foreignRoot = mkdtempSync(join(tmpdir(), 'kory-context-private-'));
  registry = new ToolRegistry();
  registry.register(retrieveNoteContextTool);
  setContext({ kory: { tools: registry } } as never);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(foreignRoot, { recursive: true, force: true });
});
function context(extra: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 'note-context-invocation',
    workingDirectory: root,
    permissionPolicy: resolveToolPermissionPolicy({
      ...DEFAULT_AGENT_SETTINGS,
      permissionMode: 'ask',
    }),
    validateToolInput: true,
    ...extra,
  };
}
function native(input: Record<string, unknown>, ctx = context()) {
  return registry.execute(ctx, {
    id: `retrieval-${++callNumber}`,
    name: 'retrieve_note_context',
    input,
  });
}
async function mcp(method: string, params: Record<string, unknown> = {}) {
  return (await handleMcpRequest({ jsonrpc: '2.0', id: ++callNumber, method, params }, root)) as {
    result?: {
      isError?: boolean;
      content: Array<{ text: string }>;
      tools: Array<{ name: string }>;
    };
    error?: { code: number; message: string };
  };
}
function permission(tool: 'retrieve_note_context' | 'read_note', level: 'auto' | 'ask' | 'block') {
  saveNotesAgentPermissions(root, {
    preset: 'custom',
    tools: { ...DEFAULT_NOTE_TOOL_PERMISSIONS, [tool]: level },
  });
}

describe('Note Network native and MCP invocation', () => {
  test('native read-only retrieval works for managers, workers, and critics in Ask/Plan modes', async () => {
    const note = await createNote(
      { title: 'Invocation evidence', content: 'quasar handoff decision' },
      root,
    );
    for (const callerRole of ['manager', 'worker', 'critic'] as const) {
      for (const mode of ['ask', 'plan'] as const) {
        let prompts = 0;
        const ctx = context({
          callerRole,
          permissionPolicy: { ...context().permissionPolicy!, mode },
          waitForUserInput: async () => {
            prompts++;
            return 'Reject';
          },
        });
        const result = await native({ query: 'quasar', semantic: false }, ctx);
        expect(result.isError).toBe(false);
        expect(result.output).toContain(note.id);
        expect(prompts).toBe(0);
      }
    }
  });

  test('the host-owned scope wins over worker checkouts and caller-supplied project roots are rejected', async () => {
    const local = await createNote({ title: 'Host evidence', content: 'quasar HOST_ONLY' }, root);
    const foreign = await createNote(
      { title: 'Private evidence', content: 'quasar FOREIGN_ONLY' },
      foreignRoot,
    );
    const result = await native(
      { query: 'quasar', seedIds: [foreign.id], semantic: false },
      context({ settingsRoot: root, workingDirectory: foreignRoot }),
    );
    expect(result.isError).toBe(false);
    expect(result.output).toContain(local.id);
    expect(result.output).not.toContain(foreign.id);
    expect(result.output).not.toContain('FOREIGN_ONLY');
    const injected = await native({ query: 'quasar', projectRoot: foreignRoot, semantic: false });
    expect(injected.isError).toBe(true);
    expect(injected.output).not.toContain('FOREIGN_ONLY');
  });

  test('native invocation fails closed for blocked or approval-required retrieval and read access', async () => {
    await createNote({ title: 'Private match', content: 'quasar NEVER_DISCLOSE' }, root);
    for (const tool of ['retrieve_note_context', 'read_note'] as const) {
      for (const level of ['ask', 'block'] as const) {
        permission(tool, level);
        const result = await native({ query: 'quasar', semantic: false });
        expect(result.isError).toBe(true);
        expect(result.output).not.toContain('NEVER_DISCLOSE');
      }
    }
    saveNotesAgentPermissions(root, { preset: 'custom', tools: DEFAULT_NOTE_TOOL_PERMISSIONS });
    saveNotesSettings(root, { enabled: false });
    expect((await native({ query: 'quasar', semantic: false })).isError).toBe(true);
  });

  test('approval is reachable exactly once and a reused call ID cannot replay an old receipt', async () => {
    const note = await createNote(
      { title: 'Approved evidence', content: 'quasar APPROVED_CONTENT' },
      root,
    );
    for (const tool of ['retrieve_note_context', 'read_note'] as const) {
      permission(tool, 'ask');
      let prompts = 0;
      const ctx = context({
        approvedToolCallIds: new Set(),
        waitForUserInput: async () => (++prompts === 1 ? 'Allow once' : 'Reject'),
      });
      const call = {
        id: 'reused-provider-id',
        name: 'retrieve_note_context',
        input: { query: 'quasar', semantic: false },
      };
      const approved = await registry.execute(ctx, call);
      expect(approved.isError).toBe(false);
      expect(approved.output).toContain(note.id);
      expect(prompts).toBe(1);
      const rejected = await registry.execute(ctx, call);
      expect(rejected.isError).toBe(true);
      expect(rejected.output).not.toContain('APPROVED_CONTENT');
      expect(prompts).toBe(2);
    }
  });

  test('read-tool host blocklists cannot be bypassed through associative retrieval', async () => {
    await createNote({ title: 'Host blocked evidence', content: 'quasar HOST_BLOCKED' }, root);
    const result = await native(
      { query: 'quasar', semantic: false },
      context({
        permissionPolicy: resolveToolPermissionPolicy({
          ...DEFAULT_AGENT_SETTINGS,
          permissionMode: 'yolo',
          toolBlocklist: ['read_note'],
        }),
      }),
    );
    expect(result.isError).toBe(true);
    expect(result.output).not.toContain('HOST_BLOCKED');
  });

  test('HTTP knowledge MCP advertises and executes the same bounded tool through the registry', async () => {
    const note = await createNote({ title: 'MCP evidence', content: 'quasar MCP_PUBLIC' }, root);
    await createNote({ title: 'MCP secret', content: 'quasar MCP_PRIVATE' }, foreignRoot);
    expect((await mcp('tools/list')).result?.tools.map((tool) => tool.name)).toContain(
      'retrieve_note_context',
    );
    const result = await mcp('tools/call', {
      name: 'retrieve_note_context',
      arguments: { query: 'quasar', semantic: false },
    });
    expect(result.error).toBeUndefined();
    expect(result.result?.isError).toBe(false);
    expect(result.result?.content[0]?.text).toContain(note.id);
    expect(result.result?.content[0]?.text).not.toContain('MCP_PRIVATE');
  });

  test('stale MCP clients cannot invoke retrieval after Notes access is revoked or needs approval', async () => {
    await createNote({ title: 'Protected MCP evidence', content: 'quasar DO_NOT_RETURN' }, root);
    for (const level of ['ask', 'block'] as const) {
      permission('retrieve_note_context', level);
      if (level === 'block') {
        expect((await mcp('tools/list')).result?.tools.map((tool) => tool.name)).not.toContain(
          'retrieve_note_context',
        );
      }
      const result = await mcp('tools/call', {
        name: 'retrieve_note_context',
        arguments: { query: 'quasar', semantic: false },
      });
      expect(result.result?.isError).toBe(true);
      expect(result.result?.content[0]?.text).not.toContain('DO_NOT_RETURN');
    }
    permission('read_note', 'block');
    const result = await mcp('tools/call', {
      name: 'retrieve_note_context',
      arguments: { query: 'quasar', semantic: false },
    });
    expect(result.result?.isError).toBe(true);
    expect(result.result?.content[0]?.text).not.toContain('DO_NOT_RETURN');
  });

  test('real MCP protocol validates the retrieval schema before proxying and preserves its response', async () => {
    const note = await createNote(
      { title: 'Bridge evidence', content: 'quasar BRIDGE_EVIDENCE' },
      root,
    );
    let calls = 0;
    const handler = createMcpHandler(() =>
      createBridgeServer(
        [
          {
            name: 'kory__retrieve_note_context',
            description: retrieveNoteContextTool.description,
            inputSchema: retrieveNoteContextTool.inputSchema,
          },
        ],
        async (name, input) => {
          calls++;
          const result = await registry.execute(context({ callerRole: 'critic' }), {
            id: `bridge-${calls}`,
            name: name.replace(/^kory__/, ''),
            input,
          });
          return { content: result.output, isError: result.isError };
        },
      ),
    );
    const client = new Client(
      { name: 'note-context-test', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
          fetch: (url, init) => handler.fetch(new Request(url, init)),
        }),
      );
      const valid = await client.callTool({
        name: 'kory__retrieve_note_context',
        arguments: { query: 'quasar', maxHops: 0, semantic: false },
      });
      expect(valid.isError).toBe(false);
      expect(JSON.stringify(valid.content)).toContain(note.id);
      expect(calls).toBe(1);
      for (const input of [
        {},
        { query: 'quasar', maxHops: 99 },
        { query: 'quasar', projectRoot: foreignRoot },
      ]) {
        const invalid = await client.callTool({
          name: 'kory__retrieve_note_context',
          arguments: input,
        });
        expect(invalid.isError).toBe(true);
      }
      expect(calls).toBe(1);
    } finally {
      await client.close();
      await handler.close();
    }
  });
});
