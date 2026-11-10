import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Elysia } from 'elysia';
import { getDb, initDb } from '../../db';
import { buildLocalBearerToken } from '../../auth/local-route-auth';
import { localAuth } from '../../auth/local-auth';
import { errorHandler } from '../../middleware/error-handling';
import { createNote } from '../../notes/notes-service';
import { nanoid } from 'nanoid';
import { notesRoutes } from './notes';

const app = new Elysia().onError(errorHandler).use(notesRoutes);
const root = mkdtempSync(join(tmpdir(), 'kory-notes-capture-'));
let authorization = '';
beforeAll(async () => {
  await initDb();
  authorization = buildLocalBearerToken(localAuth.createSession(['*']));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
function request(path: string, method = 'GET', body?: unknown, auth = true) {
  return new Request(`http://localhost/api/notes${path}`, {
    method,
    headers: {
      'x-koryphaios-project': root,
      'content-type': 'application/json',
      ...(auth ? { authorization } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

test('appearances route reports where a note appears and scopes to the project', async () => {
  const target = await createNote({ title: 'Route target', content: 'Body' }, root);
  await createNote({ title: 'Route linker', content: `[[${target.title}]]` }, root);
  const response = await app.handle(request(`/${target.id}/appearances`));
  expect(response.status).toBe(200);
  const payload = await response.json();
  expect(payload.ok).toBe(true);
  expect(payload.data).toMatchObject({
    noteId: target.id,
    title: 'Route target',
    counts: { backlinks: 1, relationships: 0, canvases: 0, bases: 0 },
    truncated: false,
  });
  expect(payload.data.backlinks.map((row: { title: string }) => row.title)).toContain('Route linker');
  expect((await app.handle(request('/missing/appearances'))).status).toBe(404);
  expect((await app.handle(request(`/${target.id}/appearances`, 'GET', undefined, false))).status).toBe(
    401,
  );
});

test('chat findings save a sourced note with verified host-recorded provenance', async () => {
  expect(
    (await app.handle(
      request(
        '/chat-findings',
        'POST',
        {
          title: 'Finding',
          body: 'Evidence',
          source: { sessionId: 'missing-session', messageId: 'missing-message' },
        },
        false,
      ),
    )).status,
  ).toBe(401);

  const sessionId = `finding-session-${nanoid()}`;
  const messageId = `finding-message-${nanoid()}`;
  const now = Date.now();
  getDb()
    .query(`INSERT INTO sessions (id, title, working_directory, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)`)
    .run(sessionId, 'Finding source session', root, now, now);
  getDb()
    .query(`INSERT INTO messages
      (id, session_id, role, content, provider, model, context_revision, created_at)
      VALUES (?, ?, 'assistant', ?, ?, ?, 0, ?)`)
    .run(
      messageId,
      sessionId,
      JSON.stringify([
        { type: 'text', text: 'The chat established the cache key includes the locale.' },
      ]),
      'test-provider',
      'test-model',
      now,
    );

  const response = await app.handle(
    request('/chat-findings', 'POST', {
      title: 'Cache key finding',
      body: 'The chat established the cache key includes the locale.',
      source: { sessionId, messageId },
    }),
  );
  expect(response.status).toBe(200);
  const payload = await response.json();
  const note = payload.data;
  expect(note).toMatchObject({
    title: 'Cache key finding',
    folderPath: '/Findings',
    tags: ['chat-finding', 'sourced'],
  });
  expect(note.content).toContain('## Finding');
  expect(note.content).toContain('The chat established the cache key includes the locale.');
  expect(note.content).toContain('## Provenance');
  expect(note.content).toContain(sessionId);
  expect(note.content).toContain(messageId);
  expect(note.content).toContain('assistant');
  expect(note.content).toContain('test-provider');
  expect(note.content).toContain('test-model');

  const invalidSource = await app.handle(
    request('/chat-findings', 'POST', {
      title: 'Forged source',
      body: 'A claim',
      source: { sessionId, messageId: 'missing-message' },
    }),
  );
  expect(invalidSource.status).toBeGreaterThanOrEqual(400);

  // A real user message cannot be misrepresented as an assistant finding.
  const userMessageId = `finding-user-${nanoid()}`;
  getDb()
    .query(`INSERT INTO messages
      (id, session_id, role, content, context_revision, created_at)
      VALUES (?, ?, 'user', ?, 0, ?)`)
    .run(userMessageId, sessionId, 'A user prompt', now);
  const wrongRole = await app.handle(
    request('/chat-findings', 'POST', {
      title: 'Forged assistant finding',
      body: 'A user message is not an assistant finding.',
      source: { sessionId, messageId: userMessageId },
    }),
  );
  expect(wrongRole.status).toBeGreaterThanOrEqual(400);

  const rejected = await app.handle(
    request('/chat-findings', 'POST', {
      title: '',
      body: '',
      source: { sessionId, messageId },
    }),
  );
  expect(rejected.status).toBeGreaterThanOrEqual(400);
});
