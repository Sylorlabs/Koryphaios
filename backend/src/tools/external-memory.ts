import type { Tool, ToolCallInput, ToolCallOutput, ToolContext } from './registry';
import { ValidationError } from '../errors/types';
import { loadMemorySettings } from '../memory/unified-memory';
import {
  externalMemoryAdd,
  externalMemoryForget,
  externalMemorySearch,
  externalMemoryStatus,
} from '../memory/external-memory';

// remember / recall / forget — long-term memory backed by an external provider
// (Mem0 or Letta).
//
// Local memory files stay the source of truth and are written by the host
// automatically. These tools operate on the *additional* external store, which
// is what lets a memory survive a reinstall or follow the user to another
// machine. Both are opt-in in Settings › Memory, so every tool here returns a
// clear "not configured" message rather than failing obscurely.

/** Project root for settings lookup; falls back to the tool's working directory. */
function settingsRoot(ctx: ToolContext): string {
  return ctx.settingsRoot ?? ctx.workingDirectory;
}

function unavailableMessage(ctx: ToolContext): string | undefined {
  const settings = loadMemorySettings(settingsRoot(ctx));
  if (!settings.externalMemoryEnabled) {
    return (
      'External memory is turned off. The user can enable it in Settings > Memory and choose ' +
      'Mem0 or Letta. Local memory still works.'
    );
  }
  const status = externalMemoryStatus(settings).find(
    (entry) => entry.provider === settings.externalMemoryProvider,
  );
  if (!status) {
    return `No external memory provider supports "${settings.externalMemoryProvider}".`;
  }
  if (!status.connected) {
    return `${status.provider} is selected for external memory but is not connected. Connect it in Providers & models first.`;
  }
  if (status.scopeRequired && !status.scope) {
    return `${status.provider} needs a scope. The user must set the memory scope in Settings > Memory.`;
  }
  return undefined;
}

function ok(call: ToolCallInput, name: string, started: number, payload: unknown): ToolCallOutput {
  return {
    callId: call.id,
    name,
    output: JSON.stringify(payload),
    isError: false,
    durationMs: Date.now() - started,
  };
}

function err(call: ToolCallInput, name: string, started: number, message: string): ToolCallOutput {
  return {
    callId: call.id,
    name,
    output: message,
    isError: true,
    durationMs: Date.now() - started,
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim()))
    : [];
}

export class RememberTool implements Tool {
  readonly name = 'remember';
  readonly description =
    'Store a durable fact about the user or their project in external long-term memory (Mem0 or Letta). ' +
    'Use this only for information that stays true across sessions: preferences, decisions, recurring ' +
    'constraints, and established facts. Do not store transient state, secrets, credentials, or anything ' +
    'already captured in a project memory file. This tool does nothing unless external memory is enabled ' +
    'in Settings > Memory.';
  readonly role = 'any' as const;

  readonly inputSchema = {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description:
          'A single self-contained fact, written so it still makes sense out of context.',
      },
    },
    required: ['text'],
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const started = Date.now();
    const text = asString(call.input.text);
    if (!text) return err(call, this.name, started, 'Error: `text` is required.');
    const blocked = unavailableMessage(ctx);
    if (blocked) return err(call, this.name, started, blocked);
    try {
      const records = await externalMemoryAdd(loadMemorySettings(settingsRoot(ctx)), { text });
      return ok(call, this.name, started, {
        stored: records.length > 0,
        note: records.length
          ? 'Stored in external memory.'
          : 'The provider accepted the request but reported no new memory, usually because it already knew this fact.',
      });
    } catch (e: unknown) {
      return err(call, this.name, started, `Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

export class RecallTool implements Tool {
  readonly name = 'recall';
  readonly description =
    'Search external long-term memory (Mem0 or Letta) for facts relevant to a query. Use this to recover ' +
    'knowledge from earlier sessions or other machines. Returns nothing when external memory is disabled ' +
    'or the provider has no matching memories.';
  readonly role = 'any' as const;

  readonly inputSchema = {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'What you are trying to remember, in natural language.',
      },
      limit: { type: 'number', description: 'Maximum memories to return (default 8).' },
    },
    required: ['query'],
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const started = Date.now();
    const query = asString(call.input.query);
    if (!query) return err(call, this.name, started, 'Error: `query` is required.');
    const blocked = unavailableMessage(ctx);
    if (blocked) return err(call, this.name, started, blocked);
    try {
      const limit = Number(call.input.limit);
      const records = await externalMemorySearch(loadMemorySettings(settingsRoot(ctx)), {
        query,
        limit: Number.isFinite(limit) ? Math.min(Math.max(1, Math.floor(limit)), 25) : 8,
        signal: ctx.signal,
      });
      return ok(call, this.name, started, {
        query,
        memories: records.map((record) => ({ id: record.id, text: record.text })),
      });
    } catch (e: unknown) {
      return err(call, this.name, started, `Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

export class ForgetTool implements Tool {
  readonly name = 'forget';
  readonly description =
    'Delete specific memories from external long-term memory by id. Only deletes from the external ' +
    'store; project memory files are unaffected. Confirm with the user before deleting, since forgetting ' +
    'cannot be undone.';
  readonly role = 'manager' as const;

  readonly inputSchema = {
    type: 'object',
    properties: {
      ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Memory ids returned by the recall tool.',
      },
    },
    required: ['ids'],
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const started = Date.now();
    const ids = asStringArray(call.input.ids);
    if (!ids.length) return err(call, this.name, started, 'Error: `ids` is required.');
    const blocked = unavailableMessage(ctx);
    if (blocked) return err(call, this.name, started, blocked);
    try {
      const removed = await externalMemoryForget(loadMemorySettings(settingsRoot(ctx)), { ids });
      if (!removed) {
        return err(
          call,
          this.name,
          started,
          'The selected external memory provider cannot delete individual memories. ' +
            'Memories are managed through the provider dashboard.',
        );
      }
      return ok(call, this.name, started, { removed });
    } catch (e: unknown) {
      if (e instanceof ValidationError) {
        return err(call, this.name, started, `Error: ${e.message}`);
      }
      return err(call, this.name, started, `Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
