import type {
  NoteProperty,
  NotePropertyType,
  NotePropertyValue,
  NotePropertyWarning,
} from '../notes/NoteProperties';

export interface NotePropertiesSnapshot {
  noteId: string;
  revision: number;
  status: 'valid' | 'invalid' | 'unsupported';
  hasFrontmatter?: boolean;
  properties: NoteProperty[];
  warnings: NotePropertyWarning[];
}

export type NotePropertyPatch =
  | { op: 'set'; key: string; type: NotePropertyType; value: NotePropertyValue }
  | { op: 'remove'; key: string };

export interface NotePropertySchema {
  key: string;
  displayName: string;
  kind: NotePropertyType;
  revision: number;
  usageCount: number;
  invalidCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export const NOTE_BASE_SYSTEM_FIELDS = [
  'title',
  'folder',
  'tags',
  'pinned',
  'context',
  'created',
  'updated',
  'format',
] as const;

export type NoteBaseSystemField = (typeof NOTE_BASE_SYSTEM_FIELDS)[number];

export type NoteBaseField =
  | { source: 'system'; field: NoteBaseSystemField }
  | { source: 'property'; key: string; type: NotePropertyType };

export type NoteBaseOperator =
  | 'eq'
  | 'neq'
  | 'contains'
  | 'not_contains'
  | 'starts_with'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'is_empty'
  | 'is_not_empty';

export type NoteBaseFilter =
  | {
      kind: 'predicate';
      field: NoteBaseField;
      operator: NoteBaseOperator;
      value?: NotePropertyValue;
    }
  | {
      kind: 'group';
      operator: 'and' | 'or';
      filters: NoteBaseFilter[];
    };

export interface NoteBaseSort {
  field: NoteBaseField;
  direction: 'asc' | 'desc';
}

export interface NoteBaseView {
  kind: 'table' | 'list' | 'card';
  fields: NoteBaseField[];
}

export interface NoteBaseDefinition {
  version: 1;
  filter?: NoteBaseFilter;
  sort: NoteBaseSort[];
  groupBy?: NoteBaseField;
  view: NoteBaseView;
}

export interface NoteBase {
  id: string;
  name: string;
  definition: NoteBaseDefinition;
  revision: number;
  trashedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface NoteBaseQueryRow {
  id: string;
  title: string;
  folderPath: string;
  tags: string[];
  pinned: boolean;
  includeInContext: boolean;
  format: 'markdown' | 'html';
  createdAt: Date;
  updatedAt: Date;
  properties: Record<string, NotePropertyValue>;
  groupValue?: string | number | boolean | null;
}

export interface NoteBaseQueryResult {
  rows: NoteBaseQueryRow[];
  limit: number;
  offset: number;
  hasMore: boolean;
  invalidDocumentCount: number;
}

export type NoteDraftState = 'recoverable' | 'conflict' | 'trashed' | 'orphaned';

export interface NoteDraftSummary {
  id: string;
  noteId: string;
  baseRevision: number;
  draftRevision: number;
  baseTitle: string;
  sourcePathAtBase?: string;
  title: string;
  contentBytes: number;
  payloadHash?: string;
  createdAt: Date;
  updatedAt: Date;
  state: NoteDraftState;
  currentRevision?: number;
}

export interface NoteDraft extends NoteDraftSummary {
  content: string;
  folderPath: string;
  tags: string[];
  pinned: boolean;
  includeInContext: boolean;
  format: 'markdown' | 'html';
}

export interface CreateNoteDraftInput {
  noteId: string;
  baseRevision: number;
  baseTitle?: string;
  title: string;
  content: string;
  folderPath: string;
  tags: string[];
  pinned: boolean;
  includeInContext: boolean;
  format: 'markdown' | 'html';
}

export interface UpdateNoteDraftInput
  extends Omit<CreateNoteDraftInput, 'noteId' | 'baseRevision' | 'baseTitle'> {
  expectedDraftRevision: number;
}

export type VaultRestoreConflictKind =
  | 'source_exists'
  | 'note_id_exists'
  | 'attachment_exists'
  | 'base_name_exists'
  | 'archive_invalid';

export interface VaultRestoreConflict {
  kind: VaultRestoreConflictKind;
  archiveId?: string;
  path?: string;
  message: string;
}

export interface VaultRestorePreview {
  format: 'koryphaios-notes-vault';
  archiveVersion: 1 | 2;
  projectName: string;
  archiveSha256: string;
  notes: number;
  revisions: number;
  attachments: number;
  links: number;
  bases: number;
  drafts: number;
  noOpNotes: number;
  conflicts: VaultRestoreConflict[];
  canRestore: boolean;
  mode: 'safe-merge';
}

export interface VaultRestoreResult extends VaultRestorePreview {
  restoredNotes: number;
  restoredRevisions: number;
  restoredAttachments: number;
  restoredLinks: number;
  restoredBases: number;
  restoredDrafts: number;
}
