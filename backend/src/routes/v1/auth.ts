import { Elysia } from 'elysia';
import { localAuth } from '../../auth/local-auth';
import { buildLocalBearerToken } from '../../auth/local-route-auth';
import { canBootstrapLocalSession, requestPeer } from '../../auth/request-peer';

export const authRoutes = new Elysia({ prefix: '/api/auth' })
  .get('/me', async ({ request }) => {
    const authHeader = request.headers.get('authorization');
    const validation = localAuth.validateRequest(authHeader);

    return {
      ok: true,
      data: {
        user: validation.valid
          ? {
              id: 'local-user',
              username: 'Local User',
              isAdmin: validation.session!.permissions.includes('*'),
              createdAt: validation.session!.created,
              permissions: validation.session!.permissions,
            }
          : null,
      },
    };
  })
  .get('/status', async ({ request }) => {
    const authHeader = request.headers.get('authorization');
    const validation = localAuth.validateRequest(authHeader);

    return {
      ok: true,
      data: {
        authenticated: validation.valid,
        session: validation.session
          ? {
              id: validation.session.id.slice(0, 8) + '...',
              expiresAt: validation.session.expiresAt,
              permissions: validation.session.permissions,
            }
          : null,
      },
    };
  })
  .post(
    '/session',
    async ({ request, set, server }) => {
      const peerIp = requestPeer(request) ?? server?.requestIP(request)?.address ?? null;
      if (!canBootstrapLocalSession(request, peerIp)) {
        if (set) set.status = 403;
        return { ok: false, error: 'Session creation is restricted to local network.' };
      }

      const permissions = ['*'];
      const session = localAuth.createSession(permissions);
      const sessionData = localAuth['sessions'].get(session.sessionId);
      const bearerToken = buildLocalBearerToken(session);

      return {
        ok: true,
        data: {
          bearerToken,
          sessionId: session.sessionId,
          signature: session.signature,
          expiresAt: sessionData?.expiresAt,
        },
      };
    },
  )
  .delete('/session', async ({ request, set }) => {
    const authHeader = request.headers.get('authorization');
    const validation = localAuth.validateRequest(authHeader);

    if (!validation.valid) {
      set.status = 401;
      return { ok: false, error: 'Unauthorized' };
    }

    localAuth.revokeSession(validation.session!.id);
    return { ok: true, message: 'Session revoked' };
  });
