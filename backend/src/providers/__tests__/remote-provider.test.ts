import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderRegistry } from '../registry';
import { RemoteProvider, applyRemoteFileEdit } from '../remote-provider';
import type { ProviderEvent, StreamRequest } from '../types';

// A RemoteProvider whose transport is stubbed — proves the registry resolves a
// remote model to the remote provider and streams its events, without a relay.
class StubRemoteProvider extends RemoteProvider {
  override isAvailable(): boolean {
    return true;
  }
  override async *streamResponse(_request: StreamRequest): AsyncGenerator<ProviderEvent> {
    yield { type: 'content_delta', content: 'hello ' };
    yield { type: 'content_delta', content: 'from host' };
    yield { type: 'complete', finishReason: 'end_turn' };
  }
}

describe('RemoteProvider registry integration', () => {
  test('a remote model resolves to the remote provider and streams', async () => {
    const registry = new ProviderRegistry();
    const remote = new StubRemoteProvider({
      id: 'remote-google',
      label: "Friend's PC · Google",
      hostProvider: 'google',
      models: [
        {
          id: 'gemini-3.1-pro',
          name: 'Gemini 3.1 Pro',
          provider: 'remote-google' as never,
          contextWindow: 1_000_000,
          maxOutputTokens: 64_000,
        },
      ],
    });
    registry.registerRemoteProvider(remote);

    // The client has NO local google — picking the model with the remote
    // provider preferred must resolve to the remote provider.
    const resolved = registry.resolveProvider('gemini-3.1-pro', 'remote-google' as never);
    expect(resolved?.name).toBe('remote-google');

    const events: ProviderEvent[] = [];
    for await (const ev of registry.executeWithRetry(
      {
        model: 'gemini-3.1-pro',
        messages: [{ role: 'user', content: 'hi' }],
        systemPrompt: '',
      },
      'remote-google' as never,
    )) {
      events.push(ev);
    }
    const text = events
      .filter((e) => e.type === 'content_delta')
      .map((e) => e.content)
      .join('');
    expect(text).toBe('hello from host');
    expect(events.some((e) => e.type === 'complete')).toBe(true);
  });

  test('clearRemoteProviders removes only remote-* providers', () => {
    const registry = new ProviderRegistry();
    registry.registerRemoteProvider(
      new StubRemoteProvider({
        id: 'remote-codex',
        label: 'Host · Codex',
        hostProvider: 'codex',
        models: [
          { id: 'gpt-5.6-sol', name: 'GPT 5.6 Sol', provider: 'remote-codex' as never, contextWindow: 400_000, maxOutputTokens: 128_000 },
        ],
      }),
    );
    expect(registry.get('remote-codex' as never)).toBeDefined();
    registry.clearRemoteProviders();
    expect(registry.get('remote-codex' as never)).toBeUndefined();
  });
});

// The Windows/agentic sharing data-integrity path: a host CLI edit must apply
// to the client's real file WITHOUT destroying the rest of it.
describe('applyRemoteFileEdit (shared CLI edit apply)', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'kory-rp-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  const ORIGINAL = `line 1\nline 2 TARGET here\nline 3\nline 4\n`;

  test('create writes the full file (nested dirs created)', async () => {
    expect(await applyRemoteFileEdit(root, {
      type: 'file_edit', filePath: 'src/new/file.ts', fileContent: 'export const x = 1;\n', fileOperation: 'create',
    })).toBe('written');
    expect(await readFile(join(root, 'src/new/file.ts'), 'utf-8')).toBe('export const x = 1;\n');
  });

  test('edit splices the snippet and PRESERVES the rest of the file (regression)', async () => {
    await writeFile(join(root, 'a.txt'), ORIGINAL, 'utf-8');
    expect(await applyRemoteFileEdit(root, {
      type: 'file_edit', filePath: 'a.txt',
      fileOldContent: 'line 2 TARGET here', fileContent: 'line 2 REPLACED', fileOperation: 'edit',
    })).toBe('spliced');
    expect(await readFile(join(root, 'a.txt'), 'utf-8')).toBe(`line 1\nline 2 REPLACED\nline 3\nline 4\n`);
  });

  test('edit does NOT overwrite the file with just the fragment', async () => {
    await writeFile(join(root, 'a.txt'), ORIGINAL, 'utf-8');
    await applyRemoteFileEdit(root, {
      type: 'file_edit', filePath: 'a.txt', fileOldContent: 'line 2 TARGET here', fileContent: 'X', fileOperation: 'edit',
    });
    const after = await readFile(join(root, 'a.txt'), 'utf-8');
    expect(after).not.toBe('X'); // the bug would make the whole file just "X"
    expect(after).toContain('line 1');
    expect(after).toContain('line 4');
  });

  test('edit whose target text is missing is skipped, file untouched', async () => {
    await writeFile(join(root, 'a.txt'), ORIGINAL, 'utf-8');
    expect(await applyRemoteFileEdit(root, {
      type: 'file_edit', filePath: 'a.txt', fileOldContent: 'DOES NOT EXIST', fileContent: 'whatever', fileOperation: 'edit',
    })).toBe('not-found');
    expect(await readFile(join(root, 'a.txt'), 'utf-8')).toBe(ORIGINAL);
  });

  test('sequential MultiEdit-style edits apply in order', async () => {
    await writeFile(join(root, 'm.txt'), `alpha beta gamma\n`, 'utf-8');
    await applyRemoteFileEdit(root, { type: 'file_edit', filePath: 'm.txt', fileOldContent: 'alpha', fileContent: 'ALPHA', fileOperation: 'edit' });
    await applyRemoteFileEdit(root, { type: 'file_edit', filePath: 'm.txt', fileOldContent: 'gamma', fileContent: 'GAMMA', fileOperation: 'edit' });
    expect(await readFile(join(root, 'm.txt'), 'utf-8')).toBe(`ALPHA beta GAMMA\n`);
  });

  test('rejects path traversal and absolute paths', async () => {
    expect(await applyRemoteFileEdit(root, { type: 'file_edit', filePath: '../escape.txt', fileContent: 'x', fileOperation: 'create' })).toBe('skipped');
    expect(await applyRemoteFileEdit(root, { type: 'file_edit', filePath: '/etc/evil', fileContent: 'x', fileOperation: 'create' })).toBe('skipped');
  });

  test('a POSIX-relative subpath writes correctly (cross-platform join)', async () => {
    await applyRemoteFileEdit(root, { type: 'file_edit', filePath: 'deep/a/b/c.ts', fileContent: 'ok', fileOperation: 'create' });
    expect(await readFile(join(root, 'deep', 'a', 'b', 'c.ts'), 'utf-8')).toBe('ok');
  });
});
