// /api/v1/mcp-registry — search the official MCP registry
// (registry.modelcontextprotocol.io) so users can discover and add MCP servers
// without knowing the exact command or URL upfront.
//
// The registry provides an unauthenticated read-only REST API. We proxy it
// through our backend to avoid CORS issues, keep the user's origin private,
// and allow future caching/rate-limiting. We only surface fields the add-server
// form needs; we never forward secrets or auth tokens.

import { Elysia, t } from 'elysia';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';
import { serverLog } from '../../logger';

const REGISTRY_BASE_URL = 'https://registry.modelcontextprotocol.io';
const MAX_RESULTS = 50;
const DEFAULT_LIMIT = 20;
const SEARCH_TIMEOUT_MS = 10_000;

// Subset of the official registry schema that we surface to the frontend.
// See https://registry.modelcontextprotocol.io/docs for the full schema.

interface RegistryPackage {
  registryType?: string;
  registryBaseUrl?: string;
  identifier?: string;
  version?: string;
  runtimeHint?: string;
  transport?: { type: string };
  runtimeArguments?: Array<{ value: string; type?: string }>;
  environmentVariables?: Array<{
    name: string;
    description?: string;
    isRequired?: boolean;
    isSecret?: boolean;
    default?: string;
  }>;
}

interface RegistryRemote {
  type: string;
  url: string;
  headers?: Array<{ name: string; description?: string; isSecret?: boolean }>;
}

interface RegistryServer {
  name: string;
  title?: string;
  description?: string;
  version?: string;
  websiteUrl?: string;
  repository?: { url?: string; source?: string; subfolder?: string };
  packages?: RegistryPackage[];
  remotes?: RegistryRemote[];
}

interface RegistryListItem {
  server: RegistryServer;
  _meta?: Record<string, unknown>;
}

interface RegistryListResponse {
  servers: RegistryListItem[];
  metadata?: { nextCursor?: string; count?: number };
}

export interface McpRegistrySearchResult {
  id: string;
  name: string;
  title: string;
  description: string;
  version: string;
  websiteUrl: string | null;
  repositoryUrl: string | null;
  /** Best available transport for the add form: "stdio" or "sse". */
  transport: 'stdio' | 'sse';
  /** Pre-built stdio command (for npx/uvx packages). */
  command: string | null;
  /** Pre-built stdio args. */
  args: string[];
  /** Environment variable definitions the user must fill in. */
  envVars: Array<{
    name: string;
    description: string;
    isRequired: boolean;
    isSecret: boolean;
    defaultValue: string | null;
  }>;
  /** Remote URL for SSE/streamable-http servers. */
  url: string | null;
  /** Remote headers the user may need to set. */
  headerVars: Array<{
    name: string;
    description: string;
    isSecret: boolean;
  }>;
}

function pickBestPackage(server: RegistryServer): RegistryPackage | null {
  if (!server.packages || server.packages.length === 0) return null;
  // Prefer npm (npx) packages since they're the most common and easiest to run.
  const npm = server.packages.find((p) => p.registryType === 'npm');
  return npm ?? server.packages[0];
}

function pickBestRemote(server: RegistryServer): RegistryRemote | null {
  if (!server.remotes || server.remotes.length === 0) return null;
  // Prefer SSE since that's what our add form supports directly.
  const sse = server.remotes.find((r) => r.type === 'sse');
  return sse ?? server.remotes[0];
}

function buildCommand(pkg: RegistryPackage): { command: string; args: string[] } | null {
  if (!pkg.identifier) return null;
  const runtime = pkg.runtimeHint ?? (pkg.registryType === 'npm' ? 'npx' : 'uvx');
  const runtimeArgs = (pkg.runtimeArguments ?? []).map((a) => a.value);
  if (runtime === 'npx') {
    return { command: 'npx', args: ['-y', pkg.identifier, ...runtimeArgs] };
  }
  if (runtime === 'uvx') {
    return { command: 'uvx', args: [pkg.identifier, ...runtimeArgs] };
  }
  // Unknown runtime — surface the raw command as best-effort.
  return { command: runtime, args: [pkg.identifier, ...runtimeArgs] };
}

function mapSearchResult(item: RegistryListItem): McpRegistrySearchResult | null {
  const server = item.server;
  if (!server?.name) return null;

  const pkg = pickBestPackage(server);
  const remote = pickBestRemote(server);

  // Determine transport: prefer stdio if a package exists, else remote.
  let transport: 'stdio' | 'sse' = 'stdio';
  let command: string | null = null;
  let args: string[] = [];
  let envVars: McpRegistrySearchResult['envVars'] = [];
  let url: string | null = null;
  let headerVars: McpRegistrySearchResult['headerVars'] = [];

  if (pkg) {
    const built = buildCommand(pkg);
    if (built) {
      command = built.command;
      args = built.args;
    }
    envVars = (pkg.environmentVariables ?? []).map((v) => ({
      name: v.name,
      description: v.description ?? '',
      isRequired: v.isRequired ?? false,
      isSecret: v.isSecret ?? false,
      defaultValue: v.default ?? null,
    }));
    transport = 'stdio';
  } else if (remote) {
    url = remote.url;
    headerVars = (remote.headers ?? []).map((h) => ({
      name: h.name,
      description: h.description ?? '',
      isSecret: h.isSecret ?? false,
    }));
    // Our add form uses "sse" for any remote HTTP transport.
    transport = 'sse';
  } else {
    // No installable package and no remote — skip.
    return null;
  }

  return {
    id: server.name,
    name: server.name,
    title: server.title ?? server.name,
    description: server.description ?? '',
    version: server.version ?? '',
    websiteUrl: server.websiteUrl ?? null,
    repositoryUrl: server.repository?.url ?? null,
    transport,
    command,
    args,
    envVars,
    url,
    headerVars,
  };
}

export const mcpRegistryRoutes = new Elysia({ prefix: '/api/v1/mcp-registry' })
  .get(
    '/search',
    async ({ request, set, query }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const q = (query.q ?? '').trim();
      const limit = Math.min(Math.max(Number(query.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1), MAX_RESULTS);
      const cursor = query.cursor ?? undefined;

      if (!q) {
        return { ok: true, data: { results: [], nextCursor: null } };
      }

      const params = new URLSearchParams({
        search: q,
        limit: String(limit),
        version: 'latest',
      });
      if (cursor) params.set('cursor', cursor);

      const url = `${REGISTRY_BASE_URL}/v0.1/servers?${params.toString()}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

      try {
        const res = await fetch(url, {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) {
          serverLog.warn(
            { status: res.status, query: q },
            'MCP registry search returned non-OK status',
          );
          set.status = 502;
          return {
            ok: false,
            error: `MCP registry returned ${res.status}`,
          };
        }
        const json = (await res.json()) as RegistryListResponse;
        const results = (json.servers ?? [])
          .map(mapSearchResult)
          .filter((r): r is McpRegistrySearchResult => r !== null);

        return {
          ok: true,
          data: {
            results,
            nextCursor: json.metadata?.nextCursor ?? null,
          },
        };
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') {
          serverLog.warn({ query: q }, 'MCP registry search timed out');
          set.status = 504;
          return { ok: false, error: 'MCP registry search timed out' };
        }
        serverLog.error(
          { error: err instanceof Error ? err.message : String(err), query: q },
          'MCP registry search failed',
        );
        set.status = 502;
        return {
          ok: false,
          error: 'Failed to search the MCP registry',
        };
      } finally {
        clearTimeout(timeout);
      }
    },
    {
      query: t.Object({
        q: t.Optional(t.String()),
        limit: t.Optional(t.String()),
        cursor: t.Optional(t.String()),
      }),
    },
  );
