export type WelcomePanelId = 'suggestions' | 'proTips' | 'workflow';

export interface WelcomePreferences {
  enabled: Record<WelcomePanelId, boolean>;
  suggestionPrompts: Record<string, string>;
  proTips: string[];
  workflow: string[];
}

export const DEFAULT_WELCOME_PREFERENCES: WelcomePreferences = {
  enabled: { suggestions: true, proTips: true, workflow: true },
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
  proTips: [
    'Ask for a repo walkthrough before making changes.',
    'Review spacing and hierarchy before polish work.',
  ],
  workflow: ['Use composer below for direct tasks.', 'Open Git panel for change review.'],
};

const STORAGE_KEY = 'koryphaios-welcome-preferences-v1';

function cloneDefaults(): WelcomePreferences {
  return {
    enabled: { ...DEFAULT_WELCOME_PREFERENCES.enabled },
    suggestionPrompts: { ...DEFAULT_WELCOME_PREFERENCES.suggestionPrompts },
    proTips: [...DEFAULT_WELCOME_PREFERENCES.proTips],
    workflow: [...DEFAULT_WELCOME_PREFERENCES.workflow],
  };
}

function readPreferences(): WelcomePreferences {
  const defaults = cloneDefaults();
  if (typeof localStorage === 'undefined') return defaults;
  try {
    const parsed = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? '{}',
    ) as Partial<WelcomePreferences>;
    return {
      enabled: {
        suggestions: parsed.enabled?.suggestions !== false,
        proTips: parsed.enabled?.proTips !== false,
        workflow: parsed.enabled?.workflow !== false,
      },
      suggestionPrompts: {
        ...defaults.suggestionPrompts,
        ...(parsed.suggestionPrompts ?? {}),
      },
      proTips:
        Array.isArray(parsed.proTips) && parsed.proTips.every((item) => typeof item === 'string')
          ? parsed.proTips
          : defaults.proTips,
      workflow:
        Array.isArray(parsed.workflow) && parsed.workflow.every((item) => typeof item === 'string')
          ? parsed.workflow
          : defaults.workflow,
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

  function updatePanelItem(panel: 'proTips' | 'workflow', index: number, text: string) {
    const items = [...preferences[panel]];
    items[index] = text;
    preferences[panel] = items;
    persist();
  }

  function resetPanel(panel: WelcomePanelId) {
    if (panel === 'suggestions') {
      preferences.suggestionPrompts = { ...DEFAULT_WELCOME_PREFERENCES.suggestionPrompts };
    } else {
      preferences[panel] = [...DEFAULT_WELCOME_PREFERENCES[panel]];
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
    updatePanelItem,
    resetPanel,
  };
}

export const welcomePreferencesStore = createWelcomePreferencesStore();
