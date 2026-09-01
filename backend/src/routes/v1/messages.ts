import { Elysia, t } from 'elysia';
import type { StoredMessage } from '@koryphaios/shared';
import { getContext } from '../../context';
import { nanoid } from 'nanoid';
import { ID, MESSAGE } from '../../constants';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';
import { serverLog } from '../../logger';
import { resolveImageModelSelection, runImageJob } from './images';
import { ConflictError } from '../../errors/types';
import type { KoryManager, SessionTurnAdmission } from '../../kory/manager';
import type { RegenerationBranchReservation } from '../../stores/message-store';

async function processImageMessage(
  kory: KoryManager,
  admission: SessionTurnAdmission,
  sessionId: string,
  prompt: string,
  selection: { provider: string; model: string },
  attachments?: Array<{ type: string; data: string; name: string; mimeType?: string }>,
  responseVariant?: { groupId: string; index: number },
  regenerationBranch?: RegenerationBranchReservation,
): Promise<void> {
  const { messages, wsManager } = getContext();
  await kory.dispatchAdmittedWork(
    admission,
    async ({ signal, phase }) => {
      await phase('streaming', 'image_generation');
      wsManager.broadcastToSession(sessionId, {
        type: 'agent.status',
        payload: { agentId: 'kory-manager', status: 'streaming' },
        timestamp: Date.now(),
        sessionId,
      });
      const source = attachments?.find((attachment) => attachment.type === 'image');
      const generatedMessageId = nanoid(ID.SESSION_ID_LENGTH);
      const result = await runImageJob(
        { prompt, ...selection },
        source ? { base64: source.data, mimeType: source.mimeType ?? 'image/png' } : undefined,
        {
          signal,
          history: 'none',
          sessionId,
          runId: admission.runId,
          usageId: generatedMessageId,
        },
      );
      if (signal.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new DOMException('Image turn cancelled', 'AbortError');
      }
      if (result.data.spendWarning) {
        wsManager.broadcastToSession(sessionId, {
          type: 'system.info',
          payload: { message: `Spend limit warning: ${result.data.spendWarning}` },
          timestamp: Date.now(),
          sessionId,
        });
      }
      const extension = result.data.mimeType.includes('jpeg')
        ? 'jpg'
        : (result.data.mimeType.split('/')[1] ?? 'png');
      const content = result.data.revisedPrompt
        ? `Generated image.\n\n${result.data.revisedPrompt}`
        : 'Generated image.';
      const generatedMessage: StoredMessage = {
        id: generatedMessageId,
        sessionId,
        role: 'assistant',
        content,
        model: result.data.model,
        provider: result.data.provider,
        cost: result.data.estimatedCostUsd,
        variantGroupId: responseVariant?.groupId,
        variantIndex: responseVariant?.index,
        attachments: [
          {
            type: 'image',
            data: result.data.imageBase64,
            name: `generated-${nanoid(8)}.${extension}`,
            mimeType: result.data.mimeType,
          },
        ],
        createdAt: Date.now(),
      };
      if (regenerationBranch) {
        await messages.commitRegeneratedResponse(regenerationBranch, generatedMessage);
      } else {
        await messages.add(sessionId, generatedMessage);
      }
      wsManager.broadcastToSession(sessionId, {
        type: 'stream.delta',
        payload: { agentId: 'kory-manager', content, model: result.data.model },
        timestamp: Date.now(),
        sessionId,
      });
    },
    'image_turn_completed',
  );
  wsManager.broadcastToSession(sessionId, {
    type: 'agent.status',
    payload: { agentId: 'kory-manager', status: 'done' },
    timestamp: Date.now(),
    sessionId,
  });
}

export const messageRoutes = new Elysia({ prefix: '/api/messages' })
  .get('/:sessionId', async ({ request, params: { sessionId }, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const { messages } = getContext();
    return { ok: true, data: await messages.getDisplayProjection(sessionId) };
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
      if (session.archivedAt !== undefined) {
        set.status = 409;
        return { ok: false, error: 'Recover this archived chat before sending a message.' };
      }

      const userMsg = {
        id: nanoid(ID.SESSION_ID_LENGTH),
        sessionId: body.sessionId,
        role: 'user' as const,
        content: body.content,
        attachments: body.attachments,
        createdAt: Date.now(),
      };

      const imageSelection = resolveImageModelSelection(body.model);
      const admission = await kory.reserveSessionTurn(
        body.sessionId,
        imageSelection ? 'image_turn' : 'user_turn',
      );
      if (!admission) {
        throw new ConflictError(
          'This session already has active work. Wait for it to finish before starting another turn.',
        );
      }

      try {
        await messages.add(body.sessionId, userMsg);
      } catch (error) {
        await kory.rejectSessionTurn(admission, 'user_message_persistence_failed');
        throw error;
      }

      // Fire-and-forget agent title generation. Only fires on the very first
      // user message of a session whose title is still the default — the
      // manager method is a no-op otherwise, so this is safe to call every
      // turn.
      kory.generateSessionTitle(body.sessionId, body.content).catch((err: unknown) => {
        serverLog.debug(
          { err: err instanceof Error ? err.message : String(err), sessionId: body.sessionId },
          'Session title generation failed (non-critical, fire-and-forget)',
        );
      });

      if (imageSelection) {
        processImageMessage(
          kory,
          admission,
          body.sessionId,
          body.content,
          imageSelection,
          body.attachments,
        ).catch((err: unknown) => {
          wsManager.broadcastToSession(body.sessionId, {
            type: 'system.error',
            payload: {
              error: err instanceof Error ? err.message : String(err),
              sessionId: body.sessionId,
            },
            timestamp: Date.now(),
            sessionId: body.sessionId,
          });
        });
        return {
          ok: true,
          data: { status: 'processing', runId: admission.runId, messageId: userMsg.id },
        };
      }

      kory
        .dispatchAdmittedTask(admission, {
          userMessage: body.content,
          preferredModel: body.model,
          reasoningLevel: body.reasoningLevel,
          attachments: body.attachments,
          interactionMode: body.interactionMode ?? session.interactionMode ?? 'act',
          fastMode: body.fastMode,
          inputAlreadyPersisted: true,
          imageInputMode: body.imageInputMode ?? 'reject',
        })
        .catch((err) => {
          wsManager.broadcast({
            type: 'system.error',
            payload: { error: err.message, sessionId: body.sessionId },
            timestamp: Date.now(),
            sessionId: body.sessionId,
          });
        });

      return {
        ok: true,
        data: { status: 'processing', runId: admission.runId, messageId: userMsg.id },
      };
    },
    {
      body: t.Object({
        sessionId: t.String(),
        content: t.String(),
        model: t.Optional(t.String()),
        reasoningLevel: t.Optional(t.String()),
        fastMode: t.Optional(t.Boolean()),
        interactionMode: t.Optional(t.Union([t.Literal('act'), t.Literal('plan')])),
        imageInputMode: t.Optional(t.Union([t.Literal('reject'), t.Literal('omit')])),
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
  .delete('/:sessionId/:messageId', async ({ request, params: { sessionId, messageId }, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const { kory, messages, sessions } = getContext();
    const session = await sessions.get(sessionId);
    if (!session) {
      set.status = 404;
      return { ok: false, error: 'Session not found' };
    }
    if (session.archivedAt !== undefined) {
      set.status = 409;
      return { ok: false, error: 'Recover this archived chat before deleting messages.' };
    }
    const mutationLease = kory.tryAcquireSessionMutationBarrier(sessionId);
    if (!mutationLease) {
      throw new ConflictError('Wait for active session work before deleting messages.');
    }
    try {
      const deleted = await messages.deleteMessage(sessionId, messageId);
      if (!deleted) {
        set.status = 404;
        return { ok: false, error: 'Message not found' };
      }
      return { ok: true };
    } finally {
      mutationLease.release();
    }
  })
  .post(
    '/variant',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const { kory, messages, sessions } = getContext();
      const session = await sessions.get(body.sessionId);
      if (!session) {
        set.status = 404;
        return { ok: false, error: 'Session not found' };
      }
      if (session.archivedAt !== undefined) {
        set.status = 409;
        return {
          ok: false,
          error: 'Recover this archived chat before selecting a response variant.',
        };
      }
      const mutationLease = kory.tryAcquireSessionMutationBarrier(body.sessionId);
      if (!mutationLease) {
        throw new ConflictError(
          'Wait for active session work before selecting a response variant.',
        );
      }
      try {
        const activated = await messages.activateResponseVariant(body);
        if (!activated) {
          set.status = 404;
          return { ok: false, error: 'Response variant not found' };
        }
        return { ok: true, data: activated };
      } finally {
        mutationLease.release();
      }
    },
    {
      body: t.Object({
        sessionId: t.String(),
        messageId: t.String(),
        expectedActiveMessageId: t.String(),
        expectedProviderConversationRevision: t.Integer({ minimum: 0 }),
      }),
    },
  )
  .post(
    '/regenerate',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const { kory, sessions, messages, wsManager } = getContext();
      const session = await sessions.get(body.sessionId);
      if (!session) {
        set.status = 404;
        return { ok: false, error: 'Session not found' };
      }
      if (session.archivedAt !== undefined) {
        set.status = 409;
        return { ok: false, error: 'Recover this archived chat before regenerating a response.' };
      }
      const candidate = await messages.getRegenerationCandidate(body.sessionId, body.messageId);
      if (!candidate) {
        set.status = 404;
        return { ok: false, error: 'Assistant response is not available on this conversation' };
      }
      const { target, prompt } = candidate;
      const selectedModel =
        body.model ??
        (target.provider && target.model ? `${target.provider}:${target.model}` : undefined);
      const imageSelection = resolveImageModelSelection(selectedModel);
      const admission = await kory.reserveSessionTurn(
        body.sessionId,
        imageSelection ? 'image_regenerate_turn' : 'regenerate_turn',
      );
      if (!admission) {
        throw new ConflictError(
          'This session already has active work. Wait for it to finish before regenerating.',
        );
      }
      let branch: RegenerationBranchReservation;
      try {
        branch = await messages.prepareRegenerationBranch({
          sessionId: body.sessionId,
          targetMessageId: target.id,
          promptMessageId: prompt.id,
          expectedActiveMessageId: candidate.boundary.messageId,
          expectedProviderConversationRevision: candidate.providerConversationRevision,
        });
      } catch (error) {
        await kory.rejectSessionTurn(admission, 'regeneration_branch_persistence_failed');
        throw error;
      }
      const { groupId, index: nextIndex } = branch;
      if (imageSelection) {
        processImageMessage(
          kory,
          admission,
          body.sessionId,
          prompt.content,
          imageSelection,
          prompt.attachments,
          { groupId, index: nextIndex },
          branch,
        ).catch((error: unknown) => {
          wsManager.broadcastToSession(body.sessionId, {
            type: 'system.error',
            payload: { error: error instanceof Error ? error.message : String(error) },
            timestamp: Date.now(),
            sessionId: body.sessionId,
          });
        });
        return {
          ok: true,
          data: { status: 'processing', runId: admission.runId, groupId, index: nextIndex },
        };
      }

      kory
        .dispatchAdmittedTask(admission, {
          userMessage: prompt.content,
          preferredModel: selectedModel,
          reasoningLevel: body.reasoningLevel,
          attachments: prompt.attachments,
          responseVariant: { groupId, index: nextIndex },
          inputAlreadyPersisted: true,
          regenerationBranch: branch,
        })
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
        data: { status: 'processing', runId: admission.runId, groupId, index: nextIndex },
      };
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
