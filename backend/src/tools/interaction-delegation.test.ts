import { describe, expect, test } from 'bun:test';
import { DelegateToWorkerTool, RequestCriticReviewTool, WaitForAgentsTool } from './interaction';
import type { ToolContext } from './registry';

function call(name: string, input: Record<string, unknown>) {
  return { id: `${name}-call`, name, input };
}

describe('delegate_to_worker wait and compare', () => {
  test('wait:false and a compare group are passed to the host as options', async () => {
    let options: unknown;
    const ctx = {
      delegateToWorker: async (...args: unknown[]) => {
        options = args[7];
        return 'Started background worker child-1';
      },
    } as unknown as ToolContext;
    const result = await new DelegateToWorkerTool().run(
      ctx,
      call('delegate_to_worker', {
        task: 'Fix it',
        model: 'anthropic:claude-x',
        worktree: true,
        wait: false,
        compare: { groupId: 'auth-models' },
      }),
    );
    expect(result.isError).toBe(false);
    expect(options).toEqual({ wait: false, compareGroupId: 'auth-models' });
  });

  test('wait defaults to true when omitted', async () => {
    let options: unknown;
    const ctx = {
      delegateToWorker: async (...args: unknown[]) => {
        options = args[7];
        return 'done';
      },
    } as unknown as ToolContext;
    await new DelegateToWorkerTool().run(ctx, call('delegate_to_worker', { task: 'Read it' }));
    expect(options).toEqual({ wait: true });
  });

  test('a compare attempt without worktree:true is refused before any worker starts', async () => {
    let started = false;
    const ctx = {
      delegateToWorker: async () => {
        started = true;
        return 'done';
      },
    } as unknown as ToolContext;
    const result = await new DelegateToWorkerTool().run(
      ctx,
      call('delegate_to_worker', { task: 'Edit', worktree: false, compare: { groupId: 'g' } }),
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('worktree:true');
    expect(started).toBe(false);
  });

  test('an invalid compare group id is refused', async () => {
    const ctx = { delegateToWorker: async () => 'done' } as unknown as ToolContext;
    const result = await new DelegateToWorkerTool().run(
      ctx,
      call('delegate_to_worker', { task: 'Edit', worktree: true, compare: { groupId: 'bad id!' } }),
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('compare.groupId');
  });

  test('a compare attempt that failed is reported as an error, even when grouped', async () => {
    const ctx = {
      delegateToWorker: async () =>
        '[compare g · attempt 1 · openai:x]\nWORKER_FAILED (domain=general): boom',
    } as unknown as ToolContext;
    const result = await new DelegateToWorkerTool().run(
      ctx,
      call('delegate_to_worker', { task: 'Edit', worktree: true, compare: { groupId: 'g' } }),
    );
    expect(result.isError).toBe(true);
  });

  test('a worker below the depth limit gets a depth message, not a role message', async () => {
    const result = await new DelegateToWorkerTool().run(
      { callerRole: 'worker' } as unknown as ToolContext,
      call('delegate_to_worker', { task: 'Nested' }),
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('maximum delegation depth');
  });

  test('the schema advertises wait, compare and model', () => {
    const schema = new DelegateToWorkerTool().inputSchema as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(['model', 'wait', 'compare', 'worktree']),
    );
    expect(new DelegateToWorkerTool().description).toContain('wait:false');
  });
});

describe('wait_for_agents', () => {
  test('forwards agentIds and timeoutSec to the host', async () => {
    let received: unknown;
    const ctx = {
      waitForAgents: async (input: unknown) => {
        received = input;
        return 'Finished (1):';
      },
    } as unknown as ToolContext;
    const result = await new WaitForAgentsTool().run(
      ctx,
      call('wait_for_agents', { agentIds: ['child-a', 7, ' child-b '], timeoutSec: 9999 }),
    );
    expect(result.isError).toBe(false);
    expect(received).toEqual({ agentIds: ['child-a', 'child-b'], timeoutSec: 1800 });
  });

  test('omitting agentIds waits for every outstanding worker', async () => {
    let received: unknown;
    const ctx = {
      waitForAgents: async (input: unknown) => {
        received = input;
        return 'ok';
      },
    } as unknown as ToolContext;
    await new WaitForAgentsTool().run(ctx, call('wait_for_agents', {}));
    expect(received).toEqual({});
  });

  test('is an error when the host did not bind it', async () => {
    const result = await new WaitForAgentsTool().run(
      {} as ToolContext,
      call('wait_for_agents', {}),
    );
    expect(result.isError).toBe(true);
  });

  test('is registered for the manager only', () => {
    expect(new WaitForAgentsTool().role).toBe('manager');
    expect(new WaitForAgentsTool().name).toBe('wait_for_agents');
  });
});

describe('request_critic_review compare group', () => {
  test('passes a valid compareGroupId to the host', async () => {
    let seen: unknown[] = [];
    const ctx = {
      requestCriticReview: (...args: unknown[]) => {
        seen = args;
      },
    } as unknown as ToolContext;
    const result = await new RequestCriticReviewTool().run(
      ctx,
      call('request_critic_review', { reason: 'Rank these', compareGroupId: 'auth-models' }),
    );
    expect(result.isError).toBe(false);
    expect(seen).toEqual(['Rank these', 'auth-models']);
  });

  test('rejects a malformed compareGroupId', async () => {
    const ctx = { requestCriticReview: () => undefined } as unknown as ToolContext;
    const result = await new RequestCriticReviewTool().run(
      ctx,
      call('request_critic_review', { reason: 'Rank', compareGroupId: 'no spaces allowed' }),
    );
    expect(result.isError).toBe(true);
  });
});
