import type { Tool, ToolCallInput, ToolCallOutput, ToolContext } from './registry';
import {
  cancelMonitor,
  createMonitor,
  listMonitors,
  type SessionMonitor,
} from '../kory/services/monitor-service';
import type { MonitorSchedule } from '../kory/services/monitor-schedule';
import { parseLocalDateTime, parseClockTime } from '../kory/services/monitor-schedule';

function formatCadence(intervalMs: number): string {
  const minutes = intervalMs / 60_000;
  return Number.isInteger(minutes) ? `${minutes} min` : `${(intervalMs / 1_000).toFixed(1)} s`;
}

function describeSchedule(schedule: MonitorSchedule): string {
  switch (schedule.kind) {
    case 'interval':
      return `every ${formatCadence(schedule.intervalMs)}`;
    case 'daily':
      return schedule.weekdays?.length
        ? `at ${schedule.time} on weekdays ${schedule.weekdays.join(',')} (local time)`
        : `daily at ${schedule.time} (local time)`;
    case 'cron':
      return `cron "${schedule.expression}" (local time)`;
    case 'once':
      return `once at ${new Date(schedule.at).toISOString()}`;
  }
}

function formatMonitor(monitor: SessionMonitor): string {
  const next = new Date(monitor.nextRunAt).toISOString();
  const target = monitor.target === 'new_chat' ? 'new chat each run' : 'this chat';
  return `${monitor.id} — ${describeSchedule(monitor.schedule)} — ${target} — next ${next} — runs ${monitor.runCount} — ${monitor.prompt}`;
}

/** Build a schedule from the tool's input. Throws a readable error for a bad field. */
export function scheduleFromToolInput(input: Record<string, unknown>): MonitorSchedule {
  const kind = typeof input.kind === 'string' ? input.kind : 'interval';
  if (kind === 'interval') {
    const intervalMinutes = typeof input.intervalMinutes === 'number' ? input.intervalMinutes : 5;
    if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
      throw new Error('intervalMinutes must be greater than zero.');
    }
    return { kind: 'interval', intervalMs: intervalMinutes * 60_000 };
  }
  if (kind === 'daily' || kind === 'weekdays') {
    const time = typeof input.time === 'string' ? input.time.trim() : '';
    if (!parseClockTime(time)) throw new Error('time must be HH:MM on a 24-hour clock.');
    const weekdays =
      kind === 'weekdays'
        ? [1, 2, 3, 4, 5]
        : Array.isArray(input.weekdays)
          ? input.weekdays.filter((day): day is number => typeof day === 'number')
          : undefined;
    return { kind: 'daily', time, ...(weekdays?.length ? { weekdays } : {}) };
  }
  if (kind === 'cron') {
    const expression = typeof input.cron === 'string' ? input.cron.trim() : '';
    if (!expression) throw new Error('cron is required for a cron schedule (five fields).');
    return { kind: 'cron', expression };
  }
  if (kind === 'once') {
    const at = typeof input.at === 'string' ? parseLocalDateTime(input.at) : null;
    if (at === null) throw new Error('at must be "YYYY-MM-DD HH:MM" (local) or an ISO timestamp.');
    return { kind: 'once', at };
  }
  throw new Error('kind must be interval, daily, weekdays, cron, or once.');
}

/**
 * Manager control plane for host-scheduled wake-ups. A monitor is not a fake
 * user message: the host submits a real session turn at the requested cadence,
 * and a busy chat queues the wake-up until admission succeeds.
 */
export class ScheduleMonitorTool implements Tool {
  readonly name = 'schedule_monitor';
  readonly role = 'manager' as const;
  readonly description =
    'Create, list, or cancel a durable monitor. A monitor wakes a chat with a fresh turn on a schedule. ' +
    'Schedules: interval (every N minutes, default 5), daily (kind "daily" with time "HH:MM"), weekdays (kind "weekdays" with time), ' +
    'cron (kind "cron" with a five-field expression in local time), or once (kind "once" with a local at "YYYY-MM-DD HH:MM"). ' +
    'Clock times are the user\'s local time. target "same_chat" (default) wakes this chat; "new_chat" opens a new chat for each run. ' +
    'A run that was missed while the host was off fires once on wake and is not backfilled. The host queues a wake-up while a chat is busy and re-arms monitors after a restart. ' +
    'Actions: create, list, cancel (monitorId).';

  readonly inputSchema = {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'list', 'cancel'] },
      kind: {
        type: 'string',
        enum: ['interval', 'daily', 'weekdays', 'cron', 'once'],
        description: 'For create: the schedule kind. Defaults to interval.',
      },
      time: {
        type: 'string',
        description: 'For kind daily or weekdays: local time of day, HH:MM (24-hour).',
      },
      weekdays: {
        type: 'array',
        items: { type: 'integer', minimum: 0, maximum: 6 },
        description: 'For kind daily: days to run, 0 (Sunday) to 6 (Saturday). Omit for every day.',
      },
      cron: {
        type: 'string',
        description: 'For kind cron: five fields, minute hour day-of-month month day-of-week, local time.',
      },
      at: {
        type: 'string',
        description: 'For kind once: local "YYYY-MM-DD HH:MM" or an ISO timestamp, in the future.',
      },
      target: {
        type: 'string',
        enum: ['same_chat', 'new_chat'],
        description: 'Where each run goes. Defaults to same_chat.',
      },
      prompt: {
        type: 'string',
        maxLength: 8_000,
        description:
          'For create: what to check or do on each wake-up. Written as an instruction to your future self.',
      },
      intervalMinutes: {
        type: 'number',
        exclusiveMinimum: 0,
        description: 'For create: cadence in minutes. Defaults to 5.',
      },
      monitorId: {
        type: 'string',
        description: 'For cancel: the monitor id returned by create or list.',
      },
    },
    required: ['action'],
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const action = typeof call.input.action === 'string' ? call.input.action : '';
    try {
      if (action === 'list') {
        const monitors = listMonitors(ctx.sessionId);
        return this.ok(
          call,
          monitors.length
            ? `Active monitors:\n${monitors.map(formatMonitor).join('\n')}`
            : 'No active monitors in this chat.',
        );
      }

      if (action === 'cancel') {
        const monitorId =
          typeof call.input.monitorId === 'string' ? call.input.monitorId.trim() : '';
        if (!monitorId) return this.fail(call, 'monitorId is required to cancel a monitor.');
        const monitor = await cancelMonitor(monitorId, ctx.sessionId);
        if (!monitor) return this.fail(call, `No monitor ${monitorId} belongs to this chat.`);
        return this.ok(call, `Cancelled monitor ${monitor.id}.`);
      }

      if (action === 'create') {
        const prompt = typeof call.input.prompt === 'string' ? call.input.prompt.trim() : '';
        if (!prompt) return this.fail(call, 'prompt is required to create a monitor.');
        const schedule = scheduleFromToolInput(call.input);
        const target = call.input.target === 'new_chat' ? 'new_chat' : 'same_chat';
        const monitor = await createMonitor({
          sessionId: ctx.sessionId,
          workingDirectory: ctx.workingDirectory,
          prompt,
          schedule,
          target,
        });
        return this.ok(
          call,
          `Created monitor ${monitor.id}: ${describeSchedule(monitor.schedule)}, ` +
            `${target === 'new_chat' ? 'a new chat per run' : 'this chat'}. ` +
            `The host will wake it with a fresh turn; if a chat is busy, the wake-up stays queued.`,
        );
      }

      return this.fail(call, 'action must be one of create, list, or cancel.');
    } catch (error: unknown) {
      return this.fail(call, error instanceof Error ? error.message : String(error));
    }
  }

  private ok(call: ToolCallInput, output: string): ToolCallOutput {
    return { callId: call.id, name: this.name, output, isError: false, durationMs: 0 };
  }

  private fail(call: ToolCallInput, message: string): ToolCallOutput {
    return {
      callId: call.id,
      name: this.name,
      output: `Error: ${message}`,
      isError: true,
      durationMs: 0,
    };
  }
}
