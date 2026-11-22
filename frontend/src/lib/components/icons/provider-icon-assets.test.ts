import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXISTING_PROVIDER_ICON_PATHS } from './provider-icon-assets';

describe('provider icon assets', () => {
  it('ships the standalone Reflection symbol at the backend iconPath', () => {
    expect(EXISTING_PROVIDER_ICON_PATHS.has('/provider-icons/reflection.svg')).toBe(true);
    const source = readFileSync(join(process.cwd(), 'static/provider-icons/reflection.svg'), 'utf8');
    const svg = new DOMParser().parseFromString(source, 'image/svg+xml');
    expect(svg.querySelector('parsererror')).toBeNull();
    expect(svg.documentElement.getAttribute('viewBox')).toBe('0 0 170.36 82.5');
    expect(svg.documentElement.getAttribute('fill')).toBe('currentColor');
    expect(svg.querySelectorAll('path')).toHaveLength(1);
    expect(svg.querySelector('rect, image, style, script, foreignObject')).toBeNull();
  });

  it('ships the first-party Command Code logomark in the generated manifest', () => {
    // backend/src/providers/provider-display.ts points Command Code at this exact
    // path. ProviderIcon.svelte rejects any local candidate missing from this
    // manifest, so a shipped file alone still renders a placeholder with no
    // error anywhere — the two must stay in lockstep.
    expect(EXISTING_PROVIDER_ICON_PATHS.has('/provider-icons/commandcode-color.svg')).toBe(true);
  });

  it('maps the commandcode provider id to its own icon slug', () => {
    // The -color variant is tried first, which matters here: the official
    // logomark is a fixed black square with a white glyph, so it must never be
    // treated as a theme-adaptive monochrome asset (that would invert it to
    // white-on-white in dark mode).
    const source = readFileSync(
      join(process.cwd(), 'src/lib/components/icons/ProviderIcon.svelte'),
      'utf8',
    );
    expect(source).toMatch(/commandcode:\s*\['commandcode'\]/);
  });

  it('ships the 100MillionSeek and Numes marks as transparent, themeable assets', () => {
    // Both provider-display entries point at these exact paths, and
    // ProviderIcon.svelte rejects local candidates missing from the manifest.
    // The official marks ship without their opaque favicon backgrounds and use
    // currentColor, so the dark-mode inversion styles them correctly.
    for (const [slug, viewBox] of [
      ['hundredmillionseek', '0 0 32 32'],
      ['numes', '0 0 219 167'],
    ] as const) {
      const path = `/provider-icons/${slug}.svg`;
      expect(EXISTING_PROVIDER_ICON_PATHS.has(path)).toBe(true);
      const source = readFileSync(join(process.cwd(), `static${path}`), 'utf8');
      const svg = new DOMParser().parseFromString(source, 'image/svg+xml');
      expect(svg.querySelector('parsererror')).toBeNull();
      expect(svg.documentElement.getAttribute('viewBox')).toBe(viewBox);
      // A raster or an opaque canvas would defeat the cut-out requirement.
      expect(svg.querySelector('image, style, foreignObject')).toBeNull();
      expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(source).toMatch(/currentColor/);
    }
  });

  it('ships the first-party UnoRouter logomark in the generated manifest', () => {
    // backend/src/providers/provider-display.ts points UnoRouter at this exact
    // path. ProviderIcon.svelte rejects any local candidate missing from this
    // manifest, so a shipped file alone still renders a placeholder with no
    // error anywhere — the two must stay in lockstep.
    expect(EXISTING_PROVIDER_ICON_PATHS.has('/provider-icons/unorouter-color.svg')).toBe(true);
  });

  it('maps the unorouter provider id to its own icon slug', () => {
    // The -color variant is tried first: the official logomark is a fixed
    // dark circle with red/white glyphs, so it must never be treated as a
    // theme-adaptive monochrome asset.
    const source = readFileSync(
      join(process.cwd(), 'src/lib/components/icons/ProviderIcon.svelte'),
      'utf8',
    );
    expect(source).toMatch(/unorouter:\s*\['unorouter'\]/);
  });

  it('ships the first-party Experiential Labs logomark in the generated manifest', () => {
    // backend/src/providers/provider-display.ts points Experiential Labs at
    // this exact path. ProviderIcon.svelte rejects any local candidate missing
    // from this manifest, so a shipped file alone still renders a placeholder
    // with no error anywhere — the two must stay in lockstep.
    expect(EXISTING_PROVIDER_ICON_PATHS.has('/provider-icons/experientiallabs-color.svg')).toBe(
      true,
    );
  });

  it('ships only the transparent, monochrome Experiential Labs mark', () => {
    // The legacy -color URL is still public, but its full-canvas light rect
    // must not return: a CSS background cannot remove pixels inside an img.
    const source = readFileSync(
      join(process.cwd(), 'static/provider-icons/experientiallabs-color.svg'),
      'utf8',
    );
    const svg = new DOMParser().parseFromString(source, 'image/svg+xml');
    expect(svg.querySelector('parsererror')).toBeNull();
    expect(svg.documentElement.getAttribute('viewBox')).toBe('0 0 32 32');
    expect(svg.querySelectorAll('path')).toHaveLength(2);
    expect(svg.querySelector('rect, image, style, foreignObject')).toBeNull();
    expect(Array.from(svg.querySelectorAll('[fill]'), (node) => node.getAttribute('fill'))).toEqual(
      ['currentColor'],
    );
  });

  it('scopes the inline Codex gradient id to the component instance', () => {
    // `fill="url(#id)"` resolves against the whole document, so a hard-coded
    // gradient id is shared by every Codex card. Searching "codex" renders
    // both the `codex` and `codex-auth` cards; narrowing to "openai" unmounts
    // the `codex` card and the surviving `codex-auth` path is left pointing at
    // a deleted gradient, which the SVG spec paints as nothing. That is the
    // empty tile this id scoping prevents.
    const source = readFileSync(
      join(process.cwd(), 'src/lib/components/icons/ProviderIcon.svelte'),
      'utf8',
    );
    expect(source).not.toMatch(/id="codex-app-gradient"/);
    expect(source).not.toMatch(/url\(#codex-app-gradient\)/);
    expect(source).toMatch(/\$props\.id\(\)/);
  });

  it('scopes the animated status bulb clip path to the component instance', () => {
    // Same document-wide reference hazard: multiple agent status icons share
    // one clip path id, so unmounting any of them breaks the others.
    const source = readFileSync(
      join(process.cwd(), 'src/lib/components/AnimatedStatusIcon.svelte'),
      'utf8',
    );
    expect(source).not.toMatch(/id="bulb-fill"/);
    expect(source).not.toMatch(/url\(#bulb-fill\)/);
    expect(source).toMatch(/\$props\.id\(\)/);
  });
});
