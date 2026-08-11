/**
 * MCP servers store — Svelte 5 runes
 *
 * Manages user-pluggable Model Context Protocol tool servers via the
 * /api/v1/mcp-servers CRUD API. Env var values are never stored client-side;
 * only keys are surfaced from the backend's masked secret store.
 */

import { apiFetch, parseJsonResponse } from '$lib/api.svelte';
import { apiUrl } from '$lib/utils/api-url';
import { toastStore } from './toast.svelte';

export interface McpServerStatus {
  name: string;
  transport: 'stdio' | 'sse';
  connected: boolean;
  toolCount: number;
  protocolVersion?: string;
  lastError?: string | null;
  configured: boolean;
}

export interface McpServerTestResult {
  connected: boolean;
  tools: string[];
  protocolVersion?: string;
  error?: string;
}

export interface McpServerInput {
  name: string;
  type: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  addedBy?: string;
}

type McpListResponse = { ok?: boolean; data?: McpServerStatus[]; error?: string };
type McpStatusResponse = { ok?: boolean; data?: unknown; error?: string };
type McpTestResponse = { ok?: boolean; data?: McpServerTestResult; error?: string };
type McpEnvResponse = {
  ok?: boolean;
  data?: { keys: string[]; valuesMasked: true };
  error?: string;
};

function createMcpServersStore() {
  let servers = $state<McpServerStatus[]>([]);
  let loading = $state(false);
  let error = $state<string | undefined>(undefined);

  async function loadAll(): Promise<void> {
    loading = true;
    error = undefined;
    try {
      const res = await apiFetch(apiUrl('/api/v1/mcp-servers'));
      const json = await parseJsonResponse<McpListResponse>(res);
      if (!json?.ok || !Array.isArray(json.data)) {
        throw new Error(json?.error ?? 'Could not load MCP servers');
      }
      servers = json.data;
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not load MCP servers';
      toastStore.error(error);
    } finally {
      loading = false;
    }
  }

  async function addServer(input: McpServerInput): Promise<boolean> {
    loading = true;
    error = undefined;
    try {
      const res = await apiFetch(apiUrl('/api/v1/mcp-servers'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const json = await parseJsonResponse<McpStatusResponse>(res);
      if (!json?.ok) throw new Error(json?.error ?? 'Could not add MCP server');
      toastStore.success(`MCP server "${input.name}" added`);
      await loadAll();
      return true;
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not add MCP server';
      toastStore.error(error);
      return false;
    } finally {
      loading = false;
    }
  }

  async function updateServer(name: string, input: McpServerInput): Promise<boolean> {
    loading = true;
    error = undefined;
    try {
      const res = await apiFetch(apiUrl(`/api/v1/mcp-servers/${encodeURIComponent(name)}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const json = await parseJsonResponse<McpStatusResponse>(res);
      if (!json?.ok) throw new Error(json?.error ?? 'Could not update MCP server');
      toastStore.success(`MCP server "${name}" updated`);
      await loadAll();
      return true;
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not update MCP server';
      toastStore.error(error);
      return false;
    } finally {
      loading = false;
    }
  }

  async function removeServer(name: string): Promise<boolean> {
    loading = true;
    error = undefined;
    try {
      const res = await apiFetch(apiUrl(`/api/v1/mcp-servers/${encodeURIComponent(name)}`), {
        method: 'DELETE',
      });
      const json = await parseJsonResponse<McpStatusResponse>(res);
      if (!json?.ok) throw new Error(json?.error ?? 'Could not remove MCP server');
      toastStore.success(`MCP server "${name}" removed`);
      await loadAll();
      return true;
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not remove MCP server';
      toastStore.error(error);
      return false;
    } finally {
      loading = false;
    }
  }

  async function testServer(name: string): Promise<McpServerTestResult | null> {
    try {
      const res = await apiFetch(apiUrl(`/api/v1/mcp-servers/${encodeURIComponent(name)}/test`), {
        method: 'POST',
      });
      const json = await parseJsonResponse<McpTestResponse>(res);
      if (!json?.ok) throw new Error(json?.error ?? 'Could not test MCP server');
      const result = json.data;
      if (result?.connected) {
        toastStore.success(
          `MCP server "${name}" connected (${result.tools.length} tool${result.tools.length === 1 ? '' : 's'})`,
        );
      } else {
        toastStore.warning(`MCP server "${name}" test failed: ${result?.error ?? 'not connected'}`);
      }
      return result ?? null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not test MCP server';
      toastStore.error(msg);
      return null;
    }
  }

  async function reloadServer(name: string): Promise<boolean> {
    loading = true;
    error = undefined;
    try {
      const res = await apiFetch(apiUrl(`/api/v1/mcp-servers/${encodeURIComponent(name)}/reload`), {
        method: 'POST',
      });
      const json = await parseJsonResponse<McpStatusResponse>(res);
      if (!json?.ok) throw new Error(json?.error ?? 'Could not reload MCP server');
      toastStore.success(`MCP server "${name}" reloaded`);
      await loadAll();
      return true;
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not reload MCP server';
      toastStore.error(error);
      return false;
    } finally {
      loading = false;
    }
  }

  async function getEnvKeys(name: string): Promise<string[]> {
    try {
      const res = await apiFetch(apiUrl(`/api/v1/mcp-servers/${encodeURIComponent(name)}/env`));
      const json = await parseJsonResponse<McpEnvResponse>(res);
      if (!json?.ok || !json.data) throw new Error(json?.error ?? 'Could not load env keys');
      return Array.isArray(json.data.keys) ? json.data.keys : [];
    } catch (err) {
      toastStore.error(err instanceof Error ? err.message : 'Could not load env keys');
      return [];
    }
  }

  return {
    get servers() {
      return servers;
    },
    get loading() {
      return loading;
    },
    get error() {
      return error;
    },
    loadAll,
    addServer,
    updateServer,
    removeServer,
    testServer,
    reloadServer,
    getEnvKeys,
  };
}

export const mcpServersStore = createMcpServersStore();
