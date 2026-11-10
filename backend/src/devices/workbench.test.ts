import { afterEach, beforeEach, expect, test } from 'bun:test';
import { setContext, type AppContext } from '../context';
import { localAuth } from '../auth/local-auth';
import { executeDeviceWorkbench, setDeviceWorkbenchHandler } from './workbench';

let captured: Request | undefined;
let authorized = true;
const authorize = () => { if (!authorized) throw new Error('revoked'); };
beforeEach(() => {
  captured = undefined;
  authorized = true;
  setContext({ kory: { resolveSessionWorkingDirectoryPublic: async () => '/srv/target/project',
    getAgentThreadsForSession: () => [{ agent: { id: 'own-worker' } }] },
  } as unknown as AppContext);
  setDeviceWorkbenchHandler((request) => {
    captured = request;
    expect(localAuth.validateRequest(request.headers.get('authorization')).valid).toBe(true);
    return Response.json({ ok: true, data: { target: true } });
  });
});
afterEach(() => setDeviceWorkbenchHandler(undefined));

test('target headers and ephemeral auth are owned by the receiver and auth is revoked afterward', async () => {
  expect(await executeDeviceWorkbench('own-chat', { path: '/api/git/status' }, authorize)).toMatchObject({ status: 200 });
  expect(captured?.headers.get('X-Koryphaios-Session')).toBe('own-chat');
  expect(captured?.headers.get('X-Koryphaios-Project')).toBe('/srv/target/project');
  expect(localAuth.validateRequest(captured!.headers.get('authorization')).valid).toBe(false);
});

test('credential/configuration routes and foreign session, agent and workspace controls never dispatch', async () => {
  for (const input of [
    { path: '/api/providers' }, { path: '/api/auth/session', method: 'POST' },
    { path: '/api/devices/pairing', method: 'POST' }, { path: '/api/sessions/other-chat' },
    { path: '/api/agent/foreign-worker/message', method: 'POST' },
    { path: '/api/messages/regenerate', method: 'POST', body: { sessionId: 'other-chat' } },
    { path: '/api/git/status?sessionId=other-chat' },
    { path: '/api/sessions/own-chat', method: 'PATCH', body: { workingDirectory: '/etc' } },
    { path: '/api/sessions/own-chat', method: 'PATCH', body: { nested: { sessionId: 'other-chat' } } },
  ]) await expect(executeDeviceWorkbench('own-chat', input, authorize)).rejects.toThrow();
  expect(captured).toBeUndefined();
});

test('route metadata is checked against the receiver-owned descriptor', async () => {
  await expect(
    executeDeviceWorkbench(
      'own-chat',
      { path: '/api/git/status', routeId: 'notes', capability: 'notes' },
      authorize,
    ),
  ).rejects.toThrow('route metadata');
  await expect(
    executeDeviceWorkbench(
      'own-chat',
      { path: '/api/git/status', routeId: 'git', capability: 'notes' },
      authorize,
    ),
  ).rejects.toThrow('capability metadata');
  await expect(
    executeDeviceWorkbench('own-chat', { path: '/api/git/status', method: 'OPTIONS' }, authorize),
  ).rejects.toThrow('Invalid workbench method');
  expect(captured).toBeUndefined();
});

test('regeneration is admitted only through the owning session body', async () => {
  await executeDeviceWorkbench('own-chat', { path: '/api/messages/regenerate', method: 'POST',
    body: { sessionId: 'own-chat', messageId: 'response-id' } }, authorize);
  expect(await captured!.json()).toMatchObject({ sessionId: 'own-chat', messageId: 'response-id' });
});

test('revocation during a target control discards the response and revokes its temporary auth', async () => {
  setDeviceWorkbenchHandler((request) => { captured = request; authorized = false; return Response.json({ secret: 'synthetic' }); });
  await expect(executeDeviceWorkbench('own-chat', { path: '/api/git/status' }, authorize)).rejects.toThrow('revoked');
  expect(localAuth.validateRequest(captured!.headers.get('authorization')).valid).toBe(false);
});

test('linked mobile users can reach the explicit mobile control surface without opening auth or device-link routes', async () => {
  expect(
    await executeDeviceWorkbench(null, { path: '/api/appearance' }, authorize, 'mobile'),
  ).toMatchObject({ status: 200 });
  expect(
    await executeDeviceWorkbench(null, { path: '/api/mode' }, authorize, 'mobile'),
  ).toMatchObject({ status: 200 });
  expect(captured?.headers.get('X-Koryphaios-Session')).toBeNull();

  for (const path of ['/api/auth/session', '/api/devices/', '/api/private-control']) {
    captured = undefined;
    await expect(
      executeDeviceWorkbench(null, { path }, authorize, 'mobile'),
    ).rejects.toThrow('not exposed');
    expect(captured).toBeUndefined();
  }
});

test('linked mobile note deletion forwards only a validated revision while retaining receiver-owned authorization', async () => {
  const result = await executeDeviceWorkbench('own-chat', {
    path: '/api/notes/note-a', method: 'DELETE', noteRevision: 7,
    headers: { Authorization: 'Bearer attacker', 'X-Koryphaios-Project': '/private' },
  }, authorize, 'mobile');
  expect(result).toMatchObject({ status: 200 });
  expect(captured?.headers.get('x-kory-note-revision')).toBe('7');
  expect(captured?.headers.get('X-Koryphaios-Project')).toBe('/srv/target/project');
  expect(captured?.headers.get('authorization')).not.toBe('Bearer attacker');
  expect(localAuth.validateRequest(captured!.headers.get('authorization')).valid).toBe(false);
});

test('linked note revision cannot be forged onto unrelated routes or methods', async () => {
  for (const input of [
    { path: '/api/notes/note-a', method: 'DELETE', noteRevision: 0 },
    { path: '/api/notes/note-a', method: 'DELETE', noteRevision: -2 },
    { path: '/api/notes/note-a', method: 'DELETE', noteRevision: 2.5 },
    { path: '/api/notes/note-a', method: 'DELETE', noteRevision: '5' },
    { path: '/api/notes/note-a', method: 'DELETE', noteRevision: Number.MAX_SAFE_INTEGER + 1 },
    { path: '/api/notes/note-a', method: 'PATCH', noteRevision: 1 },
    { path: '/api/git/status', method: 'DELETE', noteRevision: 1 },
    { path: '/api/notes/bases/base-a', method: 'DELETE', noteRevision: 1 },
    { path: '/api/notes/note-a?override=true', method: 'DELETE', noteRevision: 1 },
  ]) {
    captured = undefined;
    await expect(executeDeviceWorkbench('own-chat', input, authorize, 'mobile')).rejects.toThrow('note revision');
    expect(captured).toBeUndefined();
  }
  captured = undefined;
  await expect(executeDeviceWorkbench('own-chat', {
    path: '/api/notes/note-a', method: 'DELETE', noteRevision: 3,
  }, authorize, 'desktop')).rejects.toThrow('note revision');
  expect(captured).toBeUndefined();
});

test('linked mobile workbench rebuilds multipart file uploads on the target', async () => {
  setDeviceWorkbenchHandler(async (request) => {
    captured = request;
    expect(request.headers.get('content-type')).toStartWith('multipart/form-data;');
    const form = await request.formData();
    const file = form.get('file');
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe('note.md');
    expect((file as File).type).toBe('text/markdown');
    expect(await (file as File).text()).toBe('# linked note');
    expect(form.get('archiveSha256')).toBe('digest');
    return Response.json({ ok: true });
  });
  await expect(executeDeviceWorkbench('own-chat', {
    path: '/api/notes/import-file',
    method: 'POST',
    form: { parts: [
      { name: 'file', filename: 'note.md', mimeType: 'text/markdown', base64: Buffer.from('# linked note').toString('base64') },
      { name: 'archiveSha256', value: 'digest' },
    ] },
  }, authorize, 'mobile')).resolves.toMatchObject({ status: 200 });
});

test('linked mobile workbench rejects malformed multipart uploads before dispatch', async () => {
  await expect(executeDeviceWorkbench('own-chat', {
    path: '/api/notes/import-file', method: 'POST', form: { parts: [{ name: '', value: 'bad' }] },
  }, authorize, 'mobile')).rejects.toThrow('Invalid target workbench form');
  expect(captured).toBeUndefined();
});

test('linked mobile workbench preserves binary downloads', async () => {
  setDeviceWorkbenchHandler(() => new Response(new Uint8Array([0, 1, 2, 255]), {
    headers: {
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment; filename="fixture.bin"',
    },
  }));
  const result = await executeDeviceWorkbench(
    'own-chat',
    { path: '/api/notes/export' },
    authorize,
    'mobile',
  );
  expect(result).toMatchObject({
    status: 200,
    contentType: 'application/octet-stream',
    contentDisposition: 'attachment; filename="fixture.bin"',
    bodyEncoding: 'base64',
    body: 'AAEC/w==',
  });
});
