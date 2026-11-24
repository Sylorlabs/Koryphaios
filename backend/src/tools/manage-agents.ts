import type { Tool, ToolCallInput, ToolCallOutput, ToolContext } from './registry';

/** Manager control plane for already-spawned workers. */
export class ManageAgentsTool implements Tool {
  readonly name = 'manage_agents';
  readonly role = 'manager' as const;
  readonly description =
    'Inspect and control agents in this chat. Actions: list, message, cancel, set_controls, prune_context. ' +
    'Use list to see every manager, worker, and critic with its model, provider, reasoning level, fallback chain, permission posture, worktree mode, status, and busy state. ' +
    'Workers are controllable; the manager row accepts durable set_controls. Use message to send an instruction when the worker is idle, ' +
    'set_controls to change model, reasoning, or fallback chain for the next turn, cancel to stop a worker, or prune_context to remove older prompt messages while retaining the visible transcript. ' +
    'Permissions stay user-owned and cannot be changed through this tool. Managers should change controls only when the user asks or the task requires it.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'message', 'cancel', 'set_controls', 'prune_context'],
      },
      agentId: { type: 'string' },
      message: { type: 'string' },
      model: { type: 'string', description: 'Worker model, optionally provider:model.' },
      reasoningLevel: { type: 'string' },
      fallbacks: {
        type: 'array',
        maxItems: 20,
        description: 'Ordered fallback models tried only on provider or rate-limit failure.',
        items: {
          type: 'object',
          properties: {
            model: { type: 'string' },
            reasoningLevel: { type: 'string' },
          },
          required: ['model'],
          additionalProperties: false,
        },
      },
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
