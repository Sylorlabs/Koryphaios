// Theme system — multiple presets, accent colors, fonts, Svelte 5 runes

export type ThemePreset = 'midnight' | 'nord' | 'dracula' | 'catppuccin' | 'light' | 'system';
export type AccentColor = 'indigo' | 'cyan' | 'emerald' | 'amber' | 'rose' | 'violet';
export type FontFamily = 'inter' | 'geist' | 'jetbrains';

export interface ThemeConfig {
  preset: ThemePreset;
  accent: AccentColor;
  font: FontFamily;
}

const THEME_PRESETS: Record<Exclude<ThemePreset, 'system'>, Record<string, string>> = {
  midnight: {
    '--color-surface-0': '#0a0a0b',
    '--color-surface-1': '#111113',
    '--color-surface-2': '#1a1a1e',
    '--color-surface-3': '#242428',
    '--color-surface-4': '#2e2e34',
    '--color-border': '#2a2a30',
    '--color-border-bright': '#3a3a42',
    '--color-text-primary': '#e8e8ed',
    '--color-text-secondary': '#8b8b96',
    '--color-text-muted': '#5a5a66',
  },
  nord: {
    '--color-surface-0': '#2e3440',
    '--color-surface-1': '#3b4252',
    '--color-surface-2': '#434c5e',
    '--color-surface-3': '#4c566a',
    '--color-surface-4': '#5a657d',
    '--color-border': '#4c566a',
    '--color-border-bright': '#5a657d',
    '--color-text-primary': '#eceff4',
    '--color-text-secondary': '#d8dee9',
    '--color-text-muted': '#81a1c1',
  },
  dracula: {
    '--color-surface-0': '#1e1f29',
    '--color-surface-1': '#282a36',
    '--color-surface-2': '#2d303e',
    '--color-surface-3': '#343746',
    '--color-surface-4': '#3c3f52',
    '--color-border': '#44475a',
    '--color-border-bright': '#555870',
    '--color-text-primary': '#f8f8f2',
    '--color-text-secondary': '#c7c7d1',
    '--color-text-muted': '#6272a4',
  },
  catppuccin: {
    '--color-surface-0': '#1e1e2e',
    '--color-surface-1': '#24243a',
    '--color-surface-2': '#2a2a42',
    '--color-surface-3': '#313148',
    '--color-surface-4': '#3a3a52',
    '--color-border': '#3a3a52',
    '--color-border-bright': '#4a4a65',
    '--color-text-primary': '#cdd6f4',
    '--color-text-secondary': '#a6adc8',
    '--color-text-muted': '#6c7086',
  },
  light: {
    '--color-surface-0': '#ffffff',
    '--color-surface-1': '#f8f9fa',
    '--color-surface-2': '#f1f3f5',
    '--color-surface-3': '#e9ecef',
    '--color-surface-4': '#dee2e6',
    '--color-border': '#dee2e6',
    '--color-border-bright': '#ced4da',
    '--color-text-primary': '#212529',
    '--color-text-secondary': '#495057',
    '--color-text-muted': '#868e96',
  },
};

const ACCENT_COLORS: Record<AccentColor, { main: string; hover: string }> = {
  indigo: { main: '#6366f1', hover: '#818cf8' },
  cyan: { main: '#06b6d4', hover: '#22d3ee' },
  emerald: { main: '#10b981', hover: '#34d399' },
  amber: { main: '#f59e0b', hover: '#fbbf24' },
  rose: { main: '#f43f5e', hover: '#fb7185' },
  violet: { main: '#8b5cf6', hover: '#a78bfa' },
};

const FONT_FAMILIES: Record<FontFamily, string> = {
  inter: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
  geist: "'Geist', 'Inter', -apple-system, sans-serif",
  jetbrains: "'JetBrains Mono', 'SF Mono', monospace",
};

import { browser } from '$app/environment';

function createThemeStore() {
  const defaults: ThemeConfig = { preset: 'midnight', accent: 'indigo', font: 'inter' };

  // Load from localStorage
  let savedConfig: ThemeConfig = defaults;
  if (browser) {
    try {
      const stored = localStorage.getItem('koryphaios-theme');
      if (stored) savedConfig = { ...defaults, ...JSON.parse(stored) };
    } catch {}
  }

  let preset = $state<ThemePreset>(savedConfig.preset);
  let accent = $state<AccentColor>(savedConfig.accent);
  let font = $state<FontFamily>(savedConfig.font);

  function applyToDOM() {
    if (!browser) return;

    const resolvedPreset = resolvePreset(preset);
    const vars = THEME_PRESETS[resolvedPreset];
    const accentVars = ACCENT_COLORS[accent];
    const root = document.documentElement;

    if (!vars || !accentVars) return;

    for (const [key, val] of Object.entries(vars)) {
      root.style.setProperty(key, val);
    }
    root.style.setProperty('--color-accent', accentVars.main);
    root.style.setProperty('--color-accent-hover', accentVars.hover);
    root.style.setProperty('--font-sans', FONT_FAMILIES[font]);

    const isLight = resolvedPreset === 'light';
    root.setAttribute('data-theme', isLight ? 'light' : 'dark');
    root.style.colorScheme = isLight ? 'light' : 'dark';
  }

  function resolvePreset(p: ThemePreset): Exclude<ThemePreset, 'system'> {
    if (p !== 'system') return p;
    if (browser && window.matchMedia('(prefers-color-scheme: light)').matches) {
      return 'light';
    }
    return 'midnight';
  }

  function save() {
    if (browser) {
      localStorage.setItem('koryphaios-theme', JSON.stringify({ preset, accent, font }));
    }
    applyToDOM();
  }

  return {
    get preset() { return preset; },
    get accent() { return accent; },
    get font() { return font; },
    get isDark() {
      return resolvePreset(preset) !== 'light';
    },

    setPreset(p: ThemePreset) { preset = p; save(); },
    setAccent(a: AccentColor) { accent = a; save(); },
    setFont(f: FontFamily) { font = f; save(); },

    get presets(): Array<{ id: ThemePreset; label: string }> {
      return [
        { id: 'midnight', label: 'Midnight' },
        { id: 'nord', label: 'Nord' },
        { id: 'dracula', label: 'Dracula' },
        { id: 'catppuccin', label: 'Catppuccin' },
        { id: 'light', label: 'Light' },
        { id: 'system', label: 'System' },
      ];
    },
    get accents(): Array<{ id: AccentColor; label: string; color: string }> {
      return [
        { id: 'indigo', label: 'Indigo', color: '#6366f1' },
        { id: 'cyan', label: 'Cyan', color: '#06b6d4' },
        { id: 'emerald', label: 'Emerald', color: '#10b981' },
        { id: 'amber', label: 'Amber', color: '#f59e0b' },
        { id: 'rose', label: 'Rose', color: '#f43f5e' },
        { id: 'violet', label: 'Violet', color: '#8b5cf6' },
      ];
    },
    get fonts(): Array<{ id: FontFamily; label: string }> {
      return [
        { id: 'inter', label: 'Inter' },
        { id: 'geist', label: 'Geist' },
        { id: 'jetbrains', label: 'JetBrains Mono' },
      ];
    },

    init() {
      if (!browser) return;
      applyToDOM();
      if (preset === 'system') {
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
          if (preset === 'system') applyToDOM();
        });
      }
    },
  };
}

export const theme = createThemeStore();
