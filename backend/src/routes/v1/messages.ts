import { Elysia, t } from 'elysia';
import { legacyTurnParts, type StoredMessage, type ProviderName } from '@koryphaios/shared';
import { getContext } from '../../context';
import { nanoid } from 'nanoid';
import { ID, MESSAGE } from '../../constants';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';
import { serverLog } from '../../logger';
import { resolveImageModelSelection, runImageJob } from './images';
import { normalizeSpeedTier } from '../../providers/speed-tiers';
import { ConflictError } from '../../errors/types';
import { TurnOwnershipLostError } from '../../kory/services/TurnRuntime.types';
import type { KoryManager, SessionTurnAdmission } from '../../kory/manager';
import type { RegenerationBranchReservation } from '../../stores/message-store';

function isIntentionalCancellation(error: unknown, admission: SessionTurnAdmission): boolean {
  return admission.signal.aborted && error === admission.signal.reason;
}

function reportTurnFailure(
  error: unknown,
  admission: SessionTurnAdmission,
  sessionId: string,
  wsManager: ReturnType<typeof getContext>['wsManager'],
): void {
  // A superseded turn is a steer outcome, never a user-facing failure.
  if (isIntentionalCancellation(error, admission) || error instanceof TurnOwnershipLostError)
    return;
  wsManager.broadcastToSession(sessionId, {
    type: 'system.error',
    payload: { error: error instanceof Error ? error.message : String(error), sessionId },
    timestamp: Date.now(),
    sessionId,
  });
}

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
      // Naming is metadata, never a prerequisite for image generation. The
      // old await made a title-model probe (and its retries/403) sit directly
      // on the user's first-token path. Let it refine the default title in the
      // background and keep failures out of the response turn.
      void kory.generateSessionTitle(sessionId, prompt, undefined, signal).catch((error) => {
        serverLog.debug(
          { sessionId, error: error instanceof Error ? error.message : String(error) },
          'Background session title generation failed',
        );
      });
      signal.throwIfAborted();
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
      let content = result.data.revisedPrompt
        ? `Generated image.\n\n${result.data.revisedPrompt}`
        : 'Generated image.';
      const review = await kory.runCriticGate(
        sessionId,
        [
          { role: 'user', content: prompt },
          { role: 'assistant', content },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Generated image to evaluate against the original request.' },
              {
                type: 'image',
                imageData: result.data.imageBase64,
                imageMimeType: result.data.mimeType,
              },
            ],
          },
        ],
        undefined,
        prompt,
        await kory.resolveSessionWorkingDirectoryPublic(sessionId),
        { provider: result.data.provider as ProviderName, model: result.data.model },
        undefined,
        { responseOnly: true, purpose: 'image' },
      );
      signal.throwIfAborted();
      if (review.criticUnavailable) {
        // The Critic could not run — deliver the image marked unverified
        // rather than failing the whole generation turn.
        content += `\n\nUNVERIFIED: Critic could not run:\n${review.feedback ?? ''}`;
      } else if (!review.passed) {
        throw new Error(`Critic did not approve the generated response: ${review.feedback}`);
      }
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

/**
 * Assistant rows always leave the API with `parts`. Rows written before parts
 * existed are rendered as [reasoning?, text] so the client has one shape.
 */
/**
 * Backstop for a ledger-owned turn whose completion rejects. A user stop is a
 * cancellation, not a failure, so it is never published as a system error.
 */
function reportLedgerTurnFailure(
  error: unknown,
  sessionId: string,
  wsManager: ReturnType<typeof getContext>['wsManager'],
): void {
  if (error instanceof DOMException && error.name === 'AbortError') return;
  if (error instanceof TurnOwnershipLostError) return;
  wsManager.broadcastToSession(sessionId, {
    type: 'system.error',
    payload: { error: error instanceof Error ? error.message : String(error), sessionId },
    timestamp: Date.now(),
    sessionId,
  });
}

export function withDisplayParts(message: StoredMessage): StoredMessage {
  if (message.role !== 'assistant') return message;
  return {
    ...message,
    parts:
      message.parts ??
      legacyTurnParts(message.content, message.reasoningContent, message.createdAt),
  };
}

export const messageRoutes = new Elysia({ prefix: '/api/messages' })
  .get('/:sessionId', async ({ request, params: { sessionId }, query, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const { messages } = getContext();
    const requestedLimit = Number(query?.limit);
    // The ceiling matches the frontend's MAX_RESUME_PAGE_SIZE: a parked
    // reader's first read must reach from their saved anchor to the newest
    // message in one request, or the position cannot be restored.
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(20, Math.min(1000, Math.floor(requestedLimit)))
      : 120;
    const beforeMessageId =
      typeof query?.before === 'string' && query.before ? query.before : undefined;
    const projection = await messages.getDisplayProjection(sessionId, limit, { beforeMessageId });
    return {
      ok: true,
      data: { ...projection, messages: projection.messages.map(withDisplayParts) },
    };
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

      // Every user turn that is not an image turn starts through the session-turn
      // command ledger: the command row is the durable intent record, the input
      // write is idempotent, and receipts replay. A send without a client id gets
      // a server-minted id, so it is a new command on the same path.
      // Image turns keep their admitted path below because image generation is
      // not a provider chat loop and has no ledger-backed dispatch yet.
      const imageSelection = resolveImageModelSelection(body.model);
      if (!imageSelection) {
        const sourceCommandId = body.clientMessageId ?? `srv_${nanoid()}`;
        const submission = await kory.startSessionTurn({
          sessionId: body.sessionId,
          source: 'user',
          sourceCommandId,
          userMessage: body.content,
          preferredModel: body.model,
          reasoningLevel: body.reasoningLevel,
          contextWindow: body.contextWindow,
          attachments: body.attachments,
          interactionMode: body.interactionMode ?? session.interactionMode ?? 'act',
          fastMode: body.fastMode,
          speedTier: normalizeSpeedTier(body.model?.split(':')[0], body.speedTier, body.fastMode),
          modelParameters: body.modelParameters,
          fusion: body.fusion,
          imageInputMode: body.imageInputMode ?? 'reject',
        });
        if (submission.accepted === 'queued') {
          // The session has a live run, so the send was parked behind it and
          // will be admitted as the next turn when the running stack yields at
          // a safe boundary. Its user message is already durable.
          return {
            ok: true,
            data: {
              status: 'queued',
              steeringCommandId: submission.steeringCommandId,
              messageId: submission.userMessageId,
            },
          };
        }
        if (!submission.accepted) {
          const { result } = submission;
          // A replayed command reports its own run and user message. A command
          // still in flight may not have persisted its message yet, so it is
          // replayed without the check. Otherwise the message must exist: a
          // command that failed before persisting its input is not accepted.
          if (submission.replay !== undefined) {
            if (
              submission.replay === 'in_flight' ||
              (await messages.getById(body.sessionId, submission.userMessageId))
            ) {
              return {
                ok: true,
                data: {
                  status: 'processing',
                  runId: result.runId,
                  messageId: submission.userMessageId,
                },
              };
            }
            throw new ConflictError(
              'This message id belongs to an attempt that failed before its message was recorded. Retry with a new message id.',
            );
          }
          if (result.reason === 'session_busy') {
            throw new ConflictError(
              'This session already has active work. Wait for it to finish before starting another turn.',
            );
          }
          throw new ConflictError(
            'This message id is already bound to a command that did not complete. Retry with a new message id.',
          );
        }
        // Not awaited: the HTTP response reports admission, and the turn's
        // outcome reaches the client through the run and transcript events.
        submission.completion.catch((error: unknown) => {
          reportLedgerTurnFailure(error, body.sessionId, wsManager);
        });
        return {
          ok: true,
          data: {
            status: 'processing',
            runId: submission.runId,
            messageId: submission.userMessageId,
          },
        };
      }

      // Image turn (documented exception in docs/architecture/transcript-integrity.md).
      const userMsg = {
        id: nanoid(ID.SESSION_ID_LENGTH),
        sessionId: body.sessionId,
        role: 'user' as const,
        content: body.content,
        attachments: body.attachments,
        createdAt: Date.now(),
      };
      const admission = await kory.reserveSessionTurnAfterSteer(body.sessionId, 'image_turn');
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

      processImageMessage(
        kory,
        admission,
        body.sessionId,
        body.content,
        imageSelection,
        body.attachments,
      ).catch((error: unknown) => {
        reportTurnFailure(error, admission, body.sessionId, wsManager);
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
        clientMessageId: t.Optional(
          t.String({ minLength: 8, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' }),
        ),
        model: t.Optional(t.String()),
        reasoningLevel: t.Optional(t.String()),
        contextWindow: t.Optional(t.Number()),
        fastMode: t.Optional(t.Boolean()),
        speedTier: t.Optional(t.String()),
        modelParameters: t.Optional(t.Record(t.String(), t.Union([t.Number(), t.String()]))),
        fusion: t.Optional(
          t.Object({
            lead: t.String(),
            leadEffort: t.String(),
            leadFast: t.Boolean(),
            sidekick: t.String(),
            sidekickEffort: t.Union([t.String(), t.Null()]),
          }),
        ),
        interactionMode: t.Optional(t.Union([t.Literal('act'), t.Literal('plan')])),
        imageInputMode: t.Optional(
          t.Union([t.Literal('reject'), t.Literal('omit'), t.Literal('allow')]),
        ),
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
      const admission = await kory.reserveSessionTurnAfterSteer(
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
          reportTurnFailure(error, admission, body.sessionId, wsManager);
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
        .catch((error: unknown) => {
          reportTurnFailure(error, admission, body.sessionId, wsManager);
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
