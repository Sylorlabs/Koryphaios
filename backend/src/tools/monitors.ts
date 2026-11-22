import type { Tool, ToolCallInput, ToolCallOutput, ToolContext } from './registry';
import {
  cancelMonitor,
  createMonitor,
  listMonitors,
  type SessionMonitor,
} from '../kory/services/monitor-service';

function formatCadence(intervalMs: number): string {
  const minutes = intervalMs / 60_000;
  return Number.isInteger(minutes) ? `${minutes} min` : `${(intervalMs / 1_000).toFixed(1)} s`;
}

function formatMonitor(monitor: SessionMonitor): string {
  const next = new Date(monitor.nextRunAt).toISOString();
  return `${monitor.id} — every ${formatCadence(monitor.intervalMs)} — next ${next} — runs ${monitor.runCount} — ${monitor.prompt}`;
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
    'Create, list, or cancel a durable recurring monitor in this chat. A monitor wakes this session with a fresh turn on the chosen cadence (default every 5 minutes). ' +
    'Use it when the user asks you to check something later or on an interval. The host queues the wake-up while the chat is busy and re-arms monitors after a restart. ' +
    'Actions: create (prompt + optional intervalMinutes), list, cancel (monitorId).';

  readonly inputSchema = {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'list', 'cancel'] },
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
        const intervalMinutes =
          typeof call.input.intervalMinutes === 'number' ? call.input.intervalMinutes : 5;
        if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
          return this.fail(call, 'intervalMinutes must be greater than zero.');
        }
        const monitor = await createMonitor({
          sessionId: ctx.sessionId,
          workingDirectory: ctx.workingDirectory,
          prompt,
          intervalMs: intervalMinutes * 60_000,
        });
        return this.ok(
          call,
          `Created monitor ${monitor.id}: every ${formatCadence(monitor.intervalMs)}. ` +
            `The host will wake this chat with a fresh turn; if it is busy, the wake-up stays queued.`,
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
