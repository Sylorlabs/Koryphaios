import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  DEFAULT_DESKTOP_SHORTCUTS,
  cloneDefaultDesktopShortcuts,
  cloneDefaultWelcomePreferences,
  defaultDesktopUiSettings,
  isWelcomeIconSource,
  type DesktopShortcut,
  type DesktopUiSettings,
  type WelcomePreferences,
} from '@koryphaios/shared';
import { serverLog } from './logger';

function settingsPath(): string {
  const override = process.env.KORYPHAIOS_DESKTOP_UI_SETTINGS_PATH?.trim();
  if (override) return override;
  const dataRoot =
    process.env.KORYPHAIOS_DATA_DIR?.trim() || join(homedir(), '.config', 'koryphaios');
  return join(dataRoot, 'desktop-ui.json');
}

function normalizeWelcome(value: unknown): WelcomePreferences {
  const defaults = cloneDefaultWelcomePreferences();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return defaults;
  const record = value as {
    enabled?: { suggestions?: unknown };
    homeTitle?: unknown;
    homeSubtitle?: unknown;
    suggestionPrompts?: unknown;
    suggestionCards?: unknown;
    background?: unknown;
  };
  const prompts =
    record.suggestionPrompts &&
    typeof record.suggestionPrompts === 'object' &&
    !Array.isArray(record.suggestionPrompts)
      ? Object.fromEntries(
          Object.entries(record.suggestionPrompts)
            .filter(
              ([key, prompt]) =>
                key.length > 0 &&
                key.length <= 120 &&
                typeof prompt === 'string' &&
                prompt.length <= 20_000,
            )
            .map(([key, prompt]) => [key, prompt as string]),
        )
      : {};
  return {
    enabled: { suggestions: record.enabled?.suggestions !== false },
    homeTitle:
      typeof record.homeTitle === 'string' && record.homeTitle.trim().length > 0
        ? record.homeTitle.slice(0, 160)
        : defaults.homeTitle,
    homeSubtitle:
      typeof record.homeSubtitle === 'string'
        ? record.homeSubtitle.slice(0, 300)
        : defaults.homeSubtitle,
    suggestionPrompts: { ...defaults.suggestionPrompts, ...prompts },
    suggestionCards:
      record.suggestionCards &&
      typeof record.suggestionCards === 'object' &&
      !Array.isArray(record.suggestionCards)
        ? Object.fromEntries(
            Object.entries(record.suggestionCards)
              .filter(([key, value]) => {
                if (
                  !key ||
                  key.length > 120 ||
                  !value ||
                  typeof value !== 'object' ||
                  Array.isArray(value)
                )
                  return false;
                const card = value as Record<string, unknown>;
                return (
                  typeof card.label === 'string' &&
                  typeof card.prompt === 'string' &&
                  Array.isArray(card.skills)
                );
              })
              .map(([key, value]) => {
                const card = value as Record<string, unknown>;
                return [
                  key,
                  {
                    label: String(card.label).slice(0, 120),
                    icon: (typeof card.icon === 'string' &&
                    [
                      'sparkles',
                      'paintbrush',
                      'git-branch',
                      'bug',
                      'zap',
                      'bot',
                      'terminal',
                      'layers',
                    ].includes(card.icon)
                      ? card.icon
                      : 'sparkles') as WelcomePreferences['suggestionCards'][string]['icon'],
                    ...(isWelcomeIconSource(card.iconSource)
                      ? { iconSource: card.iconSource }
                      : {}),
                    prompt: String(card.prompt).slice(0, 20_000),
                    ...(typeof card.provider === 'string'
                      ? { provider: card.provider.slice(0, 120) }
                      : {}),
                    ...(typeof card.model === 'string' ? { model: card.model.slice(0, 240) } : {}),
                    ...(typeof card.reasoning === 'string'
                      ? { reasoning: card.reasoning.slice(0, 80) }
                      : {}),
                    ...(typeof card.permission === 'string'
                      ? { permission: card.permission.slice(0, 80) }
                      : {}),
                    skills: (Array.isArray(card.skills) ? card.skills : [])
                      .filter((skill: unknown): skill is string => typeof skill === 'string')
                      .slice(0, 30),
                    enabled: card.enabled !== false,
                  },
                ];
              }),
          )
        : defaults.suggestionCards,
    ...(record.background &&
    typeof record.background === 'object' &&
    !Array.isArray(record.background)
      ? (() => {
          const background = record.background as Record<string, unknown>;
          return typeof background.source === 'string' && background.source.length <= 7_000_000
            ? {
                background: {
                  source: background.source,
                  fit:
                    background.fit === 'contain' || background.fit === 'fill'
                      ? background.fit
                      : 'cover',
                  position:
                    typeof background.position === 'string'
                      ? background.position.slice(0, 40)
                      : 'center',
                  opacity:
                    typeof background.opacity === 'number'
                      ? Math.min(1, Math.max(0, background.opacity))
                      : 0.45,
                },
              }
            : {};
        })()
      : {}),
  };
}

function normalizeShortcut(value: unknown, fallback: DesktopShortcut): DesktopShortcut {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...fallback, keys: [...fallback.keys] };
  }
  const candidate = value as Partial<DesktopShortcut>;
  const keys =
    Array.isArray(candidate.keys) &&
    candidate.keys.length > 0 &&
    candidate.keys.length <= 5 &&
    candidate.keys.every(
      (key) => typeof key === 'string' && key.trim().length > 0 && key.length <= 40,
    )
      ? candidate.keys.map((key) => key.trim())
      : [...fallback.keys];
  return { ...fallback, keys };
}

function normalizeShortcuts(value: unknown): DesktopShortcut[] {
  if (!Array.isArray(value)) return cloneDefaultDesktopShortcuts();
  const supplied = new Map<string, unknown>();
  for (const shortcut of value) {
    if (!shortcut || typeof shortcut !== 'object' || Array.isArray(shortcut)) continue;
    const id = (shortcut as { id?: unknown }).id;
    if (typeof id === 'string') supplied.set(id, shortcut);
  }
  return DEFAULT_DESKTOP_SHORTCUTS.map((fallback) =>
    normalizeShortcut(supplied.get(fallback.id), fallback),
  );
}

function normalizeSettings(value: unknown): DesktopUiSettings {
  const defaults = defaultDesktopUiSettings();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return defaults;
  const record = value as Partial<DesktopUiSettings>;
  return {
    welcome: normalizeWelcome(record.welcome),
    shortcuts: normalizeShortcuts(record.shortcuts),
    onboardingReplayRevision:
      Number.isSafeInteger(record.onboardingReplayRevision) &&
      Number(record.onboardingReplayRevision) >= 0
        ? Number(record.onboardingReplayRevision)
        : 0,
    ...(typeof record.updatedAt === 'number' ? { updatedAt: record.updatedAt } : {}),
  };
}

function writeSettings(settings: DesktopUiSettings): DesktopUiSettings {
  const path = settingsPath();
  const next = normalizeSettings(settings);
  next.updatedAt = Date.now();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + '.' + process.pid + '.tmp';
  writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
  renameSync(temporary, path);
  return next;
}

export function loadDesktopUiSettings(): DesktopUiSettings {
  const path = settingsPath();
  if (!existsSync(path)) return defaultDesktopUiSettings();
  try {
    return normalizeSettings(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    serverLog.warn({ path, error }, 'Failed to load desktop UI settings');
    return defaultDesktopUiSettings();
  }
}

export function saveWelcomePreferences(value: unknown): DesktopUiSettings {
  const current = loadDesktopUiSettings();
  return writeSettings({ ...current, welcome: normalizeWelcome(value) });
}

export function saveDesktopShortcuts(value: unknown): DesktopUiSettings {
  const current = loadDesktopUiSettings();
  return writeSettings({ ...current, shortcuts: normalizeShortcuts(value) });
}

export function resetDesktopShortcuts(): DesktopUiSettings {
  const current = loadDesktopUiSettings();
  return writeSettings({ ...current, shortcuts: cloneDefaultDesktopShortcuts() });
}

export function requestOnboardingReplay(): DesktopUiSettings {
  const current = loadDesktopUiSettings();
  return writeSettings({
    ...current,
    onboardingReplayRevision: current.onboardingReplayRevision + 1,
  });
}
