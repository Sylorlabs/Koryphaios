/**
 * Agent Settings Store
 * 
 * Manages agent behavior, rule enforcement, and workflow preferences.
 * Rules are ALWAYS applied - no option to disable.
 */

import { apiUrl } from "$lib/utils/api-url";
import { toastStore } from "./toast.svelte";

// ============================================================================
// Types
// ============================================================================

export interface AgentSettings {
  ruleEnforcementLevel: "strict" | "moderate" | "lenient";
  preferencesEnabled: boolean;
  criticGateEnabled: boolean;
  criticEnforcesPreferences: boolean;
  autoApplySafeFixes: boolean;
  confirmRuleViolations: boolean;
  agentMemoryEnabled: boolean;
  agentCanUpdatePreferences: boolean;
  maxCriticIterations: number;
  approvalThresholdFiles: number;
  approvalThresholdLines: number;
}

export interface CriticReviewResult {
  approved: boolean;
  canAutoFix: boolean;
  violations: Array<{
    rule: string;
    severity: "critical" | "error" | "warning";
    message: string;
    file?: string;
    line?: number;
  }>;
  warnings: Array<{
    rule: string;
    message: string;
    suggestion: string;
  }>;
  suggestions: string[];
  requiredChanges: string[];
}

export interface AgentContext {
  settings: AgentSettings;
  preferences: string;
  rules: string;
  enforcementMessage: string;
}

// ============================================================================
// Default Settings
// ============================================================================

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  ruleEnforcementLevel: "strict",
  preferencesEnabled: true,
  criticGateEnabled: true,
  criticEnforcesPreferences: true,
  autoApplySafeFixes: false,
  confirmRuleViolations: true,
  agentMemoryEnabled: true,
  agentCanUpdatePreferences: false,
  maxCriticIterations: 3,
  approvalThresholdFiles: 5,
  approvalThresholdLines: 100,
};

// ============================================================================
// Store Factory
// ============================================================================

function createAgentSettingsStore() {
  let settings = $state<AgentSettings>(DEFAULT_AGENT_SETTINGS);
  let preferences = $state<{ exists: boolean; content: string; path: string } | null>(null);
  let isLoading = $state(false);
  let activeTab = $state<"settings" | "preferences" | "enforcement">("settings");
  let lastCriticResult = $state<CriticReviewResult | null>(null);

  // ========================================================================
  // Settings
  // ========================================================================

  async function loadSettings(): Promise<void> {
    isLoading = true;
    try {
      const res = await fetch(apiUrl("/api/agent/settings"), {
        credentials: "include",
      });

      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          settings = data.data;
        }
      }
    } catch (err) {
      console.error("Failed to load agent settings:", err);
    } finally {
      isLoading = false;
    }
  }

  async function saveSettings(newSettings: Partial<AgentSettings>): Promise<boolean> {
    isLoading = true;
    try {
      const res = await fetch(apiUrl("/api/agent/settings"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(newSettings),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          settings = data.data;
          toastStore.success("Agent settings saved");
          return true;
        }
      }
      throw new Error("Failed to save");
    } catch (err) {
      toastStore.error("Failed to save agent settings");
      return false;
    } finally {
      isLoading = false;
    }
  }

  async function resetSettings(): Promise<boolean> {
    try {
      const res = await fetch(apiUrl("/api/agent/settings/reset"), {
        method: "POST",
        credentials: "include",
      });

      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          settings = data.data;
          toastStore.success("Agent settings reset to defaults");
          return true;
        }
      }
      return false;
    } catch (err) {
      toastStore.error("Failed to reset agent settings");
      return false;
    }
  }

  // ========================================================================
  // Preferences
  // ========================================================================

  async function loadPreferences(): Promise<void> {
    try {
      const res = await fetch(apiUrl("/api/agent/preferences"), {
        credentials: "include",
      });

      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          preferences = data.data;
        }
      }
    } catch (err) {
      console.error("Failed to load preferences:", err);
    }
  }

  async function savePreferences(content: string): Promise<boolean> {
    isLoading = true;
    try {
      const res = await fetch(apiUrl("/api/agent/preferences"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ content }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          preferences = { ...preferences, content, exists: true } as typeof preferences;
          toastStore.success("Preferences saved. Critic will enforce new rules.");
          return true;
        }
      }
      throw new Error("Failed to save");
    } catch (err) {
      toastStore.error("Failed to save preferences");
      return false;
    } finally {
      isLoading = false;
    }
  }

  async function initializePreferences(): Promise<void> {
    try {
      const res = await fetch(apiUrl("/api/agent/preferences/init"), {
        method: "POST",
        credentials: "include",
      });

      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          preferences = data.data;
          toastStore.success("Preferences initialized with template");
        }
      }
    } catch (err) {
      toastStore.error("Failed to initialize preferences");
    }
  }

  // ========================================================================
  // Context & Enforcement
  // ========================================================================

  async function loadContext(): Promise<AgentContext | null> {
    try {
      const res = await fetch(apiUrl("/api/agent/context"), {
        credentials: "include",
      });

      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          return data.data;
        }
      }
      return null;
    } catch (err) {
      console.error("Failed to load agent context:", err);
      return null;
    }
  }

  async function runCriticReview(
    code: string,
    filePath: string,
    changeDescription: string
  ): Promise<CriticReviewResult | null> {
    isLoading = true;
    try {
      const res = await fetch(apiUrl("/api/agent/critic-review"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ code, filePath, changeDescription }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          lastCriticResult = data.data;
          return data.data;
        }
      }
      return null;
    } catch (err) {
      console.error("Critic review failed:", err);
      return null;
    } finally {
      isLoading = false;
    }
  }

  // ========================================================================
  // Bulk Operations
  // ========================================================================

  async function loadAll(): Promise<void> {
    isLoading = true;
    try {
      await Promise.all([
        loadSettings(),
        loadPreferences(),
      ]);
    } finally {
      isLoading = false;
    }
  }

  function setActiveTab(tab: typeof activeTab): void {
    activeTab = tab;
  }

  // ========================================================================
  // Getters
  // ========================================================================

  return {
    // State
    get settings() { return settings; },
    get preferences() { return preferences; },
    get isLoading() { return isLoading; },
    get activeTab() { return activeTab; },
    get lastCriticResult() { return lastCriticResult; },

    // Rules are always enforced - no getter to disable
    get rulesAlwaysEnforced() { return true; },
    get criticActive() { return settings.criticGateEnabled; },
    get strictMode() { return settings.ruleEnforcementLevel === "strict"; },

    // Settings
    loadSettings,
    saveSettings,
    resetSettings,

    // Preferences
    loadPreferences,
    savePreferences,
    initializePreferences,

    // Context & Enforcement
    loadContext,
    runCriticReview,

    // Bulk
    loadAll,
    setActiveTab,
  };
}

export const agentSettingsStore = createAgentSettingsStore();
