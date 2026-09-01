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

export interface McpRegistrySearchResult {
  id: string;
  name: string;
  title: string;
  description: string;
  version: string;
  websiteUrl: string | null;
  repositoryUrl: string | null;
  transport: 'stdio' | 'sse';
  command: string | null;
  args: string[];
  envVars: Array<{
    name: string;
    description: string;
    isRequired: boolean;
    isSecret: boolean;
    defaultValue: string | null;
  }>;
  url: string | null;
  headerVars: Array<{
    name: string;
    description: string;
    isSecret: boolean;
  }>;
  /** Curated grouping for featured registry entries. */
  category?: string;
}

type McpListResponse = { ok?: boolean; data?: McpServerStatus[]; error?: string };
type McpStatusResponse = { ok?: boolean; data?: unknown; error?: string };
type McpTestResponse = { ok?: boolean; data?: McpServerTestResult; error?: string };
type McpEnvResponse = {
  ok?: boolean;
  data?: { keys: string[]; valuesMasked: true };
  error?: string;
};
type McpRegistrySearchResponse = {
  ok?: boolean;
  data?: { results: McpRegistrySearchResult[]; nextCursor: string | null };
  error?: string;
};
type McpRegistryFeaturedResponse = {
  ok?: boolean;
  data?: McpRegistrySearchResult[];
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

  let registryResults = $state<McpRegistrySearchResult[]>([]);
  let registrySearching = $state(false);
  let registryError = $state<string | undefined>(undefined);
  let registryNextCursor = $state<string | null>(null);
  let registryQuery = $state('');

  async function searchRegistry(query: string, cursor?: string): Promise<void> {
    const q = query.trim();
    if (!q) {
      registryResults = [];
      registryNextCursor = null;
      registryError = undefined;
      return;
    }
    registrySearching = true;
    registryError = undefined;
    if (!cursor) registryResults = [];
    try {
      const params = new URLSearchParams({ q, limit: '20' });
      if (cursor) params.set('cursor', cursor);
      const res = await apiFetch(apiUrl(`/api/v1/mcp-registry/search?${params.toString()}`));
      const json = await parseJsonResponse<McpRegistrySearchResponse>(res);
      if (!json?.ok || !json.data) throw new Error(json?.error ?? 'Registry search failed');
      if (cursor) {
        registryResults = [...registryResults, ...json.data.results];
      } else {
        registryResults = json.data.results;
      }
      registryNextCursor = json.data.nextCursor;
    } catch (err) {
      registryError = err instanceof Error ? err.message : 'Registry search failed';
      toastStore.error(registryError);
    } finally {
      registrySearching = false;
    }
  }

  function clearRegistry(): void {
    registryResults = [];
    registryNextCursor = null;
    registryError = undefined;
    registryQuery = '';
  }

  let featuredServers = $state<McpRegistrySearchResult[]>([]);
  let featuredLoading = $state(false);
  let featuredError = $state<string | undefined>(undefined);

  async function loadFeatured(): Promise<void> {
    if (featuredServers.length > 0 || featuredLoading) return;
    featuredLoading = true;
    featuredError = undefined;
    try {
      const res = await apiFetch(apiUrl('/api/v1/mcp-registry/featured'));
      const json = await parseJsonResponse<McpRegistryFeaturedResponse>(res);
      if (!json?.ok || !Array.isArray(json.data)) {
        throw new Error(json?.error ?? 'Could not load featured MCP servers');
      }
      featuredServers = json.data;
    } catch (err) {
      featuredError = err instanceof Error ? err.message : 'Could not load featured MCP servers';
    } finally {
      featuredLoading = false;
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
    // Registry search
    get registryResults() {
      return registryResults;
    },
    get registrySearching() {
      return registrySearching;
    },
    get registryError() {
      return registryError;
    },
    get registryNextCursor() {
      return registryNextCursor;
    },
    get registryQuery() {
      return registryQuery;
    },
    set registryQuery(value: string) {
      registryQuery = value;
    },
    searchRegistry,
    clearRegistry,
    // Featured (curated) registry entries
    get featuredServers() {
      return featuredServers;
    },
    get featuredLoading() {
      return featuredLoading;
    },
    get featuredError() {
      return featuredError;
    },
    loadFeatured,
  };
}

export const mcpServersStore = createMcpServersStore();
