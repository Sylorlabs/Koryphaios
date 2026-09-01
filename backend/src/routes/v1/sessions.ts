import { Elysia, t } from 'elysia';
import { getContext } from '../../context';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';
import { processSupervisor } from '../../process-supervisor/supervisor';
import { serializeProcess } from '../../process-supervisor/serialize';
import { serverLog } from '../../logger';
import { writeAllCliRulesAndSkills } from '../../providers/cli-rules-skills';
import {
  AuthenticationError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../errors/types';
import { SESSION } from '../../constants';
import { timeTravelDegradedResponse, withSessionRecoveryGuard } from './session-recovery-guard';
import {
  eraseSessionsCoordinated,
  tryAcquireSessionCreationLease,
} from '../../services/session-erasure-service';
import {
  archiveSessionCoordinated,
  restoreSessionCoordinated,
} from '../../services/session-archive-service';

async function requireActiveSession(sessionId: string) {
  const { sessions } = getContext();
  const session = await sessions.get(sessionId);
  if (!session) throw new NotFoundError('Session', sessionId);
  if (session.archivedAt !== undefined) {
    throw new ConflictError('Recover this archived chat before changing or continuing its work.');
  }
  return session;
}

async function timeTravelForSession(sessionId: string) {
  const { kory, timeTravel } = getContext();
  await requireActiveSession(sessionId);
  const workingDirectory = await kory.resolveSessionWorkingDirectoryPublic(sessionId);
  return timeTravel.forWorkingDirectory(workingDirectory);
}

export const sessionRoutes = new Elysia({ prefix: '/api/sessions' })
  .get('/', async ({ request }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
    const { sessions } = getContext();
    const list = await sessions.listActive();
    return { ok: true, data: list };
  })
  .post(
    '/',
    async ({ request, body }) => {
      if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
      const { sessions } = getContext();
      const creationLease = tryAcquireSessionCreationLease();
      if (!creationLease) {
        throw new ConflictError(
          'Session creation is temporarily blocked while delete-all is finishing.',
        );
      }
      let session;
      try {
        session = await sessions.create(
          'local-user',
          body.title,
          body.parentId,
          body.workingDirectory,
        );
      } finally {
        creationLease.release();
      }
      // Write Koryphaios rules + skills files to every CLI's isolated home so
      // the native CLIs (claude, codex, devin, grok, cursor, cline, antigravity)
      // discover Kory's tool-usage + orchestration conventions on startup.
      try {
        writeAllCliRulesAndSkills(session.id, '');
      } catch (err: unknown) {
        // Expected failure: CLI rules are supplementary, not request-critical.
        serverLog.warn({ err, sessionId: session.id }, 'Failed to write CLI rules + skills');
      }
      return { ok: true, data: session };
    },
    {
      body: t.Object({
        userId: t.Optional(t.String()),
        title: t.Optional(t.String()),
        parentId: t.Optional(t.String()),
        workingDirectory: t.Optional(t.String()),
      }),
    },
  )
  .delete('/', async ({ request }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
    const result = await eraseSessionsCoordinated({ kind: 'all' });
    return { ok: true, deleted: result.deleted, operationId: result.operationId };
  })
  .get('/archived', async ({ request }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
    const list = await getContext().sessions.listArchived();
    return { ok: true, data: list };
  })
  .get('/:id', async ({ request, params: { id } }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
    const { sessions } = getContext();
    const session = await sessions.get(id);
    if (!session) throw new NotFoundError('Session', id);
    return { ok: true, data: session };
  })
  .patch(
    '/:id',
    async ({ request, params: { id }, body }) => {
      if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
      const { sessions } = getContext();
      const current = await sessions.get(id);
      if (!current) throw new NotFoundError('Session', id);
      if (
        current.archivedAt !== undefined &&
        (body.title === undefined || Object.keys(body).some((field) => field !== 'title'))
      ) {
        throw new ConflictError('Archived chats can only be renamed, recovered, or deleted.');
      }
      const title = body.title?.trim();
      if (body.title !== undefined) {
        if (!title) throw new ValidationError('Chat name cannot be empty.');
        if (title.length > SESSION.MAX_TITLE_LENGTH) {
          throw new ValidationError(
            `Chat name cannot exceed ${SESSION.MAX_TITLE_LENGTH} characters.`,
          );
        }
        if (/\p{Cc}/u.test(title)) {
          throw new ValidationError('Chat name cannot contain control characters.');
        }
      }
      const updated = await sessions.update(id, {
        ...body,
        ...(title !== undefined ? { title } : {}),
      });
      if (!updated) throw new NotFoundError('Session', id);
      return { ok: true, data: updated };
    },
    {
      body: t.Partial(
        t.Object({
          title: t.String(),
          messageCount: t.Number(),
          totalTokensIn: t.Number(),
          totalTokensOut: t.Number(),
          totalCost: t.Number(),
          interactionMode: t.Union([t.Literal('act'), t.Literal('plan')]),
        }),
      ),
    },
  )
  .post('/:id/archive', async ({ request, params: { id } }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
    const session = await archiveSessionCoordinated(id);
    return { ok: true, data: session };
  })
  .post('/:id/restore', async ({ request, params: { id } }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
    const session = await restoreSessionCoordinated(id);
    return { ok: true, data: session };
  })
  .delete('/:id', async ({ request, params: { id } }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
    const result = await eraseSessionsCoordinated({ kind: 'selected', sessionId: id });
    return { ok: true, operationId: result.operationId };
  })
  .get('/:id/processes', async ({ request, params: { id } }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
    const processes = await processSupervisor.getProcessesBySession(id);
    return {
      ok: true,
      processes: await Promise.all(processes.map((process) => serializeProcess(process))),
    };
  })
  .post('/:id/cancel', async ({ request, params: { id } }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
    const { kory, wsManager } = getContext();
    // Cancel all workers for this session
    await getContext().goalDriver.pauseForSession(id);
    await kory.cancelSessionWorkers(id);
    // Cancel any LLM jobs for this session
    const { cancelLLMJobsForSession } = await import('../../queue/workers/llm-worker');
    await cancelLLMJobsForSession(id);
    // Notify all clients about the cancellation
    wsManager.broadcastToSession(id, {
      type: 'system.info',
      payload: { message: 'Session cancelled' },
      timestamp: Date.now(),
      sessionId: id,
    });
    return { ok: true, message: 'Session cancelled' };
  })
  .post(
    '/:id/compact',
    async ({ request, params: { id }, body }) => {
      if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
      await requireActiveSession(id);
      const result = await getContext().kory.compactSession({
        sessionId: id,
        selectedModel: body.model,
        reasoningLevel: body.reasoningLevel,
        automatic: body.automatic,
      });
      return { ok: true, data: result };
    },
    {
      body: t.Object({
        model: t.String(),
        reasoningLevel: t.Optional(t.String()),
        automatic: t.Optional(t.Boolean()),
      }),
    },
  )
  .get('/:id/context', async ({ request, params: { id } }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
    const { sessions, messages } = getContext();
    if (!(await sessions.get(id))) throw new NotFoundError('Session', id);
    // Archived tool activity for this session — used to restore tool entries
    // in the feed after a reload (they're not part of the message history).
    const { getContextArchive, usageSnapshotMatchesBoundary } =
      await import('../../kory/context-archive');
    const archive = getContextArchive();
    if (!archive) return { ok: true, data: [] };
    const [entries, lastUsage, boundary] = await Promise.all([
      archive.listRecent(id, 500),
      archive.getLastUsage(id),
      messages.getActiveBoundary(id),
    ]);
    return {
      ok: true,
      lastUsage: usageSnapshotMatchesBoundary(lastUsage, boundary) ? lastUsage : null,
      data: entries.map((e) => ({
        id: e.id,
        ts: e.ts,
        kind: e.kind,
        label: e.label,
        content: e.content.slice(0, 4000),
        originalByteCount: e.originalByteCount,
        contentSha256: e.contentSha256,
        truncated: e.truncated,
        redacted: e.redacted,
        isError: e.isError,
        prunedForAgent: e.prunedForAgent === true,
      })),
    };
  })
  .post(
    '/:id/context/model-preview',
    async ({ request, params: { id }, body }) => {
      if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
      // Model switched in the composer: re-baseline the context bar from the
      // backend's trusted window data (never a frontend guess).
      const { kory, sessions } = getContext();
      if (!(await sessions.get(id))) throw new NotFoundError('Session', id);
      // previewModelContext types provider as `never` to force literal callers;
      // the runtime value is a valid provider string from the client request.
      // This is a read-only response. It deliberately does not acquire the
      // session mutation barrier, emit websocket usage, or persist anything,
      // so the picker can refresh during a turn without racing run state.
      const usage = await kory.previewModelContext(id, body.model, body.provider as never);
      return { ok: true, usage };
    },
    { body: t.Object({ model: t.String(), provider: t.String() }) },
  )
  .post(
    '/:id/context/:archiveId/visibility',
    async ({ request, params: { id, archiveId }, body }) => {
      if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
      // User-driven "hide from agent": stubs this entry out of the model's
      // context on the next turn. Its bounded, redacted preview stays archived.
      const { kory } = getContext();
      const lease = kory.tryAcquireSessionMutationBarrier(id);
      if (!lease) {
        throw new ConflictError('Wait for active session work or deletion to finish.');
      }
      const { getContextArchive } = await import('../../kory/context-archive');
      const archive = getContextArchive();
      try {
        await requireActiveSession(id);
        if (!archive) return { ok: false, error: 'Context archive unavailable' };
        // Body has no t.Object schema so it is untyped — cast to the expected shape.
        const hidden =
          (body as { hiddenFromAgent?: boolean } | undefined)?.hiddenFromAgent === true;
        const changed = await archive.setPrunedForAgent(id, archiveId, hidden);
        if (!changed) throw new NotFoundError('Archive entry', archiveId);
        return { ok: true };
      } finally {
        lease.release();
      }
    },
  )
  .post(
    '/:id/rewind/preview',
    async ({ request, params: { id }, body }) => {
      if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
      const busy = () => ({
        ok: false,
        data: {
          canTravel: false,
          currentHash: '',
          targetHash: body.hash,
          description: '',
          evidence: { timestamp: 0 },
          diff: '',
          filesChanged: [],
          conversationEffect: 'code-only' as const,
          message: 'Stop or wait for active agent work before rewinding this session.',
        },
        message: 'Stop or wait for active agent work before rewinding this session.',
      });
      return withSessionRecoveryGuard({
        tryAcquireManager: () => getContext().kory.tryAcquireSessionMutationBarrier(id),
        tryAcquireProcess: () => processSupervisor.tryAcquireAgentToolBarrier(id),
        onBusy: busy,
        run: async () => {
          const preview = await (await timeTravelForSession(id)).previewTravel(body.hash, id);
          return { ok: preview.canTravel, data: preview, message: preview.message };
        },
      });
    },
    { body: t.Object({ hash: t.String() }) },
  )
  .post(
    '/:id/rewind',
    async ({ request, params: { id }, body }) => {
      if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
      const busy = () => ({
        ok: false,
        message: 'Stop or wait for active agent work before rewinding this session.',
      });
      return withSessionRecoveryGuard({
        tryAcquireManager: () => getContext().kory.tryAcquireSessionMutationBarrier(id),
        tryAcquireProcess: () => processSupervisor.tryAcquireAgentToolBarrier(id),
        onBusy: busy,
        run: async () => {
          const result = await (
            await timeTravelForSession(id)
          ).travelTo(body.hash, id, body.expectedCurrentHash);
          const eventEpoch =
            result.success && result.conversationEffect === 'rewind'
              ? getContext().wsManager.rewriteSessionTimeline(id).epoch
              : undefined;
          return {
            ok: result.success,
            message: result.message,
            ...(eventEpoch !== undefined ? { eventEpoch } : {}),
          };
        },
      });
    },
    {
      body: t.Object({
        hash: t.String(),
        confirmed: t.Literal(true),
        expectedCurrentHash: t.String(),
      }),
    },
  )
  .get('/:id/timetravel', async ({ request, params: { id } }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
    try {
      const state = await (await timeTravelForSession(id)).getState(id);
      return { ok: true, data: state };
    } catch (err: unknown) {
      // Preserve the session while truthfully surfacing missing/corrupt shadow
      // storage or an unreconciled journal. This remains an HTTP-successful
      // route response so panel loading does not create a console-level 500.
      serverLog.warn({ err, sessionId: id }, 'Failed to load time travel timeline');
      return timeTravelDegradedResponse(err);
    }
  });
