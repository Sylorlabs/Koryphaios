/**
 * Mode Store - Beginner vs Advanced mode management
 *
 * Beginner Mode:
 * - Friendly, non-technical language
 * - Auto-commit enabled
 * - Simplified UI
 *
 * Advanced Mode:
 * - Technical terminology
 * - Manual commit control
 * - Full feature access
 */

import type { UIMode, ModeConfig, ModeContext } from '@koryphaios/shared';
import { MODE_DISPLAY_NAMES, MODE_DESCRIPTIONS } from '@koryphaios/shared';
import { apiUrl } from '$lib/utils/api-url';
import { toastStore } from './toast.svelte';
import { apiFetch, parseJsonResponse } from '$lib/api.svelte';

const STORAGE_KEY = 'koryphaios-mode';

interface ModeState {
  mode: UIMode;
  config: ModeConfig;
  context: ModeContext;
  shouldWarnNoGit: boolean;
  noGitWarning: string | null;
  isLoading: boolean;
}

type ModeResponse = {
  ok: boolean;
  data?: {
    mode: UIMode;
    config: ModeConfig;
    context?: ModeContext;
    shouldWarnNoGit?: boolean;
    noGitWarning?: string | null;
  };
  error?: string;
};

function modeRequestError(response: Response, payload?: ModeResponse): Error {
  return new Error(payload?.error || `Mode settings request failed (HTTP ${response.status})`);
}

function createModeStore() {
  // Initialize from localStorage or default to beginner
  const stored =
    typeof localStorage !== 'undefined'
      ? (localStorage.getItem(STORAGE_KEY) as UIMode | null)
      : null;

  const initialMode: UIMode = stored === 'advanced' ? 'advanced' : 'beginner';

  let state = $state<ModeState>({
    mode: initialMode,
    config: getDefaultConfig(initialMode),
    context: {
      mode: initialMode,
      config: getDefaultConfig(initialMode),
      hasGitRepo: false,
    },
    shouldWarnNoGit: false,
    noGitWarning: null,
    isLoading: false,
  });

  // Persist mode changes - using a derived-like pattern with getter
  // Note: We can't use $effect here since this runs at module level, not component level
  // The persistence is handled in the setMode function instead

  function getDefaultConfig(mode: UIMode): ModeConfig {
    if (mode === 'beginner') {
      return {
        autoCommit: true,
        simplifiedPrompts: true,
        maxWorkers: 2,
        requireConfirmations: false,
        toolAccess: 'curated',
        explanations: 'verbose',
        enableShadowLoggerUI: false,
        enableWorktrees: false,
        enableCriticGate: false,
        showAgentDetails: false,
        showCostTracking: false,
      };
    }
    return {
      autoCommit: false,
      simplifiedPrompts: false,
      maxWorkers: 8,
      requireConfirmations: true,
      toolAccess: 'full',
      explanations: 'minimal',
      enableShadowLoggerUI: true,
      enableWorktrees: true,
      enableCriticGate: true,
      showAgentDetails: true,
      showCostTracking: true,
    };
  }

  async function fetchMode(): Promise<void> {
    try {
      const res = await apiFetch(apiUrl('/api/mode'));
      const payload = await parseJsonResponse<ModeResponse>(res);
      if (!res.ok || !payload.ok || !payload.data) throw modeRequestError(res, payload);

      const data = payload.data;
      state.mode = data.mode;
      state.config = data.config;
      state.context = data.context ?? {
        ...state.context,
        mode: data.mode,
        config: data.config,
      };
      state.shouldWarnNoGit = data.shouldWarnNoGit ?? false;
      state.noGitWarning = data.noGitWarning ?? null;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      toastStore.error(`Could not load workspace mode: ${message}`, {
        onRetry: () => void fetchMode(),
      });
      console.error('Failed to fetch mode:', err);
    }
  }

  async function setMode(mode: UIMode): Promise<void> {
    if (state.mode === mode) return;

    state.isLoading = true;

    try {
      const res = await apiFetch(apiUrl('/api/mode'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });

      const payload = await parseJsonResponse<ModeResponse>(res);
      if (res.ok && payload.ok && payload.data) {
        const data = payload.data;
        state.mode = data.mode;
        state.config = data.config;

        // Update context mode
        state.context = {
          ...state.context,
          mode: data.mode,
          config: data.config,
        };

        // Persist to localStorage
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(STORAGE_KEY, state.mode);
        }

        toastStore.success(`Switched to ${MODE_DISPLAY_NAMES[mode]} mode`);
      } else {
        throw modeRequestError(res, payload);
      }
    } catch (err) {
      toastStore.error('Failed to switch mode');
      console.error(err);
    } finally {
      state.isLoading = false;
    }
  }

  async function toggleMode(): Promise<void> {
    const newMode = state.mode === 'beginner' ? 'advanced' : 'beginner';
    await setMode(newMode);
  }

  function dismissNoGitWarning(): void {
    state.shouldWarnNoGit = false;
  }

  return {
    get mode() {
      return state.mode;
    },
    get config() {
      return state.config;
    },
    get context() {
      return state.context;
    },
    get shouldWarnNoGit() {
      return state.shouldWarnNoGit;
    },
    get noGitWarning() {
      return state.noGitWarning;
    },
    get isLoading() {
      return state.isLoading;
    },
    get isBeginner() {
      return state.mode === 'beginner';
    },
    get isAdvanced() {
      return state.mode === 'advanced';
    },
    get displayName() {
      return MODE_DISPLAY_NAMES[state.mode];
    },
    get description() {
      return MODE_DESCRIPTIONS[state.mode];
    },

    // Computed helpers - with safety checks for undefined state
    get showAgentDetails() {
      return state.config?.showAgentDetails ?? false;
    },
    get showCostTracking() {
      return state.config?.showCostTracking ?? false;
    },
    get autoCommit() {
      return state.config.autoCommit;
    },
    get requireConfirmations() {
      return state.config.requireConfirmations;
    },

    fetchMode,
    setMode,
    toggleMode,
    dismissNoGitWarning,
  };
}

export const modeStore = createModeStore();
