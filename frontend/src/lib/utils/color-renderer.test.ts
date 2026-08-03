import { describe, expect, it } from 'bun:test';
import { renderKoryColors } from './color-renderer';

describe('renderKoryColors', () => {
  it('renders hex, rgb, hsl, and named colors from plain-text lines', () => {
    const html = renderKoryColors('#d5b261 Gold\nrgb(96,165,250) Sky\nhsl(280, 60%, 50%) Violet\nteal');
    expect(html).toContain('class="kory-color"');
    expect(html).toContain('class="kory-color-grid"');
    expect(html).toContain('background:#d5b261');
    expect(html).toContain('background:rgb(96,165,250)');
    expect(html).toContain('background:hsl(280,60%,50%)');
    expect(html).toContain('background:teal');
    expect((html?.match(/kory-color-chip"/g) ?? []).length).toBe(4);
  });

  it('accepts JSON object, array, and { colors: [...] } shapes', () => {
    const single = renderKoryColors(JSON.stringify({ value: '#ff0000', label: 'Red' }));
    expect(single).toContain('background:#ff0000');
    expect(single).toContain('Red');

    const arr = renderKoryColors(JSON.stringify([
      { value: '#00ff00', label: 'Green' },
      { value: '#0000ff', name: 'Blue' },
    ]));
    expect(arr).toContain('Green');
    expect(arr).toContain('Blue');

    const wrap = renderKoryColors(JSON.stringify({ colors: [{ value: '#fff', label: 'White' }] }));
    expect(wrap).toContain('background:#fff');
  });

  it('escapes labels and rejects values that could break the style attribute', () => {
    const html = renderKoryColors('#000 <script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    // A value with a quote or semicolon must be rejected, not injected.
    const bad = renderKoryColors('red";body{display:none}#fff');
    expect(bad).toBeNull();
  });

  it('returns null for empty or unrecognized input', () => {
    expect(renderKoryColors('')).toBeNull();
    expect(renderKoryColors('not a color')).toBeNull();
    expect(renderKoryColors('{ "value": "not-a-color" }')).toBeNull();
  });

  it('chooses a readable caption color for light and dark swatches', () => {
    const dark = renderKoryColors('#000000') ?? '';
    const light = renderKoryColors('#ffffff') ?? '';
    expect(dark).toContain('rgba(255,255,255,0.92)');
    expect(light).toContain('rgba(0,0,0,0.78)');
  });

  it('computes correct contrast for hsl and named colors (not just hex/rgb)', () => {
    // Dark hsl → white text (was hardcoded to dark text before the fix).
    const darkHsl = renderKoryColors('hsl(240,80%,10%)') ?? '';
    expect(darkHsl).toContain('rgba(255,255,255,0.92)');

    // Light hsl → dark text.
    const lightHsl = renderKoryColors('hsl(60,100%,90%)') ?? '';
    expect(lightHsl).toContain('rgba(0,0,0,0.78)');

    // Dark named color (navy) → white text (was hardcoded to dark before).
    const navy = renderKoryColors('navy') ?? '';
    expect(navy).toContain('rgba(255,255,255,0.92)');

    // Light named color (white) → dark text.
    const white = renderKoryColors('white') ?? '';
    expect(white).toContain('rgba(0,0,0,0.78)');

    // Mid-luminance named color (gray) → dark text (luminance ~0.5 < 0.6).
    const gray = renderKoryColors('gray') ?? '';
    expect(gray).toContain('rgba(255,255,255,0.92)');
  });

  it('caps nested { colors: { colors: ... } } recursion depth', () => {
    // 5 levels of nesting — exceeds MAX_DEPTH (4), innermost is dropped.
    const deep = JSON.stringify({
      colors: { colors: { colors: { colors: { colors: [{ value: '#f00' }] } } } },
    });
    const result = renderKoryColors(deep);
    expect(result).toBeNull();
  });
});
