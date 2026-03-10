<script lang="ts">
  import { onMount } from 'svelte';
  import { apiUrl } from '$lib/utils/api-url';

  export let sessionId: string | null = null;

  interface SpendCaps {
    hourly: string | null;
    daily: string | null;
    monthly: string | null;
    maxSessionLength: number | null;
    maxTokensPerHour: number | null;
    maxCommandsPerHour: number | null;
  }

  interface SpendStatus {
    caps: SpendCaps;
    global: {
      daily: { spent: string; tokens: number; commands: number; activeSessions: number };
      monthly: { spent: string; tokens: number; commands: number; activeSessions: number };
      allowed: boolean;
      reason?: string;
    };
    session: {
      spent: string;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      commands: number;
      duration: number;
      allowed: boolean;
      reason?: string;
    } | null;
  }

  let status: SpendStatus | null = null;
  let loading = true;
  let error: string | null = null;
  let autoRefresh = true;

  async function fetchStatus() {
    if (!autoRefresh) return;

    try {
      const url = sessionId
        ? `${apiUrl}/spend/status?sessionId=${sessionId}`
        : `${apiUrl}/spend/status`;

      const response = await fetch(url);
      const data = await response.json();

      if (data.ok) {
        status = data.data;
        error = null;
      } else {
        error = data.error || 'Failed to load spend status';
      }
    } catch (e) {
      error = 'Failed to connect to server';
    } finally {
      loading = false;
    }

    // Auto-refresh every 30 seconds
    if (autoRefresh) {
      setTimeout(fetchStatus, 30000);
    }
  }

  function formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    }
    return `${seconds}s`;
  }

  onMount(() => {
    fetchStatus();
    return () => { autoRefresh = false; };
  });
</script>

<div class="spend-status">
  {#if loading}
    <div class="loading">Loading spend status...</div>
  {:else if error}
    <div class="error">{error}</div>
  {:else if status}
    <div class="spend-header">
      <h3>Spend Status</h3>
      <span class="caps">
        {#if status.caps.daily}
          Daily Limit: {status.caps.daily}
        {/if}
        {#if status.caps.monthly}
          • Monthly: {status.caps.monthly}
        {/if}
      </span>
    </div>

    {#if !status.global.allowed}
      <div class="alert alert-critical">
        <strong>System Shutoff:</strong> {status.global.reason}
      </div>
    {/if}

    {#if status.session && !status.session.allowed}
      <div class="alert alert-warning">
        <strong>Session Limited:</strong> {status.session.reason}
      </div>
    {/if}

    <div class="spend-grid">
      <div class="spend-card">
        <h4>Global Usage (Today)</h4>
        <div class="stat">Spent: <span class="value">{status.global.daily.spent}</span></div>
        <div class="stat">Tokens: <span class="value">{status.global.daily.tokens.toLocaleString()}</span></div>
        <div class="stat">Commands: <span class="value">{status.global.daily.commands}</span></div>
        <div class="stat">Active Sessions: <span class="value">{status.global.daily.activeSessions}</span></div>
      </div>

      {#if status.session}
        <div class="spend-card">
          <h4>This Session</h4>
          <div class="stat">Spent: <span class="value">{status.session.spent}</span></div>
          <div class="stat">Tokens: <span class="value">{status.session.totalTokens.toLocaleString()}</span></div>
          <div class="stat">Commands: <span class="value">{status.session.commands}</span></div>
          <div class="stat">Duration: <span class="value">{formatDuration(status.session.duration)}</span></div>
        </div>
      {/if}

      <div class="spend-card">
        <h4>This Month</h4>
        <div class="stat">Spent: <span class="value">{status.global.monthly.spent}</span></div>
        <div class="stat">Tokens: <span class="value">{status.global.monthly.tokens.toLocaleString()}</span></div>
        <div class="stat">Commands: <span class="value">{status.global.monthly.commands}</span></div>
      </div>
    </div>
  {/if}
</div>

<style>
  .spend-status {
    padding: 1rem;
    background: var(--bg-secondary, #1a1a1a);
    border-radius: 8px;
    margin: 1rem 0;
  }

  .spend-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
  }

  .spend-header h3 {
    margin: 0;
    font-size: 1.1rem;
  }

  .caps {
    font-size: 0.85rem;
    color: var(--text-secondary, #888);
  }

  .spend-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 1rem;
  }

  .spend-card {
    background: var(--bg-primary, #0a0a0a);
    padding: 1rem;
    border-radius: 6px;
    border: 1px solid var(--border-color, #333);
  }

  .spend-card h4 {
    margin: 0 0 0.75rem 0;
    font-size: 0.9rem;
    color: var(--text-secondary, #888);
  }

  .stat {
    display: flex;
    justify-content: space-between;
    margin-bottom: 0.5rem;
    font-size: 0.85rem;
  }

  .value {
    font-weight: 600;
    color: var(--text-primary, #fff);
  }

  .alert {
    padding: 0.75rem;
    margin-bottom: 1rem;
    border-radius: 4px;
    font-size: 0.9rem;
  }

  .alert-critical {
    background: rgba(239, 68, 68, 0.2);
    border: 1px solid rgba(239, 68, 68, 0.5);
    color: #fca5a5;
  }

  .alert-warning {
    background: rgba(234, 179, 8, 0.2);
    border: 1px solid rgba(234, 179, 8, 0.5);
    color: #fde047;
  }

  .loading {
    text-align: center;
    padding: 2rem;
    color: var(--text-secondary, #888);
  }

  .error {
    padding: 1rem;
    background: rgba(239, 68, 68, 0.2);
    border: 1px solid rgba(239, 68, 68, 0.5);
    border-radius: 4px;
    color: #fca5a5;
  }
</style>
