import { Elysia, t } from 'elysia';
import { getContext } from '../../context';
import { processSupervisor } from '../../process-supervisor/supervisor';
import { serializeProcess } from '../../process-supervisor/serialize';
import { serverLog } from '../../logger';

export const sessionRoutes = new Elysia({ prefix: '/api/sessions' })
  .get('/', async () => {
    const { sessions } = getContext();
    const list = await sessions.list();
    return { ok: true, data: list };
  })
  .post(
    '/',
    async ({ body }) => {
      const { sessions } = getContext();
      const session = await sessions.create(
        'local-user',
        body.title,
        body.parentId,
        body.workingDirectory,
      );
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
  .get('/:id', async ({ params: { id }, set }) => {
    const { sessions } = getContext();
    const session = await sessions.get(id);
    if (!session) {
      set.status = 404;
      return { ok: false, error: 'Session not found' };
    }
    return { ok: true, data: session };
  })
  .patch(
    '/:id',
    async ({ params: { id }, body, set }) => {
      const { sessions } = getContext();
      const updated = await sessions.update(id, body);
      if (!updated) {
        set.status = 404;
        return { ok: false, error: 'Session not found' };
      }
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
  .delete('/:id', async ({ params: { id } }) => {
    const { sessions, kory, wsManager } = getContext();
    // Cancel any running workers, abort the manager thread, and clear
    // in-memory session state BEFORE removing the DB row so pending
    // operations can't fire a `session.updated` event that re-adds the
    // deleted session on the frontend.
    try {
      kory.cleanupSession(id);
    } catch (err) {
      serverLog.warn({ err, sessionId: id }, 'Failed to clean up session resources during delete');
    }
    // Cancel any queued LLM jobs for this session.
    try {
      const { cancelLLMJobsForSession } = await import('../../queue/workers/llm-worker');
      await cancelLLMJobsForSession(id);
    } catch (err) {
      serverLog.warn({ err, sessionId: id }, 'Failed to cancel LLM jobs during delete');
    }
    // Purge replay events so a future fork/replay can't resurrect the chat.
    try {
      const { getReplayBuffer } = await import('../../replay/buffer');
      await getReplayBuffer().deleteSession(id);
    } catch (err) {
      serverLog.warn({ err, sessionId: id }, 'Failed to purge replay events during delete');
    }
    await sessions.delete(id);
    // Broadcast deletion to ALL clients so every open tab/window removes
    // the session from its local state — not just the one that triggered
    // the delete. Without this, a WebSocket reconnect or a pending
    // `session.updated` event can silently re-add the deleted session.
    wsManager.broadcast({
      type: 'session.deleted',
      payload: { sessionId: id },
      timestamp: Date.now(),
      sessionId: id,
    });
    return { ok: true };
  })
  .get('/:id/processes', async ({ params: { id } }) => {
    const processes = await processSupervisor.getProcessesBySession(id);
    return {
      ok: true,
      processes: await Promise.all(processes.map((process) => serializeProcess(process))),
    };
  })
  .post('/:id/cancel', async ({ params: { id } }) => {
    const { kory, goalDriver, wsManager } = getContext();
    // A human stop is an explicit Goal Mode pause. The durable loop must not
    // silently launch another turn after the session abort completes.
    await goalDriver.pauseForSession(id);
    // Cancel all workers for this session
    kory.cancelSessionWorkers(id);
    // Abort manager thread for this session
    kory.abortManagerRun(id);
    // Cancel any LLM jobs for this session
    const { cancelLLMJobsForSession } = await import('../../queue/workers/llm-worker');
    await cancelLLMJobsForSession(id);
    // Notify all clients about the cancellation
    wsManager.broadcastToSession(id, {
      type: 'system.info',
      payload: { message: 'Stopped by user.', kind: 'cancelled' },
      timestamp: Date.now(),
      sessionId: id,
    });
    return { ok: true, message: 'Session cancelled' };
  })
  .get('/:id/runtime-status', async ({ params: { id } }) => {
    const { kory } = getContext();
    return { ok: true, running: kory.isSessionRunning(id) || processSupervisor.hasRunningForSession(id) };
  })
  .post('/:id/compact', async ({ params: { id }, body, set }) => {
    const { kory, sessions } = getContext();
    if (!(await sessions.get(id))) {
      set.status = 404;
      return { ok: false, error: 'Session not found' };
    }
    try {
      const compactBody = body as { model?: string; reasoningLevel?: string } | undefined;
      await kory.compactSession(id, compactBody?.model, compactBody?.reasoningLevel);
      return { ok: true };
    } catch (error) {
      set.status = 409;
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  })
  .get('/:id/context', async ({ params: { id } }) => {
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
  .post('/:id/context/model-preview', async ({ params: { id }, body }) => {
    // Model switched in the composer: re-baseline the context bar from the
    // backend's trusted window data (never a frontend guess).
    const { kory } = getContext();
    const b = body as { model?: string; provider?: string } | undefined;
    if (!b?.model || !b?.provider) return { ok: false, error: 'model and provider required' };
    const usage = await kory.previewModelContext(id, b.model, b.provider as never);
    return { ok: true, usage };
  })
  .post('/:id/context/:archiveId/visibility', async ({ params: { id, archiveId }, body }) => {
    // User-driven "hide from agent": stubs this entry out of the model's
    // context on the next turn. Content stays archived and recoverable.
    const { getContextArchive } = await import('../../kory/context-archive');
    const archive = getContextArchive();
    if (!archive) return { ok: false, error: 'Context archive unavailable' };
    const hidden = (body as { hiddenFromAgent?: boolean } | undefined)?.hiddenFromAgent === true;
    const changed = await archive.setPrunedForAgent(id, archiveId, hidden);
    return changed ? { ok: true } : { ok: false, error: 'Unknown archive entry' };
  })
  .post(
    '/:id/rewind',
    async ({ params: { id }, body }) => {
      const { timeTravel } = getContext();
      const result = await timeTravel.travelTo(body.hash, id);
      return { ok: result.success, message: result.message };
    },
    {
      body: t.Object({
        hash: t.String(),
      }),
    },
  )
  .post('/:id/undo', async ({ params: { id } }) => {
    const { timeTravel } = getContext();
    const result = await timeTravel.undo(id);
    return { ok: result.success, message: result.message };
  })
  .post('/:id/redo', async ({ params: { id } }) => {
    const { timeTravel } = getContext();
    const result = await timeTravel.redo(id);
    return { ok: result.success, message: result.message };
  })
  .get('/:id/timetravel', async ({ params: { id } }) => {
    try {
      const { timeTravel } = getContext();
      const state = await timeTravel.getState(id);
      return { ok: true, data: state };
    } catch (err) {
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
