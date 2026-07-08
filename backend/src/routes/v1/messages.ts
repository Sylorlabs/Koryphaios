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

      // Fire-and-forget agent title generation. Only fires on the very first
      // user message of a session whose title is still the default — the
      // manager method is a no-op otherwise, so this is safe to call every
      // turn.
      kory.generateSessionTitle(body.sessionId, body.content).catch(() => {});

      // Trigger Kory processing
      kory
        .processTask(
          body.sessionId,
          body.content,
          body.model,
          body.reasoningLevel,
          body.attachments,
        )
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
        attachments: t.Optional(
          t.Array(
            t.Object({
              type: t.String(),
              data: t.String(),
              name: t.String(),
            }),
          ),
        ),
      }),
    },
  )
  .post(
    '/regenerate',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const { kory, sessions, messages, wsManager } = getContext();
      if (!(await sessions.get(body.sessionId))) {
        set.status = 404;
        return { ok: false, error: 'Session not found' };
      }
      const history = await messages.getAll(body.sessionId);
      const targetIndex = history.findIndex((message) => message.id === body.messageId);
      const target = history[targetIndex];
      if (!target || target.role !== 'assistant') {
        set.status = 404;
        return { ok: false, error: 'Assistant response not found' };
      }
      let userIndex = targetIndex - 1;
      while (userIndex >= 0 && history[userIndex]?.role !== 'user') userIndex--;
      const prompt = history[userIndex];
      if (!prompt) {
        set.status = 409;
        return { ok: false, error: 'Original prompt not found' };
      }
      const groupId = target.variantGroupId ?? `response-${prompt.id}`;
      const variants = history.filter((message) => message.variantGroupId === groupId);
      const nextIndex =
        Math.max(
          target.variantIndex ?? 0,
          ...variants.map((message) => message.variantIndex ?? 0),
        ) + 1;
      if (!target.variantGroupId) await messages.assignVariantGroup(target.id, groupId, 0);

      kory
        .processTask(
          body.sessionId,
          prompt.content,
          body.model ?? target.model,
          body.reasoningLevel,
          undefined,
          undefined,
          { groupId, index: nextIndex },
        )
        .catch((error) => {
          wsManager.broadcastToSession(body.sessionId, {
            type: 'system.error',
            payload: { error: error instanceof Error ? error.message : String(error) },
            timestamp: Date.now(),
            sessionId: body.sessionId,
          });
        });
      return { ok: true, data: { groupId, index: nextIndex } };
    },
    {
      body: t.Object({
        sessionId: t.String(),
        messageId: t.String(),
        model: t.Optional(t.String()),
        reasoningLevel: t.Optional(t.String()),
      }),
    },
  );
