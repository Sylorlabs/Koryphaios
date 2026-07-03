// Context-window management tools.
//
// Everything an agent does (tool outputs, file reads, terminal runs) is
// archived locally per session. Old outputs get stubbed out of the LLM
// context to free the window; these tools let the agent recover exact
// content on demand (fetch_context) or proactively drop things it no
// longer needs (prune_context).

import { getContextArchive } from '../kory/context-archive';
import type { Tool, ToolCallInput, ToolCallOutput, ToolContext } from './registry';

const FETCH_MAX_CHARS = 24_000;

export class FetchContextTool implements Tool {
  readonly name = 'fetch_context';
  readonly description =
    'Recall past activity from this session. With no arguments, lists recent actions (file edits, ' +
    'reads, terminal runs) with their archive ids and timestamps — use this to remember WHAT you did ' +
    'and when. Pass an id (e.g. "cx_12") to recover the exact content, or a query to search past outputs.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Archive id from a pruned stub, e.g. "cx_12"' },
      query: {
        type: 'string',
        description: 'Search past activity by keyword (used when no id is given)',
      },
    },
  };
  readonly role = 'any' as const;

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const archive = getContextArchive();
    const fail = (output: string): ToolCallOutput => ({
      callId: call.id,
      name: this.name,
      output,
      isError: true,
      durationMs: 0,
    });
    if (!archive) return fail('Context archive unavailable.');

    const id = (call.input.id as string | undefined)?.trim();
    const query = (call.input.query as string | undefined)?.trim();

    if (id) {
      const entry = await archive.get(ctx.sessionId, id);
      if (!entry) return fail(`No archived entry ${id} in this session.`);
      return {
        callId: call.id,
        name: this.name,
        output: `[${entry.id}] ${entry.label}\n${entry.content.slice(0, FETCH_MAX_CHARS)}`,
        isError: false,
        durationMs: 0,
      };
    }

    if (query) {
      const hits = await archive.search(ctx.sessionId, query, 5);
      if (hits.length === 0) return fail(`No archived activity matching "${query}".`);
      const perHit = Math.floor(FETCH_MAX_CHARS / hits.length);
      const output = hits
        .map((e) => `[${e.id}] ${e.label}\n${e.content.slice(0, perHit)}`)
        .join('\n\n---\n\n');
      return { callId: call.id, name: this.name, output, isError: false, durationMs: 0 };
    }

    // No args: activity index — what happened, when, under which id. This is
    // how the agent remembers "I edited that file at 10:32" without holding
    // every output in context.
    const recent = await archive.listRecent(ctx.sessionId, 30);
    if (recent.length === 0) return fail('No archived activity in this session yet.');
    const lines = recent.map((e) => {
      const t = new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return `[${e.id}] ${t} ${e.kind}: ${e.label} (${e.content.length} chars)`;
    });
    return {
      callId: call.id,
      name: this.name,
      output: `Recent session activity (newest last):\n${lines.join('\n')}\n\nPass an id to fetch_context to recover full content.`,
      isError: false,
      durationMs: 0,
    };
  }
}

export class PruneContextTool implements Tool {
  readonly name = 'prune_context';
  readonly description =
    'Free context-window space by pruning earlier tool outputs you no longer need (old file reads, ' +
    'terminal output, search results). Pass their archive ids. Pruned content is replaced by a stub ' +
    'and stays recoverable via fetch_context — nothing is lost.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Archive ids to prune, e.g. ["cx_3", "cx_4"]',
      },
    },
    required: ['ids'],
  };
  readonly role = 'manager' as const;

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const archive = getContextArchive();
    if (!archive) {
      return {
        callId: call.id,
        name: this.name,
        output: 'Context archive unavailable.',
        isError: true,
        durationMs: 0,
      };
    }
    const ids = Array.isArray(call.input.ids) ? (call.input.ids as string[]) : [];
    const pruned: string[] = [];
    for (const id of ids) {
      if (await archive.setPrunedForAgent(ctx.sessionId, id, true)) pruned.push(id);
    }
    return {
      callId: call.id,
      name: this.name,
      output: pruned.length
        ? `Pruned ${pruned.join(', ')} from context. Recover any of them with fetch_context.`
        : 'No matching archive ids to prune.',
      isError: pruned.length === 0,
      durationMs: 0,
    };
  }
}
