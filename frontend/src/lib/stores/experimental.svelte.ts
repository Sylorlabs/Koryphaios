/**
 * Experimental Features Store
 *
 * Manages experimental/beta features that are not yet production-ready.
 * These features can be toggled on/off and may have breaking changes.
 */

import { apiUrl } from '$lib/utils/api-url';
import { toastStore } from './toast.svelte';
import { apiFetch } from '$lib/api.svelte';

// ============================================================================
// Types
// ============================================================================

export interface ExperimentalFeatures {
  // Spend Caps & Billing
  hardSpendCaps: boolean;

  // Database & Persistence
  sqliteConnectionPool: boolean;
  postgresBackend: boolean;
  redisJobQueue: boolean;

  // Sync & Reliability
  messageReplayBuffer: boolean;
  requestCorrelation: boolean;
  serverSideSessionFilter: boolean;

  // Process Management
  processSupervisor: boolean;
  processAutoRestart: boolean;
  orphanProcessCleanup: boolean;

  // Performance
  workerPool: boolean;
  parallelAgentLimit: number;
  connectionPooling: boolean;
  queryOptimization: boolean;

  // UX & UI
  commandPaletteV2: boolean;
  inlineDiffPreview: boolean;
  realTimeMetrics: boolean;
  advancedThemeEditor: boolean;

  // AI & Agents
  agentMemoryV2: boolean;
  multiAgentCoordination: boolean;
  reasoningModeConfig: boolean;

  // Integrations
  vectorSearch: boolean;
  mcpServerV2: boolean;
  telegramBotV2: boolean;

  // Security
  enhancedAuditLogs: boolean;
  sessionRecording: boolean;
  ipRateLimiting: boolean;
}

export interface SpendCapConfig {
  enabled: boolean;
  sessionHourlyCents: number;
  sessionDailyCents: number;
  globalHourlyCents: number;
  globalDailyCents: number;
  perRequestCents: number;
  action: 'pause' | 'warn' | 'block';
  notifyAtPercent: number[];
}

export interface PoolStats {
  totalWrites: number;
  queuedWrites: number;
  failedWrites: number;
  avgQueueWaitMs: number;
  queueDepth: number;
  isProcessing: boolean;
}

export interface PausedSession {
  sessionId: string;
  pausedAt: number;
  reason: string;
  capType: string;
  currentSpend: number;
  limit: number;
}

// ============================================================================
// Default Settings
// ============================================================================

export const DEFAULT_EXPERIMENTAL_FEATURES: ExperimentalFeatures = {
  // Spend Caps & Billing
  hardSpendCaps: false,

  // Database & Persistence
  sqliteConnectionPool: false,
  postgresBackend: false,
  redisJobQueue: false,

  // Sync & Reliability
  messageReplayBuffer: false,
  requestCorrelation: false,
  serverSideSessionFilter: false,

  // Process Management
  processSupervisor: true, // Enabled by default since it's production ready
  processAutoRestart: true,
  orphanProcessCleanup: true,

  // Performance
  workerPool: false,
  parallelAgentLimit: 3,
  connectionPooling: false,
  queryOptimization: false,

  // UX & UI
  commandPaletteV2: false,
  inlineDiffPreview: false,
  realTimeMetrics: false,
  advancedThemeEditor: false,

  // AI & Agents
  agentMemoryV2: false,
  multiAgentCoordination: true, // On: Kory delegates to specialist workers when a task warrants it.
  reasoningModeConfig: true, // Stable + broadly wanted — on by default.

  // Integrations
  vectorSearch: false,
  mcpServerV2: false,
  telegramBotV2: false,

  // Security
  enhancedAuditLogs: false,
  sessionRecording: false,
  ipRateLimiting: false,
};

export const DEFAULT_SPEND_CAP_CONFIG: SpendCapConfig = {
  enabled: true,
  sessionHourlyCents: 200, // $2/hour per session
  sessionDailyCents: 1000, // $10/day per session
  globalHourlyCents: 1000, // $10/hour globally
  globalDailyCents: 5000, // $50/day globally
  perRequestCents: 50, // $0.50 per request
  action: 'pause',
  notifyAtPercent: [80, 95],
};

// ============================================================================
// Feature Metadata
// ============================================================================

export interface FeatureMetadata {
  key: keyof ExperimentalFeatures;
  label: string;
  description: string;
  category: string;
  status: 'stable' | 'beta' | 'alpha' | 'coming-soon';
  requiresRestart?: boolean;
}

export const FEATURE_METADATA: FeatureMetadata[] = [
  // Spend Caps & Billing
  {
    key: 'hardSpendCaps',
    label: 'Hard Spend Caps',
    description: 'Actually PAUSE agents when spend limits are reached. Prevents runaway costs.',
    category: 'Billing',
    status: 'beta',
  },

  // Database & Persistence
  {
    key: 'sqliteConnectionPool',
    label: 'SQLite Connection Pool',
    description: "Multiple read connections with write queue. Reduces 'database is locked' errors.",
    category: 'Database',
    status: 'beta',
  },

  // Process Management
  {
    key: 'processSupervisor',
    label: 'Process Supervisor',
    description: 'Automatic crash detection, restart, and orphan cleanup for background processes.',
    category: 'Processes',
    status: 'stable',
  },
  {
    key: 'processAutoRestart',
    label: 'Process Auto-Restart',
    description: 'Automatically restart crashed background processes with exponential backoff.',
    category: 'Processes',
    status: 'stable',
  },
  {
    key: 'orphanProcessCleanup',
    label: 'Orphan Process Cleanup',
    description: 'Kill leftover processes on server startup. Keeps system clean.',
    category: 'Processes',
    status: 'stable',
  },

  // Performance
  {
    key: 'workerPool',
    label: 'Worker Pool',
    description: 'Pool of pre-warmed workers for faster agent spawning.',
    category: 'Performance',
    status: 'alpha',
  },
  // AI & Agents
  {
    key: 'multiAgentCoordination',
    label: 'Multi-Agent Coordination',
    description:
      'Let Kory delegate to specialist workers. Engages only when you pick Multi-Agent in the composer, or when Auto decides a task needs it — never for simple chat.',
    category: 'AI',
    status: 'stable',
  },
  {
    key: 'reasoningModeConfig',
    label: 'Reasoning Mode Configuration',
    description: 'Configure thinking effort per model (low/medium/high/max).',
    category: 'AI',
    status: 'stable',
  },
];

export const FEATURE_CATEGORIES = [...new Set(FEATURE_METADATA.map((f) => f.category))];

// ============================================================================
// Store Factory
// ============================================================================

function createExperimentalStore() {
  // Load from localStorage on init
  const loadFromStorage = (): ExperimentalFeatures => {
    try {
      const stored = localStorage.getItem('koryphaios-experimental');
      if (stored) {
        return { ...DEFAULT_EXPERIMENTAL_FEATURES, ...JSON.parse(stored) };
      }
    } catch {}
    return DEFAULT_EXPERIMENTAL_FEATURES;
  };

  let features = $state<ExperimentalFeatures>(loadFromStorage());
  let spendCapConfig = $state<SpendCapConfig>(DEFAULT_SPEND_CAP_CONFIG);
  let isLoading = $state(false);
  let poolStats = $state<PoolStats | null>(null);
  let pausedSessions = $state<PausedSession[]>([]);
  let searchQuery = $state('');
  let selectedCategory = $state<string>('All');

  // ========================================================================
  // Persistence
  // ========================================================================

  function saveToStorage() {
    try {
      localStorage.setItem('koryphaios-experimental', JSON.stringify(features));
    } catch {}
  }

  // ========================================================================
  // Feature Toggles
  // ========================================================================

  function toggleFeature(feature: keyof ExperimentalFeatures): void {
    const value = features[feature];
    if (typeof value === 'boolean') {
      (features as unknown as Record<string, boolean>)[feature] = !value;
      saveToStorage();

      // Special handling for certain features
      if (feature === 'hardSpendCaps' && !value === true) {
        // Enabling spend caps - load config from server
        void loadSpendCapConfig();
      }

      toastStore.success(`${feature} ${!value ? 'enabled' : 'disabled'}`);
    }
  }

  function setFeature<K extends keyof ExperimentalFeatures>(
    feature: K,
    value: ExperimentalFeatures[K],
  ): void {
    features[feature] = value;
    saveToStorage();
  }

  // ========================================================================
  // Spend Caps API
  // ========================================================================

  async function loadSpendCapConfig(): Promise<void> {
    try {
      const res = await apiFetch(apiUrl('/api/spend-caps/config'));

      if (res.ok) {
        const data = await res.json();
        if (data.ok && data.config) {
          spendCapConfig = { ...DEFAULT_SPEND_CAP_CONFIG, ...data.config };
        }
      }
    } catch (err) {
      console.error('Failed to load spend cap config:', err);
    }
  }

  async function saveSpendCapConfig(config: Partial<SpendCapConfig>): Promise<boolean> {
    isLoading = true;
    try {
      const res = await apiFetch(apiUrl('/api/spend-caps/config'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          spendCapConfig = data.config;
          toastStore.success('Spend caps configuration saved');
          return true;
        }
      }
      throw new Error('Failed to save');
    } catch (err) {
      toastStore.error('Failed to save spend caps config');
      return false;
    } finally {
      isLoading = false;
    }
  }

  async function loadPausedSessions(): Promise<void> {
    try {
      const res = await apiFetch(apiUrl('/api/spend-caps/status'));

      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          pausedSessions = data.pausedSessions || [];
        }
      }
    } catch (err) {
      console.error('Failed to load paused sessions:', err);
    }
  }

  async function resumeSession(sessionId: string): Promise<boolean> {
    try {
      const res = await apiFetch(apiUrl(`/api/spend-caps/sessions/${sessionId}/resume`), {
        method: 'POST',
      });

      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          // Remove from paused list
          pausedSessions = pausedSessions.filter((s) => s.sessionId !== sessionId);
          toastStore.success('Session resumed');
          return true;
        }
      }
      throw new Error('Failed to resume');
    } catch (err) {
      toastStore.error('Failed to resume session');
      return false;
    }
  }

  // ========================================================================
  // Pool Stats (for SQLite Connection Pool)
  // ========================================================================

  async function loadPoolStats(): Promise<void> {
    // This would connect to a real endpoint when implemented
    // For now, just simulate
    poolStats = {
      totalWrites: 0,
      queuedWrites: 0,
      failedWrites: 0,
      avgQueueWaitMs: 0,
      queueDepth: 0,
      isProcessing: false,
    };
  }

  // ========================================================================
  // Bulk Operations
  // ========================================================================

  async function loadAll(): Promise<void> {
    isLoading = true;
    try {
      await Promise.all([loadSpendCapConfig(), loadPausedSessions(), loadPoolStats()]);
    } finally {
      isLoading = false;
    }
  }

  function resetToDefaults(): void {
    features = DEFAULT_EXPERIMENTAL_FEATURES;
    saveToStorage();
    toastStore.info('Experimental features reset to defaults');
  }

  function setSearchQuery(query: string): void {
    searchQuery = query;
  }

  function setSelectedCategory(category: string): void {
    selectedCategory = category;
  }

  // ========================================================================
  // Getters
  // ========================================================================

  return {
    // State
    get features() {
      return features;
    },
    get spendCapConfig() {
      return spendCapConfig;
    },
    get isLoading() {
      return isLoading;
    },
    get poolStats() {
      return poolStats;
    },
    get pausedSessions() {
      return pausedSessions;
    },
    get searchQuery() {
      return searchQuery;
    },
    get selectedCategory() {
      return selectedCategory;
    },

    // Computed
    get filteredFeatures() {
      return FEATURE_METADATA.filter((feature) => {
        // Category filter
        if (selectedCategory !== 'All' && feature.category !== selectedCategory) {
          return false;
        }
        // Search filter
        if (searchQuery.trim()) {
          const q = searchQuery.toLowerCase();
          return (
            feature.label.toLowerCase().includes(q) ||
            feature.description.toLowerCase().includes(q) ||
            feature.category.toLowerCase().includes(q)
          );
        }
        return true;
      });
    },

    get enabledCount() {
      return Object.values(features).filter((v) => typeof v === 'boolean' && v).length;
    },

    get isAnyEnabled() {
      return Object.values(features).some((v) => typeof v === 'boolean' && v);
    },

    // Feature toggles
    toggleFeature,
    setFeature,

    // Search/filter
    setSearchQuery,
    setSelectedCategory,

    // Spend caps
    loadSpendCapConfig,
    saveSpendCapConfig,
    loadPausedSessions,
    resumeSession,

    // Pool
    loadPoolStats,

    // Bulk
    loadAll,
    resetToDefaults,
  };
}

export const experimentalStore = createExperimentalStore();
