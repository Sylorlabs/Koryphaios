export type WelcomePanelId = 'suggestions';

export interface WelcomePreferences {
  enabled: Record<WelcomePanelId, boolean>;
  suggestionPrompts: Record<string, string>;
}

export const DEFAULT_WELCOME_PREFERENCES: WelcomePreferences = {
  enabled: { suggestions: true },
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
};

const STORAGE_KEY = 'koryphaios-welcome-preferences-v1';

function cloneDefaults(): WelcomePreferences {
  return {
    enabled: { ...DEFAULT_WELCOME_PREFERENCES.enabled },
    suggestionPrompts: { ...DEFAULT_WELCOME_PREFERENCES.suggestionPrompts },
  };
}

function readPreferences(): WelcomePreferences {
  const defaults = cloneDefaults();
  if (typeof localStorage === 'undefined') return defaults;
  try {
    // Older payloads also carried `proTips` / `workflow` panels. Those panels
    // were removed in favor of the first-launch walkthrough; unknown keys are
    // simply ignored here and dropped on the next persist.
    const parsed = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? '{}',
    ) as Partial<WelcomePreferences>;
    return {
      enabled: {
        suggestions: parsed.enabled?.suggestions !== false,
      },
      suggestionPrompts: {
        ...defaults.suggestionPrompts,
        ...(parsed.suggestionPrompts ?? {}),
      },
    };
  } catch {
    return defaults;
  }
}

function createWelcomePreferencesStore() {
  let preferences = $state<WelcomePreferences>(readPreferences());

  function persist() {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
    } catch {}
  }

  function setPanelEnabled(panel: WelcomePanelId, enabled: boolean) {
    preferences.enabled = { ...preferences.enabled, [panel]: enabled };
    persist();
  }

  function updateSuggestion(id: string, prompt: string) {
    preferences.suggestionPrompts = { ...preferences.suggestionPrompts, [id]: prompt };
    persist();
  }

  function resetPanel(panel: WelcomePanelId) {
    if (panel === 'suggestions') {
      preferences.suggestionPrompts = { ...DEFAULT_WELCOME_PREFERENCES.suggestionPrompts };
    }
    preferences.enabled = { ...preferences.enabled, [panel]: true };
    persist();
  }

  return {
    get preferences() {
      return preferences;
    },
    setPanelEnabled,
    updateSuggestion,
    resetPanel,
  };
}

export const welcomePreferencesStore = createWelcomePreferencesStore();
