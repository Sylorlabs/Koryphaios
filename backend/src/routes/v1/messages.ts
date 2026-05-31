import { Elysia, t } from 'elysia';
import { getContext } from '../../context';
import { nanoid } from 'nanoid';
import { ID, MESSAGE } from '../../constants';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';

export const messageRoutes = new Elysia({ prefix: '/api/messages' })
  .get('/:sessionId', async ({ request, params: { sessionId }, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const { messages } = getContext();
    const list = await messages.getAll(sessionId);
    return { ok: true, data: list };
  })
  .post(
    '/',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const { kory, sessions, messages, wsManager } = getContext();

      // Ensure session exists
      const session = await sessions.get(body.sessionId);
      if (!session) {
        set.status = 404;
        return { ok: false, error: 'Session not found' };
      }

      const userMsg = {
        id: nanoid(ID.SESSION_ID_LENGTH),
        sessionId: body.sessionId,
        role: 'user' as const,
        content: body.content,
        createdAt: Date.now(),
      };

      await messages.add(body.sessionId, userMsg);

      // Trigger Kory processing
      kory
        .processTask(body.sessionId, body.content, body.model, body.reasoningLevel)
        .catch((err) => {
          wsManager.broadcast({
            type: 'system.error',
            payload: { error: err.message, sessionId: body.sessionId },
            timestamp: Date.now(),
            sessionId: body.sessionId,
          });
        });

      return { ok: true, data: { status: 'processing' } };
    },
    {
      body: t.Object({
        sessionId: t.String(),
        content: t.String(),
        model: t.Optional(t.String()),
        reasoningLevel: t.Optional(t.String()),
      }),
    },
  );
