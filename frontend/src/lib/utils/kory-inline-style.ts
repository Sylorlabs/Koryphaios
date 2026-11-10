// Safe agent inline styling for chat markdown.
//
// Agents can style inline text three ways (all validated, all XSS-safe):
//   [display]{color, size, flags}  — e.g. [alert]{red, large, bold},
//                                    [note]{color=accent, size=xl}
//   ==highlight==                  — accent-tinted <mark>
//   ++underline++                   — <u>
//   <span style="...">...</span>    — validated safe subset (see
//                                    sanitizeInlineHtmlStyles)
//
// Colors accept #hex, rgb()/rgba(), hsl()/hsla(), CSS named colors, plus the
// `accent` / `secondary-accent` keywords. Those keywords resolve to the
// user's theme accent (`var(--color-accent)`), so agents can explicitly
// prioritize the user's chosen accent while still reaching for custom colors
// when emphasis genuinely calls for it.
//
// Everything this module emits is a plain <span>/<mark>/<u> with an allowlist
// of CSS properties and tightly validated values. It must stay in sync with
// the fenced `color` block validator in color-renderer.ts (same value forms).

import type { Token } from 'marked';

export interface ParsedInlineStyle {
  /** Validated CSS declarations joined for a style attribute (no quotes). */
  css: string;
}

const HEX_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const FN_INNER_RE = /^[\d.,%]+$/;

// Small named-color set for inline text. The fenced color-block renderer
// carries the full list; inline text only needs the common cases — anything
// else must use #hex or a functional notation.
const NAMED_COLORS = new Set([
  'black',
  'white',
  'red',
  'green',
  'blue',
  'yellow',
  'cyan',
  'magenta',
  'gray',
  'grey',
  'silver',
  'maroon',
  'olive',
  'lime',
  'aqua',
  'teal',
  'navy',
  'fuchsia',
  'purple',
  'orange',
  'gold',
  'pink',
  'brown',
  'tan',
  'salmon',
  'coral',
  'tomato',
  'crimson',
  'indigo',
  'violet',
  'plum',
  'orchid',
  'khaki',
  'wheat',
  'ivory',
  'snow',
  'azure',
  'lavender',
  'beige',
]);

/** User-accent keywords agents use to prioritize the chosen theme accent. */
export function accentKeywordCss(keyword: string): string | null {
  switch (keyword.trim().toLowerCase()) {
    case 'accent':
      return 'var(--color-accent)';
    case 'secondary':
    case 'secondary-accent':
    case 'accent-secondary':
      return 'var(--color-accent-secondary)';
    default:
      return null;
  }
}

/** Validate an inline color value. Returns safe CSS or null. */
export function sanitizeInlineColor(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  const accent = accentKeywordCss(value);
  if (accent) return accent;
  // Agents instructed to prefer the theme accent may write the CSS variable
  // directly in raw HTML. Admit only the exact known-safe references.
  const lowerExact = value.toLowerCase().replace(/\s+/g, '');
  if (lowerExact === 'var(--color-accent)') return 'var(--color-accent)';
  if (
    lowerExact === 'var(--color-accent-secondary)' ||
    lowerExact === 'var(--color-accent-secondary-hover)'
  ) {
    return 'var(--color-accent-secondary)';
  }
  if (HEX_RE.test(value)) return value;
  const lower = value.toLowerCase();
  const fnMatch = /^(rgba?|hsla?)\(([^)]*)\)$/i.exec(lower);
  if (fnMatch) {
    const inner = fnMatch[2].replace(/\s+/g, '');
    if (!inner || !FN_INNER_RE.test(inner)) return null;
    return `${fnMatch[1]}(${inner})`;
  }
  if (NAMED_COLORS.has(lower)) return lower;
  return null;
}

const NAMED_SIZES: Record<string, string> = {
  xs: '0.75em',
  sm: '0.875em',
  small: '0.875em',
  base: '1em',
  medium: '1em',
  lg: '1.125em',
  large: '1.125em',
  xl: '1.25em',
  'x-large': '1.25em',
  '2xl': '1.5em',
  'xx-large': '1.5em',
  '3xl': '1.875em',
};

/** Validate an inline font size. Named, px (10–48), em/rem (0.7–3), % (70–300). */
export function sanitizeInlineFontSize(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  const named = NAMED_SIZES[value];
  if (named) return named;
  const numeric = /^(\d+(?:\.\d+)?)(px|r?em|%)$/.exec(value);
  if (numeric) {
    const amount = Number(numeric[1]);
    if (!Number.isFinite(amount)) return null;
    switch (numeric[2]) {
      case 'px':
        if (amount < 10 || amount > 48) return null;
        return `${amount}px`;
      case 'em':
      case 'rem':
        if (amount < 0.7 || amount > 3) return null;
        return `${amount}em`;
      case '%':
        if (amount < 70 || amount > 300) return null;
        return `${amount}%`;
      default:
        return null;
    }
  }
  // Bare number means px.
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const amount = Number(value);
    if (amount >= 10 && amount <= 48) return `${amount}px`;
  }
  return null;
}

function sanitizeFontWeight(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  if (['normal', 'bold', 'bolder', 'lighter'].includes(value)) return value;
  if (/^[1-9]00$/.test(value)) return value;
  return null;
}

const COLOR_KEYS = new Set(['color', 'c', 'colour', 'fg', 'text']);
const SIZE_KEYS = new Set(['size', 's', 'font-size']);
const BG_KEYS = new Set(['bg', 'background', 'background-color', 'highlight']);
const FLAG_WORDS: Record<string, string> = {
  bold: 'font-weight:700',
  b: 'font-weight:700',
  italic: 'font-style:italic',
  i: 'font-style:italic',
  underline: 'text-decoration:underline',
  u: 'text-decoration:underline',
  strike: 'text-decoration:line-through',
  strikethrough: 'text-decoration:line-through',
  mark: 'mark',
  highlight: 'mark',
  hl: 'mark',
};
const FALSY = new Set(['0', 'false', 'no', 'off', 'none']);

/** Split on commas/semicolons that are not inside parens (rgb() may contain commas). */
function splitTopLevel(raw: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of raw) {
    if (char === '(') depth++;
    if (char === ')') depth = Math.max(0, depth - 1);
    if ((char === ',' || char === ';') && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/**
 * Parse `[display]{attrs}` attribute lists. Returns validated CSS or null when
 * any token is unrecognized — null leaves the source literal so a typo stays
 * visible instead of silently dropping the author's intent.
 */
export function parseInlineStyleAttrs(raw: string): ParsedInlineStyle | null {
  const declarations: string[] = [];
  let markRequested = false;
  const seen = new Set<string>();
  const parts = splitTopLevel(raw);
  if (!parts.length) return null;

  const push = (property: string, css: string) => {
    if (seen.has(property)) return;
    seen.add(property);
    declarations.push(css);
  };

  for (const part of parts) {
    const kvMatch = /^([a-zA-Z-]+)\s*[:=]\s*(.+)$/.exec(part);
    if (kvMatch) {
      const key = kvMatch[1].toLowerCase();
      const val = kvMatch[2].trim();
      if (COLOR_KEYS.has(key)) {
        const color = sanitizeInlineColor(val);
        if (!color) return null;
        push('color', `color:${color}`);
        continue;
      }
      if (SIZE_KEYS.has(key)) {
        const size = sanitizeInlineFontSize(val);
        if (!size) return null;
        push('font-size', `font-size:${size}`);
        continue;
      }
      if (BG_KEYS.has(key)) {
        const bg = sanitizeInlineColor(val);
        if (!bg) return null;
        push('background-color', `background-color:${bg}`);
        continue;
      }
      if (key === 'weight' || key === 'font-weight') {
        const weight = sanitizeFontWeight(val);
        if (!weight) return null;
        push('font-weight', `font-weight:${weight}`);
        continue;
      }
      const flag = FLAG_WORDS[key];
      if (flag && !FALSY.has(val.toLowerCase())) {
        if (flag === 'mark') markRequested = true;
        else push(flag.split(':')[0], flag);
        continue;
      }
      return null;
    }
    // Bare token: color, size, or flag word.
    const bare = part.toLowerCase();
    const flag = FLAG_WORDS[bare];
    if (flag && bare !== 's') {
      if (flag === 'mark') markRequested = true;
      else push(flag.split(':')[0], flag);
      continue;
    }
    const color = sanitizeInlineColor(part);
    if (color) {
      push('color', `color:${color}`);
      continue;
    }
    const size = sanitizeInlineFontSize(part);
    if (size) {
      push('font-size', `font-size:${size}`);
      continue;
    }
    return null;
  }

  if (!declarations.length && !markRequested) return null;
  if (markRequested && !seen.has('background-color')) {
    // Default highlight tracks the user's accent instead of a fixed yellow.
    declarations.push('background:color-mix(in srgb, var(--color-accent) 24%, transparent)');
  }
  return { css: declarations.join(';') };
}

// ── marked inline extensions ──────────────────────────────────────────────
// Each tokenizer returns undefined for input it does not own so the source
// stays literal. Nested markdown inside the display text (bold, links, code)
// is re-lexed so agents can compose formatting.

type InlineLexerThis = { lexer: { inlineTokens: (src: string) => Token[] } };
type InlineRendererThis = { parser: { parseInline: (tokens: Token[]) => string } };

const STYLE_ATTRS_RE = /^\[([^\]\n]+)\]\{([^}\n]{1,240})\}/;

export const koryInlineStyleExtension = {
  name: 'koryInlineStyle',
  level: 'inline' as const,
  start(src: string): number | undefined {
    const index = src.indexOf(']{');
    return index === -1 ? undefined : index;
  },
  tokenizer(this: InlineLexerThis, src: string) {
    const match = STYLE_ATTRS_RE.exec(src);
    if (!match) return undefined;
    const parsed = parseInlineStyleAttrs(match[2]);
    if (!parsed) return undefined;
    const text = match[1].trim();
    if (!text) return undefined;
    return {
      type: 'koryInlineStyle',
      raw: match[0],
      text,
      tokens: this.lexer.inlineTokens(text),
      css: parsed.css,
    };
  },
  renderer(this: InlineRendererThis, token: { tokens: Token[]; css: string }) {
    const inner = this.parser.parseInline(token.tokens);
    return `<span class="kory-inline" style="${token.css}">${inner}</span>`;
  },
};

export const koryHighlightExtension = {
  name: 'koryHighlight',
  level: 'inline' as const,
  start(src: string): number | undefined {
    const index = src.indexOf('==');
    return index === -1 ? undefined : index;
  },
  tokenizer(this: InlineLexerThis, src: string) {
    const match = /^==(?!=)(?!\s)([^=\n]+?)(?<!\s)==(?!=)/.exec(src);
    if (!match) return undefined;
    return {
      type: 'koryHighlight',
      raw: match[0],
      text: match[1],
      tokens: this.lexer.inlineTokens(match[1]),
    };
  },
  renderer(this: InlineRendererThis, token: { tokens: Token[] }) {
    return `<mark class="kory-mark">${this.parser.parseInline(token.tokens)}</mark>`;
  },
};

export const koryUnderlineExtension = {
  name: 'koryUnderline',
  level: 'inline' as const,
  start(src: string): number | undefined {
    const index = src.indexOf('++');
    return index === -1 ? undefined : index;
  },
  tokenizer(this: InlineLexerThis, src: string) {
    // Lookbehinds keep C++ / a++b-style code prose literal: the opener must
    // not follow a word char or plus, and neither edge may be whitespace.
    const match = /(?<![+\w])\+\+(?!\s)((?:(?!\+\+)[^+\n]|\B\+|\+\B)+?)(?<!\s)\+\+(?!\+)/.exec(src);
    if (!match || match.index !== 0) return undefined;
    return {
      type: 'koryUnderline',
      raw: match[0],
      text: match[1],
      tokens: this.lexer.inlineTokens(match[1]),
    };
  },
  renderer(this: InlineRendererThis, token: { tokens: Token[] }) {
    return `<u class="kory-underline">${this.parser.parseInline(token.tokens)}</u>`;
  },
};

// ── Raw-HTML style validation ─────────────────────────────────────────────
// Agents will also reach for familiar <span style="..."> markup (marked
// passes inline HTML through and DOMPurify keeps style attributes). This
// post-sanitizer pass rebuilds every style attribute from validated parts so
// only the safe subset survives: no url(), no expression(), no !important,
// no layout/position/behavior properties — just color, size, and emphasis.

const ALLOWED_STYLE_TAGS = new Set([
  'span',
  'font',
  'mark',
  'b',
  'strong',
  'i',
  'em',
  'u',
  's',
  'del',
  'ins',
  'small',
  'big',
  'sub',
  'sup',
  'kbd',
]);

const SAFE_CLASS_RE = /^[A-Za-z0-9_][A-Za-z0-9_ -]*$/;

function sanitizeStyleDeclarations(style: string): string | null {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const declaration of style.split(';')) {
    const trimmed = declaration.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(':');
    if (colon === -1) continue;
    const property = trimmed.slice(0, colon).trim().toLowerCase();
    // !important never reaches the output: strip it and keep the validated
    // declaration so `color:red !important` degrades to `color:red`.
    const value = trimmed
      .slice(colon + 1)
      .replace(/\s*!important\s*/gi, '')
      .trim();
    if (!value || seen.has(property)) continue;
    // Structural gate: values are re-emitted from typed validators below, so
    // anything shaped like an escape hatch never reaches the output.
    if (/[<>\"'`\\!]/.test(value)) continue;
    const lowered = value.toLowerCase();
    // Function-shaped values are admitted only for the color functions the
    // typed validators accept (rgb()/hsl() with numeric contents) and the
    // exact theme-accent references. Everything else shaped like a call —
    // url(), expression(), calc(), attr(), env() — is rejected here.
    const compact = lowered.replace(/\s+/g, '');
    const isSafeCall =
      compact === 'var(--color-accent)' ||
      compact === 'var(--color-accent-secondary)' ||
      /^(rgba?|hsla?)\([\d.,%]+\)$/.test(compact);
    if (
      !isSafeCall &&
      (lowered.includes('(') ||
        lowered.includes('behavior') ||
        lowered.includes('binding') ||
        lowered.includes('javascript:'))
    ) {
      continue;
    }
    let css: string | null = null;
    switch (property) {
      case 'color':
        css = sanitizeInlineColor(value);
        if (css) css = `color:${css}`;
        break;
      case 'background':
      case 'background-color':
        css = sanitizeInlineColor(value);
        if (css) css = `background-color:${css}`;
        break;
      case 'font-size':
        css = sanitizeInlineFontSize(value);
        if (css) css = `font-size:${css}`;
        break;
      case 'font-weight': {
        const weight =
          value === '700' || value.toLowerCase() === 'bold' ? '700' : sanitizeFontWeight(value);
        if (weight) css = `font-weight:${weight}`;
        break;
      }
      case 'font-style':
        if (['normal', 'italic', 'oblique'].includes(lowered)) css = `font-style:${lowered}`;
        break;
      case 'text-decoration':
        if (['underline', 'line-through', 'underline line-through', 'none'].includes(lowered)) {
          css = `text-decoration:${lowered}`;
        }
        break;
      case 'text-decoration-color': {
        const color = sanitizeInlineColor(value);
        if (color) css = `text-decoration-color:${color}`;
        break;
      }
      default:
        continue;
    }
    if (css) {
      seen.add(property);
      out.push(css);
    }
  }
  return out.length ? out.join(';') : null;
}

/**
 * Validate style/class/color attributes on inline HTML that survived
 * DOMPurify. Runs on sanitized output (no event handlers, no script URLs —
 * DOMPurify already removed those); this pass only clamps the style subset.
 */
export function sanitizeInlineHtmlStyles(html: string): string {
  return html.replace(
    /<(span|font|mark|b|strong|i|em|u|s|del|ins|small|big|sub|sup|kbd)((?:\s+[a-zA-Z-]+(?:="[^"]*"|='[^']*'|[^\s>]*))*)>/g,
    (tag, tagName: string, attrs: string) => {
      if (!ALLOWED_STYLE_TAGS.has(tagName.toLowerCase())) return tag;
      let style: string | null = null;
      let cssClass: string | null = null;
      const attrRe = /([a-zA-Z-]+)(?:=("([^"]*)"|'([^']*)'|([^\s>]*)))?/g;
      let match: RegExpExecArray | null;
      let fontColor: string | null = null;
      while ((match = attrRe.exec(attrs)) !== null) {
        const name = match[1].toLowerCase();
        const val = match[3] ?? match[4] ?? match[5] ?? '';
        if (name === 'style') {
          style = sanitizeStyleDeclarations(val);
        } else if (name === 'class' && SAFE_CLASS_RE.test(val)) {
          cssClass = val.trim().replace(/\s+/g, ' ');
        } else if (tagName.toLowerCase() === 'font' && name === 'color') {
          const color = sanitizeInlineColor(val);
          if (color) fontColor = `color:${color}`;
        }
      }
      const declarations = [style, fontColor].filter(Boolean).join(';');
      let rebuilt = `<${tagName}`;
      if (cssClass) rebuilt += ` class="${cssClass}"`;
      if (declarations) rebuilt += ` style="${declarations}"`;
      return `${rebuilt}>`;
    },
  );
}
