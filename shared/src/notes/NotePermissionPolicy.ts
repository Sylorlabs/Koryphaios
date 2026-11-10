import {
  DEFAULT_NOTE_TOOL_PERMISSIONS,
  type NotesAgentPermissions,
  type NotePermissionLevel,
  type NoteToolName,
} from '../types/NoteTypes';

export function effectiveNotePermission(
  permissions: NotesAgentPermissions,
  name: NoteToolName,
  mode?: string,
): NotePermissionLevel {
  const level = permissions.overrides?.[name] ?? permissions.tools[name];
  if (level === 'block') return level;
  if (mode === 'yolo') return 'auto';
  // Guarded skips inherited defaults only. Explicit Ask settings still prompt.
  if (mode === 'guarded' && level === DEFAULT_NOTE_TOOL_PERMISSIONS[name]) return 'auto';
  return level;
}
