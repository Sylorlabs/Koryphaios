import { getContext } from '../context';
import type { Checklist, ChecklistItemStatus, ChecklistScope } from '@koryphaios/shared';
import type { Tool, ToolCallInput, ToolCallOutput, ToolContext } from './registry';
import type { ChecklistActor } from '../stores/checklist-store';

/**
 * App-wide checklists, available to every agent role and to the user.
 *
 * Unlike `create_goal`/`update_goal`, these carry no evidence gate and no
 * verification semantics: a checklist records intent and progress, not proof.
 * Every role is granted write access on purpose -- a worker that cannot tick off
 * its own steps is worse than useless, and the critic's independence is
 * preserved by what it does *not* touch (Goal Mode verification).
 */
const SCOPES: ChecklistScope[] = ['workspace', 'project', 'session'];

/** The transcript renders a live, tappable checklist wherever this appears. */
const TOKEN = (id: string) => `{{checklist:${id}}}`;

/** Attribute a mutation so the UI can show who changed what. */
const actorFor = (ctx: ToolContext): ChecklistActor => ({
  name: ctx.callerRole ? `${ctx.callerRole} agent` : 'agent',
  role:
    ctx.callerRole === 'critic'
      ? 'critic'
      : ((ctx.callerRole as ChecklistActor['role']) ?? 'manager'),
});

/** Push a change to every surface showing this checklist. */
const publish = (checklist: Checklist | undefined, deletedId?: string): Checklist | undefined => {
  const { wsManager } = getContext();
  if (deletedId)
    wsManager.broadcast({
      type: 'checklists.updated',
      payload: { deletedId },
      timestamp: Date.now(),
      sessionId: undefined,
    });
  else if (checklist)
    wsManager.broadcast({
      type: 'checklists.updated',
      payload: { checklist },
      timestamp: Date.now(),
      sessionId: checklist.sessionId,
    });
  return checklist;
};

const fail = (call: ToolCallInput, message: string): ToolCallOutput => ({
  callId: call.id,
  name: call.name,
  output: `Error: ${message}`,
  isError: true,
  durationMs: 0,
});

/** Render a checklist for a model: compact, ordered, and explicit about state. */
const render = (checklist: Checklist): string => {
  const embed = `To show this checklist in the chat, include ${TOKEN(checklist.id)} in your reply.`;
  if (!checklist.items.length)
    return `${checklist.title} (${checklist.id}) — no items yet\n${embed}`;
  const lines = checklist.items.map((item) => {
    const mark = item.status === 'done' ? '[x]' : item.status === 'skipped' ? '[-]' : '[ ]';
    return `  ${mark} ${item.id}  ${item.title}`;
  });
  const done = checklist.items.filter((item) => item.status === 'done').length;
  return [
    `${checklist.title} (${checklist.id}) — ${done}/${checklist.items.length} done, scope ${checklist.scope}`,
    ...lines,
    embed,
  ].join('\n');
};

/** Accept a single string, an array, or a newline-delimited blob. */
const asTitles = (value: unknown): string[] => {
  if (Array.isArray(value))
    return value.filter((entry): entry is string => typeof entry === 'string');
  if (typeof value === 'string') return value.split('\n');
  return [];
};

const asId = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

export const createChecklistTool: Tool = {
  name: 'create_checklist',
  description:
    'Create a checklist to track multi-step work. Unlike a Goal, a checklist needs no user request, carries no evidence gate, and is yours to edit freely. Use it whenever a task has three or more steps worth tracking.',
  role: 'any',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', maxLength: 1000, description: 'What this checklist tracks' },
      items: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional starting items',
      },
      scope: {
        type: 'string',
        enum: SCOPES,
        description: 'Visibility; default workspace (visible in every chat)',
      },
    },
    required: ['title'],
  },
  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const start = Date.now();
    const input = call.input as Record<string, unknown>;
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (!title) return { ...fail(call, 'title is required'), durationMs: Date.now() - start };
    const scope = (input.scope ?? 'workspace') as ChecklistScope;
    try {
      const checklist = await getContext().checklists.create({
        title,
        scope,
        items: asTitles(input.items),
        // A session-scoped list is only meaningful inside the chat that asked
        // for it, so scope it there rather than leaving it unreachable.
        sessionId: ctx.sessionId,
        projectPath: ctx.workingDirectory,
        actor: actorFor(ctx),
      });
      return {
        callId: call.id,
        name: call.name,
        output: `Created checklist ${checklist.id}.\n${render(checklist)}`,
        isError: false,
        durationMs: Date.now() - start,
      };
    } catch (err: unknown) {
      return {
        ...fail(call, err instanceof Error ? err.message : String(err)),
        durationMs: Date.now() - start,
      };
    }
  },
};

export const listChecklistsTool: Tool = {
  name: 'list_checklists',
  description: 'List checklists visible in this chat with their progress.',
  role: 'any',
  inputSchema: {
    type: 'object',
    properties: {
      includeArchived: {
        type: 'boolean',
        description: 'Include finished checklists; default false',
      },
    },
  },
  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const start = Date.now();
    const input = call.input as Record<string, unknown>;
    try {
      const checklists = await getContext().checklists.listVisible({
        sessionId: ctx.sessionId,
        projectPath: ctx.workingDirectory,
      });
      const visible = input.includeArchived
        ? checklists
        : checklists.filter((checklist) => !checklist.archivedAt);
      if (!visible.length)
        return {
          callId: call.id,
          name: call.name,
          output: 'No checklists found',
          isError: false,
          durationMs: Date.now() - start,
        };
      return {
        callId: call.id,
        name: call.name,
        output: visible.map(render).join('\n\n'),
        isError: false,
        durationMs: Date.now() - start,
      };
    } catch (err: unknown) {
      return {
        ...fail(call, err instanceof Error ? err.message : String(err)),
        durationMs: Date.now() - start,
      };
    }
  },
};

export const readChecklistTool: Tool = {
  name: 'read_checklist',
  description: 'Read one checklist and its items.',
  role: 'any',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'Checklist id' } },
    required: ['id'],
  },
  async run(_ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const start = Date.now();
    const id = asId((call.input as Record<string, unknown>).id);
    if (!id) return { ...fail(call, 'id is required'), durationMs: Date.now() - start };
    try {
      const checklist = await getContext().checklists.get(id);
      if (!checklist)
        return { ...fail(call, `No checklist ${id}`), durationMs: Date.now() - start };
      return {
        callId: call.id,
        name: call.name,
        output: render(checklist),
        isError: false,
        durationMs: Date.now() - start,
      };
    } catch (err: unknown) {
      return {
        ...fail(call, err instanceof Error ? err.message : String(err)),
        durationMs: Date.now() - start,
      };
    }
  },
};

export const addChecklistItemTool: Tool = {
  name: 'add_checklist_item',
  description:
    'Append one or more items to a checklist. Use this instead of update_checklist when you are only adding steps.',
  role: 'any',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Checklist id' },
      items: {
        type: 'array',
        items: { type: 'string' },
        description: 'Titles to append, in order',
      },
    },
    required: ['id', 'items'],
  },
  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const start = Date.now();
    const input = call.input as Record<string, unknown>;
    const id = asId(input.id);
    if (!id) return { ...fail(call, 'id is required'), durationMs: Date.now() - start };
    try {
      const checklist = await getContext().checklists.addItems(
        id,
        asTitles(input.items),
        actorFor(ctx),
        ctx.sessionId,
      );
      if (!checklist)
        return { ...fail(call, `No checklist ${id}`), durationMs: Date.now() - start };
      publish(checklist);
      return {
        callId: call.id,
        name: call.name,
        output: render(checklist),
        isError: false,
        durationMs: Date.now() - start,
      };
    } catch (err: unknown) {
      return {
        ...fail(call, err instanceof Error ? err.message : String(err)),
        durationMs: Date.now() - start,
      };
    }
  },
};

export const checkChecklistItemTool: Tool = {
  name: 'check_checklist_item',
  description:
    'Mark a checklist item done, skipped, or pending again. Use "pending" to reopen a finished step.',
  role: 'any',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Checklist id' },
      itemId: { type: 'string', description: 'Item id, as shown by read_checklist' },
      status: {
        type: 'string',
        enum: ['pending', 'done', 'skipped'],
        description: 'New status; default done',
      },
    },
    required: ['id', 'itemId'],
  },
  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const start = Date.now();
    const input = call.input as Record<string, unknown>;
    const id = asId(input.id);
    const itemId = asId(input.itemId);
    if (!id || !itemId)
      return { ...fail(call, 'id and itemId are required'), durationMs: Date.now() - start };
    const status = (input.status ?? 'done') as ChecklistItemStatus;
    try {
      const checklist = await getContext().checklists.setItemStatus(
        id,
        itemId,
        status,
        actorFor(ctx),
        ctx.sessionId,
      );
      if (!checklist)
        return { ...fail(call, `No checklist ${id}`), durationMs: Date.now() - start };
      publish(checklist);
      return {
        callId: call.id,
        name: call.name,
        output: render(checklist),
        isError: false,
        durationMs: Date.now() - start,
      };
    } catch (err: unknown) {
      return {
        ...fail(call, err instanceof Error ? err.message : String(err)),
        durationMs: Date.now() - start,
      };
    }
  },
};

export const updateChecklistTool: Tool = {
  name: 'update_checklist',
  description:
    'Replace a checklist title and/or its whole item plan. Existing items keep their done/skipped state. To only add items, prefer add_checklist_item.',
  role: 'any',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Checklist id' },
      title: { type: 'string', maxLength: 1000, description: 'New title' },
      items: {
        type: 'array',
        items: { type: 'object' },
        description: 'Replacement plan as {id?, title, order?}. Omitted items are removed.',
      },
      archive: { type: 'boolean', description: 'Archive the checklist when finished' },
    },
    required: ['id'],
  },
  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const start = Date.now();
    const input = call.input as Record<string, unknown>;
    const id = asId(input.id);
    if (!id) return { ...fail(call, 'id is required'), durationMs: Date.now() - start };
    try {
      const { checklists } = getContext();
      const actor = actorFor(ctx);
      let checklist = await checklists.get(id);
      if (!checklist)
        return { ...fail(call, `No checklist ${id}`), durationMs: Date.now() - start };
      if (typeof input.title === 'string' && input.title.trim())
        checklist = await checklists.setTitle(id, input.title, actor);
      if (Array.isArray(input.items)) {
        const edits = input.items
          .map((entry, index) => {
            const raw = (entry ?? {}) as Record<string, unknown>;
            const title = typeof raw.title === 'string' ? raw.title : '';
            return {
              ...(asId(raw.id) ? { id: asId(raw.id) } : {}),
              title,
              order: Number.isFinite(raw.order) ? Number(raw.order) : index,
            };
          })
          .filter((edit) => edit.title.trim());
        if (input.items.length && !edits.length)
          return { ...fail(call, 'Every item requires a title'), durationMs: Date.now() - start };
        checklist = await checklists.edit(id, edits, actor);
      }
      if (input.archive) checklist = await checklists.archive(id, actor);
      if (!checklist)
        return { ...fail(call, `No checklist ${id}`), durationMs: Date.now() - start };
      publish(checklist);
      return {
        callId: call.id,
        name: call.name,
        output: render(checklist),
        isError: false,
        durationMs: Date.now() - start,
      };
    } catch (err: unknown) {
      return {
        ...fail(call, err instanceof Error ? err.message : String(err)),
        durationMs: Date.now() - start,
      };
    }
  },
};

export const deleteChecklistTool: Tool = {
  name: 'delete_checklist',
  description:
    'Permanently delete a checklist and its items. Prefer archiving when the work is merely done.',
  role: 'any',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'Checklist id' } },
    required: ['id'],
  },
  async run(_ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const start = Date.now();
    const id = asId((call.input as Record<string, unknown>).id);
    if (!id) return { ...fail(call, 'id is required'), durationMs: Date.now() - start };
    try {
      const removed = await getContext().checklists.delete(id);
      if (!removed) return { ...fail(call, `No checklist ${id}`), durationMs: Date.now() - start };
      publish(undefined, id);
      return {
        callId: call.id,
        name: call.name,
        output: `Deleted checklist ${id}.`,
        isError: false,
        durationMs: Date.now() - start,
      };
    } catch (err: unknown) {
      return {
        ...fail(call, err instanceof Error ? err.message : String(err)),
        durationMs: Date.now() - start,
      };
    }
  },
};

export const checklistTools: Tool[] = [
  createChecklistTool,
  listChecklistsTool,
  readChecklistTool,
  addChecklistItemTool,
  checkChecklistItemTool,
  updateChecklistTool,
  deleteChecklistTool,
];
