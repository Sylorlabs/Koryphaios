/**
 * Mode Store - Beginner vs Advanced mode management
 * 
 * Beginner Mode:
 * - Git panel completely hidden
 * - Friendly, non-technical language
 * - Auto-commit enabled
 * - Simplified UI
 * 
 * Advanced Mode:
 * - Full Git panel with shadow logger
 * - Technical terminology
 * - Manual commit control
 * - Full feature access
 */

import type { UIMode, ModeConfig, ModeContext } from "@koryphaios/shared";
import { MODE_DISPLAY_NAMES, MODE_DESCRIPTIONS } from "@koryphaios/shared";
import { apiUrl } from "$lib/utils/api-url";
import { toastStore } from "./toast.svelte";

const STORAGE_KEY = "koryphaios-mode";

interface ModeState {
  mode: UIMode;
  config: ModeConfig;
  context: ModeContext;
  shouldWarnNoGit: boolean;
  noGitWarning: string | null;
  isLoading: boolean;
}

function createModeStore() {
  // Initialize from localStorage or default to beginner
  const stored = typeof localStorage !== "undefined" 
    ? localStorage.getItem(STORAGE_KEY) as UIMode | null 
    : null;
  
  const initialMode: UIMode = stored === "advanced" ? "advanced" : "beginner";

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

  // Persist mode changes
  $effect(() => {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, state.mode);
    }
  });

  function getDefaultConfig(mode: UIMode): ModeConfig {
    if (mode === "beginner") {
      return {
        hideGitPanel: true,
        autoCommit: true,
        simplifiedPrompts: true,
        maxWorkers: 2,
        requireConfirmations: false,
        toolAccess: "curated",
        explanations: "verbose",
        enableShadowLoggerUI: false,
        enableWorktrees: false,
        enableCriticGate: false,
        showAgentDetails: false,
        showCostTracking: false,
      };
    }
    return {
      hideGitPanel: false,
      autoCommit: false,
      simplifiedPrompts: false,
      maxWorkers: 8,
      requireConfirmations: true,
      toolAccess: "full",
      explanations: "minimal",
      enableShadowLoggerUI: true,
      enableWorktrees: true,
      enableCriticGate: true,
      showAgentDetails: true,
      showCostTracking: true,
    };
  }

  async function fetchMode(): Promise<void> {
    try {
      const res = await fetch(apiUrl("/api/mode"), {
        credentials: "include",
      });
      
      if (res.ok) {
        const data = await res.json();
        state.mode = data.mode;
        state.config = data.config;
        state.context = data.context;
        state.shouldWarnNoGit = data.shouldWarnNoGit;
        state.noGitWarning = data.noGitWarning;
      }
    } catch (err) {
      console.error("Failed to fetch mode:", err);
    }
  }

  async function setMode(mode: UIMode): Promise<void> {
    if (state.mode === mode) return;
    
    state.isLoading = true;
    
    try {
      const res = await fetch(apiUrl("/api/mode"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ mode }),
      });

      if (res.ok) {
        const data = await res.json();
        state.mode = data.mode;
        state.config = data.config;
        
        // Update context mode
        state.context = {
          ...state.context,
          mode: data.mode,
          config: data.config,
        };

        toastStore.success(`Switched to ${MODE_DISPLAY_NAMES[mode]} mode`);
      } else {
        throw new Error("Failed to switch mode");
      }
    } catch (err) {
      toastStore.error("Failed to switch mode");
      console.error(err);
    } finally {
      state.isLoading = false;
    }
  }

  async function toggleMode(): Promise<void> {
    const newMode = state.mode === "beginner" ? "advanced" : "beginner";
    await setMode(newMode);
  }

  function dismissNoGitWarning(): void {
    state.shouldWarnNoGit = false;
  }

  return {
    get mode() { return state.mode; },
    get config() { return state.config; },
    get context() { return state.context; },
    get shouldWarnNoGit() { return state.shouldWarnNoGit; },
    get noGitWarning() { return state.noGitWarning; },
    get isLoading() { return state.isLoading; },
    get isBeginner() { return state.mode === "beginner"; },
    get isAdvanced() { return state.mode === "advanced"; },
    get displayName() { return MODE_DISPLAY_NAMES[state.mode]; },
    get description() { return MODE_DESCRIPTIONS[state.mode]; },
    
    // Computed helpers
    get showGitPanel() { return !state.config.hideGitPanel; },
    get showAgentDetails() { return state.config.showAgentDetails; },
    get showCostTracking() { return state.config.showCostTracking; },
    get autoCommit() { return state.config.autoCommit; },
    get requireConfirmations() { return state.config.requireConfirmations; },
    
    fetchMode,
    setMode,
    toggleMode,
    dismissNoGitWarning,
  };
}

export const modeStore = createModeStore();
