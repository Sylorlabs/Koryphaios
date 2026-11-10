import { SESSION } from '../constants';
import type { Tool, ToolContext, ToolCallInput, ToolCallOutput } from './registry';

export class RenameSessionTool implements Tool {
  readonly name = 'rename_session';
  readonly role = 'manager' as const;
  readonly description =
    'Rename the current chat with a concise, specific title (usually 3-6 words). Use when the conversation topic evolves or the user asks for a new name. Preserve a user-chosen title unless they request a change. Only changes the current session title.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 1, maxLength: SESSION.MAX_TITLE_LENGTH },
    },
    required: ['title'],
    additionalProperties: false,
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    try {
      if (ctx.callerRole !== 'manager' || !ctx.renameSession) {
        throw new Error('Session renaming is only available to this chat’s manager.');
      }
      if (typeof call.input.title !== 'string' || !call.input.title.trim()) {
        throw new Error('A descriptive title is required.');
      }
      ctx.signal?.throwIfAborted();
      const title = await ctx.renameSession(call.input.title);
      return {
        callId: call.id,
        name: this.name,
        output: `Session renamed to: ${title}`,
        isError: false,
        durationMs: 0,
      };
    } catch (error) {
      return {
        callId: call.id,
        name: this.name,
        output: `Error: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
        durationMs: 0,
      };
    }
  }
}
