import { Tool, ToolRegistry, ToolContext, ToolCallInput, ToolCallOutput } from './registry';
import { CheckpointStore } from '../kory/checkpoint-store';

/**
 * GhostCommitTool — lets an agent create a checkpoint on demand.
 *
 * Agents can call this to save a named restore point mid-turn or at a
 * logical milestone. The checkpoint captures the current worktree state
 * as a ghost commit in the shadow repo (invisible to normal git operations).
 */
export class GhostCommitTool implements Tool {
  readonly name = 'ghost_commit';
  readonly description =
    'Create a named checkpoint (ghost commit) of the current working state. ' +
    'Use this to save a restore point before risky changes, at logical milestones, ' +
    'or when you want to be able to rewind to the current state later. ' +
    'The checkpoint is invisible to normal git operations (log, push, etc.) — ' +
    'it lives in a separate shadow repository. Returns the checkpoint hash.';
  readonly role = 'worker';
  readonly inputSchema = {
    type: 'object',
    properties: {
      label: {
        type: 'string',
        description:
          'A short, human-readable label for this checkpoint (e.g. "before refactor", "tests passing").',
      },
    },
    required: ['label'],
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const start = Date.now();
    try {
      const label = String(call.input.label || '').trim();
      if (!label) {
        return this.createResult(call, 'Error: label is required', true, start);
      }

      const store = new CheckpointStore(ctx.workingDirectory);
      const hash = await store.createGhostCommit(label, {
        agentId: ctx.sessionId,
        checkpointType: 'agent_manual',
        model: ctx.activeModel,
        provider: ctx.activeProvider,
      });

      if (!hash) {
        return this.createResult(
          call,
          'Failed to create checkpoint — see server logs for details',
          true,
          start,
        );
      }

      return this.createResult(
        call,
        `Checkpoint created: ${label} (hash: ${hash.slice(0, 8)}). You can rewind to this state via the timeline UI.`,
        false,
        start,
      );
    } catch (e) {
      return this.createResult(
        call,
        `Error: ${e instanceof Error ? e.message : String(e)}`,
        true,
        start,
      );
    }
  }

  private createResult(
    call: ToolCallInput,
    output: string,
    isError: boolean,
    startTs: number,
  ): ToolCallOutput {
    return {
      callId: call.id,
      name: this.name,
      output,
      isError,
      durationMs: Date.now() - startTs,
    };
  }
}

export function registerCheckpointTools(registry: ToolRegistry) {
  registry.register(new GhostCommitTool());
}
