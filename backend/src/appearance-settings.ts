import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { serverLog } from './logger';

export type AppearanceThemePreset =
  | 'kintsugi'
  | 'midnight'
  | 'nord'
  | 'dracula'
  | 'catppuccin'
  | 'gruvbox'
  | 'tokyo'
  | 'solarized'
  | 'kintsugi-light'
  | 'light'
  | 'nord-light'
  | 'tokyo-day'
  | 'lagoon'
  | 'everforest-light'
  | 'gruvbox-light'
  | 'rose-pine-dawn'
  | 'catppuccin-latte';

/** v1-only preset sentinel: adaptive mode is `mode: 'system'` in v2. */
export type AppearanceThemePresetV1 = AppearanceThemePreset | 'system';

export type AppearanceAccent =
  | 'gold'
  | 'indigo'
  | 'cyan'
  | 'emerald'
  | 'amber'
  | 'rose'
  | 'violet'
  | 'custom';

export type AppearanceFont =
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

export interface AppearanceAccentValue {
  main: string;
  hover: string;
}

export interface AppearanceModeSettings {
  preset: AppearanceThemePreset;
  accent: AppearanceAccent;
  secondaryAccent: AppearanceAccent;
  customAccent?: AppearanceAccentValue;
  customSecondaryAccent?: AppearanceAccentValue;
}

/** v2: separate light/dark appearances plus an explicit mode. */
export interface AppearanceSettingsV2 {
  version: 2;
  mode: 'dark' | 'light' | 'system';
  font: AppearanceFont;
  dark: AppearanceModeSettings;
  light: AppearanceModeSettings;
  updatedAt?: number;
}

/** Legacy v1 persisted shape; still accepted so an older frontend can write. */
export interface AppearanceSettingsV1 {
  preset: AppearanceThemePresetV1;
  accent: AppearanceAccent;
  secondaryAccent: AppearanceAccent;
  font: AppearanceFont;
  customAccent?: AppearanceAccentValue;
  customSecondaryAccent?: AppearanceAccentValue;
  updatedAt?: number;
}

export type AppearanceSettings = AppearanceSettingsV1 | AppearanceSettingsV2;

function settingsPath(): string {
  const override = process.env.KORYPHAIOS_APPEARANCE_SETTINGS_PATH?.trim();
  if (override) return override;
  return join(homedir(), '.config', 'koryphaios', 'appearance.json');
}

export function loadAppearanceSettings(): AppearanceSettings | null {
  const path = settingsPath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as AppearanceSettings;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    serverLog.warn({ path, error }, 'Failed to load appearance settings');
    return null;
  }
}

export function saveAppearanceSettings(settings: AppearanceSettings): AppearanceSettings {
  const path = settingsPath();
  const next: AppearanceSettings = { ...settings, updatedAt: Date.now() };
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });

  const tempPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  renameSync(tempPath, path);
  return next;
}
