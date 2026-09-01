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
  /** Monotonic revision used for optimistic save/conflict detection. */
  revision: number;
  /** Project-relative path when this note mirrors a real .md or .html file. */
  sourcePath?: string;
  format?: 'markdown' | 'html';
}

/** A recoverable note hidden from the active vault. Trashing never removes
 * attachment bytes or a project-backed source document. */
export interface TrashedNote extends Note {
  trashedAt: Date;
  trashReason: 'user' | 'source_removed';
}

export type NoteRevisionOperation =
  | 'create'
  | 'update'
  | 'external_sync'
  | 'trash'
  | 'source_removed'
  | 'restore'
  | 'revision_restore';

/** Immutable metadata for one saved note state. Content is fetched separately
 * so the history timeline stays cheap even for long-form vaults. */
export interface NoteRevisionSummary {
  noteId: string;
  revision: number;
  operation: NoteRevisionOperation;
  title: string;
  folderPath: string;
  tags: string[];
  pinned: boolean;
  includeInContext: boolean;
  format: 'markdown' | 'html';
  sourcePath?: string;
  trashedAt?: Date;
  trashReason?: 'user' | 'source_removed';
  contentBytes: number;
  noteCreatedAt: Date;
  noteUpdatedAt: Date;
  createdAt: Date;
}

export interface NoteRevision extends NoteRevisionSummary {
  content: string;
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
  /** Reject the write when another editor has already saved a newer revision. */
  expectedRevision?: number;
  /** Explicit acknowledgement that a project-backed source was deleted outside
   * Koryphaios and should be recreated from the reviewed local draft. */
  restoreDeletedSource?: boolean;
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
  /** Visible notes rendered before ghost/unresolved nodes were appended. */
  shown?: number;
  /** True when the note count exceeded the graph safety cap. */
  truncated?: boolean;
  /** Approximate total notes when truncated (for "showing X of Y" indicators). */
  total?: number;
  /** True when the link table exceeded the graph link safety cap. */
  linksTruncated?: boolean;
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
  /** When false, the product-wide hard safety ceiling is used instead of the custom limit. */
  maxContextTokensEnabled: boolean;
  maxContextTokens: number;
  /** Autosave is explicit and configurable for long-form editing. */
  autosaveEnabled: boolean;
  autosaveDelayMs: number;
  /** Per-note persistence budget. A hard safety ceiling still applies when disabled. */
  noteSizeLimitEnabled: boolean;
  maxNoteBytes: number;
  /** Per-file attachment budget and count boundary. */
  attachmentSizeLimitEnabled: boolean;
  maxAttachmentBytes: number;
  maxAttachmentsPerNote: number;
  graphPhysics: {
    gravity: number;
    linkDistance: number;
    chargeStrength: number;
  };
  defaultFolderPath: string;
}

/**
 * Product-wide context allocation contract. Memory and Notes use the same
 * bounds so disabling a custom budget means "use the safety ceiling", not
 * "send an unbounded prompt".
 */
export const CONTEXT_BUDGET_MIN_TOKENS = 100;
export const CONTEXT_BUDGET_MAX_TOKENS = 100_000;
export const DEFAULT_CONTEXT_BUDGET_TOKENS = 2_000;

export const DEFAULT_NOTES_SETTINGS: NotesSettings = {
  enabled: true,
  autoIncludeInContext: true,
  maxContextTokensEnabled: true,
  maxContextTokens: DEFAULT_CONTEXT_BUDGET_TOKENS,
  autosaveEnabled: true,
  autosaveDelayMs: 1500,
  noteSizeLimitEnabled: true,
  maxNoteBytes: 1_000_000,
  attachmentSizeLimitEnabled: true,
  maxAttachmentBytes: 25_000_000,
  maxAttachmentsPerNote: 50,
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
  'get_note_properties',
  'query_note_base',
  'render_note',
  'record_work_note',
  'create_note',
  'set_note_property',
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
    name: 'get_note_properties',
    label: 'Read properties',
    description: 'Read bounded typed YAML properties from a note',
    category: 'read',
  },
  {
    name: 'query_note_base',
    label: 'Query saved Base',
    description: 'Run a bounded saved Base view by ID',
    category: 'read',
  },
  {
    name: 'render_note',
    label: 'Use in chat',
    description: 'Pull a bounded excerpt or render a note in chat',
    category: 'read',
  },
  {
    name: 'record_work_note',
    label: 'Record work note',
    description: 'Save a structured result with host-owned run provenance and evidence',
    category: 'write',
  },
  {
    name: 'create_note',
    label: 'Create note',
    description: 'Add a new note to the vault',
    category: 'write',
  },
  {
    name: 'set_note_property',
    label: 'Set note property',
    description: 'Optimistically update one typed YAML property',
    category: 'write',
  },
  {
    name: 'update_note',
    label: 'Update note',
    description: 'Optimistically edit note content, title, or tags at a known revision',
    category: 'write',
  },
  {
    name: 'delete_note',
    label: 'Move note to trash',
    description: 'Hide a note from the active vault while keeping it recoverable',
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
  get_note_properties: 'auto',
  query_note_base: 'auto',
  render_note: 'auto',
  record_work_note: 'ask',
  create_note: 'ask',
  set_note_property: 'ask',
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
