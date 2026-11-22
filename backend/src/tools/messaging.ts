// Inter-agent messaging tools (AgentMail).
//
// Authority model enforced here and again server-side in the mail service:
// - `send_agent_message`  (manager): message another project's manager or any
//   agent in the own project.
// - `request_manager_relay` (worker): ask the own manager to forward a message
//   to another project's manager. Intercepted in the manager loop.
// - `list_agent_messages` (any): pull the inbox.

import type { Tool, ToolContext, ToolCallInput, ToolCallOutput } from './registry';
import {
  AgentMessageTargetError,
  AgentMessagingDisabledError,
  drainInbox,
  sendAgentMessage,
} from '../kory/services/agent-mail-service';
import { basename } from 'node:path';

function callerRole(ctx: ToolContext): 'manager' | 'worker' {
  if (ctx.callerRole === 'manager') return 'manager';
  if (ctx.callerRole === 'worker' || ctx.callerRole === 'critic' || ctx.callerRole === 'coder') {
    return 'worker';
  }
  // Legacy contexts without an explicit role: the Kory manager identity is the
  // only trusted fallback. Everything else fails closed as a worker.
  return ctx.agentId === 'kory-manager' ? 'manager' : 'worker';
}

function callerLabel(ctx: ToolContext, role: 'manager' | 'worker'): string {
  if (role === 'worker') {
    return ctx.callerDomain ? `${ctx.callerDomain} agent` : 'worker agent';
  }
  const project = ctx.workingDirectory ? basename(ctx.workingDirectory) : '';
  return project ? `(${project}) manager` : 'Kory manager';
}

function fail(call: ToolCallInput, err: unknown): ToolCallOutput {
  const message = err instanceof Error ? err.message : String(err);
  return {
    callId: call.id,
    name: call.name,
    output: `Error: ${message}`,
    isError: true,
    durationMs: 0,
  };
}

/**
 * Manager tool: send a message to another project's manager, or to any agent
 * inside the own project. Delivery is asynchronous — the call returns
 * immediately with a queue receipt; replies arrive via list_agent_messages.
 */
export class SendAgentMessageTool implements Tool {
  readonly name = 'send_agent_message';
  readonly role = 'any' as const;
  readonly description =
    'Send an asynchronous message to another agent. You may message the manager or a named sub-agent of any other chat (by project name, or by exact chat id via toSessionId — use list_sessions to find chat ids, or an id the user pasted), and any agent in your own chat. Messages to other chats may need user approval depending on the permission mode; messaging within your own chat is always allowed. Replies arrive in your inbox (list_agent_messages). To ask your manager to forward a request instead, use request_manager_relay.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      toSessionId: {
        type: 'string',
        description:
          'Exact chat id, e.g. one the user pasted or from list_sessions. Takes precedence over toProject.',
      },
      toProject: {
        type: 'string',
        description:
          'Target project name (or exact chat id). Required when messaging outside your own project. Omit to target an agent in your own project.',
      },
      toAgent: {
        type: 'string',
        description:
          "Optional target agent inside the receiving chat: 'manager' (default) or a sub-agent label in that chat.",
      },
      subject: { type: 'string', description: 'Short summary of the request' },
      body: { type: 'string', description: 'Full message content for the receiving agent' },
      replyToMessageId: {
        type: 'string',
        description: 'Set when replying to a received message so the thread stays correlated.',
      },
    },
    required: ['body'],
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const input = call.input as {
      toSessionId?: string;
      toProject?: string;
      toAgent?: string;
      subject?: string;
      body?: string;
      replyToMessageId?: string;
    };
    if (!input.body || typeof input.body !== 'string' || !input.body.trim()) {
      return fail(call, new AgentMessageTargetError('body is required'));
    }
    const role = callerRole(ctx);
    const toAgent = input.toAgent
      ? input.toAgent === 'manager'
        ? ({ role: 'manager' } as const)
        : ({ role: 'worker', label: input.toAgent } as const)
      : undefined;
    try {
      const message = await sendAgentMessage({
        fromSessionId: ctx.sessionId,
        fromAgentId: ctx.agentId ?? (role === 'manager' ? 'kory-manager' : 'worker'),
        fromRole: role,
        fromLabel: callerLabel(ctx, role),
        toSessionId: input.toSessionId,
        toProject: input.toProject,
        toAgent,
        subject: input.subject ?? '(no subject)',
        body: input.body,
        replyToMessageId: input.replyToMessageId,
      });
      const suffix =
        message.status === 'pending_approval'
          ? 'held for user approval (inter-agent messaging policy)'
          : message.status === 'delivered'
            ? 'delivered'
            : 'queued';
      return {
        callId: call.id,
        name: this.name,
        output: `Message ${message.id} ${suffix} for ${message.toLabel}. Replies will appear via list_agent_messages.`,
        isError: false,
        durationMs: 0,
      };
    } catch (err: unknown) {
      if (err instanceof AgentMessagingDisabledError || err instanceof AgentMessageTargetError) {
        return fail(call, err);
      }
      return fail(call, err instanceof Error ? err : new Error(String(err)));
    }
  }
}

/**
 * Worker tool: request the own manager to forward a message to another
 * project's manager. Intercepted in the manager loop — the manager decides
 * whether to forward.
 */
export class RequestManagerRelayTool implements Tool {
  readonly name = 'request_manager_relay';
  readonly role = 'worker' as const;
  readonly description =
    "Request YOUR manager to send a message to another project's manager. You can never message other projects directly; this asks your manager to relay on your behalf. The manager may forward, adapt, or decline with a reason.";
  readonly inputSchema = {
    type: 'object',
    properties: {
      toProject: {
        type: 'string',
        description: 'Target project name whose manager should receive the request',
      },
      subject: { type: 'string', description: 'Short summary of the request' },
      body: { type: 'string', description: 'What you need the other project to do or provide' },
    },
    required: ['toProject', 'body'],
  };

  async run(_ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    // Actual execution is intercepted in KoryManager's loop, mirroring
    // ask_manager, so the manager can take over the relay decision.
    const input = call.input as { toProject?: string; subject?: string; body?: string };
    return {
      callId: call.id,
      name: this.name,
      output: JSON.stringify({
        type: 'RELAY_REQUEST',
        toProject: input.toProject ?? '',
        subject: input.subject ?? '(no subject)',
        body: input.body ?? '',
      }),
      isError: false,
      durationMs: 0,
    };
  }
}

/**
 * Any role: pull the inter-agent inbox. Same-session mail is marked delivered
 * once observed here.
 */
export class ListAgentMessagesTool implements Tool {
  readonly name = 'list_agent_messages';
  readonly role = 'any' as const;
  readonly description =
    'Check your inter-agent inbox: messages from other agents (managers or sub-agents) and replies to messages you sent. Call this after receiving an agent.message notification or before assuming a peer never answered.';
  readonly inputSchema = {
    type: 'object',
    properties: {},
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    try {
      const inbox = await drainInbox(ctx.sessionId, ctx.agentId);
      if (inbox.length === 0) {
        return {
          callId: call.id,
          name: this.name,
          output: 'No agent messages.',
          isError: false,
          durationMs: 0,
        };
      }
      const lines = inbox.map((message) => {
        const replyNote = message.reply ? `\n  Reply so far: ${message.reply}` : '';
        return [
          `- [${message.status}] From ${message.fromLabel}: ${message.subject} (id: ${message.id})`,
          `  ${message.body}`,
          `  (Reply with send_agent_message and replyToMessageId: ${message.id})${replyNote}`,
        ].join('\n');
      });
      return {
        callId: call.id,
        name: this.name,
        output: lines.join('\n'),
        isError: false,
        durationMs: 0,
      };
    } catch (err: unknown) {
      return fail(call, err instanceof Error ? err : new Error(String(err)));
    }
  }
}
