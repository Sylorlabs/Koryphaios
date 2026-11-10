import type { Tool, ToolCallInput, ToolCallOutput, ToolContext } from './registry';

/** Manager control plane for already-spawned workers. */
export class ManageAgentsTool implements Tool {
  readonly name = 'manage_agents';
  readonly role = 'manager' as const;
  readonly description =
    'Inspect and control workers spawned in this chat. Actions: list, message, cancel, set_controls, prune_context. ' +
    'Use list to see worker ids, status, model, provider, reasoning level, and busy state. ' +
    'Use message to send an instruction when the worker is idle, set_controls to change its model or reasoning for the next turn, ' +
    'cancel to stop it, or prune_context to remove older prompt messages while retaining the visible transcript.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'message', 'cancel', 'set_controls', 'prune_context'] },
      agentId: { type: 'string' },
      message: { type: 'string' },
      model: { type: 'string' },
      reasoningLevel: { type: 'string' },
      keepRecent: { type: 'number', minimum: 2, maximum: 100 },
    },
    required: ['action'],
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    try {
      if (!ctx.manageAgents) throw new Error('Worker controls are unavailable in this context.');
      const output = await ctx.manageAgents(call.input);
      return { callId: call.id, name: this.name, output, isError: false, durationMs: 0 };
    } catch (error) {
      return {
        callId: call.id,
        name: this.name,
        output: error instanceof Error ? error.message : String(error),
        isError: true,
        durationMs: 0,
      };
    }
  }
}
