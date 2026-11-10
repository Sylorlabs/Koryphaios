/**
 * Stable project identity is deliberately separate from a checkout path. A
 * project can have more than one checkout, and a path or basename is not a
 * durable identity by itself.
 */
export type ProjectId = string;

export interface ProjectCheckout {
  projectId: ProjectId;
  rootPath: string;
}

export const PROJECT_ICON_MODES = ['automatic', 'emoji', 'monogram', 'color', 'image'] as const;
export type ProjectIconMode = (typeof PROJECT_ICON_MODES)[number];

export const PROJECT_ICON_SHAPES = ['circle', 'rounded-square', 'square'] as const;
export type ProjectIconShape = (typeof PROJECT_ICON_SHAPES)[number];

/** Theme tokens understood by consumers; arbitrary CSS is not part of the contract. */
export const PROJECT_ICON_COLORS = [
  'accent',
  'blue',
  'green',
  'orange',
  'pink',
  'purple',
  'teal',
] as const;
export type ProjectIconColor = (typeof PROJECT_ICON_COLORS)[number];

/** A validated, canonical six-digit hex color for project-owned accents. */
export type ProjectIconCustomColor = `#${string}`;

type ProjectIconPresentation = {
  color?: ProjectIconColor;
  customColor?: ProjectIconCustomColor;
  shape?: ProjectIconShape;
};

export type ProjectIconSpec =
  | ({ mode: 'automatic' } & ProjectIconPresentation)
  | ({ mode: 'emoji'; value: string } & ProjectIconPresentation)
  | ({ mode: 'monogram'; value: string } & ProjectIconPresentation)
  | ({ mode: 'color' } & ProjectIconPresentation)
  | ({ mode: 'image'; assetId: string } & ProjectIconPresentation);

export interface ProjectIdentity {
  /** Stable application identity. Do not derive this from rootPath or basename alone. */
  id: ProjectId;
  name: string;
  icon: ProjectIconSpec;
  /** Server-managed retrieval URL for image icons; never a filesystem path. */
  assetUrl?: string;
}

export const MAX_PROJECT_EMOJI_GRAPHEMES = 1;
export const MAX_PROJECT_MONOGRAM_GRAPHEMES = 2;

const PROJECT_ICON_COLOR_SET = new Set<string>(PROJECT_ICON_COLORS);
const PROJECT_ICON_MODE_SET = new Set<string>(PROJECT_ICON_MODES);
const PROJECT_ICON_SHAPE_SET = new Set<string>(PROJECT_ICON_SHAPES);
const CONTROL_CHARACTERS = /\p{Cc}/u;
const OPAQUE_ASSET_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,255}$/u;
const HEX_COLOR = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/iu;

type GraphemeSegmenter = {
  segment(input: string): Iterable<{ segment: string }>;
};

function segmentGraphemes(value: string): string[] {
  const Segmenter = (
    Intl as typeof Intl & {
      Segmenter?: new (
        locales?: string | string[],
        options?: { granularity: 'grapheme' },
      ) => GraphemeSegmenter;
    }
  ).Segmenter;
  if (Segmenter) {
    return Array.from(
      new Segmenter(undefined, { granularity: 'grapheme' }).segment(value),
      (part) => part.segment,
    );
  }

  // Older runtimes still get a useful fallback for combining marks, emoji
  // modifiers, joined emoji sequences, and regional-indicator flags.
  const graphemes: string[] = [];
  for (const character of value) {
    const previous = graphemes[graphemes.length - 1];
    const isMark = /\p{Mark}/u.test(character);
    const isVariationSelector = /[\uFE0E\uFE0F]/u.test(character);
    const isEmojiModifier = /[\u{1F3FB}-\u{1F3FF}]/u.test(character);
    const isJoiner = character === '\u200D';
    const joinsPrevious = previous?.endsWith('\u200D') === true;
    const isRegionalIndicator = /[\u{1F1E6}-\u{1F1FF}]/u.test(character);
    const previousIsRegionalIndicator = previous ? /[\u{1F1E6}-\u{1F1FF}]$/u.test(previous) : false;

    if (
      previous &&
      (isMark ||
        isVariationSelector ||
        isEmojiModifier ||
        isJoiner ||
        joinsPrevious ||
        (isRegionalIndicator && previousIsRegionalIndicator))
    ) {
      graphemes[graphemes.length - 1] += character;
    } else {
      graphemes.push(character);
    }
  }
  return graphemes;
}

function hasGraphemeCount(value: string, minimum: number, maximum: number): boolean {
  return (
    value.length > 0 &&
    value.trim() === value &&
    !CONTROL_CHARACTERS.test(value) &&
    segmentGraphemes(value).length >= minimum &&
    segmentGraphemes(value).length <= maximum
  );
}

function projectIconColor(value: unknown): ProjectIconColor | undefined {
  return typeof value === 'string' && PROJECT_ICON_COLOR_SET.has(value)
    ? (value as ProjectIconColor)
    : undefined;
}

export function normalizeProjectIconCustomColor(
  value: unknown,
): ProjectIconCustomColor | undefined {
  if (typeof value !== 'string') return undefined;
  const match = HEX_COLOR.exec(value.trim());
  if (!match) return undefined;
  const hex =
    match[1].length === 3
      ? match[1]
          .split('')
          .map((part) => part + part)
          .join('')
      : match[1];
  return `#${hex.toUpperCase()}` as ProjectIconCustomColor;
}

function projectIconShape(value: unknown): ProjectIconShape | undefined {
  return typeof value === 'string' && PROJECT_ICON_SHAPE_SET.has(value)
    ? (value as ProjectIconShape)
    : undefined;
}

function opaqueAssetId(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_ASSET_ID.test(value);
}

export function normalizeProjectIconMode(value: unknown): ProjectIconMode {
  return typeof value === 'string' && PROJECT_ICON_MODE_SET.has(value)
    ? (value as ProjectIconMode)
    : 'automatic';
}

/** Invalid or future icon data degrades to automatic instead of becoming unsafe UI data. */
export function normalizeProjectIconSpec(value: unknown): ProjectIconSpec {
  if (!value || typeof value !== 'object') return { mode: 'automatic' };
  const input = value as {
    mode?: unknown;
    value?: unknown;
    assetId?: unknown;
    color?: unknown;
    customColor?: unknown;
    shape?: unknown;
  };
  const color = projectIconColor(input.color);
  const customColor = normalizeProjectIconCustomColor(input.customColor);
  const shape = projectIconShape(input.shape);
  const presentation = {
    ...(color ? { color } : {}),
    ...(customColor ? { customColor } : {}),
    ...(shape ? { shape } : {}),
  };
  const mode = normalizeProjectIconMode(input.mode);

  if (
    mode === 'emoji' &&
    typeof input.value === 'string' &&
    hasGraphemeCount(input.value, 1, MAX_PROJECT_EMOJI_GRAPHEMES)
  ) {
    return { mode, value: input.value, color, ...presentationWithoutColor(presentation) };
  }
  if (
    mode === 'monogram' &&
    typeof input.value === 'string' &&
    hasGraphemeCount(input.value, 1, MAX_PROJECT_MONOGRAM_GRAPHEMES)
  ) {
    return { mode, value: input.value, color, ...presentationWithoutColor(presentation) };
  }
  if (mode === 'color' && color) return { mode, color, ...presentationWithoutColor(presentation) };
  if (mode === 'color' && customColor)
    return { mode, customColor, ...presentationWithoutColor(presentation) };
  if (mode === 'image' && opaqueAssetId(input.assetId)) {
    return { mode, assetId: input.assetId, color, ...presentationWithoutColor(presentation) };
  }
  if (mode === 'automatic') return { mode, ...presentation };
  if (color || customColor || shape) return { mode: 'automatic', ...presentation };
  return { mode: 'automatic' };
}

function presentationWithoutColor(presentation: {
  color?: ProjectIconColor;
  customColor?: ProjectIconCustomColor;
  shape?: ProjectIconShape;
}) {
  const { color: _color, ...rest } = presentation;
  return rest;
}

export function isProjectIconSpec(value: unknown): value is ProjectIconSpec {
  if (!value || typeof value !== 'object') return false;
  const input = value as {
    mode?: unknown;
    value?: unknown;
    assetId?: unknown;
    color?: unknown;
    customColor?: unknown;
    shape?: unknown;
  };
  if (normalizeProjectIconMode(input.mode) !== input.mode) return false;
  if (input.color !== undefined && projectIconColor(input.color) === undefined) return false;
  if (
    input.customColor !== undefined &&
    normalizeProjectIconCustomColor(input.customColor) === undefined
  )
    return false;
  if (input.shape !== undefined && projectIconShape(input.shape) === undefined) return false;
  switch (input.mode) {
    case 'automatic':
      return input.value === undefined && input.assetId === undefined;
    case 'emoji':
      return (
        typeof input.value === 'string' &&
        hasGraphemeCount(input.value, 1, MAX_PROJECT_EMOJI_GRAPHEMES) &&
        input.assetId === undefined
      );
    case 'monogram':
      return (
        typeof input.value === 'string' &&
        hasGraphemeCount(input.value, 1, MAX_PROJECT_MONOGRAM_GRAPHEMES) &&
        input.assetId === undefined
      );
    case 'color':
      return (
        input.value === undefined &&
        input.assetId === undefined &&
        (projectIconColor(input.color) !== undefined ||
          normalizeProjectIconCustomColor(input.customColor) !== undefined)
      );
    case 'image':
      return input.value === undefined && opaqueAssetId(input.assetId);
    default:
      return false;
  }
}

function hashProjectIdentity(identity: Pick<ProjectIdentity, 'id' | 'name'>): number {
  let hash = 2166136261;
  for (const character of `${identity.id}\u0000${identity.name}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function automaticMonogram(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  const initials = words
    .slice(0, MAX_PROJECT_MONOGRAM_GRAPHEMES)
    .map((word) => segmentGraphemes(word)[0] ?? '');
  const monogram = segmentGraphemes(initials.join('').toLocaleUpperCase()).slice(
    0,
    MAX_PROJECT_MONOGRAM_GRAPHEMES,
  );
  return monogram.join('') || '?';
}

/** Return the same concrete icon for the same identity on every client. */
export function automaticProjectIcon(
  identity: Pick<ProjectIdentity, 'id' | 'name'>,
): Extract<ProjectIconSpec, { mode: 'monogram' }> {
  const hash = hashProjectIdentity(identity);
  return {
    mode: 'monogram',
    value: automaticMonogram(identity.name),
    color: PROJECT_ICON_COLORS[hash % PROJECT_ICON_COLORS.length],
  };
}

/** Resolve explicit icon data while making automatic and unknown modes concrete. */
export function resolveProjectIcon(
  identity: Pick<ProjectIdentity, 'id' | 'name'>,
  value: unknown,
): Exclude<ProjectIconSpec, { mode: 'automatic' }> {
  const normalized = normalizeProjectIconSpec(value);
  if (normalized.mode !== 'automatic') return normalized;
  const automatic = automaticProjectIcon(identity);
  return {
    ...automatic,
    ...(normalized.color ? { color: normalized.color } : {}),
    ...(normalized.customColor ? { customColor: normalized.customColor } : {}),
    ...(normalized.shape ? { shape: normalized.shape } : {}),
  };
}
