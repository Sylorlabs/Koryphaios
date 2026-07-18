/**
 * Agent Settings Store
 *
 * Manages agent behavior, rule enforcement, and workflow preferences.
 * Rules are ALWAYS applied - no option to disable.
 */

import { apiUrl } from '$lib/utils/api-url';
import { toastStore } from './toast.svelte';
import { apiFetch } from '$lib/api.svelte';

// ============================================================================
// Types
// ============================================================================

export interface AgentSettings {
  ruleEnforcementLevel: 'strict' | 'moderate' | 'lenient';
  agentExecutionMode: 'auto' | 'single' | 'multi';
  preferencesEnabled: boolean;
  criticGateEnabled: boolean;
  gateStrictness: 'strict' | 'advisory' | 'off';
  intentInterview: 'off' | 'adaptive' | 'deep';
  designDiscovery: boolean;
  planApproval: 'always' | 'material' | 'never';
  modelQualification: 'enforce' | 'warn' | 'off';
  feedbackSharing: 'local' | 'sanitized-opt-in';
  skillLearningMode: 'human-only' | 'propose-then-verify' | 'automatic';
  criticEnforcesPreferences: boolean;
  autoApplySafeFixes: boolean;
  confirmRuleViolations: boolean;
  autoRunTools: boolean;
  allowExternalPaths: boolean;
  managerModelAccess: Record<string, string[]>;
  managerNotes: Record<string, string>;
  agentMemoryEnabled: boolean;
  agentCanUpdatePreferences: boolean;
  maxCriticIterations: number;
  approvalThresholdFiles: number;
  approvalThresholdLines: number;
  /** Experimental: Local Web Search (DuckDuckGo) */
  localWebSearch: 'off' | 'on' | 'fallback';
  /** Experimental: Multi-source research requirements */
  multiSourceResearch: boolean;
  /** Context management: auto-stub stale tool outputs (recoverable via fetch_context) */
  contextPruningEnabled: boolean;
  /** Turns whose tool outputs stay full before auto-stubbing */
  contextKeepRecentTurns: number;
  /** Minimum tool-output size (chars) worth stubbing */
  contextPruneMinChars: number;
  /** Live context-usage report injected each turn so the agent self-manages */
  contextSelfAwareness: boolean;
  /** Show complete reasoning blocks expanded in the chat feed by default */
  reasoningExpandedByDefault: boolean;
}

export interface CriticReviewResult {
  approved: boolean;
  canAutoFix: boolean;
  violations: Array<{
    rule: string;
    severity: 'critical' | 'error' | 'warning';
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
  ruleEnforcementLevel: 'strict',
  agentExecutionMode: 'auto',
  preferencesEnabled: true,
  criticGateEnabled: true,
  gateStrictness: 'strict',
  intentInterview: 'adaptive',
  designDiscovery: true,
  planApproval: 'material',
  modelQualification: 'enforce',
  feedbackSharing: 'local',
  skillLearningMode: 'propose-then-verify',
  criticEnforcesPreferences: true,
  autoApplySafeFixes: false,
  confirmRuleViolations: true,
  autoRunTools: true,
  allowExternalPaths: false,
  managerModelAccess: {},
  managerNotes: {},
  agentMemoryEnabled: true,
  agentCanUpdatePreferences: false,
  maxCriticIterations: 3,
  approvalThresholdFiles: 5,
  approvalThresholdLines: 100,
  localWebSearch: 'fallback',
  multiSourceResearch: true,
  contextPruningEnabled: true,
  contextKeepRecentTurns: 3,
  contextPruneMinChars: 600,
  contextSelfAwareness: true,
  reasoningExpandedByDefault: true,
};

// ============================================================================
// Store Factory
// ============================================================================

function createAgentSettingsStore() {
  let settings = $state<AgentSettings>(DEFAULT_AGENT_SETTINGS);
  let preferences = $state<{ exists: boolean; content: string; path: string } | null>(null);
  let isLoading = $state(false);
  let activeTab = $state<'settings' | 'preferences'>('settings');
  let lastCriticResult = $state<CriticReviewResult | null>(null);
  let settingsSaveRevision = 0;

  // ========================================================================
  // Settings
  // ========================================================================

  async function loadSettings(): Promise<void> {
    isLoading = true;
    try {
      const res = await apiFetch(apiUrl('/api/agent/settings'));

      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          settings = data.data;
        }
      }
    } catch (err) {
      console.error('Failed to load agent settings:', err);
    } finally {
      isLoading = false;
    }
  }

  async function saveSettings(
    newSettings: Partial<AgentSettings>,
    options?: { quietSuccess?: boolean },
  ): Promise<boolean> {
    const revision = ++settingsSaveRevision;
    const previousSettings = settings;
    // Keep controls stationary and responsive while the write happens. The
    // server response remains authoritative, but saving no longer blanks the
    // entire panel or waits before moving a switch/stepper.
    settings = { ...settings, ...newSettings };
    try {
      const res = await apiFetch(apiUrl('/api/agent/settings'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newSettings),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          if (revision === settingsSaveRevision) settings = data.data;
          if (!options?.quietSuccess) {
            toastStore.success('Agent settings saved');
          }
          return true;
        }
      }
      throw new Error('Failed to save');
    } catch (err) {
      if (revision === settingsSaveRevision) settings = previousSettings;
      toastStore.error('Failed to save agent settings');
      return false;
    }
  }

  async function resetSettings(): Promise<boolean> {
    try {
      const res = await apiFetch(apiUrl('/api/agent/settings/reset'), { method: 'POST' });

      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          settings = data.data;
          toastStore.success('Agent settings reset to defaults');
          return true;
        }
      }
      return false;
    } catch (err) {
      toastStore.error('Failed to reset agent settings');
      return false;
    }
  }

  // ========================================================================
  // Preferences
  // ========================================================================

  async function loadPreferences(): Promise<void> {
    try {
      const res = await apiFetch(apiUrl('/api/agent/preferences'));

      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          preferences = data.data;
        }
      }
    } catch (err) {
      console.error('Failed to load preferences:', err);
    }
  }

  async function savePreferences(content: string): Promise<boolean> {
    isLoading = true;
    try {
      const res = await apiFetch(apiUrl('/api/agent/preferences'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          preferences = { ...preferences, content, exists: true } as typeof preferences;
          toastStore.success('Preferences saved. Critic will enforce new rules.');
          return true;
        }
      }
      throw new Error('Failed to save');
    } catch (err) {
      toastStore.error('Failed to save preferences');
      return false;
    } finally {
      isLoading = false;
    }
  }

  async function initializePreferences(): Promise<void> {
    try {
      const res = await apiFetch(apiUrl('/api/agent/preferences/init'), { method: 'POST' });

      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          preferences = data.data;
          toastStore.success('Preferences initialized with template');
        }
      }
    } catch (err) {
      toastStore.error('Failed to initialize preferences');
    }
  }

  // ========================================================================
  // Context & Enforcement
  // ========================================================================

  async function loadContext(): Promise<AgentContext | null> {
    try {
      const res = await apiFetch(apiUrl('/api/agent/context'));

      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          return data.data;
        }
      }
      return null;
    } catch (err) {
      console.error('Failed to load agent context:', err);
      return null;
    }
  }

  async function runCriticReview(
    code: string,
    filePath: string,
    changeDescription: string,
  ): Promise<CriticReviewResult | null> {
    isLoading = true;
    try {
      const res = await apiFetch(apiUrl('/api/agent/critic-review'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
      console.error('Critic review failed:', err);
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
      await Promise.all([loadSettings(), loadPreferences()]);
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
    get settings() {
      return settings;
    },
    get preferences() {
      return preferences;
    },
    get isLoading() {
      return isLoading;
    },
    get activeTab() {
      return activeTab;
    },
    get lastCriticResult() {
      return lastCriticResult;
    },

    // Rules are always enforced - no getter to disable
    get rulesAlwaysEnforced() {
      return true;
    },
    get criticActive() {
      return settings.criticGateEnabled;
    },
    get strictMode() {
      return settings.ruleEnforcementLevel === 'strict';
    },

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
