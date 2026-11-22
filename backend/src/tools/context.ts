// Context-window management tools.
//
// A bounded, redacted preview of agent activity is archived locally per
// session. Old outputs get stubbed out of the LLM context to free the window;
// these tools retrieve the durable preview (fetch_context) or proactively hide
// entries the model no longer needs (prune_context).

import { getContextArchive } from '../kory/context-archive';
import type { Tool, ToolCallInput, ToolCallOutput, ToolContext } from './registry';

const FETCH_MAX_CHARS = 24_000;

export class FetchContextTool implements Tool {
  readonly name = 'fetch_context';
  readonly description =
    'Recall past activity from this session. With no arguments, lists recent actions (file edits, ' +
    'reads, terminal runs) with their archive ids and timestamps — use this to remember WHAT you did ' +
    'and when. Pass an id (e.g. "cx_12") to retrieve its bounded, redacted durable preview, or a query to search previews.';
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
        output:
          `[${entry.id}] ${entry.label}\n${entry.content.slice(0, FETCH_MAX_CHARS)}` +
          `\n\n[Durable preview; original ${entry.originalByteCount} bytes; sha256 ${entry.contentSha256}; ` +
          `truncated=${entry.truncated}; redacted=${entry.redacted}]`,
        isError: false,
        durationMs: 0,
      };
    }

    if (query) {
      const hits = await archive.search(ctx.sessionId, query, 5);
      if (hits.length === 0) return fail(`No archived activity matching "${query}".`);
      const perHit = Math.floor(FETCH_MAX_CHARS / hits.length);
      const output = hits
        .map(
          (e) =>
            `[${e.id}] ${e.label}\n${e.content.slice(0, perHit)}` +
            `\n[Preview; original ${e.originalByteCount} bytes; truncated=${e.truncated}; redacted=${e.redacted}]`,
        )
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
      return `[${e.id}] ${t} ${e.kind}: ${e.label} (${e.originalByteCount} original bytes; preview ${Buffer.byteLength(e.content, 'utf8')} bytes; truncated=${e.truncated}; redacted=${e.redacted})`;
    });
    return {
      callId: call.id,
      name: this.name,
      output: `Recent session activity (newest last):\n${lines.join('\n')}\n\nPass an id to fetch_context to retrieve its bounded, redacted preview.`,
      isError: false,
      durationMs: 0,
    };
  }
}

export class ManageContextTool implements Tool {
  readonly name = 'manage_context';
  readonly description =
    'Decide what tool output stays in YOUR context. Actions: report (see what is prunable and ' +
    'which policies are active), hide (agent sees only the tool name, time and size), summarize ' +
    '(replace an output with your own summary, or with a model-written one when summary is omitted), ' +
    'restore (bring a hidden output back), set_policy (set a per-tool mode: full, summary, hidden), ' +
    'compact (compact now instead of waiting for the automatic threshold). The full output always ' +
    'stays in the transcript and archive; this only changes what the model sees. A Manager controls ' +
    'this chat; a Worker or Critic controls only its own private context.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['report', 'hide', 'summarize', 'restore', 'set_policy', 'compact'],
        description: 'What to do',
      },
      ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Archive ids (e.g. ["cx_3"]) from fetch_context or a context-status report',
      },
      summary: {
        type: 'string',
        description:
          'For summarize with a single id: the summary to keep. Omit to have a model write it.',
      },
      summaries: {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: { type: 'string' }, summary: { type: 'string' } },
          required: ['id', 'summary'],
        },
        description: 'For summarize with several ids and your own summaries',
      },
      tool: {
        type: 'string',
        description: 'For set_policy: the tool name whose context mode you are choosing',
      },
      mode: {
        type: 'string',
        enum: ['full', 'summary', 'hidden'],
        description: 'For set_policy: how much of that tool output you want to see',
      },
      reason: { type: 'string', description: 'For compact: why you are compacting early' },
    },
    required: ['action'],
  };
  readonly role = 'any' as const;

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const fail = (output: string): ToolCallOutput => ({
      callId: call.id,
      name: this.name,
      output,
      isError: true,
      durationMs: 0,
    });
    if (!ctx.manageContext) {
      return fail(
        'Context control is not available for this agent. Use prune_context to reclaim space.',
      );
    }
    try {
      return {
        callId: call.id,
        name: this.name,
        output: await ctx.manageContext(call.input),
        isError: false,
        durationMs: 0,
      };
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  }
}

export class PruneContextTool implements Tool {
  readonly name = 'prune_context';
  readonly description =
    'Free context-window space by pruning earlier tool outputs you no longer need (old file reads, ' +
    'terminal output, search results). Managers may pass archive ids. Workers and Critics may omit ids ' +
    'and prune their own older tool output context with keepRecent. Pruned content is replaced by a stub ' +
    'and is not removed from the visible transcript.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Archive ids to prune, e.g. ["cx_3", "cx_4"]',
      },
      keepRecent: {
        type: 'number',
        minimum: 4,
        maximum: 100,
        description: 'For a worker or Critic, retain this many recent context messages.',
      },
    },
  };
  readonly role = 'any' as const;

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    if (ctx.pruneOwnContext) {
      const keepRecent =
        typeof call.input.keepRecent === 'number' ? call.input.keepRecent : undefined;
      try {
        return {
          callId: call.id,
          name: this.name,
          output: await ctx.pruneOwnContext(keepRecent),
          isError: false,
          durationMs: 0,
        };
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
