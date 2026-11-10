import { describe, expect, test } from 'bun:test';
import { PruneContextTool } from './context';
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
