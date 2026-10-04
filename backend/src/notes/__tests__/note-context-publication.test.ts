import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb } from '../../db';
import { createNote } from '../notes-service';
import { rebuildNoteSemanticIndex } from '../note-semantic-index';
import { saveNotesAgentPermissions, saveNotesSettings } from '../notes-settings';
import { retrieveNoteContextTool, noteGraphSummaryTool } from '../../tools/notes';
import { ToolRegistry, type ToolContext } from '../../tools/registry';
import { resolveToolPermissionPolicy } from '../../tools/permission-policy';
import { DEFAULT_AGENT_SETTINGS } from '../../agent-settings';

const envKeys = [
  'KORY_EMBEDDINGS_ENABLED',
  'KORY_EMBEDDING_ENDPOINT',
  'KORY_EMBEDDING_MODEL',
  'KORY_EMBEDDING_DIMENSIONS',
  'KORY_EMBEDDING_API_KEY',
];
const originalFetch = globalThis.fetch;
let root: string;
let saved: Record<string, string | undefined>;
beforeAll(() => initDb());
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kory-note-publication-'));
  saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    KORY_EMBEDDINGS_ENABLED: '1',
    KORY_EMBEDDING_ENDPOINT: 'https://embedding.example/embeddings',
    KORY_EMBEDDING_MODEL: 'publication-test',
    KORY_EMBEDDING_DIMENSIONS: '2',
    KORY_EMBEDDING_API_KEY: 'mock-only',
  });
  globalThis.fetch = (async () =>
    Response.json({ data: [{ index: 0, embedding: [1, 0] }] })) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of envKeys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(root, { recursive: true, force: true });
});

describe('note context publication authorization', () => {
  test('graph summaries distinguish unresolved references from real notes', async () => {
    await createNote({ title: 'One real note', content: '[[A missing target]]' }, root);
    const output = await noteGraphSummaryTool.run(
      { sessionId: 'graph-summary', workingDirectory: root },
      { id: 'summary', name: 'get_note_graph_summary', input: {} },
    );
    expect(output.isError).toBe(false);
    expect(output.output).toContain('Shown notes: 1');
    expect(output.output).toContain('Unresolved references: 1');
    expect(output.output).toContain('Connected shown notes: 1');
    expect(output.output).not.toContain('Total notes:');
  });
  for (const change of [
    'read_block',
    'retrieval_block',
    'read_ask',
    'notes_disabled',
    'host_block',
  ] as const) {
    test(`does not publish lexical fallback after ${change} during semantic transport`, async () => {
      await createNote(
        { title: 'Publication evidence', content: 'quasar NEVER_PUBLISH_AFTER_REVOCATION' },
        root,
      );
      await rebuildNoteSemanticIndex(root, { optIn: true });
      const registry = new ToolRegistry();
      registry.register(retrieveNoteContextTool);
      const context: ToolContext = {
        sessionId: 'publication-test',
        workingDirectory: root,
        permissionPolicy: resolveToolPermissionPolicy({
          ...DEFAULT_AGENT_SETTINGS,
          permissionMode: 'guarded',
        }),
      };
      globalThis.fetch = (async () => {
        if (change === 'notes_disabled') saveNotesSettings(root, { enabled: false });
        else if (change === 'host_block')
          context.permissionPolicy = { ...context.permissionPolicy!, toolBlocklist: ['read_note'] };
        else
          saveNotesAgentPermissions(root, {
            tools: {
              [change === 'retrieval_block' ? 'retrieve_note_context' : 'read_note']:
                change === 'read_ask' ? 'ask' : 'block',
            },
          } as Parameters<typeof saveNotesAgentPermissions>[1]);
        return Response.json({ data: [{ index: 0, embedding: [1, 0] }] });
      }) as typeof fetch;
      const output = await registry.execute(context, {
        id: 'publication-read',
        name: 'retrieve_note_context',
        input: { query: 'quasar' },
      });
      expect(output.isError).toBe(true);
      expect(output.output).not.toContain('NEVER_PUBLISH_AFTER_REVOCATION');
    });
  }
});
