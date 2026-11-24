/** Presentation metadata is independent of document revisions and draft text. */
export interface NoteIcon {
  /**
   * `builtin` is one of the curated quick picks (kept for stored icons written
   * before free emoji existed). `emoji` is any single emoji grapheme. `image`
   * is a bounded raster data URL.
   */
  kind: 'builtin' | 'emoji' | 'image';
  value: string;
  /** Optional user-authored label shown beside the glyph in notes and graphs. */
  label?: string;
}

export const MAX_NOTE_ICON_LABEL_LENGTH = 48;
/** Upper bound on the UTF-16 length of a single emoji grapheme, ZWJ sequences included. */
export const MAX_NOTE_EMOJI_LENGTH = 32;

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

const EMOJI_PICTOGRAPH = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
/** Keycap sequences such as 1️⃣ are emoji but carry no pictograph property. */
const KEYCAP = /^[0-9#*]️?⃣$/u;
const CONTROL = /[\x00-\x1f\x7f]/;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * True when the value is exactly one emoji grapheme: a single pictograph,
 * flag, keycap, or ZWJ/skin-tone/variation-selector sequence. Plain text,
 * digits, control characters, surrounding whitespace, multiple emoji and
 * oversized sequences are rejected.
 */
export function isNoteEmoji(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > MAX_NOTE_EMOJI_LENGTH) return false;
  if (value !== value.trim() || CONTROL.test(value)) return false;
  let count = 0;
  let only = '';
  for (const { segment } of graphemes.segment(value)) {
    count += 1;
    only = segment;
    if (count > 1) return false;
  }
  if (count !== 1) return false;
  return KEYCAP.test(only) || EMOJI_PICTOGRAPH.test(only);
}

export function isNoteIconLabel(label: unknown): label is string {
  if (typeof label !== 'string') return false;
  const trimmed = label.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_NOTE_ICON_LABEL_LENGTH && !CONTROL.test(trimmed);
}

export function isNoteIcon(value: unknown): value is NoteIcon {
  if (!value || typeof value !== 'object') return false;
  const icon = value as NoteIcon;
  if (icon.label !== undefined && !isNoteIconLabel(icon.label)) return false;
  if (icon.kind === 'builtin') return NOTE_ICON_CHOICES.some((choice) => choice.value === icon.value);
  if (icon.kind === 'emoji') return isNoteEmoji(icon.value);
  return (
    icon.kind === 'image' &&
    typeof icon.value === 'string' &&
    icon.value.length <= MAX_NOTE_ICON_DATA_LENGTH &&
    /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(icon.value)
  );
}
