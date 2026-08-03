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
  /** Default approval behavior exposed in the composer permission picker. */
  permissionMode: 'yolo' | 'guarded' | 'edits' | 'ask' | 'plan' | 'custom';
  preferencesEnabled: boolean;
  criticGateEnabled: boolean;
  gateStrictness: 'strict' | 'advisory' | 'off';
  intentInterview: 'off' | 'adaptive' | 'deep';
  goalPlanningDepth: 'minimal' | 'adaptive' | 'structured';
  automaticGoalDriving: boolean;
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
  /** Apply the configured file/line approval thresholds. Off by default. */
  autonomyLimitsEnabled: boolean;
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
  /** Automatically compact completed conversations before the model window is exhausted. */
  autoCompactEnabled: boolean;
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

export interface SkillRevision {
  name: string;
  description: string;
  source: 'personal' | 'project';
  state: 'active' | 'draft';
  path: string;
  content: string;
  hash: string;
  metadata: {
    version: string;
    baseVersion: string;
    baseHash: string;
    parent?: string;
    depth: number;
    requires: string[];
    conflicts: string[];
    activation: string[];
    excludes: string[];
    domains: string[];
    targetMedia: string[];
    contextBudget: number;
  };
  validation: {
    valid: boolean;
    errors: string[];
    warnings: string[];
    ignoredAuthorityClaims: string[];
  };
}

export interface HarnessQualificationRecord {
  provider: string;
  model: string;
  harnessVersion: string;
  skill: string;
  role: 'worker' | 'critic';
  medium?: string;
  sampleSize: number;
  successes: number;
  quality: number;
  verification: number;
  updatedAt: string;
  evidence: string[];
}

export interface SkillPromotionGate {
  status: 'unmeasured' | 'insufficient-evidence' | 'blocked' | 'ready';
  candidateRuns: number;
  distinctHarnesses: number;
  distinctProviders: number;
  distinctModels: number;
  humanBlindReviews: number;
  passRate: number | null;
  quality: number | null;
  verification: number | null;
  baselineDelta: number | null;
  reasons: string[];
}

export interface SkillEvaluationCard {
  skill: string;
  revisionHash: string;
  cases: Array<{
    id: string;
    prompt: string;
    expectedSelection: boolean;
    requiredEvidence: string[];
  }>;
  gate: SkillPromotionGate;
  runs: Array<{
    id: string;
    provider: string;
    model: string;
    evaluator: string;
    passed: boolean;
    quality: number;
    verification: number;
    evidence: string[];
    recordedAt: string;
  }>;
}

export interface SkillRevisionComparison {
  activeHash: string;
  draftHash: string;
  changed: boolean;
  active: string;
  draft: string;
}

export interface SkillResolutionPreview {
  selected: Array<{
    skill: SkillRevision;
    reason: string;
    representation: 'full' | 'compact' | 'minimal';
    contextCost: number;
    fullContextCost: number;
    omittedDetailChars: number;
  }>;
  collisions: Array<{ name: string; personalHash: string; projectHash: string }>;
  selectionConflicts: Array<{ left: string; right: string }>;
  hierarchyErrors: string[];
  omittedByBudget: string[];
  compressedByBudget: Array<{
    name: string;
    representation: 'compact' | 'minimal';
    fullContextCost: number;
    contextCost: number;
    omittedDetailChars: number;
  }>;
  blocked: boolean;
  totalContextCost: number;
}

// ============================================================================
// Default Settings
// ============================================================================

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  ruleEnforcementLevel: 'strict',
  agentExecutionMode: 'auto',
  permissionMode: 'guarded',
  preferencesEnabled: true,
  criticGateEnabled: true,
  gateStrictness: 'strict',
  intentInterview: 'off',
  goalPlanningDepth: 'adaptive',
  automaticGoalDriving: true,
  designDiscovery: false,
  planApproval: 'never',
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
  autonomyLimitsEnabled: false,
  localWebSearch: 'fallback',
  multiSourceResearch: true,
  contextPruningEnabled: true,
  contextKeepRecentTurns: 3,
  contextPruneMinChars: 600,
  contextSelfAwareness: true,
  reasoningExpandedByDefault: false,
};

// ============================================================================
// Store Factory
// ============================================================================

function createAgentSettingsStore() {
  let settings = $state<AgentSettings>(DEFAULT_AGENT_SETTINGS);
  let preferences = $state<{ exists: boolean; content: string; path: string } | null>(null);
  let isLoading = $state(false);
  let activeTab = $state<'settings' | 'preferences' | 'skills'>('settings');
  let skills = $state<SkillRevision[]>([]);
  let skillQualifications = $state<HarnessQualificationRecord[]>([]);
  let skillEvaluationCards = $state<Record<string, SkillEvaluationCard>>({});
  let skillComparison = $state<SkillRevisionComparison | null>(null);
  let skillResolutionPreview = $state<SkillResolutionPreview | null>(null);
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

  async function loadSkills(): Promise<void> {
    try {
      const res = await apiFetch(apiUrl('/api/agent/skills'));
      const data = await res.json();
      if (res.ok && data.ok) skills = data.data;
    } catch (err) {
      console.error('Failed to load skills:', err);
    }
  }

  async function loadSkillQualifications(): Promise<void> {
    try {
      const res = await apiFetch(apiUrl('/api/agent/skills/qualifications'));
      const data = await res.json();
      if (res.ok && data.ok) skillQualifications = data.data;
    } catch (err) {
      console.error('Failed to load skill qualifications:', err);
    }
  }

  async function loadSkillEvaluationCard(skill: SkillRevision): Promise<void> {
    const key = `${skill.source}:${skill.name}:${skill.state}:${skill.hash}`;
    if (skillEvaluationCards[key]) return;
    try {
      const query = new URLSearchParams({ source: skill.source, state: skill.state });
      const res = await apiFetch(
        apiUrl(`/api/agent/skills/${skill.name}/evaluation-card?${query}`),
      );
      const data = await res.json();
      if (res.ok && data.ok) skillEvaluationCards = { ...skillEvaluationCards, [key]: data.data };
    } catch (err) {
      console.error('Failed to load skill evaluation card:', err);
    }
  }

  async function createSkillDraft(input: {
    source: 'personal' | 'project';
    name: string;
    description: string;
    instructions: string;
    domains: string[];
    activation: string[];
    shouldTrigger: string[];
    shouldNotTrigger: string[];
    evidence: string[];
  }): Promise<SkillRevision | null> {
    try {
      const res = await apiFetch(apiUrl('/api/agent/skills'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error);
      await loadSkills();
      toastStore.success('Skill draft created');
      return data.data as SkillRevision;
    } catch (err: any) {
      toastStore.error(err?.message ?? 'Failed to create skill draft');
      return null;
    }
  }

  async function saveSkillDraft(skill: SkillRevision, content: string): Promise<boolean> {
    try {
      const res = await apiFetch(apiUrl(`/api/agent/skills/${skill.name}/draft`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: skill.source, content }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error);
      await loadSkills();
      toastStore.success('Skill saved as draft');
      return true;
    } catch (err: any) {
      toastStore.error(err?.message ?? 'Failed to save skill draft');
      return false;
    }
  }

  async function testAndActivateSkill(skill: SkillRevision): Promise<boolean> {
    try {
      const testRes = await apiFetch(apiUrl(`/api/agent/skills/${skill.name}/test`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: skill.source, state: 'draft' }),
      });
      const tested = await testRes.json();
      if (!testRes.ok || !tested.ok || !tested.data.passed)
        throw new Error('Trigger tests did not pass');
      const res = await apiFetch(apiUrl(`/api/agent/skills/${skill.name}/activate`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: skill.source }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error);
      await loadSkills();
      toastStore.success('Validated skill activated');
      return true;
    } catch (err: any) {
      toastStore.error(err?.message ?? 'Failed to activate skill');
      return false;
    }
  }

  async function compareSkillDraft(skill: SkillRevision): Promise<boolean> {
    try {
      const query = new URLSearchParams({ source: skill.source });
      const res = await apiFetch(apiUrl(`/api/agent/skills/${skill.name}/compare?${query}`));
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error);
      skillComparison = data.data;
      return true;
    } catch (err: any) {
      skillComparison = null;
      toastStore.error(err?.message ?? 'Active and draft revisions are required');
      return false;
    }
  }

  async function applyBundledSkillUpdate(
    skill: SkillRevision,
    choice: 'replace' | 'merge' | 'keep-local',
  ): Promise<boolean> {
    try {
      const res = await apiFetch(apiUrl(`/api/agent/skills/${skill.name}/update-default`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ choice }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error);
      await loadSkills();
      skillComparison = null;
      toastStore.success(
        choice === 'merge' ? 'Bundled update saved as a draft' : 'Skill update choice applied',
      );
      return true;
    } catch (err: any) {
      toastStore.error(err?.message ?? 'Failed to apply bundled update');
      return false;
    }
  }

  async function previewSkillResolution(
    prompt: string,
    collisionChoices: Record<string, 'personal' | 'project'> = {},
  ): Promise<boolean> {
    try {
      const res = await apiFetch(apiUrl('/api/agent/skills/resolve'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, options: { collisionChoices } }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error);
      skillResolutionPreview = data.data;
      return true;
    } catch (err: any) {
      skillResolutionPreview = null;
      toastStore.error(err?.message ?? 'Failed to preview skill selection');
      return false;
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
      await Promise.all([
        loadSettings(),
        loadPreferences(),
        loadSkills(),
        loadSkillQualifications(),
      ]);
    } finally {
      isLoading = false;
    }
  }

  function setActiveTab(tab: 'settings' | 'preferences' | 'skills'): void {
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
    get skills() {
      return skills;
    },
    get skillQualifications() {
      return skillQualifications;
    },
    get skillEvaluationCards() {
      return skillEvaluationCards;
    },
    get skillComparison() {
      return skillComparison;
    },
    get skillResolutionPreview() {
      return skillResolutionPreview;
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
    loadSkills,
    loadSkillQualifications,
    loadSkillEvaluationCard,
    createSkillDraft,
    saveSkillDraft,
    testAndActivateSkill,
    compareSkillDraft,
    applyBundledSkillUpdate,
    previewSkillResolution,

    // Context & Enforcement
    loadContext,
    runCriticReview,

    // Bulk
    loadAll,
    setActiveTab,
  };
}

export const agentSettingsStore = createAgentSettingsStore();
