import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.NODE_ENV = 'test';
const supervisorDatabaseDir = process.env.DATABASE_URL
  ? undefined
  : mkdtempSync(join(tmpdir(), 'kory-process-supervisor-db-'));
process.env.DATABASE_URL ??= `sqlite://${join(supervisorDatabaseDir!, 'supervisor.sqlite')}`;

const { processSupervisor } = await import('../supervisor');
const { getProcessById } = await import('../database');
const { BashTool } = await import('../../tools/bash');
const { ShellManageTool } = await import('../../tools/shell-manage');

afterAll(() => {
  if (supervisorDatabaseDir) {
    rmSync(supervisorDatabaseDir, { recursive: true, force: true });
  }
});

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

  test('Bash background work and shell_manage use the authoritative agent registry', async () => {
    await processSupervisor.initialize();
    const sessionId = `bash-lifecycle-${Date.now()}`;
    const context = {
      sessionId,
      workingDirectory: tmpdir(),
      isSandboxed: false,
    };
    const started = await new BashTool().run(context, {
      id: 'background-tool-call',
      name: 'bash',
      input: {
        command: `printf 'bash-to-monitor'; sleep 5`,
        isBackground: true,
        processName: 'bash-monitor-contract',
      },
    });
    expect(started.isError).toBe(false);
    const processId = /ID:\s*(\S+)/.exec(started.output)?.[1];
    expect(processId).toBeTruthy();

    const persisted = await getProcessById(processId!);
    expect(persisted?.provenance).toBe('agent-tool');
    expect(persisted?.supervision).toBe('owned-child');
    expect(persisted?.isBackground).toBe(true);
    expect(processSupervisor.hasActiveAgentToolForSession(sessionId)).toBe(true);

    const shellManage = new ShellManageTool();
    const listed = await shellManage.run(context, {
      id: 'list-background',
      name: 'shell_manage',
      input: { action: 'list' },
    });
    expect(listed.output).toContain(processId!);
    expect(listed.output).toContain('bash-monitor-contract');

    const logsDeadline = Date.now() + 1_000;
    let logs = await shellManage.run(context, {
      id: 'logs-background',
      name: 'shell_manage',
      input: { action: 'logs', processId },
    });
    while (!logs.output.includes('bash-to-monitor') && Date.now() < logsDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      logs = await shellManage.run(context, {
        id: 'logs-background',
        name: 'shell_manage',
        input: { action: 'logs', processId },
      });
    }
    expect(logs.output).toContain('bash-to-monitor');

    const killed = await shellManage.run(context, {
      id: 'kill-background',
      name: 'shell_manage',
      input: { action: 'kill', processId },
    });
    expect(killed.isError).toBe(false);
    expect(processSupervisor.hasActiveAgentToolForSession(sessionId)).toBe(false);
    expect((await getProcessById(processId!))?.terminalReason).toBe('killed-by-user');
  });
});
