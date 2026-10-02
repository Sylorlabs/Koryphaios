import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNote, searchNotes, updateNote, trashNote } from '../notes-service';
import { saveNotesAgentPermissions } from '../notes-settings';

let root: string;
let otherRoot: string;
const originalFetch = globalThis.fetch;
let savedEnv: Record<string, string | undefined>;
const envNames = [
  'KORY_EMBEDDINGS_ENABLED',
  'KORY_EMBEDDING_ENDPOINT',
  'KORY_EMBEDDING_MODEL',
  'KORY_EMBEDDING_DIMENSIONS',
  'KORY_EMBEDDING_API_KEY',
  'KORY_EMBEDDING_TIMEOUT_MS',
];
let inputs: string[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'semantic-notes-'));
  otherRoot = mkdtempSync(join(tmpdir(), 'semantic-private-'));
  savedEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    KORY_EMBEDDINGS_ENABLED: '1',
    KORY_EMBEDDING_ENDPOINT: 'https://embedding.example/embeddings',
    KORY_EMBEDDING_MODEL: 'test',
    KORY_EMBEDDING_DIMENSIONS: '2',
    KORY_EMBEDDING_API_KEY: 'mock-secret',
    KORY_EMBEDDING_TIMEOUT_MS: '50',
  });
  inputs = [];
  globalThis.fetch = (async (_, init) => {
    const texts = JSON.parse(init!.body as string).input as string[];
    inputs.push(...texts);
    return Response.json({
      data: texts.map((text, index) => ({
        index,
        embedding: /automobile|vehicle/.test(text) ? [1, 0] : [0, 1],
      })),
    });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of envNames) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(root, { recursive: true, force: true });
  rmSync(otherRoot, { recursive: true, force: true });
});

describe('active semantic notes search', () => {
  test('retrieves semantic matches and excludes foreign project and trash before transport', async () => {
    const car = await createNote({ title: 'Transport', content: 'automobile' }, root);
    await createNote({ title: 'Lunch', content: 'banana' }, root);
    await createNote({ title: 'Secret', content: 'private-other-project' }, otherRoot);
    const trash = await createNote({ title: 'Discarded', content: 'private-trash' }, root);
    await trashNote(trash.id, root);
    expect((await searchNotes('vehicle', 1, root)).map((n) => n.id)).toEqual([car.id]);
    expect(inputs.join(' ')).toContain('automobile');
    expect(inputs.join(' ')).not.toContain('private-other-project');
    expect(inputs.join(' ')).not.toContain('private-trash');
    await updateNote(car.id, { content: 'banana now' }, root);
    await searchNotes('vehicle', 1, root);
    expect(inputs.join(' ')).toContain('banana now');
    await trashNote(car.id, root);
    expect((await searchNotes('vehicle', 50, root)).some((n) => n.id === car.id)).toBe(false);
  });
  test('disabled, unscoped and blocked/approval-required notes never reach transport', async () => {
    await createNote({ title: 'Local', content: 'banana' }, root);
    delete process.env.KORY_EMBEDDINGS_ENABLED;
    expect((await searchNotes('banana', 50, root)).length).toBe(1);
    process.env.KORY_EMBEDDINGS_ENABLED = '1';
    await searchNotes('banana');
    for (const permission of ['block', 'ask'] as const) {
      saveNotesAgentPermissions(root, { tools: { read_note: permission } } as Parameters<
        typeof saveNotesAgentPermissions
      >[1]);
      await searchNotes('banana', 50, root);
    }
    expect(inputs).toEqual([]);
  });
  test('credential rotation re-embeds documents and cancellation stops active search', async () => {
    await createNote({ title: 'Transport', content: 'automobile' }, root);
    await searchNotes('vehicle', 50, root);
    inputs = [];
    await searchNotes('vehicle', 50, root);
    expect(inputs).toEqual(['vehicle']);
    process.env.KORY_EMBEDDING_API_KEY = 'rotated-mock';
    inputs = [];
    await searchNotes('vehicle', 50, root);
    expect(inputs.join(' ')).toContain('automobile');
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    globalThis.fetch = (async (_, init) => {
      seen = init!.signal as AbortSignal;
      controller.abort();
      return new Promise<Response>(() => {});
    }) as typeof fetch;
    await searchNotes('automobile', 50, root, { signal: controller.signal });
    expect(seen?.aborted).toBe(true);
  });
  test('agent search caller propagates abort and never returns late semantic results', async () => {
    const { searchNotesTool } = await import('../../tools/notes');
    await createNote({ title: 'Late semantic result', content: 'automobile' }, root);
    const controller = new AbortController();
    let transportSignal: AbortSignal | undefined;
    let finish: ((response: Response) => void) | undefined;
    globalThis.fetch = (async (_, init) => {
      transportSignal = init!.signal as AbortSignal;
      controller.abort();
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    }) as typeof fetch;
    const output = await searchNotesTool.run(
      { sessionId: 'test', workingDirectory: root, signal: controller.signal },
      { id: 'search', name: 'search_notes', input: { query: 'vehicle' } },
    );
    expect(transportSignal?.aborted).toBe(true);
    expect(output.isError).toBe(true);
    expect(output.output).toContain('Notes search canceled');
    finish?.(Response.json({ data: [{ index: 0, embedding: [1, 0] }] }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(output.output).not.toContain('Late semantic result');
  });
  test('authentication errors, malformed vectors and timeout fall back to existing FTS', async () => {
    const note = await createNote({ title: 'Local', content: 'banana' }, root);
    for (const transport of [
      async () => new Response('mock-secret', { status: 401 }),
      async () => Response.json({ data: [{ index: 0, embedding: [1] }] }),
      async () => new Promise<Response>(() => {}),
    ]) {
      globalThis.fetch = transport as typeof fetch;
      expect((await searchNotes('banana', 50, root)).map((n) => n.id)).toEqual([note.id]);
    }
  });
});
