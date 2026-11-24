// Restart simulation for every persisted image kind.
//
// Each case writes through the real production path in this process, then
// starts a brand-new Bun process (new DB connection, new store instances, no
// shared module state, different cwd) against the SAME data dir and asks it to
// read the reference back. If the reference is lost, the child says so.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nanoid } from 'nanoid';

process.env.NODE_ENV = 'test';
process.env.SESSION_TOKEN_SECRET ??= 'test_only_not_for_production_aaaaaaaaaa';
const dataRoot = mkdtempSync(join(tmpdir(), 'kory-image-restart-'));
process.env.KORYPHAIOS_DATA_DIR = dataRoot;

const { initDb, db, sessions } = await import('../db');
const { MessageStore } = await import('../stores/message-store');
const { saveImageHistory } = await import('./image-history');
const { computerScreenshots } = await import('../computer-use/screenshots');
const { createNote, saveAttachment, setNoteIcon } = await import('../notes/notes-service');
const { storeProjectIcon } = await import('../projects/project-icons');

await initDb();

// A real 1x1 PNG.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG_BYTES = Buffer.from(PNG_B64, 'base64');
const SRC = (file: string) => join(import.meta.dir, '..', file);
const SRC_IMPORT = {
  db: SRC('db/index.ts'),
  messageStore: SRC('stores/message-store.ts'),
  imageHistory: SRC('images/image-history.ts'),
  screenshots: SRC('computer-use/screenshots.ts'),
  notes: SRC('notes/notes-service.ts'),
  projectIcons: SRC('projects/project-icons.ts'),
};

/** A 256x256 PNG header: the same minimal shape the project-icon validator accepts. */
function png256(): Buffer {
  const header = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  Buffer.from('IHDR', 'ascii').copy(header, 12);
  header.writeUInt32BE(256, 16);
  header.writeUInt32BE(256, 20);
  return Buffer.concat([header, Buffer.alloc(64)]);
}

/**
 * Run `body` in a fresh Bun process that shares only the data dir and the DB
 * URL with this one. The child starts from a different cwd, so nothing may
 * depend on the launch directory either.
 */
async function afterRestart<T>(body: string): Promise<T> {
  const probe = `
    (async () => {
      const { initDb } = await import(${JSON.stringify(SRC_IMPORT.db)});
      await initDb();
      const result = await (async () => { ${body} })();
      console.log('RESTART_RESULT ' + JSON.stringify(result));
    })().catch((error) => {
      console.error(error instanceof Error ? error.stack : String(error));
      process.exit(3);
    });
  `;
  const proc = Bun.spawn([process.execPath, '-e', probe], {
    cwd: tmpdir(),
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const line = stdout.split('\n').find((candidate) => candidate.startsWith('RESTART_RESULT '));
  if (code !== 0 || !line) throw new Error(`restart probe failed (exit ${code}): ${stderr}`);
  return JSON.parse(line.slice('RESTART_RESULT '.length)) as T;
}

async function newSession(label: string): Promise<string> {
  const sessionId = `restart-${label}-${nanoid(8)}`;
  await db.insert(sessions).values({
    id: sessionId,
    title: 'Restart simulation',
    createdAt: new Date(1_000),
    updatedAt: new Date(1_000),
  });
  return sessionId;
}

describe('image references survive a process restart', () => {
  test('chat composer attachment on a user message', async () => {
    const sessionId = await newSession('user-attachment');
    const messageId = `user-${nanoid(8)}`;
    await new MessageStore().add(sessionId, {
      id: messageId,
      sessionId,
      role: 'user',
      content: 'What is in this screenshot?',
      attachments: [{ type: 'image', data: PNG_B64, name: 'shot.png', mimeType: 'image/png' }],
      createdAt: 2_000,
    });

    const after = await afterRestart<{ attachments?: unknown; content: string }>(`
      const message = await new (await import(${JSON.stringify(SRC_IMPORT.messageStore)})).MessageStore()
        .getById(${JSON.stringify(sessionId)}, ${JSON.stringify(messageId)});
      return { content: message?.content ?? '', attachments: message?.attachments };
    `);
    expect(after.content).toBe('What is in this screenshot?');
    expect(after.attachments).toEqual([
      { type: 'image', data: PNG_B64, name: 'shot.png', mimeType: 'image/png' },
    ]);
  });

  test('chat-generated image on an assistant message', async () => {
    const sessionId = await newSession('generated-chat');
    const messageId = `assistant-${nanoid(8)}`;
    await new MessageStore().add(sessionId, {
      id: messageId,
      sessionId,
      role: 'assistant',
      content: 'Generated image.',
      attachments: [{ type: 'image', data: PNG_B64, name: 'generated.png', mimeType: 'image/png' }],
      createdAt: 2_000,
    });

    const after = await afterRestart<{ attachments?: unknown }>(`
      const message = await new (await import(${JSON.stringify(SRC_IMPORT.messageStore)})).MessageStore()
        .getById(${JSON.stringify(sessionId)}, ${JSON.stringify(messageId)});
      return { attachments: message?.attachments };
    `);
    expect(after.attachments).toEqual([
      { type: 'image', data: PNG_B64, name: 'generated.png', mimeType: 'image/png' },
    ]);
  });

  test('image studio history entry', async () => {
    const entry = await saveImageHistory({
      imageBase64: PNG_B64,
      mimeType: 'image/png',
      prompt: 'A restart-proof gallery image',
      provider: 'openai',
      model: 'gpt-image-1',
      mode: 'generate',
    });
    expect(entry?.id).toBeDefined();

    const after = await afterRestart<{ ids: string[]; imageBase64?: string }>(`
      const history = await import(${JSON.stringify(SRC_IMPORT.imageHistory)});
      const list = await history.listImageHistory();
      const detail = await history.getImageHistoryEntry(${JSON.stringify(entry!.id)});
      return { ids: list.map((row) => row.id), imageBase64: detail?.imageBase64 };
    `);
    expect(after.ids).toContain(entry!.id);
    expect(after.imageBase64).toBe(PNG_B64);
  });

  test('computer-use screenshot referenced by a persisted tool receipt', async () => {
    const sessionId = await newSession('computer-use');
    const receipt = computerScreenshots.put(sessionId, PNG_B64);

    const after = await afterRestart<{ base64?: string }>(`
      const shots = (await import(${JSON.stringify(SRC_IMPORT.screenshots)})).computerScreenshots;
      const bytes = shots.get(${JSON.stringify(sessionId)}, ${JSON.stringify(receipt.id)});
      return { base64: bytes ? Buffer.from(bytes).toString('base64') : undefined };
    `);
    expect(after.base64).toBe(PNG_B64);
  });

  test('note image attachment', async () => {
    const note = await createNote({ title: 'Restart attachment' }, dataRoot);
    const attachment = await saveAttachment(note.id, 'shot.png', 'image/png', PNG_BYTES, dataRoot);

    const after = await afterRestart<{ base64?: string; mimeType?: string }>(`
      const notes = await import(${JSON.stringify(SRC_IMPORT.notes)});
      const stored = await notes.getAttachment(${JSON.stringify(attachment.id)}, ${JSON.stringify(dataRoot)});
      if (!stored) return {};
      const bytes = (await import('node:fs')).readFileSync(stored.storagePath);
      return { base64: bytes.toString('base64'), mimeType: stored.mimeType };
    `);
    expect(after.mimeType).toBe('image/png');
    expect(after.base64).toBe(PNG_B64);
  });

  test('note icon of kind image', async () => {
    const note = await createNote({ title: 'Restart icon' }, dataRoot);
    const icon = { kind: 'image' as const, value: `data:image/png;base64,${PNG_B64}` };
    await setNoteIcon(note.id, icon, dataRoot);

    const after = await afterRestart<{ icon?: unknown }>(`
      const notes = await import(${JSON.stringify(SRC_IMPORT.notes)});
      const row = await notes.getNote(${JSON.stringify(note.id)}, ${JSON.stringify(dataRoot)});
      return { icon: row?.icon };
    `);
    expect(after.icon).toEqual(icon);
  });

  test('project icon asset', async () => {
    const projectId = `project-${nanoid(8)}`;
    const stored = await storeProjectIcon(projectId, png256());

    const after = await afterRestart<{ base64?: string }>(`
      const icons = await import(${JSON.stringify(SRC_IMPORT.projectIcons)});
      const read = await icons.readProjectIcon(${JSON.stringify(projectId)}, ${JSON.stringify(stored.assetId)});
      return { base64: read?.bytes.toString('base64') };
    `);
    expect(after.base64).toBe(png256().toString('base64'));
  });
});
