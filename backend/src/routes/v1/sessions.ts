import { Elysia, t } from 'elysia';
import { getContext } from '../../context';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';
import { processSupervisor } from '../../process-supervisor/supervisor';
import { serializeProcess } from '../../process-supervisor/serialize';
import { serverLog } from '../../logger';
import { writeAllCliRulesAndSkills } from '../../providers/cli-rules-skills';
import { AuthenticationError, NotFoundError, ValidationError } from '../../errors/types';

export const sessionRoutes = new Elysia({ prefix: '/api/sessions' })
  .get('/', async ({ request }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
    const { sessions } = getContext();
    const list = await sessions.list();
    return { ok: true, data: list };
  })
  .post(
    '/',
    async ({ request, body }) => {
      if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
      const { sessions } = getContext();
      const session = await sessions.create(
        'local-user',
        body.title,
        body.parentId,
        body.workingDirectory,
      );
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
    const { sessions, kory, goalDriver } = getContext();
    const existingSessions = await sessions.list();
    const { cancelLLMJobsForSession } = await import('../../queue/workers/llm-worker');

    // A bulk delete must not leave work running for conversations that no
    // longer exist. Stop every session before removing their persisted data.
    for (const session of existingSessions) {
      await goalDriver.pauseForSession(session.id);
      kory.cancelSessionWorkers(session.id);
      kory.abortManagerRun(session.id);
      await cancelLLMJobsForSession(session.id);
    }

    await sessions.clear();
    return { ok: true, deleted: existingSessions.length };
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
      const updated = await sessions.update(id, body);
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
  .delete('/:id', async ({ request, params: { id } }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
    const { sessions, kory, goalDriver, wsManager } = getContext();
    const { cancelLLMJobsForSession } = await import('../../queue/workers/llm-worker');

    // A deleted session must not retain a live manager turn or queued job:
    // either can otherwise publish a stale update after its row is removed.
    await goalDriver.pauseForSession(id);
    kory.cancelSessionWorkers(id);
    kory.abortManagerRun(id);
    await cancelLLMJobsForSession(id);
    await sessions.delete(id);
    wsManager.broadcast({
      type: 'session.deleted',
      payload: { sessionId: id },
      timestamp: Date.now(),
      sessionId: id,
    });
    return { ok: true };
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
    kory.cancelSessionWorkers(id);
    // Abort manager thread for this session
    kory.abortManagerRun(id);
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
      const result = await getContext().kory.compactSession({
        sessionId: id,
        selectedModel: body.model,
        reasoningLevel: body.reasoningLevel,
        automatic: body.automatic,
      });
      return { ok: true, data: result };
    },
    { body: t.Object({ model: t.String(), reasoningLevel: t.Optional(t.String()), automatic: t.Optional(t.Boolean()) }) },
  )
  .get('/:id/context', async ({ request, params: { id } }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
    // Archived tool activity for this session — used to restore tool entries
    // in the feed after a reload (they're not part of the message history).
    const { getContextArchive } = await import('../../kory/context-archive');
    const archive = getContextArchive();
    if (!archive) return { ok: true, data: [] };
    const entries = await archive.listRecent(id, 500);
    const lastUsage = await archive.getLastUsage(id);
    return {
      ok: true,
      lastUsage: lastUsage ?? null,
      data: entries.map((e) => ({
        id: e.id,
        ts: e.ts,
        kind: e.kind,
        label: e.label,
        content: e.content.slice(0, 4000),
        prunedForAgent: e.prunedForAgent === true,
      })),
    };
  })
  .post('/:id/context/model-preview', async ({ request, params: { id }, body }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
    // Model switched in the composer: re-baseline the context bar from the
    // backend's trusted window data (never a frontend guess).
    const { kory } = getContext();
    // Body has no t.Object schema so it is untyped — cast to the expected shape.
    const b = body as { model?: string; provider?: string } | undefined;
    if (!b?.model || !b?.provider) throw new ValidationError('model and provider required');
    // previewModelContext types provider as `never` to force literal callers;
    // the runtime value is a valid provider string from the client request.
    const usage = await kory.previewModelContext(id, b.model, b.provider as never);
    return { ok: true, usage };
  })
  .post(
    '/:id/context/:archiveId/visibility',
    async ({ request, params: { id, archiveId }, body }) => {
      if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
      // User-driven "hide from agent": stubs this entry out of the model's
      // context on the next turn. Content stays archived and recoverable.
      const { getContextArchive } = await import('../../kory/context-archive');
      const archive = getContextArchive();
      if (!archive) return { ok: false, error: 'Context archive unavailable' };
      // Body has no t.Object schema so it is untyped — cast to the expected shape.
      const hidden =
        (body as { hiddenFromAgent?: boolean } | undefined)?.hiddenFromAgent === true;
      const changed = await archive.setPrunedForAgent(id, archiveId, hidden);
      if (!changed) throw new NotFoundError('Archive entry', archiveId);
      return { ok: true };
    },
  )
  .post(
    '/:id/rewind/preview',
    async ({ request, params: { id }, body }) => {
      if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
      const { timeTravel } = getContext();
      const preview = await timeTravel.previewTravel(body.hash, id);
      return { ok: preview.canTravel, data: preview, message: preview.message };
    },
    { body: t.Object({ hash: t.String() }) },
  )
  .post(
    '/:id/rewind',
    async ({ request, params: { id }, body }) => {
      if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
      const { timeTravel } = getContext();
      const result = await timeTravel.travelTo(body.hash, id, body.expectedCurrentHash);
      return { ok: result.success, message: result.message };
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
      const { timeTravel } = getContext();
      const state = await timeTravel.getState(id);
      return { ok: true, data: state };
    } catch (err: unknown) {
      // Timeline history is supplementary UI. A git/reflog edge case must not
      // turn opening an otherwise valid session into a browser-console 500.
      // Return the empty, non-rewindable state the UI already understands.
      serverLog.warn({ err, sessionId: id }, 'Failed to load time travel timeline');
      return {
        ok: true,
        data: {
          currentHash: '',
          timeline: [],
          canUndo: false,
          canRedo: false,
          stats: { totalStates: 0, totalCost: 0, modelsUsed: [] },
        },
      };
    }
  });
