import { describe, expect, test } from 'bun:test';
import { authRoutes } from '../src/routes/v1/auth';
import { sessionRoutes } from '../src/routes/v1/sessions';
import {
  buildLocalBearerToken,
  requireLocalRouteAuth,
  validateLocalBearerToken,
} from '../src/auth/local-route-auth';
import { localAuth } from '../src/auth/local-auth';

type JsonResponse = Record<string, any>;

async function readJson(response: Response): Promise<JsonResponse> {
  return (await response.json()) as JsonResponse;
}

describe('local route auth guard', () => {
  test('rejects requests with no authorization header', () => {
    const set: { status?: number | string } = {};
    const session = requireLocalRouteAuth(new Request('http://localhost/api/sessions'), set);

    expect(session).toBeNull();
    expect(set.status).toBe(401);
  });

  test('rejects requests with an invalid bearer token', () => {
    const set: { status?: number | string } = {};
    const session = requireLocalRouteAuth(
      new Request('http://localhost/api/sessions', {
        headers: { Authorization: 'Bearer invalid:token' },
      }),
      set,
    );

    expect(session).toBeNull();
    expect(set.status).toBe(401);
  });

  test('accepts requests with a valid bearer token', () => {
    const token = buildLocalBearerToken(localAuth.createSession(['*']));
    const set: { status?: number | string } = {};
    const session = requireLocalRouteAuth(
      new Request('http://localhost/api/sessions', {
        headers: { Authorization: token },
      }),
      set,
    );

    expect(session).not.toBeNull();
    expect(session?.permissions).toContain('*');
    expect(set.status).toBeUndefined();
  });

  test('protected routes return 401 before touching app context', async () => {
    const response = await sessionRoutes.handle(new Request('http://localhost/api/sessions'));
    const body = await readJson(response);

    expect(response.status).toBe(401);
    expect(body).toEqual({ ok: false, error: 'Unauthorized' });
  });
});

describe('auth routes', () => {
  test('GET /api/auth/me returns a null user when unauthenticated', async () => {
    const response = await authRoutes.handle(new Request('http://localhost/api/auth/me'));
    const body = await readJson(response);

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      data: {
        user: null,
      },
    });
  });

  test('GET /api/auth/status returns unauthenticated state without a token', async () => {
    const response = await authRoutes.handle(new Request('http://localhost/api/auth/status'));
    const body = await readJson(response);

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      data: {
        authenticated: false,
        session: null,
      },
    });
  });

  test('POST /api/auth/session issues a bearer token that authenticates /me and /status', async () => {
    const createResponse = await authRoutes.handle(
      new Request('http://localhost/api/auth/session', { method: 'POST' }),
    );
    const createBody = await readJson(createResponse);

    expect(createResponse.status).toBe(200);
    expect(createBody.ok).toBe(true);
    expect(typeof createBody.data?.bearerToken).toBe('string');
    expect(typeof createBody.data?.sessionId).toBe('string');
    expect(typeof createBody.data?.signature).toBe('string');
    expect(typeof createBody.data?.expiresAt).toBe('number');

    const token = createBody.data.bearerToken as string;
    const validatedSession = validateLocalBearerToken(token);
    expect(validatedSession).not.toBeNull();

    const meResponse = await authRoutes.handle(
      new Request('http://localhost/api/auth/me', {
        headers: { Authorization: token },
      }),
    );
    const meBody = await readJson(meResponse);

    expect(meResponse.status).toBe(200);
    expect(meBody).toEqual({
      ok: true,
      data: {
        user: {
          id: 'local-user',
          username: 'Local User',
          isAdmin: true,
          createdAt: validatedSession!.created,
          permissions: ['*'],
        },
      },
    });

    const statusResponse = await authRoutes.handle(
      new Request('http://localhost/api/auth/status', {
        headers: { Authorization: token },
      }),
    );
    const statusBody = await readJson(statusResponse);

    expect(statusResponse.status).toBe(200);
    expect(statusBody.ok).toBe(true);
    expect(statusBody.data?.authenticated).toBe(true);
    expect(statusBody.data?.session).toEqual({
      id: `${validatedSession!.id.slice(0, 8)}...`,
      expiresAt: validatedSession!.expiresAt,
      permissions: ['*'],
    });
  });

  test('DELETE /api/auth/session rejects invalid tokens', async () => {
    const response = await authRoutes.handle(
      new Request('http://localhost/api/auth/session', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer invalid:token' },
      }),
    );
    const body = await readJson(response);

    expect(response.status).toBe(401);
    expect(body).toEqual({ ok: false, error: 'Unauthorized' });
  });

  test('DELETE /api/auth/session revokes a valid session', async () => {
    const createResponse = await authRoutes.handle(
      new Request('http://localhost/api/auth/session', { method: 'POST' }),
    );
    const createBody = await readJson(createResponse);
    const token = createBody.data.bearerToken as string;

    const deleteResponse = await authRoutes.handle(
      new Request('http://localhost/api/auth/session', {
        method: 'DELETE',
        headers: { Authorization: token },
      }),
    );
    const deleteBody = await readJson(deleteResponse);

    expect(deleteResponse.status).toBe(200);
    expect(deleteBody).toEqual({ ok: true, message: 'Session revoked' });
    expect(validateLocalBearerToken(token)).toBeNull();

    const meResponse = await authRoutes.handle(
      new Request('http://localhost/api/auth/me', {
        headers: { Authorization: token },
      }),
    );
    const meBody = await readJson(meResponse);

    expect(meResponse.status).toBe(200);
    expect(meBody).toEqual({
      ok: true,
      data: {
        user: null,
      },
    });
  });
});
