export type WelcomePanelId = 'suggestions';

export interface WelcomeSuggestionCard {
  label: string;
  icon: 'sparkles' | 'paintbrush' | 'git-branch' | 'bug' | 'zap' | 'bot' | 'terminal' | 'layers';
  /** Locally imported, resized image; the built-in icon remains the fallback. */
  iconSource?: string;
  prompt: string;
  provider?: string;
  model?: string;
  reasoning?: string;
  permission?: string;
  skills: string[];
  enabled: boolean;
}

export function isWelcomeIconSource(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 350_000 &&
    /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
  );
}

export interface WelcomeBackground {
  source: string;
  fit: 'cover' | 'contain' | 'fill';
  position: string;
  opacity: number;
}

export interface WelcomePreferences {
  enabled: Record<WelcomePanelId, boolean>;
  homeTitle: string;
  homeSubtitle: string;
  suggestionPrompts: Record<string, string>;
  suggestionCards: Record<string, WelcomeSuggestionCard>;
  background?: WelcomeBackground;
}

export interface DesktopShortcut {
  id: string;
  keys: string[];
  action: string;
  description?: string;
}

export interface DesktopUiSettings {
  welcome: WelcomePreferences;
  shortcuts: DesktopShortcut[];
  onboardingReplayRevision: number;
  updatedAt?: number;
}

export const DEFAULT_WELCOME_PREFERENCES: WelcomePreferences = {
  enabled: { suggestions: true },
  homeTitle: 'Start with your project',
  homeSubtitle: 'Choose a starting point, or write a task below.',
  suggestionPrompts: {
    'map-codebase':
      'Inspect this project and summarize the architecture, key entry points, and the highest-leverage next steps.',
    'critique-ui':
      'Critique the current UI in this project, identify the weakest hierarchy and spacing choices, and recommend the most important visual fixes.',
    'review-changes':
      'Review the current uncommitted changes in this project and identify the most likely bugs, regressions, or missing tests.',
    'debug-regression':
      'Help me trace a bug in this project. Start by asking for the failing behavior or error, then narrow the likely root cause.',
  },
  suggestionCards: {
    'map-codebase': {
      label: 'Map the codebase',
      icon: 'zap',
      prompt:
        'Inspect this project and summarize the architecture, key entry points, and the highest-leverage next steps.',
      skills: [],
      enabled: true,
    },
    'critique-ui': {
      label: 'Critique the UI',
      icon: 'paintbrush',
      prompt:
        'Critique the current UI in this project, identify the weakest hierarchy and spacing choices, and recommend the most important visual fixes.',
      skills: [],
      enabled: true,
    },
    'review-changes': {
      label: 'Review recent changes',
      icon: 'git-branch',
      prompt:
        'Review the current uncommitted changes in this project and identify the most likely bugs, regressions, or missing tests.',
      skills: [],
      enabled: true,
    },
    'debug-regression': {
      label: 'Debug a regression',
      icon: 'bug',
      prompt:
        'Help me trace a bug in this project. Start by asking for the failing behavior or error, then narrow the likely root cause.',
      skills: [],
      enabled: true,
    },
  },
};

export const DEFAULT_DESKTOP_SHORTCUTS: DesktopShortcut[] = [
  { id: 'send', keys: ['Mod', 'Enter'], action: 'Send message', description: 'Submit task' },
  { id: 'settings', keys: ['Mod', ','], action: 'Open settings', description: 'Preferences' },
  { id: 'new_session', keys: ['Mod', 'N'], action: 'New session', description: 'Clear' },
  {
    id: 'focus_input',
    keys: ['Mod', 'Shift', 'K'],
    action: 'Focus input',
    description: 'Jump',
  },
  {
    id: 'toggle_palette',
    keys: ['Mod', 'K'],
    action: 'Command palette',
    description: 'Open palette',
  },
  {
    id: 'toggle_zen_mode',
    keys: ['Mod', 'Shift', 'Z'],
    action: 'Toggle Zen mode',
    description: 'Focus',
  },
  {
    id: 'voice_mode',
    // Keep Control on macOS too: Command+Space belongs to Spotlight.
    keys: ['Ctrl', ' '],
    action: 'Voice mode',
    description: 'Press to record, press again to transcribe',
  },
  { id: 'close', keys: ['Esc'], action: 'Close dialogs', description: 'Back' },
];

export function cloneDefaultWelcomePreferences(): WelcomePreferences {
  return {
    enabled: { ...DEFAULT_WELCOME_PREFERENCES.enabled },
    homeTitle: DEFAULT_WELCOME_PREFERENCES.homeTitle,
    homeSubtitle: DEFAULT_WELCOME_PREFERENCES.homeSubtitle,
    suggestionPrompts: { ...DEFAULT_WELCOME_PREFERENCES.suggestionPrompts },
    suggestionCards: JSON.parse(JSON.stringify(DEFAULT_WELCOME_PREFERENCES.suggestionCards)),
  };
}

export function cloneDefaultDesktopShortcuts(): DesktopShortcut[] {
  return DEFAULT_DESKTOP_SHORTCUTS.map((shortcut) => ({
    ...shortcut,
    keys: [...shortcut.keys],
  }));
}

export function defaultDesktopUiSettings(): DesktopUiSettings {
  return {
    welcome: cloneDefaultWelcomePreferences(),
    shortcuts: cloneDefaultDesktopShortcuts(),
    onboardingReplayRevision: 0,
  };
}
