/**
 * Agent Settings Store
 *
 * Manages project-scoped agent behavior, permissions, and workflow preferences.
 * The backend response is authoritative; defaults are only an initial shell
 * until the current project settings have loaded.
 */

import { apiUrl } from '$lib/utils/api-url';
import { toastStore } from './toast.svelte';
import { apiFetch } from '$lib/api.svelte';

// ============================================================================
// Types
// ============================================================================

export interface SandboxSettings {
  /** Master sandbox toggle. 'auto' = sandbox plan/critic/worker only;
   *  'always' = sandbox all agent bash execution; 'off' = no sandbox. */
  mode: 'auto' | 'always' | 'off';
  /** When sandboxed, enforce the static command whitelist. */
  commandWhitelist: boolean;
  /** When sandboxed, block shell metacharacters (pipes, substitution, etc.). */
  metacharacters: boolean;
  /** When sandboxed, confine execution to the project working directory. */
  pathConfinement: boolean;
  /** When sandboxed, block network commands (curl, wget, ssh, etc.). */
  network: boolean;
  /** When sandboxed, block container tools (docker, podman, etc.). */
  containerTools: boolean;
}

export const DEFAULT_SANDBOX_SETTINGS: SandboxSettings = {
  mode: 'auto',
  commandWhitelist: true,
  metacharacters: true,
  pathConfinement: true,
  network: true,
  containerTools: true,
};

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
  /** Bash execution sandbox controls. */
  sandbox: SandboxSettings;
  /** Sub-agent (worker) approval policy: 'manager' | 'user' | 'auto'. */
  subAgentApproval: 'manager' | 'user' | 'auto';
  /** Tool names that always bypass approval prompts. */
  toolAllowlist: string[];
  /** Tool names that are always denied. */
  toolBlocklist: string[];
  /** Per-tier tool overrides. Keys are permissionMode values. */
  toolPermissionsByTier?: Record<string, { allow: string[]; block: string[] }>;
  /** Bash base-command patterns that bypass the sandbox safety prompt. */
  bashCommandAllowlist: string[];
  /** Bash base-command patterns that are always blocked without prompting. */
  bashCommandBlocklist: string[];
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
  /** Compact a completed turn after it reaches the trusted context threshold. */
  autoCompactEnabled: boolean;
  /** Context-window percentage at which automatic compaction triggers. */
  autoCompactThreshold: number;
  /** Show complete reasoning blocks expanded in the chat feed by default */
  reasoningExpandedByDefault: boolean;
  skillCollisionChoices: Record<string, 'personal' | 'project'>;
  updatedAt?: number;
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
  storageVersion: 1 | 2;
  document: SkillDocumentSpec;
  sourceContent: string;
  coreInstructions: string;
  content: string;
  hash: string;
  metadata: {
    version: string;
    baseVersion: string;
    baseHash: string;
    parent?: string;
    broader: string[];
    facets: string[];
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
  compatibility?: {
    status: 'available' | 'unavailable';
    reason: string;
    supportingResources: string[];
  };
  /** True when a newer bundled version exists and the local copy has user edits. */
  bundledUpdateAvailable?: boolean;
}

export type SkillFormatKind = 'markdown' | 'text' | 'html' | 'custom';
export type SkillRenderer = 'markdown' | 'plain' | 'html';

export interface SkillDocumentSpec {
  kind: SkillFormatKind;
  extension: string;
  renderer: SkillRenderer;
  mediaType: string;
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
  activeDocument: SkillDocumentSpec;
  draftDocument: SkillDocumentSpec;
}

export interface SkillConversionPreview {
  sourceDocument: SkillDocumentSpec;
  targetDocument: SkillDocumentSpec;
  sourceContent: string;
  convertedContent: string;
  coreInstructions: string;
  warnings: string[];
  lossy: boolean;
  draft?: SkillRevision;
}

export interface BundledSkillComparison {
  localHash: string;
  bundledHash: string;
  changed: boolean;
  local: string;
  bundled: string;
  localDocument: SkillDocumentSpec;
  bundledDocument: SkillDocumentSpec;
}

export interface SkillResolutionPreview {
  planningOnly: boolean;
  planningLimit: string;
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
  rejectedCandidates: Array<{ name: string; reason: string }>;
  rejectedCandidateCount: number;
  rejectedCandidatesTruncated: boolean;
  blocked: boolean;
  contextBudget: number;
  contextOverheadCost: number;
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
  intentInterview: 'adaptive',
  goalPlanningDepth: 'adaptive',
  automaticGoalDriving: true,
  designDiscovery: true,
  planApproval: 'material',
  modelQualification: 'enforce',
  skillLearningMode: 'propose-then-verify',
  criticEnforcesPreferences: true,
  autoApplySafeFixes: false,
  confirmRuleViolations: true,
  autoRunTools: false,
  allowExternalPaths: false,
  managerModelAccess: {},
  managerNotes: {},
  agentMemoryEnabled: true,
  agentCanUpdatePreferences: false,
  maxCriticIterations: 3,
  approvalThresholdFiles: 5,
  approvalThresholdLines: 100,
  autonomyLimitsEnabled: false,
  sandbox: { ...DEFAULT_SANDBOX_SETTINGS },
  subAgentApproval: 'manager',
  toolAllowlist: [],
  toolBlocklist: [],
  toolPermissionsByTier: {},
  bashCommandAllowlist: [],
  bashCommandBlocklist: [],
  localWebSearch: 'fallback',
  multiSourceResearch: true,
  contextPruningEnabled: true,
  contextKeepRecentTurns: 3,
  contextPruneMinChars: 600,
  contextSelfAwareness: true,
  autoCompactEnabled: true,
  autoCompactThreshold: 80,
  reasoningExpandedByDefault: true,
  skillCollisionChoices: {},
};

// ============================================================================
// Store Factory
// ============================================================================

function createAgentSettingsStore() {
  let settings = $state<AgentSettings>(DEFAULT_AGENT_SETTINGS);
  let preferences = $state<{ exists: boolean; content: string; path: string } | null>(null);
  let isLoading = $state(false);
  let settingsSaving = $state(false);
  let settingsError = $state<string | null>(null);
  let settingsLoaded = $state(false);
  let activeTab = $state<'settings' | 'preferences' | 'skills'>('settings');
  let skills = $state<SkillRevision[]>([]);
  let skillQualifications = $state<HarnessQualificationRecord[]>([]);
  let skillEvaluationCards = $state<Record<string, SkillEvaluationCard>>({});
  let skillComparison = $state<SkillRevisionComparison | null>(null);
  let bundledComparison = $state<BundledSkillComparison | null>(null);
  let skillResolutionPreview = $state<SkillResolutionPreview | null>(null);
  let isMergingSkill = $state(false);
  let bundledUpdateCount = $state(0);
  let lastCriticResult = $state<CriticReviewResult | null>(null);
  // Loads and saves share one revision so a slow initial/project load can
  // never overwrite a newer optimistic permission or settings change.
  let settingsRequestRevision = 0;

  // ========================================================================
  // Settings
  // ========================================================================

  async function loadSettings(): Promise<void> {
    const revision = ++settingsRequestRevision;
    isLoading = true;
    settingsError = null;
    try {
      const res = await apiFetch(apiUrl('/api/agent/settings'));
      const data = await res.json();
      if (!res.ok || !data.ok || !data.data) {
        throw new Error(data.error || `Agent settings returned ${res.status}`);
      }
      if (revision === settingsRequestRevision) {
        settings = data.data;
        settingsLoaded = true;
      }
    } catch (err) {
      if (revision === settingsRequestRevision) {
        settingsError = err instanceof Error ? err.message : 'Could not load agent settings';
      }
    } finally {
      if (revision === settingsRequestRevision) isLoading = false;
    }
  }

  async function saveSettings(
    newSettings: Partial<AgentSettings>,
    options?: { quietSuccess?: boolean },
  ): Promise<boolean> {
    const revision = ++settingsRequestRevision;
    const previousSettings = settings;
    settingsSaving = true;
    settingsError = null;
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
          if (revision === settingsRequestRevision) {
            settings = data.data;
            settingsLoaded = true;
          }
          if (!options?.quietSuccess) {
            toastStore.success('Agent settings saved');
          }
          return true;
        }
      }
      throw new Error('The backend did not persist the agent setting');
    } catch (err) {
      if (revision === settingsRequestRevision) settings = previousSettings;
      settingsError = err instanceof Error ? err.message : 'Could not save agent settings';
      toastStore.error(settingsError);
      return false;
    } finally {
      if (revision === settingsRequestRevision) settingsSaving = false;
    }
  }

  async function resetSettings(): Promise<boolean> {
    settingsSaving = true;
    settingsError = null;
    try {
      const res = await apiFetch(apiUrl('/api/agent/settings/reset'), { method: 'POST' });

      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          settings = data.data;
          settingsLoaded = true;
          toastStore.success('Agent settings reset to defaults');
          return true;
        }
      }
      throw new Error('The backend did not reset agent settings');
    } catch (err) {
      settingsError = err instanceof Error ? err.message : 'Could not reset agent settings';
      toastStore.error(settingsError);
      return false;
    } finally {
      settingsSaving = false;
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
          toastStore.success('Project preferences saved locally');
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
      // Check for bundled updates and notify the user
      await fetchBundledUpdateCount();
      if (bundledUpdateCount > 0) {
        toastStore.info(
          `${bundledUpdateCount} skill${bundledUpdateCount > 1 ? 's have' : ' has'} a bundled update available. Open the Skills tab to review.`,
        );
      }
    } catch (err) {
      console.error('Failed to load skills:', err);
    }
  }

  async function fetchBundledUpdateCount(): Promise<void> {
    try {
      const res = await apiFetch(apiUrl('/api/agent/skills/bundled-updates/count'));
      const data = await res.json();
      if (res.ok && data.ok) bundledUpdateCount = data.data.count;
    } catch {
      // Non-critical — silently ignore
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
    broader?: string[];
    facets?: string[];
    requires?: string[];
    conflicts?: string[];
    excludes?: string[];
    targetMedia?: string[];
    depth?: number;
    contextBudget?: number;
    document?: SkillDocumentSpec;
    sourceContent?: string;
    coreInstructions?: string;
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
    } catch (err: unknown) {
      toastStore.error(
        (err instanceof Error ? err.message : String(err)) ?? 'Failed to create skill draft',
      );
      return null;
    }
  }

  async function createFreeformSkillDraft(input: {
    source: 'personal' | 'project';
    name: string;
    description: string;
    instructions: string;
  }): Promise<SkillRevision | null> {
    try {
      const res = await apiFetch(apiUrl('/api/agent/skills/freeform'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error);
      await loadSkills();
      toastStore.success('Freeform skill draft created');
      return data.data as SkillRevision;
    } catch (err: unknown) {
      toastStore.error(
        (err instanceof Error ? err.message : String(err)) ?? 'Failed to create skill draft',
      );
      return null;
    }
  }

  async function saveSkillDraft(
    skill: SkillRevision,
    sourceContent: string,
    coreInstructions = skill.coreInstructions,
  ): Promise<SkillRevision | null> {
    try {
      const legacyBody =
        skill.storageVersion === 1
          ? (sourceContent.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/)?.[1] ?? sourceContent)
          : sourceContent;
      const res = await apiFetch(apiUrl(`/api/agent/skills/${skill.name}/draft`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: skill.source,
          document: skill.document,
          sourceContent: legacyBody,
          coreInstructions:
            skill.storageVersion === 1 ? legacyBody.trim() : coreInstructions.trim(),
          expectedHash: skill.hash,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error);
      await loadSkills();
      toastStore.success('Skill saved as draft');
      return data.data as SkillRevision;
    } catch (err: unknown) {
      toastStore.error(
        (err instanceof Error ? err.message : String(err)) ?? 'Failed to save skill draft',
      );
      return null;
    }
  }

  async function convertSkill(
    skill: SkillRevision,
    document: SkillDocumentSpec,
    dryRun = true,
  ): Promise<SkillConversionPreview | null> {
    try {
      const res = await apiFetch(apiUrl(`/api/agent/skills/${skill.name}/convert`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: skill.source,
          state: skill.state,
          document,
          dryRun,
          expectedHash: skill.hash,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error);
      if (!dryRun) {
        await loadSkills();
        toastStore.success('Converted draft created for review');
      }
      return data.data as SkillConversionPreview;
    } catch (err: unknown) {
      toastStore.error((err instanceof Error ? err.message : String(err)) ?? 'Conversion failed');
      return null;
    }
  }

  async function testAndActivateSkill(skill: SkillRevision): Promise<SkillRevision | null> {
    try {
      const testRes = await apiFetch(apiUrl(`/api/agent/skills/${skill.name}/test`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: skill.source, state: 'draft', expectedHash: skill.hash }),
      });
      const tested = await testRes.json();
      if (!testRes.ok || !tested.ok || !tested.data.passed)
        throw new Error('Trigger tests did not pass');
      const res = await apiFetch(apiUrl(`/api/agent/skills/${skill.name}/activate`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: skill.source, expectedHash: skill.hash }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error);
      await loadSkills();
      toastStore.success('Validated skill activated');
      return data.data as SkillRevision;
    } catch (err: unknown) {
      toastStore.error(
        (err instanceof Error ? err.message : String(err)) ?? 'Failed to activate skill',
      );
      return null;
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
    } catch (err: unknown) {
      skillComparison = null;
      toastStore.error(
        (err instanceof Error ? err.message : String(err)) ??
          'Active and draft revisions are required',
      );
      return false;
    }
  }

  async function compareBundledSkillFn(skill: SkillRevision): Promise<boolean> {
    try {
      const res = await apiFetch(apiUrl(`/api/agent/skills/${skill.name}/compare-bundled`));
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error);
      bundledComparison = data.data;
      return true;
    } catch (err: unknown) {
      bundledComparison = null;
      toastStore.error(
        (err instanceof Error ? err.message : String(err)) ??
          'Failed to compare with bundled version',
      );
      return false;
    }
  }

  async function applyBundledSkillUpdate(
    skill: SkillRevision,
    choice: 'replace' | 'merge' | 'keep-local' | 'merge-with-agent',
  ): Promise<SkillRevision | null> {
    if (choice === 'merge-with-agent') isMergingSkill = true;
    try {
      const res = await apiFetch(apiUrl(`/api/agent/skills/${skill.name}/update-default`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ choice, expectedHash: skill.hash }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error);
      await loadSkills();
      skillComparison = null;
      bundledComparison = null;
      const messages: Record<typeof choice, string> = {
        merge: 'Bundled update saved as a draft',
        'merge-with-agent': 'Agent-merged draft saved — review and activate it',
        replace: 'Skill replaced with bundled version',
        'keep-local': 'Kept your local version',
      };
      toastStore.success(messages[choice] ?? 'Skill update choice applied');
      return data.data as SkillRevision;
    } catch (err: unknown) {
      toastStore.error(
        (err instanceof Error ? err.message : String(err)) ?? 'Failed to apply bundled update',
      );
      return null;
    } finally {
      isMergingSkill = false;
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
      const preview = data.data as Partial<SkillResolutionPreview>;
      skillResolutionPreview = {
        planningOnly: preview.planningOnly ?? true,
        planningLimit:
          preview.planningLimit ??
          'Final manager selection is recomputed against live model and context limits at run time.',
        selected: (preview.selected ?? []).map((item) => ({
          ...item,
          representation: item.representation ?? 'full',
          contextCost: item.contextCost ?? 0,
          fullContextCost: item.fullContextCost ?? item.contextCost ?? 0,
          omittedDetailChars: item.omittedDetailChars ?? 0,
        })),
        collisions: preview.collisions ?? [],
        selectionConflicts: preview.selectionConflicts ?? [],
        hierarchyErrors: preview.hierarchyErrors ?? [],
        omittedByBudget: preview.omittedByBudget ?? [],
        compressedByBudget: preview.compressedByBudget ?? [],
        rejectedCandidates: preview.rejectedCandidates ?? [],
        rejectedCandidateCount:
          preview.rejectedCandidateCount ?? preview.rejectedCandidates?.length ?? 0,
        rejectedCandidatesTruncated: preview.rejectedCandidatesTruncated ?? false,
        blocked: preview.blocked ?? true,
        contextBudget: preview.contextBudget ?? preview.totalContextCost ?? 0,
        contextOverheadCost: preview.contextOverheadCost ?? 0,
        totalContextCost: preview.totalContextCost ?? 0,
      };
      return true;
    } catch (err: unknown) {
      skillResolutionPreview = null;
      toastStore.error(
        (err instanceof Error ? err.message : String(err)) ?? 'Failed to preview skill selection',
      );
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
    get settingsSaving() {
      return settingsSaving;
    },
    get settingsError() {
      return settingsError;
    },
    get settingsLoaded() {
      return settingsLoaded;
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
    get bundledComparison() {
      return bundledComparison;
    },
    get skillResolutionPreview() {
      return skillResolutionPreview;
    },
    get isMergingSkill() {
      return isMergingSkill;
    },
    get bundledUpdateCount() {
      return bundledUpdateCount;
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
    createFreeformSkillDraft,
    saveSkillDraft,
    convertSkill,
    testAndActivateSkill,
    compareSkillDraft,
    compareBundledSkill: compareBundledSkillFn,
    applyBundledSkillUpdate,
    previewSkillResolution,
    fetchBundledUpdateCount,

    // Context & Enforcement
    loadContext,
    runCriticReview,

    // Bulk
    loadAll,
    setActiveTab,
  };
}

export const agentSettingsStore = createAgentSettingsStore();
