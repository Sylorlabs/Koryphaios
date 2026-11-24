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
  // Block is absolute: no permission mode may widen it.
  if (level === 'block') return level;
  // Guarded and YOLO relax inherited defaults only. The Notes vault is its own
  // security surface, so a tool the user set explicitly (recorded in
  // `overrides`, which normalization also fills from a non-default preset)
  // keeps its Ask even when the chat preset is YOLO — a preset chosen to avoid
  // chat approvals is not consent to publish, edit or review notes silently.
  if (mode === 'yolo' || mode === 'guarded') {
    // A choice is explicit when it is recorded in `overrides` (which also picks
    // up a non-default preset) or when the stored level differs from that
    // tool's default — older configs write the level without an override row.
    const explicit =
      permissions.overrides?.[name] !== undefined || level !== DEFAULT_NOTE_TOOL_PERMISSIONS[name];
    return explicit ? level : 'auto';
  }
  return level;
}
