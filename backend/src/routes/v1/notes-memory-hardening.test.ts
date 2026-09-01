import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Elysia } from 'elysia';
import { initDb } from '../../db';
import { buildLocalBearerToken } from '../../auth/local-route-auth';
import { localAuth } from '../../auth/local-auth';
import { errorHandler } from '../../middleware/error-handling';
import { notesRoutes } from './notes';
import { memoryRoutes } from './memory';
import { getAttachment } from '../../notes/notes-service';

// Project sync and SQLite mutation tests can overlap with other focused files
// in the full core gate. Keep the assertion bounded without relying on Bun's
// five-second unit-test default under that legitimate contention.
setDefaultTimeout(30_000);

const app = new Elysia().onError(errorHandler).use(notesRoutes).use(memoryRoutes);
let projectRoot = '';
let authorization = '';

beforeAll(async () => {
  await initDb();
  projectRoot = mkdtempSync(join(tmpdir(), 'kory-notes-routes-'));
  mkdirSync(projectRoot, { recursive: true });
  authorization = buildLocalBearerToken(localAuth.createSession(['*']));
});

afterAll(() => {
  if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
});

function request(path: string, init: RequestInit = {}, authenticated = true): Request {
  const headers = new Headers(init.headers);
  if (authenticated) headers.set('authorization', authorization);
  headers.set('x-koryphaios-project', projectRoot);
  return new Request(`http://localhost${path}`, { ...init, headers });
}

describe('Notes and Memory route hardening', () => {
  test('requires header authentication for every Notes route including attachment reads', async () => {
    const list = await app.handle(request('/api/notes', {}, false));
    expect(list.status).toBe(401);

    const queryCredential = await app.handle(
      request('/api/notes/attachments/fake?auth=fake-token', {}, false),
    );
    expect(queryCredential.status).toBe(401);
  });

  test('exposes revision preconditions and returns an explicit conflict', async () => {
    const createdResponse = await app.handle(
      request('/api/notes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Route revision', content: 'first' }),
      }),
    );
    expect(createdResponse.status).toBe(200);
    const createdBody = (await createdResponse.json()) as {
      data: { id: string; revision: number };
    };

    const missingPrecondition = await app.handle(
      request(`/api/notes/${createdBody.data.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'unconditional overwrite' }),
      }),
    );
    expect(missingPrecondition.status).toBe(400);
    expect((await missingPrecondition.json()) as Record<string, unknown>).toMatchObject({
      ok: false,
      code: 'VALIDATION_ERROR',
    });

    const update = await app.handle(
      request(`/api/notes/${createdBody.data.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: 'second',
          expectedRevision: createdBody.data.revision,
        }),
      }),
    );
    expect(update.status).toBe(200);
    const updateBody = (await update.json()) as { data: { revision: number } };

    const stale = await app.handle(
      request(`/api/notes/${createdBody.data.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: 'stale',
          expectedRevision: createdBody.data.revision,
        }),
      }),
    );
    expect(stale.status).toBe(409);
    expect((await stale.json()) as Record<string, unknown>).toMatchObject({
      ok: false,
      code: 'CONFLICT',
      details: {
        expectedRevision: createdBody.data.revision,
        currentRevision: updateBody.data.revision,
      },
    });

    const missingDeletePrecondition = await app.handle(
      request(`/api/notes/${createdBody.data.id}`, { method: 'DELETE' }),
    );
    expect(missingDeletePrecondition.status).toBe(400);

    const staleDelete = await app.handle(
      request(`/api/notes/${createdBody.data.id}`, {
        method: 'DELETE',
        headers: { 'x-kory-note-revision': String(createdBody.data.revision) },
      }),
    );
    expect(staleDelete.status).toBe(409);

    const currentDelete = await app.handle(
      request(`/api/notes/${createdBody.data.id}`, {
        method: 'DELETE',
        headers: { 'x-kory-note-revision': String(updateBody.data.revision) },
      }),
    );
    expect(currentDelete.status).toBe(200);
    const deletedBody = (await currentDelete.json()) as {
      data: { id: string; revision: number; trashedAt: string };
    };
    expect(deletedBody.data).toMatchObject({
      id: createdBody.data.id,
      revision: updateBody.data.revision + 1,
    });
    expect(deletedBody.data.trashedAt).toBeTypeOf('string');

    const trash = await app.handle(request('/api/notes/trash'));
    expect(trash.status).toBe(200);
    expect(
      ((await trash.json()) as { data: Array<{ id: string }> }).data.map(({ id }) => id),
    ).toContain(createdBody.data.id);

    const history = await app.handle(request(`/api/notes/${createdBody.data.id}/revisions`));
    expect(history.status).toBe(200);
    expect(
      ((await history.json()) as { data: Array<{ operation: string }> }).data.map(
        ({ operation }) => operation,
      ),
    ).toEqual(['trash', 'update', 'create']);

    const restore = await app.handle(
      request(`/api/notes/${createdBody.data.id}/restore`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedRevision: deletedBody.data.revision }),
      }),
    );
    expect(restore.status).toBe(200);
    expect((await restore.json()) as Record<string, unknown>).toMatchObject({
      ok: true,
      data: { id: createdBody.data.id, content: 'second' },
    });
  });

  test('exports the authenticated project as a deterministic tar archive', async () => {
    const response = await app.handle(request('/api/notes/export'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/x-tar');
    expect(response.headers.get('content-disposition')).toContain('koryphaios-');
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.length).toBe(Number(response.headers.get('content-length')));
    expect(bytes.includes(Buffer.from('manifest.json'))).toBe(true);
    expect(bytes.includes(Buffer.from('koryphaios-notes-vault'))).toBe(true);
  });

  test('keeps typed properties, saved Bases, and durable draft revisions aligned at the route', async () => {
    const createdResponse = await app.handle(
      request('/api/notes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Workspace contracts', content: '# Body' }),
      }),
    );
    const created = (await createdResponse.json()) as {
      data: { id: string; revision: number };
    };

    const invalidProperty = await app.handle(
      request(`/api/notes/${created.data.id}/properties`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: created.data.revision,
          patches: [{ op: 'set', key: 'bad:key', type: 'text', value: 'unsafe' }],
        }),
      }),
    );
    expect(invalidProperty.status).toBe(400);
    expect((await invalidProperty.json()) as Record<string, unknown>).toMatchObject({
      ok: false,
      code: 'VALIDATION_ERROR',
    });

    const emptyPatch = await app.handle(
      request(`/api/notes/${created.data.id}/properties`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedRevision: created.data.revision, patches: [] }),
      }),
    );
    expect(emptyPatch.status).toBe(400);

    const propertySave = await app.handle(
      request(`/api/notes/${created.data.id}/properties`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: created.data.revision,
          patches: [{ op: 'set', key: 'status', type: 'text', value: 'ready' }],
        }),
      }),
    );
    expect(propertySave.status).toBe(200);
    const propertyBody = (await propertySave.json()) as {
      data: { note: { revision: number }; properties: { properties: unknown[] } };
    };
    expect(propertyBody.data.properties.properties).toEqual([
      { key: 'status', type: 'text', value: 'ready' },
    ]);

    const snapshot = {
      title: 'Workspace contracts draft',
      content: '# Unsaved branch',
      folderPath: '/',
      tags: [],
      pinned: false,
      includeInContext: false,
      format: 'markdown',
    };
    const draftCreate = await app.handle(
      request('/api/notes/drafts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          noteId: created.data.id,
          baseRevision: propertyBody.data.note.revision,
          ...snapshot,
        }),
      }),
    );
    expect(draftCreate.status).toBe(200);
    const draft = (await draftCreate.json()) as {
      data: { id: string; draftRevision: number; createdAt: string; updatedAt: string };
    };
    expect(draft.data).toMatchObject({ draftRevision: 1 });
    expect(draft.data.createdAt).toBeTypeOf('string');

    const draftUpdate = await app.handle(
      request(`/api/notes/drafts/${draft.data.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedDraftRevision: 1, ...snapshot, content: '# Newer branch' }),
      }),
    );
    expect(draftUpdate.status).toBe(200);
    expect((await draftUpdate.json()) as Record<string, unknown>).toMatchObject({
      data: { draftRevision: 2 },
    });

    const staleDiscard = await app.handle(
      request(`/api/notes/drafts/${draft.data.id}/discard`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedDraftRevision: 1 }),
      }),
    );
    expect(staleDiscard.status).toBe(409);
    expect((await staleDiscard.json()) as Record<string, unknown>).toMatchObject({
      details: { expectedDraftRevision: 1, currentDraftRevision: 2 },
    });

    const invalidBase = await app.handle(
      request('/api/notes/bases', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Invalid tags sort',
          definition: {
            version: 1,
            sort: [{ field: { source: 'system', field: 'tags' }, direction: 'asc' }],
            view: { kind: 'table', fields: [{ source: 'system', field: 'title' }] },
          },
        }),
      }),
    );
    expect(invalidBase.status).toBe(400);

    const baseCreate = await app.handle(
      request('/api/notes/bases', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Recoverable view',
          definition: {
            version: 1,
            sort: [],
            view: { kind: 'table', fields: [{ source: 'system', field: 'title' }] },
          },
        }),
      }),
    );
    expect(baseCreate.status).toBe(200);
    const base = (await baseCreate.json()) as { data: { id: string; revision: number } };
    const baseTrash = await app.handle(
      request(`/api/notes/bases/${base.data.id}?expectedRevision=${base.data.revision}`, {
        method: 'DELETE',
      }),
    );
    expect(baseTrash.status).toBe(200);
    const trashedBase = (await baseTrash.json()) as {
      data: { revision: number; trashedAt: string };
    };
    expect(trashedBase.data.trashedAt).toBeTypeOf('string');

    const baseRestore = await app.handle(
      request(`/api/notes/bases/${base.data.id}/restore`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedRevision: trashedBase.data.revision }),
      }),
    );
    expect(baseRestore.status).toBe(200);
    expect((await baseRestore.json()) as Record<string, unknown>).toMatchObject({
      data: { id: base.data.id, revision: trashedBase.data.revision + 1 },
    });
  });

  test('binds attachment deletion to its owning note and rejects non-file form fields', async () => {
    const create = async (title: string) => {
      const response = await app.handle(
        request('/api/notes', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title }),
        }),
      );
      return (await response.json()) as { data: { id: string } };
    };
    const owner = await create('Attachment owner');
    const other = await create('Different note');

    const invalidForm = new FormData();
    invalidForm.set('file', 'not a file');
    const invalidUpload = await app.handle(
      request(`/api/notes/${owner.data.id}/attachments`, {
        method: 'POST',
        body: invalidForm,
      }),
    );
    expect(invalidUpload.status).toBe(400);

    const uploadForm = new FormData();
    uploadForm.set(
      'file',
      new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'safe.png', {
        type: 'image/png',
      }),
    );
    const upload = await app.handle(
      request(`/api/notes/${owner.data.id}/attachments`, {
        method: 'POST',
        body: uploadForm,
      }),
    );
    expect(upload.status).toBe(200);
    const attachment = (await upload.json()) as { data: { id: string } };

    const mismatchedDelete = await app.handle(
      request(`/api/notes/${other.data.id}/attachments/${attachment.data.id}`, {
        method: 'DELETE',
      }),
    );
    expect(mismatchedDelete.status).toBe(404);
    expect((await app.handle(request(`/api/notes/attachments/${attachment.data.id}`))).status).toBe(
      200,
    );

    const stored = await getAttachment(attachment.data.id, projectRoot);
    expect(stored).not.toBeNull();
    unlinkSync(stored!.storagePath);
    mkdirSync(stored!.storagePath);
    const failedStorageDelete = await app.handle(
      request(`/api/notes/${owner.data.id}/attachments/${attachment.data.id}`, {
        method: 'DELETE',
      }),
    );
    expect(failedStorageDelete.status).toBe(500);
    expect((await failedStorageDelete.json()) as Record<string, unknown>).toMatchObject({
      ok: false,
      code: 'INTERNAL_ERROR',
    });
    expect(await getAttachment(attachment.data.id, projectRoot)).not.toBeNull();

    rmSync(stored!.storagePath, { recursive: true, force: true });
    writeFileSync(stored!.storagePath, 'repaired storage entry');

    const correctDelete = await app.handle(
      request(`/api/notes/${owner.data.id}/attachments/${attachment.data.id}`, {
        method: 'DELETE',
      }),
    );
    expect(correctDelete.status).toBe(200);
  });

  test('round-trips custom Memory documents with strong revisions', async () => {
    const create = await app.handle(
      request('/api/memory/documents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'route-memory', kind: 'memory' }),
      }),
    );
    expect(create.status).toBe(200);
    expect(await create.text()).not.toContain(projectRoot);

    const loaded = await app.handle(request('/api/memory/documents/memory/route-memory.md'));
    const loadedBody = (await loaded.json()) as {
      data: { revision: string | null; path: string };
    };
    expect(loaded.status).toBe(200);
    expect(loadedBody.data.revision).toBeTypeOf('string');
    expect(loadedBody.data.path).toBe('memory/route-memory.md');

    const missingPrecondition = await app.handle(
      request('/api/memory/documents/memory/route-memory.md', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'unconditional overwrite' }),
      }),
    );
    expect(missingPrecondition.status).toBe(400);

    const saved = await app.handle(
      request('/api/memory/documents/memory/route-memory.md', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: '# Route memory\n\nA long-form document.',
          expectedRevision: loadedBody.data.revision,
        }),
      }),
    );
    expect(saved.status).toBe(200);

    const stale = await app.handle(
      request('/api/memory/documents/memory/route-memory.md', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'stale', expectedRevision: loadedBody.data.revision }),
      }),
    );
    expect(stale.status).toBe(409);

    const stats = await app.handle(request('/api/memory/stats'));
    expect(stats.status).toBe(200);
    expect(await stats.text()).not.toContain(projectRoot);
  });
});
