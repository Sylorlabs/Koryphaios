import { describe, expect, test } from 'bun:test';
import { ManageContextTool, PruneContextTool } from './context';
import type { ToolContext } from './registry';

describe('agent-owned context pruning', () => {
  test('lets a worker or critic prune its own context without session archive ids', async () => {
    let keepRecent: number | undefined;
    const tool = new PruneContextTool();
    const result = await tool.run(
      {
        sessionId: 'agent-context',
        workingDirectory: '.',
        callerRole: 'worker',
        pruneOwnContext: async (keep) => {
          keepRecent = keep;
          return 'Pruned 3 older tool outputs.';
        },
      } as ToolContext,
      {
        id: 'prune-1',
        name: 'prune_context',
        input: { keepRecent: 8 },
      },
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain('Pruned 3');
    expect(keepRecent).toBe(8);
  });

  test('is available to worker and critic roles', () => {
    expect(new PruneContextTool().role).toBe('any');
  });
});

describe('agent-owned context management', () => {
  test('is available to every role so a worker can shape its own context', () => {
    expect(new ManageContextTool().role).toBe('any');
  });

  test('routes the request to the host handler', async () => {
    let seen: Record<string, unknown> | undefined;
    const result = await new ManageContextTool().run(
      {
        sessionId: 'agent-context',
        workingDirectory: '.',
        callerRole: 'worker',
        manageContext: async (input) => {
          seen = input;
          return 'Hidden from your context: cx_3.';
        },
      } as ToolContext,
      { id: 'ctx-1', name: 'manage_context', input: { action: 'hide', ids: ['cx_3'] } },
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain('cx_3');
    expect(seen).toMatchObject({ action: 'hide' });
  });

  test('explains the fallback when no handler is installed', async () => {
    const result = await new ManageContextTool().run(
      { sessionId: 'agent-context', workingDirectory: '.', callerRole: 'worker' } as ToolContext,
      { id: 'ctx-2', name: 'manage_context', input: { action: 'report' } },
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('prune_context');
  });
});
