// Renders fenced `color` / `kory-color` blocks as themed swatch chips.
//
// Accepted inputs (any of):
//   1. Plain text, one color per line: `<value>[ <label>]`
//        #d5b261 Kintsugi gold
//        rgb(96,165,250) Sky
//   2. JSON object: { "value": "#d5b261", "label": "Gold" }
//   3. JSON array:  [{ "value": "#d5b261", "label": "Gold" }, ...]
//   4. JSON object: { "colors": [{ "value": ..., "label": ... }, ...] }
//
// Output is a `<figure class="kory-color">` wrapping a responsive grid of
// swatch chips. Color values are validated and HTML-escaped so they cannot
// break out of the `style` attribute.

interface ColorEntry {
  value: string;
  label?: string;
}

// CSS named colors (level 3 + a few level 4) mapped to their sRGB values so
// contrastOn can compute real luminance. Anything else must use a functional
// notation or hex form. This keeps the surface small and predictable while
// covering the common cases.
const NAMED_COLOR_RGB: ReadonlyMap<string, readonly [number, number, number]> = new Map([
  ['transparent', [0, 0, 0]],
  ['currentcolor', [0, 0, 0]],
  ['black', [0, 0, 0]],
  ['white', [255, 255, 255]],
  ['red', [255, 0, 0]],
  ['green', [0, 128, 0]],
  ['blue', [0, 0, 255]],
  ['yellow', [255, 255, 0]],
  ['cyan', [0, 255, 255]],
  ['magenta', [255, 0, 255]],
  ['gray', [128, 128, 128]],
  ['grey', [128, 128, 128]],
  ['silver', [192, 192, 192]],
  ['maroon', [128, 0, 0]],
  ['olive', [128, 128, 0]],
  ['lime', [0, 255, 0]],
  ['aqua', [0, 255, 255]],
  ['teal', [0, 128, 128]],
  ['navy', [0, 0, 128]],
  ['fuchsia', [255, 0, 255]],
  ['purple', [128, 0, 128]],
  ['orange', [255, 165, 0]],
  ['gold', [255, 215, 0]],
  ['pink', [255, 192, 203]],
  ['brown', [165, 42, 42]],
  ['tan', [210, 180, 140]],
  ['ivory', [255, 255, 240]],
  ['snow', [255, 250, 250]],
  ['azure', [240, 255, 255]],
  ['lavender', [230, 230, 250]],
  ['salmon', [250, 128, 114]],
  ['coral', [255, 127, 80]],
  ['tomato', [255, 99, 71]],
  ['khaki', [240, 230, 140]],
  ['wheat', [245, 222, 179]],
  ['crimson', [220, 20, 60]],
  ['indigo', [75, 0, 130]],
  ['violet', [238, 130, 238]],
  ['plum', [221, 160, 221]],
  ['orchid', [218, 112, 214]],
  ['thistle', [216, 191, 216]],
  ['mintcream', [245, 255, 250]],
  ['honeydew', [240, 255, 240]],
  ['seashell', [255, 245, 238]],
  ['linen', [250, 240, 230]],
  ['bisque', [255, 228, 196]],
  ['cornsilk', [255, 248, 220]],
  ['lemonchiffon', [255, 250, 205]],
  ['floralwhite', [255, 250, 240]],
  ['oldlace', [253, 245, 230]],
  ['antiquewhite', [250, 235, 215]],
  ['papayawhip', [255, 239, 213]],
  ['blanchedalmond', [255, 235, 205]],
  ['navajowhite', [255, 222, 173]],
  ['moccasin', [255, 228, 181]],
  ['peachpuff', [255, 218, 185]],
  ['mistyrose', [255, 228, 225]],
  ['gainsboro', [220, 220, 220]],
  ['darkgray', [169, 169, 169]],
  ['darkgrey', [169, 169, 169]],
  ['dimgray', [105, 105, 105]],
  ['dimgrey', [105, 105, 105]],
  ['lightslategray', [119, 136, 153]],
  ['lightslategrey', [119, 136, 153]],
  ['slategray', [112, 128, 144]],
  ['slategrey', [112, 128, 144]],
  ['darkslategray', [47, 79, 79]],
  ['darkslategrey', [47, 79, 79]],
  ['lightgray', [211, 211, 211]],
  ['lightgrey', [211, 211, 211]],
  ['aliceblue', [240, 248, 255]],
  ['ghostwhite', [248, 248, 255]],
  ['whitesmoke', [245, 245, 245]],
  ['beige', [245, 245, 220]],
]);

const HEX_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
// Functional notation inner content (after stripping whitespace): digits,
// dots, commas, and percent. This is permissive but blocks anything that
// could break out of the `style` attribute.
const FN_INNER_RE = /^[\d.,%]+$/;

function sanitizeColorValue(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  const lower = value.toLowerCase();
  if (HEX_RE.test(value)) return value;
  const fnMatch = /^(rgba?|hsla?)\(([^)]*)\)$/i.exec(lower);
  if (fnMatch) {
    const inner = fnMatch[2].replace(/\s+/g, '');
    if (!inner || !FN_INNER_RE.test(inner)) return null;
    return `${fnMatch[1]}(${inner})`;
  }
  if (NAMED_COLOR_RGB.has(lower)) return lower;
  return null;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttr(value: string): string {
  // For the `style` attribute: keep the color value intact but neutralize
  // characters that could close the attribute or chain new declarations.
  return value.replaceAll('"', '&quot;').replaceAll(';', '').replaceAll('<', '&lt;');
}

function fromLine(line: string): ColorEntry | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('//')) return null;
  // Functional notation (rgb/rgba/hsl/hsla) may contain internal spaces, so
  // consume up to the closing paren before splitting value from label.
  const fnMatch = /^(rgba?|hsla?)\(([^)]*)\)\s*(.*)$/i.exec(trimmed);
  if (fnMatch) {
    const value = sanitizeColorValue(`${fnMatch[1]}(${fnMatch[2]})`);
    if (!value) return null;
    const label = fnMatch[3]?.trim();
    return { value, label: label ? label : undefined };
  }
  // Otherwise split on the first run of whitespace: value then optional label.
  const match = /^(\S+)\s*(.*)$/.exec(trimmed);
  if (!match) return null;
  const value = sanitizeColorValue(match[1]);
  if (!value) return null;
  const label = match[2]?.trim();
  return { value, label: label ? label : undefined };
}

function fromJson(source: string): ColorEntry[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (err: unknown) {
    console.debug('Failed to parse color JSON:', err instanceof Error ? err.message : String(err));
    return null;
  }
  const MAX_DEPTH = 4;
  const collect = (item: unknown, depth = 0): ColorEntry[] => {
    if (!item || typeof item !== 'object' || depth > MAX_DEPTH) return [];
    const row = item as Record<string, unknown>;
    if (Array.isArray(row.colors)) return row.colors.flatMap((c) => collect(c, depth + 1));
    const value = sanitizeColorValue(String(row.value ?? row.color ?? ''));
    if (!value) return [];
    const label = row.label ? String(row.label) : row.name ? String(row.name) : undefined;
    return [{ value, label: label ? label : undefined }];
  };
  if (Array.isArray(raw)) return raw.flatMap((c) => collect(c)).slice(0, 24);
  const entries = collect(raw);
  return entries.length ? entries.slice(0, 24) : null;
}

function parseColors(source: string): ColorEntry[] | null {
  const trimmed = source.trim();
  if (!trimmed) return null;
  // JSON-shaped input starts with `{` or `[`.
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return fromJson(trimmed);
  }
  const lines = trimmed.split(/\r?\n/).map(fromLine).filter((e): e is ColorEntry => e !== null);
  return lines.length ? lines.slice(0, 24) : null;
}

/** Convert any supported color value to sRGB [r, g, b] (0–255). */
function colorToRgb(value: string): [number, number, number] | null {
  const lower = value.toLowerCase();
  if (lower.startsWith('#')) {
    const hex = lower.slice(1);
    const expand = (h: string) => h.split('').map((c) => c + c).join('');
    const full =
      hex.length === 3 || hex.length === 4
        ? expand(hex.slice(0, 3))
        : hex.length === 6 || hex.length === 8
          ? hex.slice(0, 6)
          : hex;
    return [
      parseInt(full.slice(0, 2), 16) || 0,
      parseInt(full.slice(2, 4), 16) || 0,
      parseInt(full.slice(4, 6), 16) || 0,
    ];
  }
  if (lower.startsWith('rgb')) {
    const parts = lower.match(/[\d.]+/g) ?? [];
    return [Number(parts[0]) || 0, Number(parts[1]) || 0, Number(parts[2]) || 0];
  }
  if (lower.startsWith('hsl')) {
    const parts = lower.match(/[\d.]+/g) ?? [];
    const h = Number(parts[0]) % 360;
    const s = Math.min(100, Math.max(0, Number(parts[1]) || 0)) / 100;
    const l = Math.min(100, Math.max(0, Number(parts[2]) || 0)) / 100;
    return hslToRgb(h, s, l);
  }
  const named = NAMED_COLOR_RGB.get(lower);
  return named ? [...named] : null;
}

/** HSL (h in degrees, s/l in 0–1) → sRGB [r, g, b] (0–255). */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hNorm = h / 360;
  return [
    Math.round(hue2rgb(p, q, hNorm + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, hNorm) * 255),
    Math.round(hue2rgb(p, q, hNorm - 1 / 3) * 255),
  ];
}

function contrastOn(value: string): string {
  const rgb = colorToRgb(value);
  if (!rgb) return 'rgba(0,0,0,0.78)';
  const [r, g, b] = rgb;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? 'rgba(0,0,0,0.78)' : 'rgba(255,255,255,0.92)';
}

export function renderKoryColors(source: string): string | null {
  const entries = parseColors(source);
  if (!entries || !entries.length) return null;
  const chips = entries.map((entry) => {
    const captionColor = contrastOn(entry.value);
    const label = entry.label ? escapeHtml(entry.label) : escapeHtml(entry.value);
    const value = escapeHtml(entry.value);
    const styleValue = escapeAttr(entry.value);
    return (
      `<div class="kory-color-chip" style="background:${styleValue}">` +
      `<span class="kory-color-chip-label" style="color:${captionColor}">${label}</span>` +
      `<span class="kory-color-chip-value" style="color:${captionColor}">${value}</span>` +
      `</div>`
    );
  }).join('');
  return `<figure class="kory-color"><div class="kory-color-grid">${chips}</div></figure>`;
}
