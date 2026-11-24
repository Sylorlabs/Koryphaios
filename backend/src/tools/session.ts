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

export class ForkChatTool implements Tool {
  readonly name = 'fork_chat';
  readonly role = 'manager' as const;
  readonly description =
    'Fork a chat into a new chat that starts from a finished point of the history (the latest finished message by default). The original chat is not changed. Returns the new chat id. Use it when the user wants to explore an alternative without losing the current thread.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: 'Chat to fork. Defaults to this chat.',
      },
      messageId: {
        type: 'string',
        description: 'Message to end the fork at. Defaults to the latest finished message.',
      },
      title: { type: 'string', minLength: 1, maxLength: SESSION.MAX_TITLE_LENGTH },
    },
    additionalProperties: false,
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    try {
      if (ctx.callerRole !== 'manager' || !ctx.forkChat) {
        throw new Error('Forking chats is only available to this chat’s manager.');
      }
      for (const key of ['sessionId', 'messageId', 'title'] as const) {
        const value = call.input[key];
        if (value !== undefined && typeof value !== 'string') {
          throw new Error(`${key} must be a string.`);
        }
      }
      ctx.signal?.throwIfAborted();
      const forked = await ctx.forkChat({
        ...(typeof call.input.sessionId === 'string' && call.input.sessionId.trim()
          ? { sessionId: call.input.sessionId.trim() }
          : {}),
        ...(typeof call.input.messageId === 'string' && call.input.messageId.trim()
          ? { messageId: call.input.messageId.trim() }
          : {}),
        ...(typeof call.input.title === 'string' && call.input.title.trim()
          ? { title: call.input.title }
          : {}),
      });
      return {
        callId: call.id,
        name: this.name,
        output: `Forked chat created: session ${forked.sessionId} ("${forked.title}"), ${forked.copiedMessageCount} message(s) copied.`,
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
