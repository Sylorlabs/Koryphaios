/**
 * Note Network Agent Tools
 *
 * Expose the note knowledge network to agents so they can create, read,
 * search, and navigate notes using [[wikilinks]] and backlink traversal.
 */

import type { Tool, ToolContext, ToolCallInput, ToolCallOutput } from './registry';
import * as notesService from '../notes/notes-service';

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
  async run(_ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const input = call.input as any;
    const start = Date.now();
    try {
      const note = await notesService.createNote({
        title: input.title,
        content: input.content ?? '',
        folderPath: input.folderPath ?? '/',
        tags: input.tags ?? [],
        includeInContext: input.includeInContext ?? false,
      });
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
    } catch (err: any) {
      return {
        callId: call.id,
        name: call.name,
        output: 'Error: ' + err.message,
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
    const input = call.input as any;
    const start = Date.now();
    try {
      let note = input.id ? await notesService.getNoteWithLinks(input.id) : null;
      if (!note && input.title) {
        const byTitle = await notesService.getNoteByTitle(input.title);
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
      const output = [
        '# ' + note.title,
        'Folder: ' + note.folderPath,
        'Tags: ' + note.tags.join(', '),
        'Backlinks: ' + backlinks.map((b) => b.title).join(', '),
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
    } catch (err: any) {
      return {
        callId: call.id,
        name: call.name,
        output: 'Error: ' + err.message,
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
    'Update an existing note. Wikilinks in content are re-parsed and graph edges updated.',
  role: 'any',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Note ID' },
      title: { type: 'string', description: 'Note title to look up if no ID' },
      content: { type: 'string', description: 'New markdown content' },
      tags: { type: 'array', items: { type: 'string' } },
      folderPath: { type: 'string' },
    },
  },
  async run(_ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const input = call.input as any;
    const start = Date.now();
    try {
      let id = input.id as string | undefined;
      if (!id && input.title) {
        const n = await notesService.getNoteByTitle(input.title);
        if (!n) {
          return {
            callId: call.id,
            name: call.name,
            output: 'Note not found',
            isError: true,
            durationMs: Date.now() - start,
          };
        }
        id = n.id;
      }
      const note = await notesService.updateNote(id!, {
        content: input.content,
        tags: input.tags,
        folderPath: input.folderPath,
      });
      return {
        callId: call.id,
        name: call.name,
        output: 'Updated: ' + note.title,
        isError: false,
        durationMs: Date.now() - start,
      };
    } catch (err: any) {
      return {
        callId: call.id,
        name: call.name,
        output: 'Error: ' + err.message,
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
    const input = call.input as any;
    const start = Date.now();
    try {
      const results = await notesService.searchNotes(input.query);
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
    } catch (err: any) {
      return {
        callId: call.id,
        name: call.name,
        output: 'Error: ' + err.message,
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
    'List all notes with their titles, folders, and tags. Use search_notes to search by content.',
  role: 'any',
  inputSchema: {
    type: 'object',
    properties: {
      folderPath: { type: 'string', description: 'Filter by folder path prefix' },
    },
  },
  async run(_ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const input = call.input as any;
    const start = Date.now();
    try {
      const notesList = await notesService.listNotes({ folderPath: input.folderPath });
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
    } catch (err: any) {
      return {
        callId: call.id,
        name: call.name,
        output: 'Error: ' + err.message,
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
  description: 'Get all notes that link TO a given note via [[wikilinks]].',
  role: 'any',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Note title' },
      id: { type: 'string', description: 'Note ID' },
    },
  },
  async run(_ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const input = call.input as any;
    const start = Date.now();
    try {
      let id = input.id as string | undefined;
      if (!id && input.title) {
        const n = await notesService.getNoteByTitle(input.title);
        if (!n) {
          return {
            callId: call.id,
            name: call.name,
            output: 'Note not found',
            isError: true,
            durationMs: Date.now() - start,
          };
        }
        id = n.id;
      }
      const backlinks = await notesService.getNoteBacklinks(id!);
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
    } catch (err: any) {
      return {
        callId: call.id,
        name: call.name,
        output: 'Error: ' + err.message,
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
    } catch (err: any) {
      return {
        callId: call.id,
        name: call.name,
        output: 'Error: ' + err.message,
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
  searchNotesTool,
  listNotesTool,
  getBacklinksTool,
  noteGraphSummaryTool,
];
