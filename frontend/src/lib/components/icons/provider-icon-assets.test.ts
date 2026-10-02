import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXISTING_PROVIDER_ICON_PATHS } from './provider-icon-assets';

describe('provider icon assets', () => {
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

  it('maps the experientiallabs provider id to its own icon slug', () => {
    // The -color variant is tried first: the official logomark is a fixed
    // light square with a black glyph, so it must never be treated as a
    // theme-adaptive monochrome asset.
    const source = readFileSync(
      join(process.cwd(), 'src/lib/components/icons/ProviderIcon.svelte'),
      'utf8',
    );
    expect(source).toMatch(/experientiallabs:\s*\['experientiallabs'\]/);
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
