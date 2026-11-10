import { describe, expect, it } from 'bun:test';
import { ToolApprovalQueue } from './approval-queue';
import type { ToolContext } from './registry';

const ctx: ToolContext = {
  sessionId: 'session-1',
  agentId: 'worker-1',
  agentName: 'Backend Worker',
  callerRole: 'worker',
  callerDomain: 'backend',
  workingDirectory: '/tmp/project',
};

describe('ToolApprovalQueue', () => {
  it('keeps concurrent requests independent and resolves only the selected request', async () => {
    const events: Array<{ type: string; payload: any }> = [];
    const queue = new ToolApprovalQueue((message) => events.push(message as any));
    const first = queue.request(
      ctx,
      { id: 'call-1', name: 'bash', input: { command: 'bun test' } },
      'Backend Worker is requesting permission to run this terminal command:\n\nbun test',
      ['Allow once', 'Reject'],
    );
    const second = queue.request(
      ctx,
      { id: 'call-2', name: 'write_file', input: { path: 'src/app.ts' } },
      'Backend Worker is requesting permission to write file',
      ['Allow once', 'Reject'],
    );

    expect(queue.list('session-1')).toHaveLength(2);
    expect(queue.respond('session-1', events[1].payload.id, 'Allow once')).toBe(true);
    await expect(second).resolves.toBe('Allow once');
    expect(queue.list('session-1')).toHaveLength(1);
    expect(queue.respond('session-1', events[0].payload.id, 'Reject')).toBe(true);
    await expect(first).resolves.toBe('Reject');
  });
});
