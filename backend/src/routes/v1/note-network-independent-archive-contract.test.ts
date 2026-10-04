import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Elysia } from 'elysia';
import { initDb } from '../../db';
import { buildLocalBearerToken } from '../../auth/local-route-auth';
import { localAuth } from '../../auth/local-auth';
import { errorHandler } from '../../middleware/error-handling';
import {
  createVaultExport,
  listNotes,
  proposeNoteRelationship,
  syncProjectDocuments,
} from '../../notes/notes-service';
import { parseVaultArchive } from '../../notes/vault-archive';
import { notesRoutes } from './notes';

// Independent integration regression: the archive/service preserve relationships,
// but the HTTP DTO must not silently omit their preview and committed counts.
const source = realpathSync(mkdtempSync(join(tmpdir(), 'network-contract-source-')));
const target = realpathSync(mkdtempSync(join(tmpdir(), 'network-contract-target-')));
const app = new Elysia().onError(errorHandler).use(notesRoutes);
let bytes: Buffer;
let authorization: string;

function request(path: string, body?: FormData) {
  return new Request(`http://localhost/api/notes${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization, 'x-koryphaios-project': target },
    ...(body ? { body } : {}),
  });
}
function form(digest?: string) {
  const body = new FormData();
  body.set('file', new File([new Uint8Array(bytes)], 'network.tar'));
  if (digest) body.set('archiveSha256', digest);
  return body;
}

beforeAll(async () => {
  await initDb();
  authorization = buildLocalBearerToken(localAuth.createSession(['*']));
  writeFileSync(join(source, 'alpha.md'), '# Alpha\n\nSource evidence.\n');
  writeFileSync(join(source, 'beta.md'), '# Beta\n\nTarget evidence.\n');
  await syncProjectDocuments(source);
  const [a, b] = await listNotes(undefined, source);
  await proposeNoteRelationship(
    {
      fromId: a!.id,
      toId: b!.id,
      type: 'supports',
      evidence: 'Source passage supports target passage.',
      expectedSourceRevision: a!.revision,
      expectedTargetRevision: b!.revision,
    },
    source,
    { provenance: 'user' },
  );
  const exported = await createVaultExport(source);
  bytes = Buffer.from(await new Response(exported.body).arrayBuffer());
  expect((await parseVaultArchive(bytes)).manifest.relationships).toHaveLength(1);
});
afterAll(() => {
  rmSync(source, { recursive: true, force: true });
  rmSync(target, { recursive: true, force: true });
});

test('vault HTTP preview reports relationship count from the validated archive', async () => {
  const response = await app.handle(request('/import-vault/preview', form()));
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.data.canRestore).toBe(true);
  expect(result.data.relationships).toBe(1);
});

test('vault HTTP commit reports the relationships it actually restored', async () => {
  const preview = await app.handle(request('/import-vault/preview', form()));
  expect(preview.status).toBe(200);
  const digest = (await preview.json()).data.archiveSha256;
  const response = await app.handle(request('/import-vault/restore', form(digest)));
  expect(response.status).toBe(200);
  const result = await response.json();
  const listing = await app.handle(request('/relationships'));
  expect(listing.status).toBe(200);
  expect((await listing.json()).data).toHaveLength(1);
  expect(result.data.restoredRelationships).toBe(1);
});
