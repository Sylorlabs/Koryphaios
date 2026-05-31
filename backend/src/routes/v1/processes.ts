import { Elysia, t } from 'elysia';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';
import { validateBashCommand } from '../../security';
import { processSupervisor } from '../../process-supervisor/supervisor';
import {
  cleanupOldProcesses,
  getProcessById,
  getProcessEventsById,
  listProcesses,
} from '../../process-supervisor/database';
import { serializeProcess } from '../../process-supervisor/serialize';

function buildLogs(processId: string, lines: number) {
  const live = processSupervisor.getProcess(processId);
  const stdout = live?.stdout ?? '';
  const stderr = live?.stderr ?? '';

  const tail = (text: string) => {
    const split = text.split('\n');
    return split.slice(-lines).join('\n');
  };

  return {
    stdout: tail(stdout),
    stderr: tail(stderr),
    stdoutLineCount: stdout ? stdout.split('\n').filter(Boolean).length : 0,
    stderrLineCount: stderr ? stderr.split('\n').filter(Boolean).length : 0,
  };
}

export const processRoutes = new Elysia({ prefix: '/api/processes' })
  .get(
    '/',
    async ({ request, query, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const includeInactive = query.includeInactive !== 'false';
      const limit = Number(query.limit ?? 100);
      const processes = await listProcesses(includeInactive, Number.isFinite(limit) ? limit : 100);

      return {
        ok: true,
        processes: await Promise.all(processes.map((process) => serializeProcess(process))),
      };
    },
    {
      query: t.Object({
        includeInactive: t.Optional(t.String()),
        limit: t.Optional(t.String()),
      }),
    },
  )
  .post(
    '/',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const validation = validateBashCommand(body.command);
      if (!validation.safe) {
        if (set) set.status = 400;
        return { ok: false, error: `Unsafe command: ${validation.reason}` };
      }
      try {
        const process = await processSupervisor.startProcess(body);
        return {
          ok: true,
          process: await serializeProcess(process),
        };
      } catch (error: any) {
        set.status = 500;
        return { ok: false, error: error?.message ?? 'Failed to start process' };
      }
    },
    {
      body: t.Object({
        name: t.String(),
        command: t.String(),
        cwd: t.Optional(t.String()),
        sessionId: t.String(),
        restartPolicy: t.Optional(t.Enum({ never: 'never', 'on-failure': 'on-failure', always: 'always' })),
        maxRestarts: t.Optional(t.Number()),
      }),
    },
  )
  .post(
    '/cleanup',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const deleted = await cleanupOldProcesses(body.daysToKeep);
      return { ok: true, deleted };
    },
    {
      body: t.Object({
        daysToKeep: t.Optional(t.Number()),
      }),
    },
  )
  .get('/:id', async ({ request, params: { id }, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const process = await getProcessById(id);
    if (!process) {
      set.status = 404;
      return { ok: false, error: 'Process not found' };
    }
    return { ok: true, process: await serializeProcess(process) };
  })
  .delete('/:id', async ({ request, params: { id }, query, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const signal = query.signal ?? 'SIGTERM';
    const allowedSignals = ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGQUIT'];
    if (!allowedSignals.includes(signal)) {
      if (set) set.status = 400;
      return { ok: false, error: 'Invalid signal' };
    }
    const success = await processSupervisor.killProcess(id, signal);
    if (!success) {
      set.status = 404;
      return { ok: false, error: 'Process not found' };
    }
    return { ok: true };
  })
  .post('/:id/restart', async ({ request, params: { id }, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    try {
      const restarted = await processSupervisor.restartProcess(id);
      if (!restarted) {
        set.status = 404;
        return { ok: false, error: 'Process not found' };
      }
      return { ok: true, process: await serializeProcess(restarted) };
    } catch (error: any) {
      set.status = 500;
      return { ok: false, error: error?.message ?? 'Failed to restart process' };
    }
  })
  .get(
    '/:id/logs',
    async ({ request, params: { id }, query, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const process = await getProcessById(id);
      if (!process) {
        set.status = 404;
        return { ok: false, error: 'Process not found' };
      }
      const lines = Number(query.lines ?? 100);
      return { ok: true, logs: buildLogs(id, Number.isFinite(lines) ? lines : 100) };
    },
    {
      query: t.Object({
        lines: t.Optional(t.String()),
      }),
    },
  )
  .get(
    '/:id/events',
    async ({ request, params: { id }, query, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const process = await getProcessById(id);
      if (!process) {
        set.status = 404;
        return { ok: false, error: 'Process not found' };
      }
      const limit = Number(query.limit ?? 50);
      const events = await getProcessEventsById(id, Number.isFinite(limit) ? limit : 50);
      return {
        ok: true,
        events: events.map((event) => ({
          id: event.id,
          eventType: event.eventType,
          eventData: event.eventData ? JSON.parse(event.eventData) : undefined,
          timestamp: event.timestamp,
        })),
      };
    },
    {
      query: t.Object({
        limit: t.Optional(t.String()),
      }),
    },
  );
