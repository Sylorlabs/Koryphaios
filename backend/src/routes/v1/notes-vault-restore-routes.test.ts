import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NODE_ENV = 'test';
process.env.SESSION_TOKEN_SECRET =
  process.env.SESSION_TOKEN_SECRET ?? 'test_only_not_for_production_aaaaaaaaaa';
const databaseDirectory = mkdtempSync(join(tmpdir(), 'kory-vault-route-db-'));
process.env.DATABASE_URL = `sqlite://${join(databaseDirectory, 'source.sqlite')}`;

const { Elysia } = await import('elysia');
const { initDb, reopenDatabase } = await import('../../db');
const { buildLocalBearerToken } = await import('../../auth/local-route-auth');
const { localAuth } = await import('../../auth/local-auth');
const { errorHandler } = await import('../../middleware/error-handling');
const { notesRoutes } = await import('./notes');

const app = new Elysia().onError(errorHandler).use(notesRoutes);
const fixtureRoot = mkdtempSync(join(tmpdir(), 'kory-vault-route-projects-'));
const sourceProject = join(fixtureRoot, 'source');
const targetProject = join(fixtureRoot, 'target');
let authorization = '';

beforeAll(async () => {
  await initDb();
  mkdirSync(sourceProject, { recursive: true });
  mkdirSync(targetProject, { recursive: true });
  authorization = buildLocalBearerToken(localAuth.createSession(['*']));
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
  rmSync(databaseDirectory, { recursive: true, force: true });
});

function request(
  projectRoot: string,
  path: string,
  init: RequestInit = {},
  authenticated = true,
): Request {
  const headers = new Headers(init.headers);
  if (authenticated) headers.set('authorization', authorization);
  headers.set('x-koryphaios-project', projectRoot);
  return new Request(`http://localhost${path}`, { ...init, headers });
}

function archiveForm(bytes: Buffer, digest?: string): FormData {
  const form = new FormData();
  form.set(
    'file',
    new File([new Uint8Array(bytes)], 'verified-vault.tar', { type: 'application/x-tar' }),
  );
  if (digest) form.set('archiveSha256', digest);
  return form;
}

describe('Notes vault restore routes', () => {
  test('requires auth, previews exact bytes, restores into a fresh database, and blocks replay', async () => {
    const create = await app.handle(
      request(sourceProject, '/api/notes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Portable route note',
          content: '# Portable\n\nVerified route restore.\n',
          folderPath: '/Portable',
          tags: ['route-restore'],
          pinned: true,
        }),
      }),
    );
    expect(create.status).toBe(200);

    const exported = await app.handle(request(sourceProject, '/api/notes/export'));
    expect(exported.status).toBe(200);
    const archiveBytes = Buffer.from(await exported.arrayBuffer());

    await reopenDatabase(join(databaseDirectory, 'target.sqlite'));

    const unauthenticated = await app.handle(
      request(
        targetProject,
        '/api/notes/import-vault/preview',
        { method: 'POST', body: archiveForm(archiveBytes) },
        false,
      ),
    );
    expect(unauthenticated.status).toBe(401);

    const previewResponse = await app.handle(
      request(targetProject, '/api/notes/import-vault/preview', {
        method: 'POST',
        body: archiveForm(archiveBytes),
      }),
    );
    expect(previewResponse.status).toBe(200);
    const previewText = await previewResponse.text();
    expect(previewText).not.toContain(targetProject);
    const preview = JSON.parse(previewText) as {
      ok: boolean;
      data: {
        archiveSha256: string;
        notes: number;
        revisions: number;
        canRestore: boolean;
        conflicts: unknown[];
      };
    };
    expect(preview).toMatchObject({
      ok: true,
      data: { notes: 1, revisions: 1, canRestore: true, conflicts: [] },
    });
    expect(preview.data.archiveSha256).toMatch(/^[a-f0-9]{64}$/);

    const wrongDigest = await app.handle(
      request(targetProject, '/api/notes/import-vault/restore', {
        method: 'POST',
        body: archiveForm(archiveBytes, '0'.repeat(64)),
      }),
    );
    expect(wrongDigest.status).toBe(409);

    const restoreResponse = await app.handle(
      request(targetProject, '/api/notes/import-vault/restore', {
        method: 'POST',
        body: archiveForm(archiveBytes, preview.data.archiveSha256),
      }),
    );
    expect(restoreResponse.status).toBe(200);
    expect(await restoreResponse.json()).toMatchObject({
      ok: true,
      data: {
        restoredNotes: 1,
        restoredRevisions: 1,
        canRestore: true,
      },
    });

    const list = await app.handle(request(targetProject, '/api/notes'));
    const listBody = (await list.json()) as { data: Array<{ title: string; content?: string }> };
    expect(listBody.data).toHaveLength(1);
    expect(listBody.data[0]?.title).toBe('Portable route note');

    const replayPreview = await app.handle(
      request(targetProject, '/api/notes/import-vault/preview', {
        method: 'POST',
        body: archiveForm(archiveBytes),
      }),
    );
    expect(replayPreview.status).toBe(200);
    expect(await replayPreview.json()).toMatchObject({
      ok: true,
      data: { canRestore: false },
    });
  });
});
