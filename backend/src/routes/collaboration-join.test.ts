import { afterAll, expect, test } from 'bun:test';

process.env.NODE_ENV = 'test';
process.env.SESSION_TOKEN_SECRET ??= 'test_only_not_for_production_aaaaaaaaaa';
const relay = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const code = new URL(request.url).pathname.slice(6);
    if (code === 'ABCDEFGH')
      return Response.json({
        ok: true,
        sessionId: 'live-team',
        sessionName: 'Live team',
        tierId: 'viewer',
        inviteUrl: 'https://relay.example/join?token=real-relay-response',
      });
    if (code === 'ZZZZZZZZ') return new Response('Unavailable', { status: 503 });
    return Response.json({ ok: false, error: 'Invalid or inactive join code' }, { status: 404 });
  },
});
const previousRelayUrl = process.env.RELAY_URL;
process.env.RELAY_URL = `http://127.0.0.1:${relay.port}`;
const { Elysia } = await import('elysia');
const { localAuth } = await import('../auth/local-auth');
const { buildLocalBearerToken } = await import('../auth/local-route-auth');
const { errorHandler } = await import('../middleware/error-handling');
const { collaborationRoutes } = await import('./collaboration');
const app = new Elysia().onError(errorHandler).use(collaborationRoutes);
afterAll(() => {
  relay.stop(true);
  if (previousRelayUrl === undefined) delete process.env.RELAY_URL;
  else process.env.RELAY_URL = previousRelayUrl;
});

function join(code: string) {
  return app.handle(
    new Request('http://localhost/api/collab/join', {
      method: 'POST',
      headers: {
        Authorization: buildLocalBearerToken(localAuth.createSession(['*'])),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ joinCode: code, userId: 'guest-1', name: 'Guest' }),
    }),
  );
}

test('unknown and malformed codes return actionable validation errors through the real route', async () => {
  for (const code of ['XXXXXXXX', 'bad']) {
    const response = await join(code);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      code: 'INVALID_JOIN_CODE',
      error: expect.stringContaining('Not a valid code'),
    });
  }
});

test('valid codes resolve through the manager to the live relay invitation', async () => {
  const response = await join(' abcdefgh ');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    ok: true,
    data: {
      sessionId: 'live-team',
      inviteUrl: expect.stringContaining('token=real-relay-response'),
    },
  });
});

test('relay outages retain a useful retry message rather than a generic internal error', async () => {
  const response = await join('ZZZZZZZZ');
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    ok: false,
    code: 'RELAY_UNAVAILABLE',
    error: expect.stringContaining('Try again'),
  });
});
