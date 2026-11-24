// Worktree-Auto chat isolation tools for the manager.
//
// isolate_chat moves the chat out of its project folder into an independent
// repository copy that starts from the folder's last commit (uncommitted
// folder work stays in the folder). merge_chat_back merges the copy's commits
// back into the folder when the task is done — in YOLO automatically, in
// every other permission mode only after the user approves.
//
// Both effects live on KoryManager: they need the session store, per-session
// runtime flags, the Git executor and the workspace caches. Wiring mirrors
// AgentMail: bootstrap calls configureChatIsolation with the manager once.

import type { KoryManager } from '../kory/manager';
import type { SessionStore } from '../stores/session-store';
import type { Tool, ToolCallInput, ToolCallOutput, ToolContext } from './registry';

interface ChatIsolationConfig {
  kory: KoryManager;
  sessions: SessionStore;
}

let config: ChatIsolationConfig | null = null;

/** Wire the runtime dependencies. Called once during backend bootstrap. */
export function configureChatIsolation(next: ChatIsolationConfig): void {
  config = next;
}

/** Drop the wiring (tests, shutdown). */
export function resetChatIsolation(): void {
  config = null;
}

function requireConfig(): ChatIsolationConfig {
  if (!config) throw new Error('Chat isolation is not configured');
  return config;
}

function fail(call: ToolCallInput, name: string, message: string): ToolCallOutput {
  return { callId: call.id, name, output: `Error: ${message}`, isError: true, durationMs: 0 };
}

function done(call: ToolCallInput, name: string, output: string): ToolCallOutput {
  return { callId: call.id, name, output, isError: false, durationMs: 0 };
}

export class IsolateChatTool implements Tool {
  readonly name = 'isolate_chat';
  readonly role = 'manager' as const;
  readonly description =
    "Move this chat out of its project folder into an independent Git copy that starts from the folder's last commit, then keep working there instead. Use when other chats are working in the same folder and your edits could collide with theirs. The copy cannot see uncommitted changes in the folder — if the task needs them, or you are unsure, ask the user instead. Never isolate for read-only work. The current turn ends right after this call and the host continues the task in the copy automatically; the chat merges back into the folder later via merge_chat_back.";
  readonly inputSchema = {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description:
          'Why this chat is being isolated, e.g. which sibling chat or files could collide.',
      },
    },
    required: ['reason'],
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    try {
      const { kory } = requireConfig();
      const reason = String((call.input as { reason?: string }).reason ?? '').trim();
      if (!reason) return fail(call, this.name, 'A reason for isolating is required.');
      const result = await kory.isolateSessionWorkspace(ctx.sessionId, reason);
      return done(
        call,
        this.name,
        `This chat now works in its own copy at ${result.path}. End this turn now with a one-line note; the host continues the task in the copy automatically.`,
      );
    } catch (err: unknown) {
      return fail(call, this.name, err instanceof Error ? err.message : String(err));
    }
  }
}

export class MergeChatBackTool implements Tool {
  readonly name = 'merge_chat_back';
  readonly role = 'manager' as const;
  readonly description =
    'Merge the work this chat did in its own copy back into the project folder, then run in the folder again. Only for chats that isolated with isolate_chat. Call it when the task is complete and verified; the copy is preserved for manual recovery. Uncommitted work in the copy is committed automatically first. If the folder moved to another branch or the merge conflicts, the call reports it and the chat stays isolated.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'Optional merge commit message.',
      },
    },
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    try {
      const { kory } = requireConfig();
      const message = (call.input as { message?: string }).message;
      const result = await kory.mergeSessionWorkspaceBack(
        ctx.sessionId,
        typeof message === 'string' && message.trim() ? message.trim() : undefined,
      );
      const lines: string[] = [];
      if (result.autoCommitted) {
        lines.push("Committed the copy's uncommitted work first.");
      }
      if (result.mergedCommit) {
        lines.push(
          `Merged into the folder as ${result.mergedCommit} (${result.filesChanged} file${result.filesChanged === 1 ? '' : 's'} changed).`,
        );
      } else {
        lines.push('The copy had no new work — nothing to merge.');
      }
      lines.push('This chat runs in the folder again; the copy is preserved on disk.');
      lines.push('End this turn now; the next turn works in the folder.');
      return done(call, this.name, lines.join('\n'));
    } catch (err: unknown) {
      return fail(call, this.name, err instanceof Error ? err.message : String(err));
    }
  }
}
