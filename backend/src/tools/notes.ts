/**
 * Note Network Agent Tools
 *
 * Expose the note knowledge network to agents so they can create, read,
 * search, navigate, link, and recall notes using [[wikilinks]] and graph edges.
 */

import type { Tool, ToolContext, ToolCallInput, ToolCallOutput } from './registry';
import * as notesService from '../notes/notes-service';
import { broadcastNotesNetworkUpdate } from '../notes/notes-events';

async function resolveId(input: { id?: string; title?: string }): Promise<string | null> {
  return notesService.resolveNoteId(input.id, input.title);
}

// ============================================================================
// create_note
// ============================================================================

export const createNoteTool: Tool = {
  name: 'create_note',
  description:
    'Create a new note in the knowledge network. Supports [[wikilinks]] in content that automatically create graph edges to other notes.',
  role: 'any',
  inputSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Note title (must be unique for wikilink resolution)',
      },
      content: {
        type: 'string',
        description:
          'Markdown content. Use [[Note Title]] to link to other notes, ![[filename]] to embed attachments.',
      },
      folderPath: {
        type: 'string',
        description: 'Folder path like /Research/AI (default: /)',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tags for categorization',
      },
      includeInContext: {
        type: 'boolean',
        description: 'If true, this note is always injected into agent context',
      },
    },
    required: ['title'],
  },
  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const input = call.input as Record<string, unknown>;
    const start = Date.now();
    try {
      const note = await notesService.createNote({
        title: String(input.title),
        content: (input.content as string) ?? '',
        folderPath: (input.folderPath as string) ?? '/',
        tags: (input.tags as string[]) ?? [],
        includeInContext: Boolean(input.includeInContext),
      });
      broadcastNotesNetworkUpdate('create', note.id, ctx.sessionId);
      return {
        callId: call.id,
        name: call.name,
        output: JSON.stringify({
          id: note.id,
          title: note.title,
          folderPath: note.folderPath,
          tags: note.tags,
        }),
        isError: false,
        durationMs: Date.now() - start,
      };
    } catch (err: unknown) {
      return {
        callId: call.id,
        name: call.name,
        output: 'Error: ' + (err instanceof Error ? err.message : String(err)),
        isError: true,
        durationMs: Date.now() - start,
      };
    }
  },
};

// ============================================================================
// read_note
// ============================================================================

export const readNoteTool: Tool = {
  name: 'read_note',
  description:
    'Read a note by title or ID. Returns full content, metadata, backlinks, and outlinks.',
  role: 'any',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Note title to look up' },
      id: { type: 'string', description: 'Note ID (use if you have it)' },
    },
  },
  async run(_ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const input = call.input as Record<string, unknown>;
    const start = Date.now();
    try {
      let note = input.id
        ? await notesService.getNoteWithLinks(String(input.id))
        : null;
      if (!note && input.title) {
        const byTitle = await notesService.getNoteByTitle(String(input.title));
        if (byTitle) note = await notesService.getNoteWithLinks(byTitle.id);
      }
      if (!note) {
        return {
          callId: call.id,
          name: call.name,
          output: 'Note not found',
          isError: true,
          durationMs: Date.now() - start,
        };
      }
      const backlinks = await notesService.getNoteBacklinks(note.id);
      const outlinks = await notesService.getNoteOutlinks(note.id);
      const output = [
        '# ' + note.title,
        'ID: ' + note.id,
        'Folder: ' + note.folderPath,
        'Tags: ' + note.tags.join(', '),
        'Backlinks: ' + backlinks.map((b) => b.title).join(', '),
        'Outlinks: ' + outlinks.map((o) => o.title).join(', '),
        '',
        note.content,
      ].join('\n');
      return {
        callId: call.id,
        name: call.name,
        output,
        isError: false,
        durationMs: Date.now() - start,
      };
    } catch (err: unknown) {
      return {
        callId: call.id,
        name: call.name,
        output: 'Error: ' + (err instanceof Error ? err.message : String(err)),
        isError: true,
        durationMs: Date.now() - start,
      };
    }
  },
};

// ============================================================================
// update_note
// ============================================================================

export const updateNoteTool: Tool = {
  name: 'update_note',
  description:
    'Update an existing note (title, content, folder, tags, pinned, includeInContext). Wikilinks in content are re-parsed and graph edges updated. Renaming updates [[wikilinks]] vault-wide.',
  role: 'any',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Note ID' },
      title: { type: 'string', description: 'Note title to look up if no ID, or new title' },
      newTitle: { type: 'string', description: 'Rename note to this title' },
      content: { type: 'string', description: 'New markdown content' },
      tags: { type: 'array', items: { type: 'string' } },
      folderPath: { type: 'string' },
      pinned: { type: 'boolean' },
      includeInContext: { type: 'boolean' },
    },
  },
  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const input = call.input as Record<string, unknown>;
    const start = Date.now();
    try {
      const lookupTitle = input.newTitle ? input.title : input.title;
      let id = (input.id as string) || (await resolveId({ title: lookupTitle as string }));
      if (!id) {
        return {
          callId: call.id,
          name: call.name,
          output: 'Note not found',
          isError: true,
          durationMs: Date.now() - start,
        };
      }
      const note = await notesService.updateNote(id, {
        title: input.newTitle ? String(input.newTitle) : undefined,
        content: input.content as string | undefined,
        tags: input.tags as string[] | undefined,
        folderPath: input.folderPath as string | undefined,
        pinned: input.pinned as boolean | undefined,
        includeInContext: input.includeInContext as boolean | undefined,
      });
      broadcastNotesNetworkUpdate('update', note.id, ctx.sessionId);
      return {
        callId: call.id,
        name: call.name,
        output: 'Updated: ' + note.title + ' [' + note.id + ']',
        isError: false,
        durationMs: Date.now() - start,
      };
    } catch (err: unknown) {
      return {
        callId: call.id,
        name: call.name,
        output: 'Error: ' + (err instanceof Error ? err.message : String(err)),
        isError: true,
        durationMs: Date.now() - start,
      };
    }
  },
};

// ============================================================================
// delete_note
// ============================================================================

export const deleteNoteTool: Tool = {
  name: 'delete_note',
  description: 'Delete a note from the knowledge network. Removes its graph edges and attachments.',
  role: 'any',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Note ID' },
      title: { type: 'string', description: 'Note title if ID unknown' },
    },
  },
  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const input = call.input as Record<string, unknown>;
    const start = Date.now();
    try {
      const id = await resolveId({
        id: input.id as string | undefined,
        title: input.title as string | undefined,
      });
      if (!id) {
        return {
          callId: call.id,
          name: call.name,
          output: 'Note not found',
          isError: true,
          durationMs: Date.now() - start,
        };
      }
      const note = await notesService.getNote(id);
      await notesService.deleteNote(id);
      broadcastNotesNetworkUpdate('delete', id, ctx.sessionId);
      return {
        callId: call.id,
        name: call.name,
        output: 'Deleted: ' + (note?.title ?? id),
        isError: false,
        durationMs: Date.now() - start,
      };
    } catch (err: unknown) {
      return {
        callId: call.id,
        name: call.name,
        output: 'Error: ' + (err instanceof Error ? err.message : String(err)),
        isError: true,
        durationMs: Date.now() - start,
      };
    }
  },
};

// ============================================================================
// link_notes / unlink_notes
// ============================================================================

export const linkNotesTool: Tool = {
  name: 'link_notes',
  description:
    'Create a directed link from one note to another in the knowledge graph. Also appends [[Target]] wikilink to source content unless syncContent is false.',
  role: 'any',
  inputSchema: {
    type: 'object',
    properties: {
      fromId: { type: 'string' },
      fromTitle: { type: 'string' },
      toId: { type: 'string' },
      toTitle: { type: 'string' },
      syncContent: {
        type: 'boolean',
        description: 'Append [[wikilink]] to source note (default true)',
      },
    },
  },
  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const input = call.input as Record<string, unknown>;
    const start = Date.now();
    try {
      const fromId = await resolveId({
        id: input.fromId as string | undefined,
        title: input.fromTitle as string | undefined,
      });
      const toId = await resolveId({
        id: input.toId as string | undefined,
        title: input.toTitle as string | undefined,
      });
      if (!fromId || !toId) {
        return {
          callId: call.id,
          name: call.name,
          output: 'Source or target note not found',
          isError: true,
          durationMs: Date.now() - start,
        };
      }
      await notesService.linkNotes(fromId, toId, {
        syncContent: input.syncContent !== false,
      });
      broadcastNotesNetworkUpdate('link', fromId, ctx.sessionId);
      const [fromNote, toNote] = await Promise.all([
        notesService.getNote(fromId),
        notesService.getNote(toId),
      ]);
      return {
        callId: call.id,
        name: call.name,
        output: `Linked [[${fromNote?.title}]] → [[${toNote?.title}]]`,
        isError: false,
        durationMs: Date.now() - start,
      };
    } catch (err: unknown) {
      return {
        callId: call.id,
        name: call.name,
        output: 'Error: ' + (err instanceof Error ? err.message : String(err)),
        isError: true,
        durationMs: Date.now() - start,
      };
    }
  },
};

export const unlinkNotesTool: Tool = {
  name: 'unlink_notes',
  description:
    'Remove a directed link between two notes. Optionally strips the [[wikilink]] from source content.',
  role: 'any',
  inputSchema: {
    type: 'object',
    properties: {
      fromId: { type: 'string' },
      fromTitle: { type: 'string' },
      toId: { type: 'string' },
      toTitle: { type: 'string' },
      syncContent: { type: 'boolean', description: 'Remove wikilink from source (default true)' },
    },
  },
  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const input = call.input as Record<string, unknown>;
    const start = Date.now();
    try {
      const fromId = await resolveId({
        id: input.fromId as string | undefined,
        title: input.fromTitle as string | undefined,
      });
      const toId = await resolveId({
        id: input.toId as string | undefined,
        title: input.toTitle as string | undefined,
      });
      if (!fromId || !toId) {
        return {
          callId: call.id,
          name: call.name,
          output: 'Source or target note not found',
          isError: true,
          durationMs: Date.now() - start,
        };
      }
      await notesService.unlinkNotes(fromId, toId, {
        syncContent: input.syncContent !== false,
      });
      broadcastNotesNetworkUpdate('unlink', fromId, ctx.sessionId);
      return {
        callId: call.id,
        name: call.name,
        output: 'Unlinked notes',
        isError: false,
        durationMs: Date.now() - start,
      };
    } catch (err: unknown) {
      return {
        callId: call.id,
        name: call.name,
        output: 'Error: ' + (err instanceof Error ? err.message : String(err)),
        isError: true,
        durationMs: Date.now() - start,
      };
    }
  },
};

// ============================================================================
// recall_notes
// ============================================================================

export const recallNotesTool: Tool = {
  name: 'recall_notes',
  description:
    'Recall full content for any notes by search query, titles, or IDs. Use this to load notes from the catalog into working memory. Omit all filters to list recent notes.',
  role: 'any',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search title/content/tags' },
      titles: { type: 'array', items: { type: 'string' }, description: 'Exact note titles' },
      ids: { type: 'array', items: { type: 'string' }, description: 'Note IDs' },
      limit: { type: 'number', description: 'Max notes to return (default 10)' },
    },
  },
  async run(_ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const input = call.input as Record<string, unknown>;
    const start = Date.now();
    try {
      const recalled = await notesService.recallNotes({
        query: input.query as string | undefined,
        titles: input.titles as string[] | undefined,
        ids: input.ids as string[] | undefined,
        limit: typeof input.limit === 'number' ? input.limit : 10,
      });
      if (!recalled.length) {
        return {
          callId: call.id,
          name: call.name,
          output: 'No notes matched',
          isError: false,
          durationMs: Date.now() - start,
        };
      }
      const output = recalled
        .map((note) => {
          return [
            '---',
            '# ' + note.title,
            'ID: ' + note.id,
            'Folder: ' + note.folderPath,
            'Tags: ' + note.tags.join(', '),
            'Outlinks: ' + note.outlinks.length,
            'Backlinks: ' + note.backlinks.length,
            '',
            note.content,
          ].join('\n');
        })
        .join('\n\n');
      return {
        callId: call.id,
        name: call.name,
        output,
        isError: false,
        durationMs: Date.now() - start,
      };
    } catch (err: unknown) {
      return {
        callId: call.id,
        name: call.name,
        output: 'Error: ' + (err instanceof Error ? err.message : String(err)),
        isError: true,
        durationMs: Date.now() - start,
      };
    }
  },
};

// ============================================================================
// search_notes
// ============================================================================

export const searchNotesTool: Tool = {
  name: 'search_notes',
  description:
    'Search notes by keyword across title, content, and tags. Returns matching notes with metadata.',
  role: 'any',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
    },
    required: ['query'],
  },
  async run(_ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const input = call.input as Record<string, unknown>;
    const start = Date.now();
    try {
      const results = await notesService.searchNotes(String(input.query));
      if (!results.length) {
        return {
          callId: call.id,
          name: call.name,
          output: 'No notes found for: ' + input.query,
          isError: false,
          durationMs: Date.now() - start,
        };
      }
      const output = results
        .map(
          (n) =>
            '- [' +
            n.id +
            '] ' +
            n.title +
            ' (' +
            n.folderPath +
            ') tags:' +
            n.tags.join(',') +
            '\n  ' +
            n.content.slice(0, 100),
        )
        .join('\n');
      return {
        callId: call.id,
        name: call.name,
        output,
        isError: false,
        durationMs: Date.now() - start,
      };
    } catch (err: unknown) {
      return {
        callId: call.id,
        name: call.name,
        output: 'Error: ' + (err instanceof Error ? err.message : String(err)),
        isError: true,
        durationMs: Date.now() - start,
      };
    }
  },
};

// ============================================================================
// list_notes
// ============================================================================

export const listNotesTool: Tool = {
  name: 'list_notes',
  description:
    'List all notes with their titles, folders, and tags. Use recall_notes to load full content.',
  role: 'any',
  inputSchema: {
    type: 'object',
    properties: {
      folderPath: { type: 'string', description: 'Filter by folder path prefix' },
    },
  },
  async run(_ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const input = call.input as Record<string, unknown>;
    const start = Date.now();
    try {
      const notesList = await notesService.listNotes({
        folderPath: input.folderPath as string | undefined,
      });
      if (!notesList.length) {
        return {
          callId: call.id,
          name: call.name,
          output: 'No notes found',
          isError: false,
          durationMs: Date.now() - start,
        };
      }
      const output = notesList
        .map(
          (n) =>
            '- [' + n.id + '] ' + n.title + ' (' + n.folderPath + ') [' + n.tags.join(', ') + ']',
        )
        .join('\n');
      return {
        callId: call.id,
        name: call.name,
        output,
        isError: false,
        durationMs: Date.now() - start,
      };
    } catch (err: unknown) {
      return {
        callId: call.id,
        name: call.name,
        output: 'Error: ' + (err instanceof Error ? err.message : String(err)),
        isError: true,
        durationMs: Date.now() - start,
      };
    }
  },
};

// ============================================================================
// get_note_backlinks
// ============================================================================

export const getBacklinksTool: Tool = {
  name: 'get_note_backlinks',
  description: 'Get all notes that link TO a given note via [[wikilinks]] or graph edges.',
  role: 'any',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Note title' },
      id: { type: 'string', description: 'Note ID' },
    },
  },
  async run(_ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const input = call.input as Record<string, unknown>;
    const start = Date.now();
    try {
      const id = await resolveId({
        id: input.id as string | undefined,
        title: input.title as string | undefined,
      });
      if (!id) {
        return {
          callId: call.id,
          name: call.name,
          output: 'Note not found',
          isError: true,
          durationMs: Date.now() - start,
        };
      }
      const backlinks = await notesService.getNoteBacklinks(id);
      if (!backlinks.length) {
        return {
          callId: call.id,
          name: call.name,
          output: 'No backlinks found',
          isError: false,
          durationMs: Date.now() - start,
        };
      }
      return {
        callId: call.id,
        name: call.name,
        output: backlinks.map((n) => '- ' + n.title + ' (' + n.folderPath + ')').join('\n'),
        isError: false,
        durationMs: Date.now() - start,
      };
    } catch (err: unknown) {
      return {
        callId: call.id,
        name: call.name,
        output: 'Error: ' + (err instanceof Error ? err.message : String(err)),
        isError: true,
        durationMs: Date.now() - start,
      };
    }
  },
};

// ============================================================================
// get_note_graph_summary
// ============================================================================

export const noteGraphSummaryTool: Tool = {
  name: 'get_note_graph_summary',
  description:
    'Get a text summary of the entire note knowledge graph: node count, most connected notes, isolated notes.',
  role: 'any',
  inputSchema: { type: 'object', properties: {} },
  async run(_ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const start = Date.now();
    try {
      const graph = await notesService.getGraphData();
      const sorted = [...graph.nodes].sort((a, b) => b.linkCount - a.linkCount);
      const isolated = sorted.filter((n) => n.linkCount === 0);
      const connected = sorted.filter((n) => n.linkCount > 0);
      const contextNotes = graph.nodes.filter((n) => n.includeInContext);

      const lines = [
        'Note Graph Summary',
        '==================',
        'Total notes: ' + graph.nodes.length,
        'Total links: ' + graph.edges.length,
        'Connected notes: ' + connected.length,
        'Isolated notes: ' + isolated.length,
        '',
        'Most connected:',
        ...connected
          .slice(0, 5)
          .map((n) => '  - ' + n.title + ' (' + n.linkCount + ' links, ' + n.folderPath + ')'),
        '',
        'Context-injected notes: ' +
          (contextNotes.length
            ? contextNotes.map((n) => n.title).join(', ')
            : '(none)'),
      ];

      return {
        callId: call.id,
        name: call.name,
        output: lines.join('\n'),
        isError: false,
        durationMs: Date.now() - start,
      };
    } catch (err: unknown) {
      return {
        callId: call.id,
        name: call.name,
        output: 'Error: ' + (err instanceof Error ? err.message : String(err)),
        isError: true,
        durationMs: Date.now() - start,
      };
    }
  },
};

// ============================================================================
// Export
// ============================================================================

export const noteTools: Tool[] = [
  createNoteTool,
  readNoteTool,
  updateNoteTool,
  deleteNoteTool,
  linkNotesTool,
  unlinkNotesTool,
  recallNotesTool,
  searchNotesTool,
  listNotesTool,
  getBacklinksTool,
  noteGraphSummaryTool,
];