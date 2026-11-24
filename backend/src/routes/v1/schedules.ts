import { Elysia, t } from 'elysia';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';
import { AuthenticationError, NotFoundError } from '../../errors/types';
import {
  cancelMonitor,
  listAllMonitors,
  type SessionMonitor,
} from '../../kory/services/monitor-service';

/** The UI's view of a monitor: its schedule, target, and next run. */
function serializeSchedule(monitor: SessionMonitor) {
  return {
    id: monitor.id,
    sessionId: monitor.sessionId,
    target: monitor.target,
    schedule: monitor.schedule,
    prompt: monitor.prompt,
    status: monitor.status,
    nextRunAt: monitor.nextRunAt,
    lastRunAt: monitor.lastRunAt ?? null,
    lastChatId: monitor.lastChatId ?? null,
    runCount: monitor.runCount,
    createdAt: monitor.createdAt,
  };
}

export const scheduleRoutes = new Elysia({ prefix: '/api/schedules' })
  .get(
    '/',
    ({ request, query }) => {
      if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
      const includeInactive = query.includeInactive === '1' || query.includeInactive === 'true';
      const sessionId = query.sessionId?.trim();
      const monitors = listAllMonitors(includeInactive).filter(
        (monitor) => !sessionId || monitor.sessionId === sessionId,
      );
      return { ok: true, data: monitors.map(serializeSchedule) };
    },
    {
      query: t.Object({
        sessionId: t.Optional(t.String({ maxLength: 256 })),
        includeInactive: t.Optional(t.String({ maxLength: 8 })),
      }),
    },
  )
  .delete('/:id', async ({ request, params: { id } }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
    const monitor = await cancelMonitor(id);
    if (!monitor) throw new NotFoundError('Schedule', id);
    return { ok: true, data: serializeSchedule(monitor) };
  });
