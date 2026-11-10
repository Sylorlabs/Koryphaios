import { browser } from '$app/environment';
import { apiFetch } from '$lib/api.svelte';
import { apiUrl } from '$lib/utils/api-url';
import type {
  WelcomeBackground,
  WelcomePreferences as SharedWelcomePreferences,
  WelcomeSuggestionCard,
} from '@koryphaios/shared';

export type WelcomePanelId = 'suggestions';

export interface WelcomePreferences extends SharedWelcomePreferences {
  enabled: Record<WelcomePanelId, boolean>;
  suggestionPrompts: Record<string, string>;
  suggestionCards: Record<string, WelcomeSuggestionCard>;
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

const STORAGE_KEY = 'koryphaios-welcome-preferences-v1';

function cloneDefaults(): WelcomePreferences {
  return {
    enabled: { ...DEFAULT_WELCOME_PREFERENCES.enabled },
    homeTitle: DEFAULT_WELCOME_PREFERENCES.homeTitle,
    homeSubtitle: DEFAULT_WELCOME_PREFERENCES.homeSubtitle,
    suggestionPrompts: { ...DEFAULT_WELCOME_PREFERENCES.suggestionPrompts },
    suggestionCards: JSON.parse(JSON.stringify(DEFAULT_WELCOME_PREFERENCES.suggestionCards)),
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
      homeTitle: parsed.homeTitle || defaults.homeTitle,
      homeSubtitle: parsed.homeSubtitle ?? defaults.homeSubtitle,
      suggestionPrompts: {
        ...defaults.suggestionPrompts,
        ...(parsed.suggestionPrompts ?? {}),
      },
      suggestionCards: parsed.suggestionCards ?? defaults.suggestionCards,
      background: parsed.background,
    };
  } catch {
    return defaults;
  }
}

function createWelcomePreferencesStore() {
  let preferences = $state<WelcomePreferences>(readPreferences());
  let persistTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingBackendSnapshot: WelcomePreferences | undefined;
  let backendSaveRunning = false;

  function persistLocal() {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
    } catch {}
  }

  async function persistToBackend(snapshot: WelcomePreferences) {
    if (!browser) return;
    try {
      await apiFetch(apiUrl('/api/desktop-ui/welcome'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(snapshot),
      });
    } catch {}
  }

  async function flushBackendSaves() {
    if (backendSaveRunning) return;
    backendSaveRunning = true;
    try {
      while (pendingBackendSnapshot) {
        const snapshot = pendingBackendSnapshot;
        pendingBackendSnapshot = undefined;
        await persistToBackend(snapshot);
      }
    } finally {
      backendSaveRunning = false;
    }
  }

  function persist() {
    persistLocal();
    if (!browser) return;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = undefined;
      pendingBackendSnapshot = JSON.parse(JSON.stringify(preferences)) as WelcomePreferences;
      void flushBackendSaves();
    }, 180);
  }

  function applyRemote(next: SharedWelcomePreferences) {
    preferences.enabled = { suggestions: next.enabled?.suggestions !== false };
    preferences.homeTitle = next.homeTitle || DEFAULT_WELCOME_PREFERENCES.homeTitle;
    preferences.homeSubtitle = next.homeSubtitle ?? DEFAULT_WELCOME_PREFERENCES.homeSubtitle;
    preferences.suggestionPrompts = {
      ...DEFAULT_WELCOME_PREFERENCES.suggestionPrompts,
      ...(next.suggestionPrompts ?? {}),
    };
    preferences.suggestionCards = next.suggestionCards ?? cloneDefaults().suggestionCards;
    preferences.background = next.background;
    persistLocal();
  }

  function setPanelEnabled(panel: WelcomePanelId, enabled: boolean) {
    preferences.enabled = { ...preferences.enabled, [panel]: enabled };
    persist();
  }

  function setHomeCopy(patch: Partial<Pick<WelcomePreferences, 'homeTitle' | 'homeSubtitle'>>) {
    if (patch.homeTitle !== undefined) preferences.homeTitle = patch.homeTitle;
    if (patch.homeSubtitle !== undefined) preferences.homeSubtitle = patch.homeSubtitle;
    persist();
  }

  function updateSuggestion(id: string, prompt: string) {
    preferences.suggestionPrompts = { ...preferences.suggestionPrompts, [id]: prompt };
    if (preferences.suggestionCards[id]) {
      preferences.suggestionCards = {
        ...preferences.suggestionCards,
        [id]: { ...preferences.suggestionCards[id], prompt },
      };
    }
    persist();
  }

  function setSuggestionCard(id: string, patch: Partial<WelcomeSuggestionCard>) {
    const current = preferences.suggestionCards[id] ?? {
      label: 'New preset',
      icon: 'sparkles' as const,
      prompt: '',
      skills: [],
      enabled: true,
    };
    preferences.suggestionCards = {
      ...preferences.suggestionCards,
      [id]: { ...current, ...patch },
    };
    if (patch.prompt !== undefined) {
      preferences.suggestionPrompts = { ...preferences.suggestionPrompts, [id]: patch.prompt };
    }
    persist();
  }

  function addSuggestionCard() {
    const id = `custom-${crypto.randomUUID()}`;
    setSuggestionCard(id, {
      label: 'New preset',
      prompt: 'Describe the task this preset should start.',
      icon: 'sparkles',
      skills: [],
      enabled: true,
    });
    return id;
  }

  function removeSuggestionCard(id: string) {
    const cards = { ...preferences.suggestionCards };
    delete cards[id];
    preferences.suggestionCards = cards;
    const prompts = { ...preferences.suggestionPrompts };
    delete prompts[id];
    preferences.suggestionPrompts = prompts;
    persist();
  }

  function setBackground(background: WelcomeBackground | undefined) {
    preferences.background = background;
    persist();
  }

  function resetPanel(panel: WelcomePanelId) {
    if (panel === 'suggestions') {
      preferences.suggestionPrompts = { ...DEFAULT_WELCOME_PREFERENCES.suggestionPrompts };
      preferences.homeTitle = DEFAULT_WELCOME_PREFERENCES.homeTitle;
      preferences.homeSubtitle = DEFAULT_WELCOME_PREFERENCES.homeSubtitle;
      preferences.suggestionCards = JSON.parse(
        JSON.stringify(DEFAULT_WELCOME_PREFERENCES.suggestionCards),
      );
      preferences.background = undefined;
    }
    preferences.enabled = { ...preferences.enabled, [panel]: true };
    persist();
  }

  return {
    get preferences() {
      return preferences;
    },
    applyRemote,
    setPanelEnabled,
    setHomeCopy,
    updateSuggestion,
    setSuggestionCard,
    addSuggestionCard,
    removeSuggestionCard,
    setBackground,
    resetPanel,
  };
}

export const welcomePreferencesStore = createWelcomePreferencesStore();
