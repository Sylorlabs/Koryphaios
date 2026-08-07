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
import { AuthenticationError, ConflictError, NotFoundError, ValidationError } from '../../errors/types';

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
    async ({ request, query }) => {
      if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
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
    async ({ request, body }) => {
      if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
      const validation = validateBashCommand(body.command);
      if (!validation.safe) {
        throw new ValidationError(`Unsafe command: ${validation.reason}`);
      }
      const process = await processSupervisor.startProcess(body);
      return {
        ok: true,
        process: await serializeProcess(process),
      };
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
    async ({ request, body }) => {
      if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
      const deleted = await cleanupOldProcesses(body.daysToKeep);
      return { ok: true, deleted };
    },
    {
      body: t.Object({
        daysToKeep: t.Optional(t.Number()),
      }),
    },
  )
  .get('/:id', async ({ request, params: { id } }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
    const process = await getProcessById(id);
    if (!process) {
      throw new NotFoundError('Process', id);
    }
    return { ok: true, process: await serializeProcess(process) };
  })
  .delete('/:id', async ({ request, params: { id }, query }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
    const signal = query.signal ?? 'SIGTERM';
    const allowedSignals = ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGQUIT'];
    if (!allowedSignals.includes(signal)) {
      throw new ValidationError('Invalid signal');
    }
    const success = await processSupervisor.killProcess(id, signal);
    if (!success) {
      throw new NotFoundError('Process', id);
    }
    return { ok: true };
  })
  .post('/:id/restart', async ({ request, params: { id } }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
    const restarted = await processSupervisor.restartProcess(id);
    if (!restarted) {
      throw new NotFoundError('Process', id);
    }
    return { ok: true, process: await serializeProcess(restarted) };
  })
  .post(
    '/:id/input',
    async ({ request, params: { id }, body }) => {
      if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
      const success = await processSupervisor.writeInput(id, body.input);
      if (!success) {
        throw new ConflictError('Process is not running or does not accept input');
      }
      return { ok: true };
    },
    { body: t.Object({ input: t.String({ maxLength: 16_384 }) }) },
  )
  .get(
    '/:id/logs',
    async ({ request, params: { id }, query }) => {
      if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
      const process = await getProcessById(id);
      if (!process) {
        throw new NotFoundError('Process', id);
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
    async ({ request, params: { id }, query }) => {
      if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
      const process = await getProcessById(id);
      if (!process) {
        throw new NotFoundError('Process', id);
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
