import type { Tool, ToolContext, ToolCallInput, ToolCallOutput } from './registry';

/**
 * Delegate substantial repo work to Google Jules — a CLOUD async agent (API only).
 * Runs in remote VMs; may take minutes and produces GitHub PRs. Not for local quick edits.
 */
export class DelegateToJulesTool implements Tool {
  readonly name = 'delegate_to_jules';
  readonly role = 'manager' as const;
  readonly description =
    'Delegate a substantial coding task to Google Jules — a CLOUD-ONLY async agent (API). Jules runs in remote Google VMs, not on this machine; tasks often take several minutes and may open GitHub pull requests. Jules never modifies the local working tree — after it completes you must sync changes with git/gh (e.g. git fetch && git pull, or gh pr checkout). Use only for multi-file implementation, test generation, dependency bumps, or repo-wide refactors — never for conversation, quick local edits, or tasks you can do with local tools. Requires JULES_API_KEY and (for repo mode) the Jules GitHub app on the target repository.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: 'Clear, self-contained task for Jules to execute in the cloud',
      },
      create_pr: {
        type: 'boolean',
        description: 'When true, request AUTO_CREATE_PR automation (default true)',
      },
      branch: {
        type: 'string',
        description: 'Optional starting branch override (default: current git branch or main)',
      },
    },
    required: ['task'],
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const { task, create_pr, branch } = call.input as {
      task: string;
      create_pr?: boolean;
      branch?: string;
    };

    if (!task || typeof task !== 'string' || !task.trim()) {
      return {
        callId: call.id,
        name: this.name,
        output: 'Error: task is required.',
        isError: true,
        durationMs: 0,
      };
    }

    if (!ctx.delegateToJules) {
      return {
        callId: call.id,
        name: this.name,
        output:
          'Error: Jules delegation not available. Configure JULES_API_KEY in Settings (https://jules.google.com/settings#api).',
        isError: true,
        durationMs: 0,
      };
    }

    const start = performance.now();
    try {
      const result = await ctx.delegateToJules(task.trim(), {
        createPr: create_pr !== false,
        branch: typeof branch === 'string' ? branch : undefined,
      });
      return {
        callId: call.id,
        name: this.name,
        output: result,
        isError: false,
        durationMs: performance.now() - start,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        callId: call.id,
        name: this.name,
        output: `Jules cloud delegation failed: ${msg}`,
        isError: true,
        durationMs: performance.now() - start,
      };
    }
  }
}