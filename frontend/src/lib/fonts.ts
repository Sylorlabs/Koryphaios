// Lazy font loading — only loads the CSS for the selected UI font plus the
// fixed mono font (JetBrains Mono, used for code blocks regardless of the UI
// font selection). This replaces the old eager import of all 13 font packages
// × 4-5 weights (60 CSS files), which Vite had to process and the browser had
// to parse on every page load.
//
// The font picker preview in SettingsDrawer needs all fonts visible, so
// `loadAllFontsForPicker()` is called when the settings drawer opens. This
// keeps the common case (settings closed) light while preserving the preview.

import type { FontFamily } from './stores/theme.svelte';

// Map each FontFamily id to its @fontsource package name.
// berkeley-mono has no @fontsource package — it falls back to JetBrains Mono.
const FONT_PACKAGE: Partial<Record<FontFamily, string>> = {
  inter: 'inter',
  geist: 'geist-sans',
  jetbrains: 'jetbrains-mono',
  roboto: 'roboto',
  outfit: 'outfit',
  'space-grotesk': 'space-grotesk',
  'dm-sans': 'dm-sans',
  'plus-jakarta': 'plus-jakarta-sans',
  'source-code-pro': 'source-code-pro',
  'ibm-plex-mono': 'ibm-plex-mono',
  'fira-code': 'fira-code',
  'source-serif': 'source-serif-4',
  'roboto-slab': 'roboto-slab',
};

const WEIGHTS = ['300', '400', '500', '600', '700'];

// Track which fonts have been loaded so we don't re-import.
const loaded = new Set<string>();

/** Dynamically import all CSS weights for a single @fontsource package. */
async function loadPackage(pkg: string): Promise<void> {
  if (loaded.has(pkg)) return;
  loaded.add(pkg);
  await Promise.all(
    WEIGHTS.map((w) =>
      import(`@fontsource/${pkg}/${w}.css`).catch(() => {
        // Some packages don't ship all weights — silently skip.
        loaded.delete(pkg);
      }),
    ),
  );
}

/** Load the CSS for the selected UI font. Safe to call repeatedly. */
export async function loadFont(id: FontFamily): Promise<void> {
  const pkg = FONT_PACKAGE[id];
  if (!pkg) return; // berkeley-mono etc. — falls back via CSS font stack
  await loadPackage(pkg);
}

/** Load JetBrains Mono (used for code blocks, --font-mono, regardless of UI font). */
export async function loadMonoFont(): Promise<void> {
  await loadPackage('jetbrains-mono');
}

/** Load every font package — used by the SettingsDrawer font picker so each
 *  preview renders in its own typeface. */
export async function loadAllFontsForPicker(): Promise<void> {
  const packages = [...new Set(Object.values(FONT_PACKAGE))];
  await Promise.all(packages.map((pkg) => loadPackage(pkg)));
}
