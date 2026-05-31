import { Elysia, t } from 'elysia';
import { collaborationManager } from '../collaboration/manager';
import { requireLocalRouteAuth } from '../auth/local-route-auth';

export const collaborationRoutes = new Elysia({ prefix: '/api/collab' })
  .post(
    '/:id/start',
    async ({ request, params: { id }, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const ownerId = body?.ownerId || 'local-user';

      try {
        const result = await collaborationManager.hostSession(id, ownerId);
        return { ok: true, data: result };
      } catch (err: any) {
        set.status = 500;
        return { ok: false, error: err.message };
      }
    },
    {
      body: t.Optional(
        t.Object({
          ownerId: t.Optional(t.String()),
        }),
      ),
    },
  )
  .post(
    '/join',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      try {
        const session = await collaborationManager.joinSession(
          body.joinCode,
          body.userId,
          body.name,
        );
        return { ok: true, data: session };
      } catch (err: any) {
        set.status = 500;
        return { ok: false, error: err.message };
      }
    },
    {
      body: t.Object({
        joinCode: t.String(),
        userId: t.String(),
        name: t.String(),
      }),
    },
  )
  .get('/:id/state', async ({ request, params: { id }, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    try {
      const state = await collaborationManager.getSessionState(id);
      if (!state) {
        set.status = 404;
        return { ok: false, error: 'Session not found' };
      }
      return { ok: true, data: state };
    } catch (err: any) {
      set.status = 500;
      return { ok: false, error: err.message };
    }
  })
  .post('/:id/end', async ({ request, params: { id }, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    try {
      await collaborationManager.endSession(id);
      return { ok: true };
    } catch (err: any) {
      set.status = 500;
      return { ok: false, error: err.message };
    }
  });
