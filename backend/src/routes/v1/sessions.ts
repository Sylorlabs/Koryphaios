import { Elysia, t } from 'elysia';
import { getContext } from '../../context';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';
import { processSupervisor } from '../../process-supervisor/supervisor';
import { serializeProcess } from '../../process-supervisor/serialize';

export const sessionRoutes = new Elysia({ prefix: '/api/sessions' })
  .get('/', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const { sessions } = getContext();
    const list = await sessions.list();
    return { ok: true, data: list };
  })
  .post(
    '/',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const { sessions } = getContext();
      const session = await sessions.create('local-user', body.title, body.parentId);
      return { ok: true, data: session };
    },
    {
      body: t.Object({
        userId: t.Optional(t.String()),
        title: t.Optional(t.String()),
        parentId: t.Optional(t.String()),
      }),
    },
  )
  .get('/:id', async ({ request, params: { id }, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
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
    async ({ request, params: { id }, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
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
        }),
      ),
    },
  )
  .delete('/:id', async ({ request, params: { id }, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const { sessions } = getContext();
    await sessions.delete(id);
    return { ok: true };
  })
  .get('/:id/processes', async ({ request, params: { id }, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const processes = await processSupervisor.getProcessesBySession(id);
    return {
      ok: true,
      processes: await Promise.all(processes.map((process) => serializeProcess(process))),
    };
  })
  .post('/:id/cancel', async ({ request, params: { id }, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const { kory, wsManager } = getContext();
    // Cancel all workers for this session
    kory.cancelSessionWorkers(id);
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
    '/:id/rewind',
    async ({ request, params: { id }, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
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
  .get('/:id/timetravel', async ({ request, params: { id }, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const { timeTravel } = getContext();
    const state = await timeTravel.getState(id);
    return { ok: true, data: state };
  });
