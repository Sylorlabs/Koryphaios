/**
 * Folder and tag appearance for the Notes network.
 *
 * Appearance is presentation metadata only: an optional single emoji and an
 * optional color. Colors are stored as one of three forms so every surface can
 * resolve them against its own theme:
 *   - `accent`            → the user's theme accent (`var(--color-accent)`)
 *   - a palette token     → a named swatch from NOTE_APPEARANCE_PALETTE
 *   - `#rrggbb`           → a custom six-digit hex (three-digit input is expanded)
 *
 * The validators here are the single contract shared by the backend store, the
 * HTTP routes, the agent tools and the frontend editor.
 */

export const NOTE_APPEARANCE_ACCENT = 'accent' as const;

/** Named swatches. Mid-luminance shades so they keep contrast on both the light and dark surfaces. */
export const NOTE_APPEARANCE_PALETTE = {
  rose: '#e11d48',
  orange: '#ea580c',
  amber: '#d97706',
  lime: '#65a30d',
  green: '#16a34a',
  teal: '#0d9488',
  sky: '#0284c7',
  blue: '#2563eb',
  indigo: '#4f46e5',
  violet: '#7c3aed',
  pink: '#db2777',
  slate: '#64748b',
} as const;

export type NoteAppearancePaletteToken = keyof typeof NOTE_APPEARANCE_PALETTE;
export type NoteAppearanceColor =
  typeof NOTE_APPEARANCE_ACCENT | NoteAppearancePaletteToken | `#${string}`;

export const NOTE_APPEARANCE_COLOR_TOKENS: readonly string[] = [
  NOTE_APPEARANCE_ACCENT,
  ...Object.keys(NOTE_APPEARANCE_PALETTE),
];

export const NOTE_APPEARANCE_MAX_FOLDER_PATH_LENGTH = 1_000;
export const NOTE_APPEARANCE_MAX_TAG_LENGTH = 100;
const MAX_EMOJI_CODE_UNITS = 32;

const HEX_COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/;
const PICTOGRAPHIC = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
const CONTROL = /\p{Cc}/u;

export interface FolderAppearance {
  /** Canonical folder path, e.g. `/` or `/Projects/api`. */
  path: string;
  emoji?: string;
  color?: NoteAppearanceColor;
}

export interface TagAppearance {
  tag: string;
  color?: NoteAppearanceColor;
  emoji?: string;
}

/** Every folder and tag appearance stored for one project. */
export interface NotesAppearanceState {
  folders: FolderAppearance[];
  tags: TagAppearance[];
}

export type NoteAppearanceResult<T> = { ok: true; value: T } | { ok: false; error: string };

const ok = <T>(value: T): NoteAppearanceResult<T> => ({ ok: true, value });
const fail = <T = never>(error: string): NoteAppearanceResult<T> => ({ ok: false, error });

/** `undefined`, `null` and blank strings all mean "no value". */
function blankToUndefined(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return value;
}

/**
 * Exactly one grapheme cluster that is a pictograph or regional indicator
 * (so ZWJ families and flags count as one emoji; plain text, digits, and
 * multi-emoji strings do not).
 */
export function normalizeNoteAppearanceEmoji(
  value: unknown,
): NoteAppearanceResult<string | undefined> {
  const raw = blankToUndefined(value);
  if (raw === undefined) return ok(undefined);
  if (typeof raw !== 'string') return fail('Emoji must be text');
  const emoji = raw.trim();
  if (emoji.length > MAX_EMOJI_CODE_UNITS || CONTROL.test(emoji)) {
    return fail('Emoji must be a single emoji');
  }
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(emoji)];
  if (graphemes.length !== 1) return fail('Emoji must be exactly one emoji');
  if (!PICTOGRAPHIC.test(graphemes[0]!.segment)) return fail('Emoji must be a pictograph');
  return ok(emoji);
}

/** Accepts `accent`, a palette token, or `#hex` (three or six digits). Stored hex is lowercase six-digit. */
export function normalizeNoteAppearanceColor(
  value: unknown,
): NoteAppearanceResult<NoteAppearanceColor | undefined> {
  const raw = blankToUndefined(value);
  if (raw === undefined) return ok(undefined);
  if (typeof raw !== 'string') return fail('Color must be text');
  const color = raw.trim().toLowerCase();
  if (color === NOTE_APPEARANCE_ACCENT) return ok(NOTE_APPEARANCE_ACCENT);
  if (Object.hasOwn(NOTE_APPEARANCE_PALETTE, color)) return ok(color as NoteAppearancePaletteToken);
  const hex = HEX_COLOR.exec(color);
  if (hex) {
    const digits = hex[1]!;
    const expanded =
      digits.length === 3
        ? digits
            .split('')
            .map((digit) => digit + digit)
            .join('')
        : digits;
    return ok(`#${expanded}` as NoteAppearanceColor);
  }
  return fail('Color must be accent, a palette name, or a #hex value');
}

/** Canonical folder path: leading slash, no empty/relative segments, `/` is the root. */
export function normalizeFolderAppearancePath(value: unknown): NoteAppearanceResult<string> {
  if (typeof value !== 'string') return fail('Folder path must be text');
  if (CONTROL.test(value)) return fail('Folder path cannot contain control characters');
  const segments = value
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return fail('Folder path cannot contain relative segments');
  }
  const path = segments.length === 0 ? '/' : `/${segments.join('/')}`;
  if (path.length > NOTE_APPEARANCE_MAX_FOLDER_PATH_LENGTH) return fail('Folder path is too long');
  return ok(path);
}

export function normalizeTagAppearanceTag(value: unknown): NoteAppearanceResult<string> {
  if (typeof value !== 'string') return fail('Tag must be text');
  const tag = value.trim();
  if (!tag) return fail('Tag cannot be empty');
  if (tag.length > NOTE_APPEARANCE_MAX_TAG_LENGTH || CONTROL.test(tag)) {
    return fail(
      `Tags cannot exceed ${NOTE_APPEARANCE_MAX_TAG_LENGTH} characters or contain controls`,
    );
  }
  return ok(tag);
}

/** True when neither an emoji nor a color is set, meaning the record should be dropped. */
export function appearanceIsEmpty(appearance: { emoji?: string; color?: string }): boolean {
  return !appearance.emoji && !appearance.color;
}

export function normalizeFolderAppearance(input: {
  path: unknown;
  emoji?: unknown;
  color?: unknown;
}): NoteAppearanceResult<FolderAppearance | null> {
  const path = normalizeFolderAppearancePath(input.path);
  if (!path.ok) return path;
  const emoji = normalizeNoteAppearanceEmoji(input.emoji);
  if (!emoji.ok) return emoji;
  const color = normalizeNoteAppearanceColor(input.color);
  if (!color.ok) return color;
  const value: FolderAppearance = {
    path: path.value,
    ...(emoji.value ? { emoji: emoji.value } : {}),
    ...(color.value ? { color: color.value } : {}),
  };
  return ok(appearanceIsEmpty(value) ? null : value);
}

export function normalizeTagAppearance(input: {
  tag: unknown;
  emoji?: unknown;
  color?: unknown;
}): NoteAppearanceResult<TagAppearance | null> {
  const tag = normalizeTagAppearanceTag(input.tag);
  if (!tag.ok) return tag;
  const emoji = normalizeNoteAppearanceEmoji(input.emoji);
  if (!emoji.ok) return emoji;
  const color = normalizeNoteAppearanceColor(input.color);
  if (!color.ok) return color;
  const value: TagAppearance = {
    tag: tag.value,
    ...(emoji.value ? { emoji: emoji.value } : {}),
    ...(color.value ? { color: color.value } : {}),
  };
  return ok(appearanceIsEmpty(value) ? null : value);
}

/** Resolve a stored color to a CSS value. `accent` maps to the theme token; palette names and hex pass through. */
export function resolveNoteAppearanceColorCss(color: string | undefined): string | undefined {
  if (!color) return undefined;
  if (color === NOTE_APPEARANCE_ACCENT) return 'var(--color-accent)';
  if (Object.hasOwn(NOTE_APPEARANCE_PALETTE, color)) {
    return NOTE_APPEARANCE_PALETTE[color as NoteAppearancePaletteToken];
  }
  return color;
}
