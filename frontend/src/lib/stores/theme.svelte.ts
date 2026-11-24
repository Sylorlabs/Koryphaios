// Theme system — per-scheme palettes + accents, fonts, Svelte 5 runes
//
// The config is versioned: v1 (single preset/accent pair, preset 'system' for
// follow-OS) is migrated to v2 (a light slot and a dark slot, each with its own
// preset + primary/secondary accents, plus an explicit mode). 'system' is no
// longer a preset — it is the adaptive mode that resolves to whichever slot
// matches the OS preference.

import { browser } from '$app/environment';
import { apiFetch } from '$lib/api.svelte';
import { loadFont } from '$lib/fonts';
import {
  THEME_PRESETS,
  THEME_SCHEME,
  THEME_PRESET_OPTIONS,
  type ConcreteThemePreset,
  type ThemePalette,
  type ThemeScheme,
} from '$lib/theme-palette';
import { readableForeground } from '$lib/theme-contrast';
import { apiUrl } from '$lib/utils/api-url';

export { THEME_PRESETS } from '$lib/theme-palette';
export type { ThemePalette, ThemeScheme } from '$lib/theme-palette';
export type ThemePreset = ConcreteThemePreset;
export type ThemeMode = 'dark' | 'light' | 'system';
export type AccentColor =
  'gold' | 'indigo' | 'cyan' | 'emerald' | 'amber' | 'rose' | 'violet' | 'custom';

export interface CustomAccent {
  main: string;
  hover: string;
}

export interface ModeAppearance {
  preset: ConcreteThemePreset;
  accent: AccentColor;
  secondaryAccent: AccentColor;
  customAccent?: CustomAccent;
  customSecondaryAccent?: CustomAccent;
}

export interface ThemeConfig {
  version: 2;
  mode: ThemeMode;
  font: FontFamily;
  dark: ModeAppearance;
  light: ModeAppearance;
}

/** Legacy (v1) persisted shape — migrated by normalizeConfig. */
interface ThemeConfigV1 {
  preset: ConcreteThemePreset | 'system';
  accent: AccentColor;
  secondaryAccent: AccentColor;
  font: FontFamily;
  customAccent?: CustomAccent;
  customSecondaryAccent?: CustomAccent;
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

export const THEME_DEFAULTS: ThemeConfig = {
  version: 2,
  mode: 'system',
  font: 'inter',
  dark: { preset: 'kintsugi', accent: 'gold', secondaryAccent: 'gold' },
  light: { preset: 'kintsugi-light', accent: 'gold', secondaryAccent: 'gold' },
};

/** Convert #RRGGBB to an RGB triplet for alpha-blended CSS variables. */
function hexToRgb(hex: string): string {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
  if (!match) return '213, 178, 97';
  return `${parseInt(match[1], 16)}, ${parseInt(match[2], 16)}, ${parseInt(match[3], 16)}`;
}

const isHex = (value: unknown): value is string =>
  typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value.trim());

function normalizeCustomAccent(value: unknown): CustomAccent | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<CustomAccent>;
  if (!isHex(candidate.main) || !isHex(candidate.hover)) return undefined;
  return { main: candidate.main.toUpperCase(), hover: candidate.hover.toUpperCase() };
}

function normalizeSlot(
  value: unknown,
  scheme: ThemeScheme,
  fallback: ModeAppearance,
): ModeAppearance {
  if (!value || typeof value !== 'object') return { ...fallback };
  const candidate = value as Partial<ModeAppearance>;
  const preset =
    typeof candidate.preset === 'string' &&
    candidate.preset in THEME_PRESETS &&
    THEME_SCHEME[candidate.preset as ConcreteThemePreset] === scheme
      ? (candidate.preset as ConcreteThemePreset)
      : fallback.preset;
  const accent =
    typeof candidate.accent === 'string' && candidate.accent in ACCENT_COLORS
      ? (candidate.accent as AccentColor)
      : fallback.accent;
  const secondaryAccent =
    typeof candidate.secondaryAccent === 'string' && candidate.secondaryAccent in ACCENT_COLORS
      ? (candidate.secondaryAccent as AccentColor)
      : candidate.accent && candidate.accent in ACCENT_COLORS
        ? (candidate.accent as AccentColor)
        : fallback.secondaryAccent;
  return {
    preset,
    accent,
    secondaryAccent,
    customAccent: normalizeCustomAccent(candidate.customAccent) ?? fallback.customAccent,
    customSecondaryAccent:
      normalizeCustomAccent(candidate.customSecondaryAccent) ??
      (candidate.secondaryAccent ? undefined : normalizeCustomAccent(candidate.customAccent)) ??
      fallback.customSecondaryAccent,
  };
}

function normalizeFont(value: unknown, fallback: FontFamily): FontFamily {
  return typeof value === 'string' && value in FONT_FAMILIES ? (value as FontFamily) : fallback;
}

function normalizeConfig(value: unknown, fallback: ThemeConfig = THEME_DEFAULTS): ThemeConfig {
  if (!value || typeof value !== 'object') {
    return { ...fallback, dark: { ...fallback.dark }, light: { ...fallback.light } };
  }
  const candidate = value as Record<string, unknown>;

  // v2: explicit mode + per-scheme slots.
  if (candidate.mode === 'dark' || candidate.mode === 'light' || candidate.mode === 'system') {
    return {
      version: 2,
      mode: candidate.mode,
      font: normalizeFont(candidate.font, fallback.font),
      dark: normalizeSlot(candidate.dark, 'dark', fallback.dark),
      light: normalizeSlot(candidate.light, 'light', fallback.light),
    };
  }

  // v1 migration: single preset (+ 'system') and one accent pair.
  if (typeof candidate.preset === 'string') {
    const legacy = candidate as unknown as Partial<ThemeConfigV1>;
    const slotSource = {
      accent: legacy.accent,
      secondaryAccent: legacy.secondaryAccent,
      customAccent: legacy.customAccent,
      customSecondaryAccent: legacy.customSecondaryAccent,
    };
    const font = normalizeFont(legacy.font, fallback.font);
    if (legacy.preset === 'system') {
      return {
        version: 2,
        mode: 'system',
        font,
        dark: normalizeSlot({ ...slotSource, preset: 'kintsugi' }, 'dark', fallback.dark),
        light: normalizeSlot({ ...slotSource, preset: 'light' }, 'light', fallback.light),
      };
    }
    const scheme =
      typeof legacy.preset === 'string' && legacy.preset in THEME_PRESETS
        ? THEME_SCHEME[legacy.preset as ConcreteThemePreset]
        : undefined;
    if (scheme === 'light') {
      return {
        version: 2,
        mode: 'light',
        font,
        dark: { ...fallback.dark },
        light: normalizeSlot({ ...slotSource, preset: legacy.preset }, 'light', fallback.light),
      };
    }
    if (scheme === 'dark') {
      return {
        version: 2,
        mode: 'dark',
        font,
        dark: normalizeSlot({ ...slotSource, preset: legacy.preset }, 'dark', fallback.dark),
        light: { ...fallback.light },
      };
    }
  }

  return { ...fallback, dark: { ...fallback.dark }, light: { ...fallback.light } };
}

function createThemeStore() {
  const defaults = THEME_DEFAULTS;

  let savedConfig: ThemeConfig = defaults;
  if (browser) {
    try {
      const stored = localStorage.getItem('koryphaios-theme');
      if (stored) savedConfig = normalizeConfig(JSON.parse(stored));
    } catch (err) {
      console.debug('Failed to parse saved theme:', err);
    }
  }

  let mode = $state<ThemeMode>(savedConfig.mode);
  let font = $state<FontFamily>(savedConfig.font);
  let dark = $state<ModeAppearance>({ ...savedConfig.dark });
  let light = $state<ModeAppearance>({ ...savedConfig.light });
  let backendHydrated = false;
  let mutationRevision = 0;
  /**
   * The light-scheme media query, or null where `matchMedia` is unavailable
   * (SSR, jsdom, embedded webviews). Absent a query, the system is treated as
   * "not light" so the dark scheme stays the default.
   */
  function lightSchemeQuery(): MediaQueryList | null {
    if (!browser || typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return null;
    }
    return window.matchMedia('(prefers-color-scheme: light)') ?? null;
  }

  function prefersLight(): boolean {
    return lightSchemeQuery()?.matches === true;
  }

  let systemPrefersLight = $state(prefersLight());

  function systemScheme(): ThemeScheme {
    void systemPrefersLight;
    if (prefersLight()) return 'light';
    return 'dark';
  }

  function slotFor(scheme: ThemeScheme): ModeAppearance {
    return scheme === 'light' ? light : dark;
  }

  function activeScheme(): ThemeScheme {
    return mode === 'system' ? systemScheme() : mode;
  }

  function accentValue(slot: ModeAppearance, which: 'primary' | 'secondary') {
    const id = which === 'primary' ? slot.accent : slot.secondaryAccent;
    const custom = which === 'primary' ? slot.customAccent : slot.customSecondaryAccent;
    if (id === 'custom' && custom) return custom;
    return ACCENT_COLORS[id] ?? ACCENT_COLORS.gold;
  }

  function applyToDOM() {
    if (!browser) return;

    const slot = slotFor(activeScheme());
    const vars = THEME_PRESETS[slot.preset];
    if (!vars) return;
    const accentVars = accentValue(slot, 'primary');
    const secondaryAccentVars = accentValue(slot, 'secondary');
    const root = document.documentElement;

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

    const scheme = THEME_SCHEME[slot.preset];
    root.setAttribute('data-theme', scheme);
    root.style.colorScheme = scheme;
  }

  function snapshot(): ThemeConfig {
    return {
      version: 2,
      mode,
      font,
      dark: { ...dark },
      light: { ...light },
    };
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
        mode = next.mode;
        font = next.font;
        dark = { ...next.dark };
        light = { ...next.light };
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

  function mutateSlot(
    scheme: ThemeScheme,
    which: 'primary' | 'secondary',
    accentId: AccentColor,
    custom?: CustomAccent,
  ) {
    const slot = scheme === 'light' ? light : dark;
    if (which === 'primary') {
      slot.accent = accentId;
      if (custom) slot.customAccent = custom;
    } else {
      slot.secondaryAccent = accentId;
      if (custom) slot.customSecondaryAccent = custom;
    }
    save();
  }

  return {
    get mode() {
      return mode;
    },
    get activeScheme(): ThemeScheme {
      return activeScheme();
    },
    get preset(): ConcreteThemePreset {
      return slotFor(activeScheme()).preset;
    },
    get accent() {
      return slotFor(activeScheme()).accent;
    },
    get secondaryAccent() {
      return slotFor(activeScheme()).secondaryAccent;
    },
    get font() {
      return font;
    },
    get customAccent() {
      return slotFor(activeScheme()).customAccent;
    },
    get customSecondaryAccent() {
      return slotFor(activeScheme()).customSecondaryAccent;
    },
    get dark(): ModeAppearance {
      return { ...dark };
    },
    get light(): ModeAppearance {
      return { ...light };
    },
    get config(): ThemeConfig {
      return snapshot();
    },
    get isDark() {
      return activeScheme() === 'dark';
    },

    setMode(value: ThemeMode) {
      mode = value;
      save();
    },
    setPreset(value: ConcreteThemePreset) {
      const scheme = THEME_SCHEME[value];
      if (!scheme) return;
      slotFor(scheme).preset = value;
      if (scheme !== activeScheme()) mode = scheme;
      save();
    },
    setModePreset(scheme: ThemeScheme, value: ConcreteThemePreset) {
      if (THEME_SCHEME[value] !== scheme) return;
      slotFor(scheme).preset = value;
      save();
    },
    setAccent(value: AccentColor) {
      mutateSlot(activeScheme(), 'primary', value);
    },
    setSecondaryAccent(value: AccentColor) {
      mutateSlot(activeScheme(), 'secondary', value);
    },
    setCustomAccent(value: CustomAccent) {
      mutateSlot(activeScheme(), 'primary', 'custom', value);
    },
    setCustomSecondaryAccent(value: CustomAccent) {
      mutateSlot(activeScheme(), 'secondary', 'custom', value);
    },
    setModeAccent(scheme: ThemeScheme, which: 'primary' | 'secondary', value: AccentColor) {
      mutateSlot(scheme, which, value);
    },
    setModeCustomAccent(scheme: ThemeScheme, which: 'primary' | 'secondary', value: CustomAccent) {
      mutateSlot(scheme, which, 'custom', value);
    },
    setFont(value: FontFamily) {
      font = value;
      save();
      void loadFont(value);
    },

    reset() {
      mode = defaults.mode;
      font = defaults.font;
      dark = { ...defaults.dark };
      light = { ...defaults.light };
      save();
      void loadFont(defaults.font);
    },

    modeAppearance(scheme: ThemeScheme): ModeAppearance {
      return { ...slotFor(scheme) };
    },
    accentFor(scheme: ThemeScheme, which: 'primary' | 'secondary') {
      return accentValue(slotFor(scheme), which);
    },
    presetsFor(scheme: ThemeScheme) {
      return THEME_PRESET_OPTIONS.filter((option) => option.scheme === scheme);
    },
    paletteFor(preset: ConcreteThemePreset): ThemePalette | undefined {
      return THEME_PRESETS[preset];
    },

    get presets(): Array<{ id: ConcreteThemePreset; label: string; scheme: ThemeScheme }> {
      return THEME_PRESET_OPTIONS;
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
      return accentValue(slotFor(activeScheme()), 'primary');
    },
    get currentSecondaryAccent(): { main: string; hover: string } {
      return accentValue(slotFor(activeScheme()), 'secondary');
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
      const media = lightSchemeQuery();
      systemPrefersLight = media?.matches === true;
      applyToDOM();
      void hydrateFromBackend();
      if (!media) return;
      const handler = () => {
        systemPrefersLight = media.matches === true;
        if (mode === 'system') applyToDOM();
      };
      if (typeof media.addEventListener === 'function') {
        media.addEventListener('change', handler);
        return () => media.removeEventListener('change', handler);
      }
      if (typeof media.addListener === 'function') {
        // Safari < 14 only exposes the deprecated listener API.
        media.addListener(handler);
        return () => media.removeListener(handler);
      }
      return undefined;
    },
  };
}

export const theme = createThemeStore();
