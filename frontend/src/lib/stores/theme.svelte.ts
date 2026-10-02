// Theme system — multiple presets, accent colors, fonts, Svelte 5 runes

import { browser } from '$app/environment';
import { apiFetch } from '$lib/api.svelte';
import { loadFont } from '$lib/fonts';
import { THEME_PRESETS, type ConcreteThemePreset } from '$lib/theme-palette';
import { readableForeground } from '$lib/theme-contrast';
import { apiUrl } from '$lib/utils/api-url';

export { THEME_PRESETS } from '$lib/theme-palette';
export type ThemePreset = ConcreteThemePreset | 'system';
export type AccentColor =
  'gold' | 'indigo' | 'cyan' | 'emerald' | 'amber' | 'rose' | 'violet' | 'custom';

export interface CustomAccent {
  main: string;
  hover: string;
}

export type FontFamily =
  | 'inter'
  | 'geist'
  | 'jetbrains'
  | 'roboto'
  | 'outfit'
  | 'space-grotesk'
  | 'dm-sans'
  | 'plus-jakarta'
  | 'source-code-pro'
  | 'ibm-plex-mono'
  | 'fira-code'
  | 'berkeley-mono'
  | 'source-serif'
  | 'roboto-slab';

export interface ThemeConfig {
  preset: ThemePreset;
  accent: AccentColor;
  secondaryAccent: AccentColor;
  font: FontFamily;
  customAccent?: CustomAccent;
  customSecondaryAccent?: CustomAccent;
}

const ACCENT_COLORS: Record<AccentColor, { main: string; hover: string }> = {
  gold: { main: '#D5B261', hover: '#F3DDB0' },
  indigo: { main: '#6366f1', hover: '#818cf8' },
  cyan: { main: '#06b6d4', hover: '#22d3ee' },
  emerald: { main: '#10b981', hover: '#34d399' },
  amber: { main: '#f59e0b', hover: '#fbbf24' },
  rose: { main: '#f43f5e', hover: '#fb7185' },
  violet: { main: '#8b5cf6', hover: '#a78bfa' },
  custom: { main: '#D5B261', hover: '#F3DDB0' },
};

const FONT_FAMILIES: Record<FontFamily, string> = {
  inter: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
  geist: "'Geist Sans', 'Inter', -apple-system, sans-serif",
  jetbrains: "'JetBrains Mono', 'SF Mono', monospace",
  roboto: "'Roboto', -apple-system, BlinkMacSystemFont, sans-serif",
  outfit: "'Outfit', 'Inter', sans-serif",
  'space-grotesk': "'Space Grotesk', 'Inter', sans-serif",
  'dm-sans': "'DM Sans', 'Inter', sans-serif",
  'plus-jakarta': "'Plus Jakarta Sans', 'Inter', sans-serif",
  'source-code-pro': "'Source Code Pro', 'SF Mono', monospace",
  'ibm-plex-mono': "'IBM Plex Mono', 'SF Mono', monospace",
  'fira-code': "'Fira Code', 'JetBrains Mono', monospace",
  'berkeley-mono': "'Berkeley Mono', 'JetBrains Mono', 'SF Mono', monospace",
  'source-serif': "'Source Serif 4', Georgia, 'Times New Roman', serif",
  'roboto-slab': "'Roboto Slab', 'Roboto', Georgia, serif",
};

/** Convert #RRGGBB to an RGB triplet for alpha-blended CSS variables. */
function hexToRgb(hex: string): string {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
  if (!match) return '213, 178, 97';
  return `${parseInt(match[1], 16)}, ${parseInt(match[2], 16)}, ${parseInt(match[3], 16)}`;
}

function createThemeStore() {
  const defaults: ThemeConfig = {
    preset: 'kintsugi',
    accent: 'gold',
    secondaryAccent: 'gold',
    font: 'inter',
  };

  const isHex = (value: unknown): value is string =>
    typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value.trim());

  function normalizeCustomAccent(value: unknown): CustomAccent | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const candidate = value as Partial<CustomAccent>;
    if (!isHex(candidate.main) || !isHex(candidate.hover)) return undefined;
    return { main: candidate.main.toUpperCase(), hover: candidate.hover.toUpperCase() };
  }

  function normalizeConfig(value: unknown, fallback: ThemeConfig = defaults): ThemeConfig {
    if (!value || typeof value !== 'object') return { ...fallback };
    const candidate = value as Partial<ThemeConfig>;
    const preset =
      candidate.preset === 'system' ||
      (typeof candidate.preset === 'string' && candidate.preset in THEME_PRESETS)
        ? candidate.preset
        : fallback.preset;
    const accent =
      typeof candidate.accent === 'string' && candidate.accent in ACCENT_COLORS
        ? candidate.accent
        : fallback.accent;
    const secondaryAccent =
      typeof candidate.secondaryAccent === 'string' && candidate.secondaryAccent in ACCENT_COLORS
        ? candidate.secondaryAccent
        : candidate.accent && candidate.accent in ACCENT_COLORS
          ? candidate.accent
          : fallback.secondaryAccent;
    const font =
      typeof candidate.font === 'string' && candidate.font in FONT_FAMILIES
        ? candidate.font
        : fallback.font;
    return {
      preset: preset as ThemePreset,
      accent: accent as AccentColor,
      secondaryAccent: secondaryAccent as AccentColor,
      font: font as FontFamily,
      customAccent: normalizeCustomAccent(candidate.customAccent) ?? fallback.customAccent,
      customSecondaryAccent:
        normalizeCustomAccent(candidate.customSecondaryAccent) ??
        (candidate.secondaryAccent ? undefined : normalizeCustomAccent(candidate.customAccent)) ??
        fallback.customSecondaryAccent,
    };
  }

  let savedConfig: ThemeConfig = defaults;
  if (browser) {
    try {
      const stored = localStorage.getItem('koryphaios-theme');
      if (stored) savedConfig = normalizeConfig(JSON.parse(stored));
    } catch (err) {
      console.debug('Failed to parse saved theme:', err);
    }
  }

  let preset = $state<ThemePreset>(savedConfig.preset);
  let accent = $state<AccentColor>(savedConfig.accent);
  let secondaryAccent = $state<AccentColor>(savedConfig.secondaryAccent);
  let font = $state<FontFamily>(savedConfig.font);
  let customAccent = $state<CustomAccent | undefined>(savedConfig.customAccent);
  let customSecondaryAccent = $state<CustomAccent | undefined>(savedConfig.customSecondaryAccent);
  let backendHydrated = false;
  let mutationRevision = 0;

  function resolvePreset(value: ThemePreset): ConcreteThemePreset {
    if (value !== 'system') return value;
    if (browser && window.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
    return 'kintsugi';
  }

  function applyToDOM() {
    if (!browser) return;

    const resolvedPreset = resolvePreset(preset);
    const vars = THEME_PRESETS[resolvedPreset];
    let accentVars = ACCENT_COLORS[accent];
    let secondaryAccentVars = ACCENT_COLORS[secondaryAccent];
    const root = document.documentElement;
    if (!vars || !accentVars || !secondaryAccentVars) return;

    if (accent === 'custom' && customAccent) accentVars = customAccent;
    if (secondaryAccent === 'custom' && customSecondaryAccent) {
      secondaryAccentVars = customSecondaryAccent;
    }
    for (const [key, value] of Object.entries(vars)) root.style.setProperty(key, value);
    root.style.setProperty('--color-accent', accentVars.main);
    root.style.setProperty('--color-accent-hover', accentVars.hover);
    root.style.setProperty('--color-accent-rgb', hexToRgb(accentVars.main));
    root.style.setProperty('--color-on-accent', readableForeground(accentVars.main));
    root.style.setProperty('--color-accent-secondary', secondaryAccentVars.main);
    root.style.setProperty('--color-accent-secondary-hover', secondaryAccentVars.hover);
    root.style.setProperty('--color-accent-secondary-rgb', hexToRgb(secondaryAccentVars.main));
    root.style.setProperty(
      '--color-on-accent-secondary',
      readableForeground(secondaryAccentVars.main),
    );
    root.style.setProperty(
      '--color-on-success',
      readableForeground(vars['--color-success'] ?? '#22c55e'),
    );
    root.style.setProperty('--font-sans', FONT_FAMILIES[font]);

    const isLight = resolvedPreset === 'light';
    root.setAttribute('data-theme', isLight ? 'light' : 'dark');
    root.style.colorScheme = isLight ? 'light' : 'dark';
  }

  function snapshot(): ThemeConfig {
    return { preset, accent, secondaryAccent, font, customAccent, customSecondaryAccent };
  }

  async function persistToBackend(config: ThemeConfig = snapshot()) {
    if (!browser) return;
    try {
      const response = await apiFetch(apiUrl('/api/appearance'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      if (!response.ok) {
        console.debug(`Appearance settings backend write returned ${response.status}`);
      }
    } catch (err) {
      console.debug('Failed to persist appearance settings to backend:', err);
    }
  }

  async function hydrateFromBackend() {
    if (!browser || backendHydrated) return;
    const revisionAtStart = mutationRevision;
    try {
      const response = await apiFetch(apiUrl('/api/appearance'));
      if (!response.ok) return;
      const payload = (await response.json()) as { ok?: boolean; data?: unknown };
      if (!payload.ok) return;

      if (revisionAtStart !== mutationRevision) {
        backendHydrated = true;
        await persistToBackend();
        return;
      }

      if (payload.data) {
        const next = normalizeConfig(payload.data, snapshot());
        preset = next.preset;
        accent = next.accent;
        secondaryAccent = next.secondaryAccent;
        font = next.font;
        customAccent = next.customAccent;
        customSecondaryAccent = next.customSecondaryAccent;
        localStorage.setItem('koryphaios-theme', JSON.stringify(snapshot()));
        applyToDOM();
        void loadFont(font);
      } else {
        await persistToBackend();
      }
      backendHydrated = true;
    } catch (err) {
      console.debug('Failed to load appearance settings from backend:', err);
    }
  }

  function save() {
    mutationRevision += 1;
    if (browser) {
      localStorage.setItem('koryphaios-theme', JSON.stringify(snapshot()));
    }
    applyToDOM();
    if (browser) void persistToBackend();
  }

  return {
    get preset() {
      return preset;
    },
    get accent() {
      return accent;
    },
    get secondaryAccent() {
      return secondaryAccent;
    },
    get font() {
      return font;
    },
    get customAccent() {
      return customAccent;
    },
    get customSecondaryAccent() {
      return customSecondaryAccent;
    },
    get isDark() {
      return resolvePreset(preset) !== 'light';
    },

    setPreset(value: ThemePreset) {
      preset = value;
      save();
    },
    setAccent(value: AccentColor) {
      accent = value;
      save();
    },
    setSecondaryAccent(value: AccentColor) {
      secondaryAccent = value;
      save();
    },
    setCustomAccent(value: CustomAccent) {
      customAccent = value;
      accent = 'custom';
      save();
    },
    setCustomSecondaryAccent(value: CustomAccent) {
      customSecondaryAccent = value;
      secondaryAccent = 'custom';
      save();
    },
    setFont(value: FontFamily) {
      font = value;
      save();
      void loadFont(value);
    },

    reset() {
      preset = defaults.preset;
      accent = defaults.accent;
      secondaryAccent = defaults.secondaryAccent;
      font = defaults.font;
      customAccent = undefined;
      customSecondaryAccent = undefined;
      save();
      void loadFont(defaults.font);
    },

    get presets(): Array<{ id: ThemePreset; label: string }> {
      return [
        { id: 'kintsugi', label: 'Kintsugi' },
        { id: 'midnight', label: 'Midnight' },
        { id: 'nord', label: 'Nord' },
        { id: 'dracula', label: 'Dracula' },
        { id: 'catppuccin', label: 'Catppuccin' },
        { id: 'gruvbox', label: 'Gruvbox' },
        { id: 'tokyo', label: 'Tokyo Night' },
        { id: 'solarized', label: 'Solarized Dark' },
        { id: 'light', label: 'Light' },
        { id: 'system', label: 'System' },
      ];
    },
    get accents(): Array<{ id: AccentColor; label: string; color: string }> {
      return [
        { id: 'gold', label: 'Kintsugi Gold', color: '#D5B261' },
        { id: 'indigo', label: 'Indigo', color: '#6366f1' },
        { id: 'cyan', label: 'Cyan', color: '#06b6d4' },
        { id: 'emerald', label: 'Emerald', color: '#10b981' },
        { id: 'amber', label: 'Amber', color: '#f59e0b' },
        { id: 'rose', label: 'Rose', color: '#f43f5e' },
        { id: 'violet', label: 'Violet', color: '#8b5cf6' },
      ];
    },
    get currentAccent(): { main: string; hover: string } {
      if (accent === 'custom' && customAccent) return customAccent;
      return ACCENT_COLORS[accent] ?? ACCENT_COLORS.gold;
    },
    get currentSecondaryAccent(): { main: string; hover: string } {
      if (secondaryAccent === 'custom' && customSecondaryAccent) return customSecondaryAccent;
      return ACCENT_COLORS[secondaryAccent] ?? ACCENT_COLORS.gold;
    },
    get fonts(): Array<{ id: FontFamily; label: string; category: string }> {
      return [
        { id: 'inter', label: 'Inter', category: 'Sans Serif' },
        { id: 'geist', label: 'Geist', category: 'Sans Serif' },
        { id: 'space-grotesk', label: 'Space Grotesk', category: 'Sans Serif' },
        { id: 'source-serif', label: 'Source Serif', category: 'Serif' },
        { id: 'roboto-slab', label: 'Roboto Slab', category: 'Serif' },
        { id: 'jetbrains', label: 'JetBrains Mono', category: 'Monospace' },
        { id: 'fira-code', label: 'Fira Code', category: 'Monospace' },
        { id: 'ibm-plex-mono', label: 'IBM Plex Mono', category: 'Monospace' },
      ];
    },
    getFontFamily(id: FontFamily): string {
      return FONT_FAMILIES[id];
    },

    init() {
      if (!browser) return;
      applyToDOM();
      void hydrateFromBackend();
      const media = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = () => {
        if (preset === 'system') applyToDOM();
      };
      media.addEventListener('change', handler);
      return () => media.removeEventListener('change', handler);
    },
  };
}

export const theme = createThemeStore();
