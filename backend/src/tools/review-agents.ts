import type { Tool, ToolCallInput, ToolCallOutput, ToolContext } from './registry';

export class ManageReviewAgentsTool implements Tool {
  readonly name = 'manage_review_agents';
  readonly role = 'critic' as const;
  readonly description =
    'Manage your own verification subagents: list their status, send a follow-up task, or cancel one. Spawn specialists with delegate_to_worker. You can only manage agents created by this review.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'message', 'cancel'] },
      agentId: { type: 'string' },
      message: { type: 'string' },
    },
    required: ['action'],
  };
  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    try {
      if (!ctx.manageReviewAgents) throw new Error('No active review team');
      const output = await ctx.manageReviewAgents(call.input);
      return { callId: call.id, name: this.name, output, isError: false, durationMs: 0 };
    } catch (error) {
      return {
        callId: call.id, name: this.name,
        output: error instanceof Error ? error.message : String(error),
        isError: true, durationMs: 0,
      };
    }
  }
}
