/**
 * App-wide safety-limit state.
 *
 * This store intentionally exposes only backend-wired behavior. Earlier
 * builds placed placeholder feature flags in this pane and persisted them to
 * localStorage even though the runtime never read them.
 */

import { apiFetch } from '$lib/api.svelte';
import { apiUrl } from '$lib/utils/api-url';
import { toastStore } from './toast.svelte';

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

export interface PausedSession {
  sessionId: string;
  pausedAt: number;
  reason: string;
  capType: string;
  currentSpend: number;
  limit: number;
}

export const DEFAULT_SPEND_CAP_CONFIG: SpendCapConfig = {
  enabled: true,
  sessionHourlyCents: 200,
  sessionDailyCents: 1_000,
  globalHourlyCents: 1_000,
  globalDailyCents: 5_000,
  perRequestCents: 50,
  action: 'pause',
  notifyAtPercent: [80, 95],
};

function createExperimentalStore() {
  let spendCapConfig = $state<SpendCapConfig>({ ...DEFAULT_SPEND_CAP_CONFIG });
  let pausedSessions = $state<PausedSession[]>([]);
  let isLoading = $state(false);
  let spendCapError = $state<string | null>(null);
  let requestRevision = 0;

  async function readJson(response: Response, fallback: string) {
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok) {
      throw new Error(data?.error || `${fallback} (${response.status})`);
    }
    return data;
  }

  async function loadSpendCapConfig(): Promise<SpendCapConfig> {
    const response = await apiFetch(apiUrl('/api/spend-caps/config'));
    const data = await readJson(response, 'Could not load spend limits');
    if (!data.config) throw new Error('The spend-limit service returned no configuration');
    return { ...DEFAULT_SPEND_CAP_CONFIG, ...data.config };
  }

  async function loadPausedSessions(): Promise<PausedSession[]> {
    const response = await apiFetch(apiUrl('/api/spend-caps/status'));
    const data = await readJson(response, 'Could not load paused sessions');
    return Array.isArray(data.pausedSessions) ? data.pausedSessions : [];
  }

  async function loadAll(): Promise<void> {
    const revision = ++requestRevision;
    isLoading = true;
    spendCapError = null;
    try {
      const [config, pauses] = await Promise.all([loadSpendCapConfig(), loadPausedSessions()]);
      if (revision !== requestRevision) return;
      spendCapConfig = config;
      pausedSessions = pauses;
    } catch (error) {
      if (revision === requestRevision) {
        spendCapError = error instanceof Error ? error.message : 'Could not load safety limits';
      }
    } finally {
      if (revision === requestRevision) isLoading = false;
    }
  }

  async function saveSpendCapConfig(patch: Partial<SpendCapConfig>): Promise<boolean> {
    const revision = ++requestRevision;
    const previous = spendCapConfig;
    isLoading = true;
    spendCapError = null;
    spendCapConfig = { ...spendCapConfig, ...patch };
    try {
      const response = await apiFetch(apiUrl('/api/spend-caps/config'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const data = await readJson(response, 'Could not save spend limits');
      if (!data.config) throw new Error('The spend-limit service did not confirm the change');
      if (revision === requestRevision) spendCapConfig = data.config;
      toastStore.success('Spend limit saved');
      return true;
    } catch (error) {
      if (revision === requestRevision) {
        spendCapConfig = previous;
        spendCapError = error instanceof Error ? error.message : 'Could not save spend limits';
        toastStore.error(spendCapError);
      }
      return false;
    } finally {
      if (revision === requestRevision) isLoading = false;
    }
  }

  async function resumeSession(sessionId: string): Promise<boolean> {
    isLoading = true;
    spendCapError = null;
    try {
      const response = await apiFetch(apiUrl(`/api/spend-caps/sessions/${sessionId}/resume`), {
        method: 'POST',
      });
      await readJson(response, 'Could not resume this session');
      pausedSessions = pausedSessions.filter((session) => session.sessionId !== sessionId);
      toastStore.success('Session resumed');
      return true;
    } catch (error) {
      spendCapError = error instanceof Error ? error.message : 'Could not resume this session';
      toastStore.error(spendCapError);
      return false;
    } finally {
      isLoading = false;
    }
  }

  return {
    get spendCapConfig() {
      return spendCapConfig;
    },
    get pausedSessions() {
      return pausedSessions;
    },
    get isLoading() {
      return isLoading;
    },
    get spendCapError() {
      return spendCapError;
    },
    loadAll,
    saveSpendCapConfig,
    resumeSession,
  };
}

export const experimentalStore = createExperimentalStore();
