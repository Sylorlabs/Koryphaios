export interface Note {
  id: string
  title: string
  content: string
  folderPath: string
  tags: string[]
  pinned: boolean
  includeInContext: boolean
  userId?: string
  createdAt: Date
  updatedAt: Date
}

export interface NoteLink {
  fromNoteId: string
  toNoteId: string
}

export interface NoteAttachment {
  id: string
  noteId: string
  filename: string
  mimeType: string
  size: number
  storagePath: string
  createdAt: Date
}

export interface CreateNoteInput {
  title: string
  content?: string
  folderPath?: string
  tags?: string[]
  pinned?: boolean
  includeInContext?: boolean
  userId?: string
}

export interface UpdateNoteInput {
  title?: string
  content?: string
  folderPath?: string
  tags?: string[]
  pinned?: boolean
  includeInContext?: boolean
}

export interface NoteWithLinks extends Note {
  outlinks: string[]   // note IDs this note links to
  backlinks: string[]  // note IDs that link to this note
  attachments: NoteAttachment[]
}

export interface GraphNode {
  id: string
  title: string
  folderPath: string
  tags: string[]
  linkCount: number
  includeInContext: boolean
}

export interface GraphEdge {
  from: string
  to: string
}

export interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export interface FolderNode {
  path: string
  name: string
  children: FolderNode[]
  noteCount: number
}

export interface NotesSettings {
  enabled: boolean
  autoIncludeInContext: boolean
  maxContextTokens: number
  graphPhysics: {
    gravity: number
    linkDistance: number
    chargeStrength: number
  }
  defaultFolderPath: string
}

export const DEFAULT_NOTES_SETTINGS: NotesSettings = {
  enabled: true,
  autoIncludeInContext: true,
  maxContextTokens: 2000,
  graphPhysics: {
    gravity: -200,
    linkDistance: 100,
    chargeStrength: -300,
  },
  defaultFolderPath: '/',
}
