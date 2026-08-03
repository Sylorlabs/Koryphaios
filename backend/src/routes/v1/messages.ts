import { Elysia, t } from 'elysia';
import { getContext } from '../../context';
import { nanoid } from 'nanoid';
import { ID, MESSAGE } from '../../constants';
import { markCliConversationRewritten } from '../../providers/cli-session-state';
import { serverLog } from '../../logger';
import { getOrderedEventLog } from '../../ws/ordered-event-log';

export const messageRoutes = new Elysia({ prefix: '/api/messages' })
  .get('/:sessionId', async ({ params: { sessionId } }) => {
    const { messages } = getContext();
    const list = await messages.getAll(sessionId);
    return { ok: true, data: list };
  })
  .post(
    '/',
    async ({ body, set }) => {
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
        attachments: body.attachments,
        createdAt: Date.now(),
      };

      await messages.add(body.sessionId, userMsg);

      // The user turn enters the same durable ordered stream as reasoning,
      // tools, and the final response. The UI waits a few milliseconds for
      // this canonical event instead of inserting an unsequenced optimistic row.
      wsManager.broadcastToSession(body.sessionId, {
        type: 'session.user_message',
        sessionId: body.sessionId,
        timestamp: userMsg.createdAt,
        payload: {
          messageId: userMsg.id,
          content: userMsg.content,
          attachments: userMsg.attachments,
        },
      });

      // Fire-and-forget agent title generation. Only fires on the very first
      // user message of a session whose title is still the default — the
      // manager method is a no-op otherwise, so this is safe to call every
      // turn.
      kory.generateSessionTitle(body.sessionId, body.content).catch((err) => {
        serverLog.warn({ err, sessionId: body.sessionId }, 'Session title generation failed');
      });

      // Trigger Kory processing
      kory
        .processTask(
          body.sessionId,
          body.content,
          body.model,
          body.reasoningLevel,
          body.attachments,
          undefined,
          undefined,
          undefined,
          session.interactionMode ?? 'act',
          body.fastMode,
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
        fastMode: t.Optional(t.Boolean()),
        interactionMode: t.Optional(t.Union([t.Literal('act'), t.Literal('plan')])),
        attachments: t.Optional(
          t.Array(
            t.Object({
              type: t.Union([t.Literal('image'), t.Literal('file')]),
              data: t.String(),
              name: t.String(),
              mimeType: t.Optional(t.String()),
            }),
          ),
        ),
      }),
    },
  )
  .post(
    '/edit',
    async ({ body, set }) => {
      const { kory, sessions, messages, wsManager } = getContext();
      const session = await sessions.get(body.sessionId);
      if (!session) {
        set.status = 404;
        return { ok: false, error: 'Session not found' };
      }
      const content = body.content.trim();
      if (!content) {
        set.status = 400;
        return { ok: false, error: 'Message cannot be empty' };
      }
      if (kory.isSessionRunning(body.sessionId)) {
        set.status = 409;
        return { ok: false, error: 'Stop the active run before editing conversation history.' };
      }

      const history = await messages.getAll(body.sessionId);
      const targetIndex = history.findIndex((message) => message.id === body.messageId);
      const target = history[targetIndex];
      if (!target || target.role !== 'user') {
        set.status = 404;
        return { ok: false, error: 'Editable user message not found' };
      }
      const nextAssistant = history
        .slice(targetIndex + 1)
        .find((message) => message.role === 'assistant');
      const routing =
        body.model ??
        (nextAssistant?.provider && nextAssistant.model
          ? `${nextAssistant.provider}:${nextAssistant.model}`
          : nextAssistant?.model);

      // Fail closed for old turns: if the context archive is unavailable we
      // cannot prove later tool context was removed, so do not rewrite history.
      const { getContextArchive } = await import('../../kory/context-archive');
      const archive = getContextArchive();
      if (!archive) {
        set.status = 409;
        return { ok: false, error: 'Conversation context cannot be safely pruned right now.' };
      }

      try {
        const prunedContextEntries = await archive.truncateAfter(body.sessionId, target.createdAt);
        const removedMessages = await messages.replaceAndTruncate(
          body.sessionId,
          body.messageId,
          content,
        );
        await sessions.update(body.sessionId, { messageCount: targetIndex + 1 });
        const conversationRevision = await markCliConversationRewritten(body.sessionId);
        getOrderedEventLog().resetEpoch(body.sessionId);

        kory
          .processTask(body.sessionId, content, routing, body.reasoningLevel, target.attachments)
          .catch((error) => {
            wsManager.broadcastToSession(body.sessionId, {
              type: 'system.error',
              payload: { error: error instanceof Error ? error.message : String(error) },
              timestamp: Date.now(),
              sessionId: body.sessionId,
            });
          });
        return {
          ok: true,
          data: {
            removedMessages,
            prunedContextEntries,
            editedMessageId: body.messageId,
            conversationRevision,
          },
        };
      } catch (error) {
        set.status = 409;
        return {
          ok: false,
          error: `Conversation history could not be safely rewritten: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
    {
      body: t.Object({
        sessionId: t.String(),
        messageId: t.String(),
        content: t.String({ minLength: 1, maxLength: MESSAGE.MAX_CONTENT_LENGTH }),
        model: t.Optional(t.String()),
        reasoningLevel: t.Optional(t.String()),
      }),
    },
  )
  .post(
    '/regenerate',
    async ({ body, set }) => {
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
          prompt.attachments,
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
