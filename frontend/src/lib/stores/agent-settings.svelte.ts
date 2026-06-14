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
  criticEnforcesPreferences: boolean;
  autoApplySafeFixes: boolean;
  confirmRuleViolations: boolean;
  autoRunTools: boolean;
  agentMemoryEnabled: boolean;
  agentCanUpdatePreferences: boolean;
  maxCriticIterations: number;
  approvalThresholdFiles: number;
  approvalThresholdLines: number;
  /** Experimental: Local Web Search (DuckDuckGo) */
  localWebSearch: 'off' | 'on' | 'fallback';
  /** Experimental: Multi-source research requirements */
  multiSourceResearch: boolean;
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

/** A routing category the user can pin a specific model to (else "auto"). */
export interface RoutingCategory {
  id: string;
  label: string;
  description: string;
  defaultModel: string;
  /** Current override as "provider:model" (or "" for auto). */
  value: string;
}

// ============================================================================
// Default Settings
// ============================================================================

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  ruleEnforcementLevel: 'strict',
  agentExecutionMode: 'auto',
  preferencesEnabled: true,
  criticGateEnabled: true,
  criticEnforcesPreferences: true,
  autoApplySafeFixes: false,
  confirmRuleViolations: true,
  autoRunTools: true,
  agentMemoryEnabled: true,
  agentCanUpdatePreferences: false,
  maxCriticIterations: 3,
  approvalThresholdFiles: 5,
  approvalThresholdLines: 100,
  localWebSearch: 'fallback',
  multiSourceResearch: true,
};

// ============================================================================
// Store Factory
// ============================================================================

function createAgentSettingsStore() {
  let settings = $state<AgentSettings>(DEFAULT_AGENT_SETTINGS);
  let preferences = $state<{ exists: boolean; content: string; path: string } | null>(null);
  let isLoading = $state(false);
  let activeTab = $state<'settings' | 'routing' | 'preferences' | 'enforcement'>('settings');
  let lastCriticResult = $state<CriticReviewResult | null>(null);
  let routingCategories = $state<RoutingCategory[]>([]);

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
    isLoading = true;
    try {
      const res = await apiFetch(apiUrl('/api/agent/settings'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newSettings),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          settings = data.data;
          if (!options?.quietSuccess) {
            toastStore.success('Agent settings saved');
          }
          return true;
        }
      }
      throw new Error('Failed to save');
    } catch (err) {
      toastStore.error('Failed to save agent settings');
      return false;
    } finally {
      isLoading = false;
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
  // Routing (per-category model assignments)
  // ========================================================================

  async function loadAssignments(): Promise<void> {
    try {
      const res = await apiFetch(apiUrl('/api/agent/assignments'));
      if (res.ok) {
        const data = await res.json();
        if (data.ok && Array.isArray(data.data?.categories)) {
          routingCategories = data.data.categories;
        }
      }
    } catch (err) {
      console.error('Failed to load routing assignments:', err);
    }
  }

  async function saveAssignment(categoryId: string, value: string): Promise<boolean> {
    // Optimistically update local state, then persist the full map.
    const next = routingCategories.map((c) =>
      c.id === categoryId ? { ...c, value } : c,
    );
    routingCategories = next;
    const assignments: Record<string, string> = {};
    for (const c of next) {
      if (c.value && c.value !== 'auto') assignments[c.id] = c.value;
    }
    try {
      const res = await apiFetch(apiUrl('/api/agent/assignments'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignments }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          toastStore.success(value && value !== 'auto'
            ? 'Model pinned for this category'
            : 'Category set to auto');
          return true;
        }
        throw new Error(data.error ?? 'Failed to save');
      }
      throw new Error('Failed to save');
    } catch (err: any) {
      toastStore.error(err?.message ?? 'Failed to save routing');
      // Reload to revert optimistic change on error.
      await loadAssignments();
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
      await Promise.all([loadSettings(), loadPreferences(), loadAssignments()]);
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
    get routingCategories() {
      return routingCategories;
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

    // Routing
    loadAssignments,
    saveAssignment,

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
