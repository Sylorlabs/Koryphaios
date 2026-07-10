export interface Note {
  id: string;
  title: string;
  content: string;
  folderPath: string;
  tags: string[];
  pinned: boolean;
  includeInContext: boolean;
  userId?: string;
  createdAt: Date;
  updatedAt: Date;
  /** Project-relative path when this note mirrors a real .md or .html file. */
  sourcePath?: string;
  format?: 'markdown' | 'html';
}

export interface NoteLink {
  fromNoteId: string;
  toNoteId: string;
}

export interface NoteAttachment {
  id: string;
  noteId: string;
  filename: string;
  mimeType: string;
  size: number;
  storagePath: string;
  createdAt: Date;
}

export interface CreateNoteInput {
  title: string;
  content?: string;
  folderPath?: string;
  tags?: string[];
  pinned?: boolean;
  includeInContext?: boolean;
  userId?: string;
  format?: 'markdown' | 'html';
}

export interface UpdateNoteInput {
  title?: string;
  content?: string;
  folderPath?: string;
  tags?: string[];
  pinned?: boolean;
  includeInContext?: boolean;
  format?: 'markdown' | 'html';
}

export interface NoteWithLinks extends Note {
  outlinks: string[]; // note IDs this note links to
  backlinks: string[]; // note IDs that link to this note
  attachments: NoteAttachment[];
}

export interface GraphNode {
  id: string;
  title: string;
  folderPath: string;
  tags: string[];
  linkCount: number;
  includeInContext: boolean;
  /** True for a placeholder node representing a [[wikilink]] whose target note
   *  doesn't exist yet (an "unresolved"/ghost node, like Obsidian). */
  unresolved?: boolean;
}

export interface GraphEdge {
  from: string;
  to: string;
  /** Edge pointing at an unresolved ghost node. */
  unresolved?: boolean;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface FolderNode {
  path: string;
  name: string;
  children: FolderNode[];
  noteCount: number;
}

export interface NotesSettings {
  enabled: boolean;
  autoIncludeInContext: boolean;
  maxContextTokens: number;
  graphPhysics: {
    gravity: number;
    linkDistance: number;
    chargeStrength: number;
  };
  defaultFolderPath: string;
}

export const DEFAULT_NOTES_SETTINGS: NotesSettings = {
  enabled: true,
  autoIncludeInContext: true,
  maxContextTokens: 2000,
  graphPhysics: {
    gravity: -30,
    linkDistance: 90,
    chargeStrength: -120,
  },
  defaultFolderPath: '/',
};

// ============================================================================
// Agent permissions for note network tools
// ============================================================================

export type NotePermissionLevel = 'auto' | 'ask' | 'block';

export type NotesPermissionPreset = 'default' | 'allow_all' | 'ask_all' | 'block_all' | 'custom';

export const NOTE_TOOL_NAMES = [
  'read_note',
  'search_notes',
  'list_notes',
  'recall_notes',
  'get_note_backlinks',
  'get_note_graph_summary',
  'render_note',
  'create_note',
  'update_note',
  'delete_note',
  'link_notes',
  'unlink_notes',
] as const;

export type NoteToolName = (typeof NOTE_TOOL_NAMES)[number];

export interface NoteToolDefinition {
  name: NoteToolName;
  label: string;
  description: string;
  category: 'read' | 'write';
}

export const NOTE_TOOL_DEFINITIONS: NoteToolDefinition[] = [
  {
    name: 'read_note',
    label: 'Read note',
    description: 'Load a single note by title or ID',
    category: 'read',
  },
  {
    name: 'search_notes',
    label: 'Search notes',
    description: 'Full-text search across the vault',
    category: 'read',
  },
  {
    name: 'list_notes',
    label: 'List notes',
    description: 'List all notes with metadata',
    category: 'read',
  },
  {
    name: 'recall_notes',
    label: 'Recall notes',
    description: 'Load full content for multiple notes',
    category: 'read',
  },
  {
    name: 'get_note_backlinks',
    label: 'Get backlinks',
    description: 'Find notes linking to a note',
    category: 'read',
  },
  {
    name: 'get_note_graph_summary',
    label: 'Graph summary',
    description: 'Summarize vault graph structure',
    category: 'read',
  },
  {
    name: 'render_note',
    label: 'Use in chat',
    description: 'Pull a bounded excerpt or render a note in chat',
    category: 'read',
  },
  {
    name: 'create_note',
    label: 'Create note',
    description: 'Add a new note to the vault',
    category: 'write',
  },
  {
    name: 'update_note',
    label: 'Update note',
    description: 'Edit note content, title, or tags',
    category: 'write',
  },
  {
    name: 'delete_note',
    label: 'Delete note',
    description: 'Permanently remove a note',
    category: 'write',
  },
  {
    name: 'link_notes',
    label: 'Link notes',
    description: 'Add a graph edge between notes',
    category: 'write',
  },
  {
    name: 'unlink_notes',
    label: 'Unlink notes',
    description: 'Remove a graph edge between notes',
    category: 'write',
  },
];

export type NoteToolPermissions = Record<NoteToolName, NotePermissionLevel>;

export interface NotesAgentPermissions {
  preset: NotesPermissionPreset;
  tools: NoteToolPermissions;
}

export const DEFAULT_NOTE_TOOL_PERMISSIONS: NoteToolPermissions = {
  read_note: 'auto',
  search_notes: 'auto',
  list_notes: 'auto',
  recall_notes: 'auto',
  get_note_backlinks: 'auto',
  get_note_graph_summary: 'auto',
  render_note: 'auto',
  create_note: 'ask',
  update_note: 'ask',
  delete_note: 'ask',
  link_notes: 'ask',
  unlink_notes: 'ask',
};

export const NOTES_PERMISSION_PRESET_LEVELS: Record<
  Exclude<NotesPermissionPreset, 'custom'>,
  NoteToolPermissions
> = {
  default: DEFAULT_NOTE_TOOL_PERMISSIONS,
  allow_all: Object.fromEntries(
    NOTE_TOOL_NAMES.map((name) => [name, 'auto']),
  ) as NoteToolPermissions,
  ask_all: Object.fromEntries(NOTE_TOOL_NAMES.map((name) => [name, 'ask'])) as NoteToolPermissions,
  block_all: Object.fromEntries(
    NOTE_TOOL_NAMES.map((name) => [name, 'block']),
  ) as NoteToolPermissions,
};

export const DEFAULT_NOTES_AGENT_PERMISSIONS: NotesAgentPermissions = {
  preset: 'default',
  tools: { ...DEFAULT_NOTE_TOOL_PERMISSIONS },
};

export function isNoteToolName(name: string): name is NoteToolName {
  return (NOTE_TOOL_NAMES as readonly string[]).includes(name);
}

export function applyNotesPermissionPreset(
  preset: Exclude<NotesPermissionPreset, 'custom'>,
): NotesAgentPermissions {
  return {
    preset,
    tools: { ...NOTES_PERMISSION_PRESET_LEVELS[preset] },
  };
}

export function detectNotesPermissionPreset(tools: NoteToolPermissions): NotesPermissionPreset {
  for (const preset of ['default', 'allow_all', 'ask_all', 'block_all'] as const) {
    const expected = NOTES_PERMISSION_PRESET_LEVELS[preset];
    if (NOTE_TOOL_NAMES.every((name) => tools[name] === expected[name])) {
      return preset;
    }
  }
  return 'custom';
}

export function normalizeNotesAgentPermissions(
  input?: Partial<NotesAgentPermissions> | null,
): NotesAgentPermissions {
  let tools: NoteToolPermissions;

  if (input?.preset && input.preset !== 'custom') {
    tools = { ...NOTES_PERMISSION_PRESET_LEVELS[input.preset] };
  } else {
    tools = { ...DEFAULT_NOTE_TOOL_PERMISSIONS };
  }

  if (input?.tools) {
    for (const name of NOTE_TOOL_NAMES) {
      const level = input.tools[name];
      if (level === 'auto' || level === 'ask' || level === 'block') {
        tools[name] = level;
      }
    }
  }

  return {
    preset: detectNotesPermissionPreset(tools),
    tools,
  };
}
