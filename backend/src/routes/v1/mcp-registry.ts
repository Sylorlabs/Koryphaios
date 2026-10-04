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
import {
  FEATURED_MCP_SERVERS,
  type McpAuthRequirement,
} from '../../mcp/featured-registry';
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
  packageArguments?: Array<{ value: string; type?: string }>;
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
  /** What the user will have to do to make this server work. */
  auth: McpAuthRequirement;
}

export function pickBestPackage(server: RegistryServer): RegistryPackage | null {
  if (!server.packages || server.packages.length === 0) return null;
  // Prefer npm (npx) packages since they're the most common and easiest to run.
  const npm = server.packages.find((p) => p.registryType === 'npm');
  return npm ?? server.packages[0];
}

export function pickBestRemote(server: RegistryServer): RegistryRemote | null {
  if (!server.remotes || server.remotes.length === 0) return null;
  // Prefer streamable-http: it is what hosted MCP servers ship today and what
  // our client speaks. Genuine `sse` endpoints are the fallback. Preferring
  // `r.type === 'sse'` first (as this used to) never matched anything, because
  // the registry labels hosted endpoints `streamable-http`.
  const streamable = server.remotes.find((r) => r.type === 'streamable-http');
  if (streamable) return streamable;
  const sse = server.remotes.find((r) => r.type === 'sse');
  return sse ?? server.remotes[0];
}

export function buildCommand(pkg: RegistryPackage): { command: string; args: string[] } | null {
  if (!pkg.identifier) return null;

  // Per the registry schema, `runtimeArguments` belong to the runtime command
  // (npx/uvx/docker/dnx) and therefore come BEFORE the identifier, while
  // `packageArguments` belong to the package binary and come AFTER it. This
  // function used to append runtimeArguments after the identifier and inject
  // its own `-y`, producing `npx -y <pkg> -y <pkgArg>`.
  const runtimeArgs = (pkg.runtimeArguments ?? []).map((a) => a.value);
  const packageArgs = (pkg.packageArguments ?? []).map((a) => a.value);
  const identifier = pkg.identifier;

  switch (pkg.runtimeHint) {
    case 'npx':
    case 'dnx': {
      // npx needs `-y` to skip the install prompt. Most registry entries
      // already list it in runtimeArguments; only add it when missing.
      const head = runtimeArgs.includes('-y') ? runtimeArgs : ['-y', ...runtimeArgs];
      return { command: 'npx', args: [...head, identifier, ...packageArgs] };
    }
    case 'uvx':
      return { command: 'uvx', args: [...runtimeArgs, identifier, ...packageArgs] };
    case 'docker':
    case 'podman': {
      // For OCI packages the identifier is the image reference.
      const head = runtimeArgs.length > 0 ? runtimeArgs : ['run', '-i', '--rm'];
      return { command: pkg.runtimeHint, args: [...head, identifier, ...packageArgs] };
    }
    default: {
      // No usable runtime hint. Only npm and pypi can be derived safely;
      // anything else would spawn a wrong executable, so surface nothing and
      // let the caller fall back to a remote transport.
      const inferred =
        pkg.registryType === 'npm' ? 'npx' : pkg.registryType === 'pypi' ? 'uvx' : null;
      if (!inferred) return null;
      if (inferred === 'npx') {
        const head = runtimeArgs.includes('-y') ? runtimeArgs : ['-y', ...runtimeArgs];
        return { command: 'npx', args: [...head, identifier, ...packageArgs] };
      }
      return { command: 'uvx', args: [...runtimeArgs, identifier, ...packageArgs] };
    }
  }
}

export function mapSearchResult(item: RegistryListItem): McpRegistrySearchResult | null {
  const server = item.server;
  if (!server?.name) return null;

  const pkg = pickBestPackage(server);
  const remote = pickBestRemote(server);

  // Determine transport. A stdio entry is only usable if we can actually build
  // a runnable command: `transport: 'stdio'` with `command: null` previously
  // produced an add-form that 422'd with "command is required for stdio".
  const built = pkg ? buildCommand(pkg) : null;
  const stdio: {
    transport: 'stdio';
    command: string;
    args: string[];
    envVars: McpRegistrySearchResult['envVars'];
  } | null = built
    ? {
        transport: 'stdio',
        command: built.command,
        args: built.args,
        envVars: (pkg?.environmentVariables ?? []).map((v) => ({
          name: v.name,
          description: v.description ?? '',
          isRequired: v.isRequired ?? false,
          isSecret: v.isSecret ?? false,
          defaultValue: v.default ?? null,
        })),
      }
    : null;

  let transport: 'stdio' | 'sse';
  let command: string | null;
  let args: string[];
  let envVars: McpRegistrySearchResult['envVars'];
  let url: string | null;
  let headerVars: McpRegistrySearchResult['headerVars'];

  if (stdio) {
    // Prefer stdio when it is actually runnable; it needs no network round trip
    // and the user controls the process.
    transport = 'stdio';
    command = stdio.command;
    args = stdio.args;
    envVars = stdio.envVars;
    url = null;
    headerVars = [];
  } else if (remote) {
    transport = 'sse';
    command = null;
    args = [];
    envVars = [];
    url = remote.url;
    headerVars = (remote.headers ?? []).map((h) => ({
      name: h.name,
      description: h.description ?? '',
      isSecret: h.isSecret ?? false,
    }));
  } else {
    // Nothing runnable: no installable package we can drive and no remote.
    return null;
  }

  const title = server.title ?? server.name;
  const requiredEnv = envVars.filter((v) => v.isRequired);

  let auth: McpAuthRequirement;
  if (transport === 'stdio') {
    if (requiredEnv.length > 0) {
      const names = requiredEnv.map((v) => v.name).join(', ');
      auth = {
        kind: 'env',
        label: 'Needs a key or connection string',
        detail: `Enter ${names} when adding this server. Koryphaios stores the value securely and never shows it again.`,
      };
    } else {
      auth = {
        kind: 'none',
        label: 'No sign-in',
        detail: `Runs ${title} locally. No credentials needed.`,
      };
    }
  } else if (headerVars.length > 0) {
    auth = {
      kind: 'headers',
      label: 'Needs a credential',
      detail: `Paste your ${title} credential into the ${headerVars
        .map((h) => h.name)
        .join(', ')} header when adding this server.`,
    };
  } else {
    // A remote endpoint with no declared credential almost always means OAuth.
    // Discovery decides whether Koryphaios can drive it automatically; if it
    // cannot, Authorize explains why and asks for app credentials instead.
    auth = {
      kind: 'oauth',
      label: `Sign in with ${title}`,
      detail: `Koryphaios opens ${title} in your browser so you can approve access. Nothing is shared until you do.`,
    };
  }

  return {
    id: server.name,
    name: server.name,
    title,
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
    auth,
  };
}

export const mcpRegistryRoutes = new Elysia({ prefix: '/api/v1/mcp-registry' })
  .get('/featured', ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    return { ok: true, data: FEATURED_MCP_SERVERS };
  })
  .get(
    '/search',
    async ({ request, set, query }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const q = (query.q ?? '').trim();
      const limit = Math.min(
        Math.max(Number(query.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1),
        MAX_RESULTS,
      );
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
