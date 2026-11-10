/** Presentation metadata is independent of document revisions and draft text. */
export interface NoteIcon {
  kind: 'builtin' | 'image';
  value: string;
}

export const NOTE_ICON_CHOICES = [
  { value: '📄', label: 'Document' },
  { value: '💡', label: 'Idea' },
  { value: '✅', label: 'Task' },
  { value: '⚡', label: 'Important' },
  { value: '🧠', label: 'Thinking' },
  { value: '📌', label: 'Pinned' },
  { value: '🔗', label: 'Reference' },
  { value: '⭐', label: 'Favorite' },
  { value: '🛠️', label: 'Work' },
  { value: '🎯', label: 'Goal' },
  { value: '📝', label: 'Draft' },
  { value: '🧪', label: 'Experiment' },
] as const;

export const MAX_NOTE_ICON_DATA_LENGTH = 500_000;

export function isNoteIcon(value: unknown): value is NoteIcon {
  if (!value || typeof value !== 'object') return false;
  const icon = value as NoteIcon;
  if (icon.kind === 'builtin') return NOTE_ICON_CHOICES.some((choice) => choice.value === icon.value);
  return (
    icon.kind === 'image' &&
    typeof icon.value === 'string' &&
    icon.value.length <= MAX_NOTE_ICON_DATA_LENGTH &&
    /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(icon.value)
  );
}
