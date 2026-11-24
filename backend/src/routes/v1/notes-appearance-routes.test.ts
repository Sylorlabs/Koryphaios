import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NODE_ENV = 'test';
process.env.SESSION_TOKEN_SECRET =
  process.env.SESSION_TOKEN_SECRET ?? 'test_only_not_for_production_aaaaaaaaaa';
const databaseDirectory = mkdtempSync(join(tmpdir(), 'kory-appearance-route-db-'));
process.env.DATABASE_URL = `sqlite://${join(databaseDirectory, 'source.sqlite')}`;

const { Elysia } = await import('elysia');
const { initDb } = await import('../../db');
const { buildLocalBearerToken } = await import('../../auth/local-route-auth');
const { localAuth } = await import('../../auth/local-auth');
const { errorHandler } = await import('../../middleware/error-handling');
const { notesRoutes } = await import('./notes');
const notesService = await import('../../notes/notes-service');

const app = new Elysia().onError(errorHandler).use(notesRoutes);
const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'kory-appearance-route-projects-')));
const project = join(fixtureRoot, 'project');
let authorization = '';

beforeAll(async () => {
  await initDb();
  mkdirSync(project, { recursive: true });
  authorization = buildLocalBearerToken(localAuth.createSession(['*']));
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
  rmSync(databaseDirectory, { recursive: true, force: true });
});

function request(path: string, init: RequestInit = {}, authenticated = true): Request {
  const headers = new Headers(init.headers);
  if (authenticated) headers.set('authorization', authorization);
  headers.set('x-koryphaios-project', project);
  if (init.body) headers.set('content-type', 'application/json');
  return new Request(`http://localhost${path}`, { ...init, headers });
}

function json(body: unknown): RequestInit {
  return { method: 'PUT', body: JSON.stringify(body) };
}

describe('Notes appearance routes', () => {
  test('requires local authentication', async () => {
    const response = await app.handle(request('/api/notes/appearance', {}, false));
    expect(response.status).toBe(401);
  });

  test('PUT and GET round-trip folder and tag appearance per project', async () => {
    const put = await app.handle(
      request('/api/notes/appearance/folders', json({ path: '/Docs', emoji: '📘', color: 'sky' })),
    );
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({
      ok: true,
      data: { path: '/Docs', emoji: '📘', color: 'sky' },
    });

    await app.handle(request('/api/notes/appearance/tags', json({ tag: 'urgent', color: '#f00' })));

    const listed = await (await app.handle(request('/api/notes/appearance'))).json();
    expect(listed.data).toEqual({
      folders: [{ path: '/Docs', emoji: '📘', color: 'sky' }],
      tags: [{ tag: 'urgent', color: '#ff0000' }],
    });
  });

  test('rejects an invalid emoji or color with a client error and stores nothing', async () => {
    const bad = await app.handle(
      request('/api/notes/appearance/folders', json({ path: '/Bad', emoji: 'two 📘📘' })),
    );
    expect(bad.status).toBe(400);
    const badColor = await app.handle(
      request('/api/notes/appearance/tags', json({ tag: 'x', color: 'rgb(1,2,3)' })),
    );
    expect(badColor.status).toBe(400);
    const listed = await (await app.handle(request('/api/notes/appearance'))).json();
    expect(listed.data.folders.map((folder: { path: string }) => folder.path)).toEqual(['/Docs']);
  });

  test('DELETE drops folder and tag appearance', async () => {
    const folder = await app.handle(
      request('/api/notes/appearance/folders?path=%2FDocs', { method: 'DELETE' }),
    );
    expect(await folder.json()).toEqual({ ok: true, data: { removed: 1 } });
    const tag = await app.handle(
      request('/api/notes/appearance/tags?tag=urgent', { method: 'DELETE' }),
    );
    expect(await tag.json()).toEqual({ ok: true, data: { removed: true } });
  });

  test('renaming a folder moves its notes and carries the appearance along', async () => {
    const note = await notesService.createNote(
      { title: 'Route rename', content: 'body', folderPath: '/Old/Area' },
      project,
    );
    await app.handle(request('/api/notes/appearance/folders', json({ path: '/Old', emoji: '🗂️' })));

    const renamed = await app.handle(
      request('/api/notes/folders/rename', {
        method: 'POST',
        body: JSON.stringify({ from: '/Old', to: '/New' }),
      }),
    );
    const body = await renamed.json();
    expect(renamed.status).toBe(200);
    expect(body.data).toMatchObject({ movedNotes: 1, appearanceMoved: true });

    expect((await notesService.getNote(note.id, project))!.folderPath).toBe('/New/Area');
    const listed = await (await app.handle(request('/api/notes/appearance'))).json();
    expect(listed.data.folders).toEqual([{ path: '/New', emoji: '🗂️' }]);
  });
});
