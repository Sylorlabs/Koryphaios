import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Elysia } from 'elysia';
import { initDb } from '../../db';
import { buildLocalBearerToken } from '../../auth/local-route-auth';
import { localAuth } from '../../auth/local-auth';
import { errorHandler } from '../../middleware/error-handling';
import { createNote, getNote, getNoteOutlinks, updateNote } from '../../notes/notes-service';
import { notesRoutes } from './notes';
const app = new Elysia().onError(errorHandler).use(notesRoutes);
const root = mkdtempSync(join(tmpdir(), 'kory-network-api-'));
let authorization = '';
beforeAll(async () => {
  await initDb();
  authorization = buildLocalBearerToken(localAuth.createSession(['*']));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
function request(path: string, method = 'GET', body?: unknown, project = root, auth = true) {
  return new Request(`http://localhost/api/notes${path}`, {
    method,
    headers: {
      'x-koryphaios-project': project,
      'content-type': 'application/json',
      ...(auth ? { authorization } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
test('network routes authenticate, scope, validate, and expose proposal/review CAS', async () => {
  expect((await app.handle(request('/relationships', 'GET', undefined, root, false))).status).toBe(
    401,
  );
  const from = await createNote({ title: 'API source', content: 'reviewable evidence' }, root);
  const to = await createNote({ title: 'API target' }, root);
  const input = {
    fromId: from.id,
    toId: to.id,
    type: 'depends_on',
    evidence: 'API contract requires dependency',
    expectedSourceRevision: 1,
    expectedTargetRevision: 1,
  };
  const response = await app.handle(request('/relationships', 'POST', input));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    success: true,
    data: { type: 'depends_on', status: 'proposed', provenance: 'user', revision: 1 },
  });
  const listed = await app.handle(request(`/relationships?noteId=${from.id}&status=proposed`));
  expect((await listed.json()).data).toHaveLength(1);
  mkdirSync(join(root, 'other'), { recursive: true });
  const foreign = await app.handle(
    request('/relationships', 'GET', undefined, join(root, 'other')),
  );
  expect((await foreign.json()).data).toEqual([]);
  const path = `/relationships/${from.id}/${to.id}`;
  expect(
    (await app.handle(request(path, 'PATCH', { status: 'accepted', expectedRevision: 2 }))).status,
  ).toBe(409);
  const accepted = await app.handle(
    request(path, 'PATCH', { status: 'accepted', expectedRevision: 1 }),
  );
  expect(await accepted.json()).toMatchObject({
    success: true,
    data: { status: 'accepted', revision: 2 },
  });
  expect(
    (await app.handle(request(path, 'PATCH', { status: 'accepted', expectedRevision: 1 }))).status,
  ).toBe(409);
});
test('relationship removal is authenticated, scoped, CAS-bound and permits reject/remove/re-propose without editing wikilinks', async () => {
  const target = await createNote({ title: 'Removal target' }, root);
  const from = await createNote(
    { title: 'Removal source', content: 'Evidence [[Removal target]]' },
    root,
  );
  const input = {
    fromId: from.id,
    toId: target.id,
    type: 'supports',
    evidence: 'Initial evidence',
    expectedSourceRevision: from.revision,
    expectedTargetRevision: target.revision,
  };
  const proposal = await app.handle(request('/relationships', 'POST', input));
  const original = (await proposal.json()).data;
  const path = `/relationships/${encodeURIComponent(from.id)}/${encodeURIComponent(target.id)}`;
  const cas = { expectedRelationshipRevision: original.revision };
  expect((await app.handle(request(path, 'DELETE', cas, root, false))).status).toBe(401);
  const foreignRoot = join(root, 'removal-foreign');
  mkdirSync(foreignRoot);
  expect((await app.handle(request(path, 'DELETE', cas, foreignRoot))).status).toBe(404);
  expect((await app.handle(request(path, 'DELETE', {}))).status).toBe(400);
  expect(
    (await app.handle(request(path, 'DELETE', { expectedRelationshipRevision: 0 }))).status,
  ).toBe(400);
  await updateNote(
    from.id,
    { content: 'Changed evidence [[Removal target]]', expectedRevision: from.revision },
    root,
  );
  expect(
    (
      await app.handle(
        request(path, 'PATCH', { status: 'accepted', expectedRevision: original.revision }),
      )
    ).status,
  ).toBe(409);
  const rejectedResponse = await app.handle(
    request(path, 'PATCH', { status: 'rejected', expectedRevision: original.revision }),
  );
  expect(rejectedResponse.status).toBe(200);
  const rejected = (await rejectedResponse.json()).data;
  const currentSource = (await getNote(from.id, root))!;
  const refreshedInput = { ...input, expectedSourceRevision: currentSource.revision };
  expect((await app.handle(request('/relationships', 'POST', refreshedInput))).status).toBe(409);
  // A stale confirmation cannot remove a newer decision.
  expect((await app.handle(request(path, 'DELETE', cas))).status).toBe(409);
  const removed = await app.handle(
    request(path, 'DELETE', { expectedRelationshipRevision: rejected.revision }),
  );
  expect(removed.status).toBe(200);
  expect(await removed.json()).toMatchObject({ success: true, data: { removed: true } });
  expect((await getNote(from.id, root))!.content).toBe(currentSource.content);
  expect((await getNoteOutlinks(from.id, root)).some((note) => note.id === target.id)).toBe(true);
  const newSource = (await getNote(from.id, root))!;
  const reproposal = await app.handle(
    request('/relationships', 'POST', {
      ...refreshedInput,
      evidence: 'Refreshed evidence requires new review',
      expectedSourceRevision: newSource.revision,
    }),
  );
  expect(reproposal.status).toBe(200);
  const recreated = (await reproposal.json()).data;
  expect(recreated.status).toBe('proposed');
  expect(recreated.revision).toBeGreaterThan(rejected.revision);
  // Even deleting and recreating a pair cannot revive a prior confirmation.
  expect(
    (await app.handle(request(path, 'DELETE', { expectedRelationshipRevision: rejected.revision })))
      .status,
  ).toBe(409);
  expect(
    (
      await app.handle(
        request(path, 'PATCH', { status: 'accepted', expectedRevision: recreated.revision }),
      )
    ).status,
  ).toBe(200);
});

test('context and semantic status/rebuild use bounded public contracts', async () => {
  const source = await createNote({ title: 'API context', content: 'uniquerecallphrase' }, root);
  const context = await app.handle(
    request('/context', 'POST', {
      query: 'uniquerecallphrase',
      seedIds: [source.id],
      semantic: false,
      maxHops: 0,
    }),
  );
  expect(context.status).toBe(200);
  const body = await context.json();
  expect(body.success).toBe(true);
  expect(body.data.results.some((row: { id: string }) => row.id === source.id)).toBe(true);
  expect((await app.handle(request('/context', 'POST', { query: 'q', maxHops: 50 }))).status).toBe(
    400,
  );
  const status = await app.handle(request('/semantic-index'));
  expect(status.status).toBe(200);
  expect((await status.json()).success).toBe(true);
  expect((await app.handle(request('/semantic-index/rebuild', 'POST', { limit: 2 }))).status).toBe(
    400,
  );
  const rebuild = await app.handle(
    request('/semantic-index/rebuild', 'POST', { optIn: true, limit: 1 }),
  );
  expect(rebuild.status).toBe(200);
  expect((await rebuild.json()).data.indexed).toBe(0);
});
