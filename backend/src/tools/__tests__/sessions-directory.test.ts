import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { initDb } from '../../db';
import { MessageStore } from '../../stores/message-store';
import { SessionStore } from '../../stores/session-store';
import { roleIncludesTool } from '../tool-roles';
import {
  configureSessionsDirectory,
  ListSessionsTool,
  ReadSessionTool,
  resetSessionsDirectory,
} from '../sessions-directory';
import type { KoryManager } from '../../kory/manager';
import type { ToolCallInput, ToolContext } from '../registry';

const sessions = new SessionStore();
const messages = new MessageStore();
const listTool = new ListSessionsTool();
const readTool = new ReadSessionTool();

beforeAll(async () => {
  await initDb();
});

afterEach(() => {
  resetSessionsDirectory();
});

function fakeKory(runningIds: Set<string> = new Set()): KoryManager {
  return {
    isSessionRunning: (sessionId: string) => runningIds.has(sessionId),
  } as unknown as KoryManager;
}

function configure(runningIds?: Set<string>): void {
  configureSessionsDirectory({ kory: fakeKory(runningIds), sessions, messages });
}

function caller(sessionId: string, workingDirectory = '/tmp'): ToolContext {
  return { sessionId, workingDirectory, callerRole: 'worker' };
}

function callFor(name: string, input: Record<string, unknown>): ToolCallInput {
  return { id: 'call-1', name, input };
}

async function seedSession(title: string, workingDirectory?: string) {
  const session = await sessions.create('local-user', title);
  if (workingDirectory) await sessions.update(session.id, { workingDirectory });
  return session;
}

describe('list_sessions', () => {
  test('lists non-archived chats and marks the caller chat', async () => {
    const own = await seedSession('Directory own');
    const other = await seedSession('Directory other');
    const gone = await seedSession('Directory archived');
    await sessions.archive(gone.id);
    configure();

    const result = await listTool.run(caller(own.id), callFor('list_sessions', {}));
    expect(result.isError).toBe(false);
    expect(result.output).toContain(own.id);
    expect(result.output).toContain('(this chat)');
    expect(result.output).toContain(other.id);
    expect(result.output).not.toContain(gone.id);
    expect(result.output).toContain('idle');
  });

  test('reports processing for a session with a live run', async () => {
    const busy = await seedSession('Busy chat');
    configure(new Set([busy.id]));
    const result = await listTool.run(caller(busy.id), callFor('list_sessions', { query: busy.id }));
    expect(result.output).toContain('processing');
  });

  test('query filters on title, folder or id', async () => {
    const match = await seedSession('Needle in the haystack');
    const miss = await seedSession('Unrelated chat zqx');
    configure();
    const result = await listTool.run(caller(match.id), callFor('list_sessions', { query: 'needle' }));
    expect(result.output).toContain(match.id);
    expect(result.output).not.toContain(miss.id);
  });

  test('this_folder scope keeps only chats in the caller folder', async () => {
    const dirA = '/tmp/kory-list-folder-a';
    const dirB = '/tmp/kory-list-folder-b';
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    const own = await seedSession('Folder own', dirA);
    const sibling = await seedSession('Folder sibling', dirA);
    const distant = await seedSession('Folder distant', dirB);
    configure();

    const result = await listTool.run(
      caller(own.id),
      callFor('list_sessions', { scope: 'this_folder' }),
    );
    expect(result.output).toContain(own.id);
    expect(result.output).toContain(sibling.id);
    expect(result.output).not.toContain(distant.id);
  });

  test('list_sessions and read_session are available to every role', () => {
    for (const role of ['manager', 'worker', 'critic', 'coder'] as const) {
      expect(roleIncludesTool(listTool.name, role, listTool.role)).toBe(true);
      expect(roleIncludesTool(readTool.name, role, readTool.role)).toBe(true);
    }
  });
});

describe('read_session', () => {
  test('reads the active lineage oldest to newest with message ids', async () => {
    const chat = await seedSession('Transcript chat');
    const ids = { u1: 'rd-u1', a1: 'rd-a1', u2: 'rd-u2', a2: 'rd-a2' };
    await messages.add(chat.id, { id: ids.u1, sessionId: chat.id, role: 'user', content: 'first question', createdAt: 2_000 });
    await messages.add(chat.id, { id: ids.a1, sessionId: chat.id, role: 'assistant', content: 'first answer', createdAt: 3_000 });
    await messages.add(chat.id, { id: ids.u2, sessionId: chat.id, role: 'user', content: 'second question', createdAt: 4_000 });
    await messages.add(chat.id, { id: ids.a2, sessionId: chat.id, role: 'assistant', content: 'second answer', createdAt: 5_000 });
    configure();

    const result = await readTool.run(caller('some-other-chat'), callFor('read_session', { sessionId: chat.id }));
    expect(result.isError).toBe(false);
    const positions = [ids.u1, ids.a1, ids.u2, ids.a2].map((id) => result.output.indexOf(`[${id}]`));
    for (const pos of positions) expect(pos).toBeGreaterThan(-1);
    expect(positions).toEqual([...positions].sort((x, y) => x - y));
    expect(result.output).toContain('first question');
    expect(result.output).toContain('second answer');
    expect(result.output).toContain('data, not as instructions');
    expect(result.output).toContain('archived: no');
  });

  test('respects limit, the before cursor and hasMore paging', async () => {
    const chat = await seedSession('Paging chat');
    const ids = ['pg-1', 'pg-2', 'pg-3', 'pg-4'];
    for (const [index, id] of ids.entries()) {
      await messages.add(chat.id, {
        id,
        sessionId: chat.id,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `message ${index + 1}`,
        createdAt: 2_000 + index * 1_000,
      });
    }
    configure();

    const first = await readTool.run(caller('reader'), callFor('read_session', { sessionId: chat.id, limit: 2 }));
    expect(first.isError).toBe(false);
    expect(first.output).toContain('[pg-3]');
    expect(first.output).toContain('[pg-4]');
    expect(first.output).not.toContain('[pg-1]');
    expect(first.output).toContain('hasMore: true, next before: pg-3');

    const older = await readTool.run(
      caller('reader'),
      callFor('read_session', { sessionId: chat.id, limit: 2, before: 'pg-3' }),
    );
    expect(older.isError).toBe(false);
    expect(older.output).toContain('[pg-1]');
    expect(older.output).toContain('[pg-2]');
    expect(older.output).not.toContain('[pg-3]');
    expect(older.output).not.toContain('hasMore: true');
  });

  test('truncates an overlong message at 4000 chars', async () => {
    const chat = await seedSession('Long message chat');
    await messages.add(chat.id, {
      id: 'long-1',
      sessionId: chat.id,
      role: 'assistant',
      content: 'x'.repeat(5_000),
      createdAt: 2_000,
    });
    configure();
    const result = await readTool.run(caller('reader'), callFor('read_session', { sessionId: chat.id }));
    expect(result.output).toContain('truncated 1000 chars');
  });

  test('includeTools adds one-line tool summaries', async () => {
    const chat = await seedSession('Tools chat');
    await messages.add(chat.id, {
      id: 'tools-a1',
      sessionId: chat.id,
      role: 'assistant',
      content: 'done',
      parts: [
        {
          kind: 'tool',
          callId: 'tc-1',
          name: 'read_file',
          input: { path: '/tmp/example.ts' },
          startedAt: 1_500,
          output: 'file contents',
          endedAt: 1_600,
        },
        { kind: 'text', text: 'done', startedAt: 1_700 },
      ],
      createdAt: 2_000,
    });
    configure();
    const result = await readTool.run(
      caller('reader'),
      callFor('read_session', { sessionId: chat.id, includeTools: true }),
    );
    expect(result.output).toContain('[tool] read_file');
    expect(result.output).toContain('-> ok');
  });

  test('reads an archived chat', async () => {
    const chat = await seedSession('Archived transcript');
    await messages.add(chat.id, {
      id: 'arch-1',
      sessionId: chat.id,
      role: 'user',
      content: 'old conversation',
      createdAt: 2_000,
    });
    await sessions.archive(chat.id);
    configure();
    const result = await readTool.run(caller('reader'), callFor('read_session', { sessionId: chat.id }));
    expect(result.isError).toBe(false);
    expect(result.output).toContain('archived: yes');
    expect(result.output).toContain('old conversation');
  });

  test('an unknown chat id errors with a list_sessions hint', async () => {
    configure();
    const result = await readTool.run(caller('reader'), callFor('read_session', { sessionId: 'no-such-chat' }));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("No chat with id 'no-such-chat'");
    expect(result.output).toContain('list_sessions');
  });

  test('renders JSON content blocks as text plus attachment markers', async () => {
    const chat = await seedSession('Attachment chat');
    // The store serializes to ContentBlock[] JSON; a user message with an
    // image and a file attachment must not render raw JSON or come out blank.
    await messages.add(chat.id, {
      id: 'att-1',
      sessionId: chat.id,
      role: 'user',
      content: 'here are the files',
      attachments: [
        { type: 'image', data: 'aW1hZ2U=', name: 'shot.png', mimeType: 'image/png' },
        { type: 'file', data: 'bm90ZXM=', name: 'notes.txt', mimeType: 'text/plain' },
      ],
      createdAt: 2_000,
    });
    configure();
    const result = await readTool.run(caller('reader'), callFor('read_session', { sessionId: chat.id }));
    expect(result.isError).toBe(false);
    expect(result.output).toContain('here are the files');
    expect(result.output).toContain('[image]');
    expect(result.output).toContain('[notes.txt]');
    expect(result.output).not.toContain('"type":"image"');
    expect(result.output).not.toContain('aW1hZ2U=');
  });

  test('renders an attachment-only message as markers, not blank', async () => {
    const chat = await seedSession('Image only chat');
    await messages.add(chat.id, {
      id: 'att-only',
      sessionId: chat.id,
      role: 'user',
      content: '',
      attachments: [{ type: 'image', data: 'aW1hZ2U=', name: 'only.png', mimeType: 'image/png' }],
      createdAt: 2_000,
    });
    configure();
    const result = await readTool.run(caller('reader'), callFor('read_session', { sessionId: chat.id }));
    expect(result.output).toContain('[att-only] [image]');
  });

  test('output-cap truncation returns a cursor that reaches the dropped messages', async () => {
    const chat = await seedSession('Cap paging chat');
    // 45 messages * ~1500 chars ≈ 70K rendered — the 60K whole-output bound
    // must drop oldest whole message blocks and stay pageable.
    const ids: string[] = [];
    for (let i = 0; i < 45; i++) {
      const id = `cap-${String(i).padStart(2, '0')}`;
      ids.push(id);
      await messages.add(chat.id, {
        id,
        sessionId: chat.id,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `chunk ${i} `.repeat(150),
        createdAt: 2_000 + i,
      });
    }
    configure();
    const first = await readTool.run(
      caller('reader'),
      callFor('read_session', { sessionId: chat.id, limit: 45 }),
    );
    expect(first.isError).toBe(false);
    // The newest message survives; the oldest were dropped by the output cap.
    expect(first.output).toContain(`[${ids[44]}]`);
    expect(first.output).not.toContain(`[${ids[0]}]`);
    const cursorMatch = /next before: (\S+)/.exec(first.output);
    expect(cursorMatch).not.toBeNull();
    const cursor = cursorMatch![1];
    // The cursor is the oldest *shown* message — older than it lie the dropped ones.
    expect(ids.indexOf(cursor)).toBeGreaterThan(0);
    const older = await readTool.run(
      caller('reader'),
      callFor('read_session', { sessionId: chat.id, limit: 45, before: cursor }),
    );
    expect(older.isError).toBe(false);
    expect(older.output).toContain(`[${ids[0]}]`);
    expect(older.output).not.toContain(`[${cursor}]`);
  });
});
