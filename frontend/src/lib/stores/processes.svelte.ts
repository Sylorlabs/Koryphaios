/**
 * Process Supervisor Store
 *
 * Manages process supervision state and provides
 * methods to interact with background processes.
 */

import { apiUrl } from '$lib/utils/api-url';
import { toastStore } from './toast.svelte';
import { apiFetch } from '$lib/api.svelte';

// ============================================================================
// Types
// ============================================================================

export interface Process {
  id: string;
  name: string;
  command: string;
  pid: number;
  sessionId: string;
  status: 'starting' | 'running' | 'exited' | 'killed' | 'crashed' | 'orphaned';
  exitCode?: number;
  signal?: string;
  restartCount: number;
  maxRestarts: number;
  restartPolicy: 'never' | 'on-failure' | 'always';
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
  health?: {
    isHealthy: boolean;
    consecutiveFailures: number;
    lastHeartbeat?: number;
    lastError?: string;
  };
  metadata?: Record<string, unknown>;
}

export interface ProcessEvent {
  id: number;
  eventType: string;
  eventData?: Record<string, unknown>;
  timestamp: number;
}

export interface ProcessLogs {
  stdout: string;
  stderr: string;
  stdoutLineCount: number;
  stderrLineCount: number;
}

// ============================================================================
// Store Factory
// ============================================================================

function createProcessStore() {
  let processes = $state<Process[]>([]);
  let selectedProcess = $state<Process | null>(null);
  let processLogs = $state<ProcessLogs | null>(null);
  let processEvents = $state<ProcessEvent[]>([]);
  let isLoading = $state(false);
  let isLogsLoading = $state(false);
  let autoRefresh = $state(false);
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let filterStatus = $state<string>('all');
  let searchQuery = $state('');

  // =======================================================================
  // Computed
  // =======================================================================

  const filteredProcesses = $derived.by(() => {
    let result = processes;

    // Filter by status
    if (filterStatus !== 'all') {
      result = result.filter((p) => p.status === filterStatus);
    }

    // Filter by search
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.command.toLowerCase().includes(q) ||
          p.id.toLowerCase().includes(q),
      );
    }

    return result.sort((a, b) => b.createdAt - a.createdAt);
  });

  const activeCount = $derived(
    processes.filter((p) => p.status === 'running' || p.status === 'starting').length,
  );

  const crashedCount = $derived(processes.filter((p) => p.status === 'crashed').length);

  // =======================================================================
  // API Calls
  // =======================================================================

  async function loadProcesses(includeInactive = true): Promise<void> {
    isLoading = true;
    try {
      const res = await apiFetch(
        apiUrl(`/api/processes?includeInactive=${includeInactive}&limit=100`),
      );

      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          processes = data.processes;
        }
      }
    } catch (err) {
      console.error('Failed to load processes:', err);
    } finally {
      isLoading = false;
    }
  }

  async function loadSessionProcesses(sessionId: string): Promise<void> {
    isLoading = true;
    try {
      const res = await apiFetch(apiUrl(`/api/sessions/${sessionId}/processes`));

      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          // Merge with existing processes, replacing session processes
          const sessionProcessIds = new Set(data.processes.map((p: Process) => p.id));
          processes = [...processes.filter((p) => !sessionProcessIds.has(p.id)), ...data.processes];
        }
      }
    } catch (err) {
      console.error('Failed to load session processes:', err);
    } finally {
      isLoading = false;
    }
  }

  async function loadProcessDetails(id: string): Promise<Process | null> {
    try {
      const res = await apiFetch(apiUrl(`/api/processes/${id}`));

      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          selectedProcess = data.process;
          return data.process;
        }
      }
    } catch (err) {
      console.error('Failed to load process details:', err);
    }
    return null;
  }

  async function loadProcessLogs(id: string, lines = 100): Promise<void> {
    isLogsLoading = true;
    try {
      const res = await apiFetch(apiUrl(`/api/processes/${id}/logs?lines=${lines}`));

      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          processLogs = data.logs;
        }
      }
    } catch (err) {
      console.error('Failed to load process logs:', err);
    } finally {
      isLogsLoading = false;
    }
  }

  async function loadProcessEvents(id: string): Promise<void> {
    try {
      const res = await apiFetch(apiUrl(`/api/processes/${id}/events?limit=50`));

      if (res.ok) {
        const data = await res.json();
        if (data.ok) {
          processEvents = data.events;
        }
      }
    } catch (err) {
      console.error('Failed to load process events:', err);
    }
  }

  async function killProcess(id: string, signal = 'SIGTERM'): Promise<boolean> {
    try {
      const res = await apiFetch(apiUrl(`/api/processes/${id}?signal=${signal}`), {
        method: 'DELETE',
      });

      if (res.ok) {
        toastStore.success('Process killed');
        await loadProcesses();
        return true;
      } else {
        const data = await res.json();
        toastStore.error(data.error || 'Failed to kill process');
        return false;
      }
    } catch (err) {
      toastStore.error('Failed to kill process');
      return false;
    }
  }

  async function restartProcess(id: string): Promise<boolean> {
    try {
      const res = await apiFetch(apiUrl(`/api/processes/${id}/restart`), {
        method: 'POST',
      });

      if (res.ok) {
        const data = await res.json();
        toastStore.success('Process restarted');
        await loadProcesses();
        if (data.process) {
          selectedProcess = data.process;
        }
        return true;
      } else {
        const data = await res.json();
        toastStore.error(data.error || 'Failed to restart process');
        return false;
      }
    } catch (err) {
      toastStore.error('Failed to restart process');
      return false;
    }
  }

  async function startProcess(options: {
    name: string;
    command: string;
    cwd?: string;
    sessionId: string;
    restartPolicy?: 'never' | 'on-failure' | 'always';
    maxRestarts?: number;
  }): Promise<Process | null> {
    try {
      const res = await apiFetch(apiUrl('/api/processes'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options),
      });

      if (res.ok) {
        const data = await res.json();
        toastStore.success('Process started');
        await loadProcesses();
        return data.process;
      } else {
        const data = await res.json();
        toastStore.error(data.error || 'Failed to start process');
        return null;
      }
    } catch (err) {
      toastStore.error('Failed to start process');
      return null;
    }
  }

  async function cleanupOldProcesses(daysToKeep = 7): Promise<number> {
    try {
      const res = await apiFetch(apiUrl('/api/processes/cleanup'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ daysToKeep }),
      });

      if (res.ok) {
        const data = await res.json();
        toastStore.success(`Cleaned up ${data.deleted} old processes`);
        await loadProcesses();
        return data.deleted;
      }
    } catch (err) {
      toastStore.error('Failed to cleanup processes');
    }
    return 0;
  }

  // =======================================================================
  // Auto-refresh
  // =======================================================================

  function startAutoRefresh(intervalMs = 5000): void {
    if (refreshTimer) return;
    autoRefresh = true;
    refreshTimer = setInterval(() => {
      loadProcesses();
    }, intervalMs);
  }

  function stopAutoRefresh(): void {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
    autoRefresh = false;
  }

  // =======================================================================
  // Selection
  // =======================================================================

  function selectProcess(process: Process | null): void {
    selectedProcess = process;
    if (process) {
      loadProcessLogs(process.id);
      loadProcessEvents(process.id);
    } else {
      processLogs = null;
      processEvents = [];
    }
  }

  function setFilterStatus(status: string): void {
    filterStatus = status;
  }

  function setSearchQuery(query: string): void {
    searchQuery = query;
  }

  // =======================================================================
  // Helpers
  // =======================================================================

  function getStatusColor(status: Process['status']): string {
    switch (status) {
      case 'running':
        return '#22c55e'; // green
      case 'starting':
        return '#3b82f6'; // blue
      case 'exited':
        return '#6b7280'; // gray
      case 'killed':
        return '#f59e0b'; // amber
      case 'crashed':
        return '#ef4444'; // red
      case 'orphaned':
        return '#8b5cf6'; // purple
      default:
        return '#6b7280';
    }
  }

  function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
    if (ms < 3600000) return `${Math.floor(ms / 60000)}m`;
    return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
  }

  // =======================================================================
  // Getters
  // =======================================================================

  return {
    // State
    get processes() {
      return processes;
    },
    get filteredProcesses() {
      return filteredProcesses;
    },
    get selectedProcess() {
      return selectedProcess;
    },
    get processLogs() {
      return processLogs;
    },
    get processEvents() {
      return processEvents;
    },
    get isLoading() {
      return isLoading;
    },
    get isLogsLoading() {
      return isLogsLoading;
    },
    get autoRefresh() {
      return autoRefresh;
    },
    get filterStatus() {
      return filterStatus;
    },
    get searchQuery() {
      return searchQuery;
    },
    get activeCount() {
      return activeCount;
    },
    get crashedCount() {
      return crashedCount;
    },

    // Actions
    loadProcesses,
    loadSessionProcesses,
    loadProcessDetails,
    loadProcessLogs,
    loadProcessEvents,
    killProcess,
    restartProcess,
    startProcess,
    cleanupOldProcesses,
    selectProcess,
    setFilterStatus,
    setSearchQuery,
    startAutoRefresh,
    stopAutoRefresh,

    // Helpers
    getStatusColor,
    formatDuration,
  };
}

export const processStore = createProcessStore();
