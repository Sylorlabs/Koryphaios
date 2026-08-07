import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? `sqlite://${join(tmpdir(), 'koryphaios-process-supervisor.sqlite')}`;

const { processSupervisor } = await import('../supervisor');
const { getProcessById } = await import('../database');

describe('process supervisor', () => {
  test('killed processes remain marked as killed', async () => {
    await processSupervisor.initialize();

    const processRecord = await processSupervisor.startProcess({
      name: 'kill-status-test',
      command: 'sleep 10',
      sessionId: 'session-kill-status',
    });

    const killed = await processSupervisor.killProcess(processRecord.id, 'SIGTERM');
    expect(killed).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 250));

    const persisted = await getProcessById(processRecord.id);
    expect(persisted?.status).toBe('killed');
    expect(persisted?.signal).toBe('SIGTERM');
  });
});
