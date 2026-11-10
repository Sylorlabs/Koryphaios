// /api/v1/mcp-servers — CRUD for user-pluggable MCP servers.
//
// All mutations go through the shared mcpServerService so config sync, env
// secret handling, validation, and hot-reload are identical for the HTTP route
// and the ManageMcpServerTool agent tool. Auth is the same local-route guard
// every other settings route uses.

import { Elysia, t } from 'elysia';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';
import { getRequestProjectRoot } from '../../runtime/request-project';
import { loadProjectMcpServers } from '../../runtime/config';
import { getContext } from '../../context';
import {
  listServers,
  addServer,
  updateServer,
  removeServer,
  testServer,
  reloadServer,
  getServerEnvKeys,
  type McpServerInput,
} from '../../mcp/server-service';
import {
  beginAuthorization,
  cancelFlow,
  completeAuthorization,
  disconnect as disconnectAuthorization,
  authorizationStatus,
} from '../../mcp/oauth-service';
import { McpOAuthError } from '../../mcp/oauth';
import { KoryphaiosError, ValidationError, NotFoundError } from '../../errors/types';

const mcpServerBodySchema = t.Object({
  name: t.String({ maxLength: 64 }),
  type: t.Union([t.Literal('stdio'), t.Literal('sse')]),
  command: t.Optional(t.String()),
  args: t.Optional(t.Array(t.String())),
  env: t.Optional(t.Record(t.String(), t.String())),
  url: t.Optional(t.String()),
  headers: t.Optional(t.Record(t.String(), t.String())),
  addedBy: t.Optional(t.Union([t.Literal('human'), t.Literal('agent')])),
});

const mcpServerUpdateBodySchema = t.Object({
  type: t.Union([t.Literal('stdio'), t.Literal('sse')]),
  command: t.Optional(t.String()),
  args: t.Optional(t.Array(t.String())),
  env: t.Optional(t.Record(t.String(), t.String())),
  url: t.Optional(t.String()),
  headers: t.Optional(t.Record(t.String(), t.String())),
  addedBy: t.Optional(t.Union([t.Literal('human'), t.Literal('agent')])),
});

function projectRootFromRequest(request: Request): string {
  return getRequestProjectRoot(request);
}

/**
 * The URL a stored server should authorize against, or null when the server is
 * unknown or is a local stdio process (which never uses OAuth).
 */
function readServerUrl(projectRoot: string, name: string): string | null {
  const configured = loadProjectMcpServers(projectRoot)[name];
  if (!configured || configured.type !== 'sse') return null;
  const url = typeof configured.url === 'string' ? configured.url.trim() : '';
  return url.length > 0 ? url : null;
}

/**
 * The `WWW-Authenticate` challenge from a live client for this server, if one
 * has connected. Servers advertise their own metadata URL there, which is more
 * reliable than guessing well-known paths.
 */
function getLiveChallenge(name: string, projectRoot: string): string | null {
  try {
    return (
      getContext().mcpManager.getClient(name, projectRoot)?.authorizationChallengeHeader ?? null
    );
  } catch {
    // No live context (e.g. a direct route test); discovery falls back to
    // probing the documented well-known locations.
    return null;
  }
}

function statusFor(projectRoot: string, name: string): unknown {
  return listServers(projectRoot).find((server) => server.name === name) ?? null;
}

// Elysia's `set.status` is a wide union of number | status-name strings.
// Use a loose type here so the helper accepts the route handler's `set`.
/* eslint-disable @typescript-eslint/no-explicit-any */
function errorResponse(err: unknown, set: any) {
  if (err instanceof McpOAuthError) {
    // The OAuth error codes are actionable for the user (no dynamic
    // registration, no published metadata, denied consent), so surface them
    // rather than collapsing to a 500.
    set.status = err.code === 'authorization_denied' ? 400 : 502;
    return { ok: false, error: err.message, code: err.code };
  }
  if (err instanceof KoryphaiosError) {
    set.status = err.statusCode;
    return { ok: false, error: err.message, code: err.code };
  }
  set.status = 500;
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export const mcpServerRoutes = new Elysia({ prefix: '/api/v1/mcp-servers' })
  // List all configured + live servers with connection status.
  .get('/', ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    try {
      const projectRoot = projectRootFromRequest(request);
      return { ok: true, data: listServers(projectRoot) };
    } catch (err) {
      return errorResponse(err, set);
    }
  })
  // Add a new MCP server.
  .post(
    '/',
    async ({ request, set, body }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      try {
        const projectRoot = projectRootFromRequest(request);
        const status = await addServer(projectRoot, body as McpServerInput);
        return { ok: true, data: status };
      } catch (err) {
        return errorResponse(err, set);
      }
    },
    { body: mcpServerBodySchema },
  )
  // Update an existing MCP server (preserve omitted settings and secret keys).
  .put(
    '/:name',
    async ({ request, set, params, body }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      try {
        const projectRoot = projectRootFromRequest(request);
        const input: McpServerInput = {
          ...(body as Omit<McpServerInput, 'name'>),
          name: params.name,
        };
        const status = await updateServer(projectRoot, params.name, input);
        return { ok: true, data: status };
      } catch (err) {
        return errorResponse(err, set);
      }
    },
    { body: mcpServerUpdateBodySchema },
  )
  // Remove an MCP server.
  .delete('/:name', async ({ request, set, params }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    try {
      const projectRoot = projectRootFromRequest(request);
      await removeServer(projectRoot, params.name);
      return { ok: true };
    } catch (err) {
      return errorResponse(err, set);
    }
  })
  // Test-connect to a server (fresh connection attempt, returns tool list).
  .post('/:name/test', async ({ request, set, params }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    try {
      const projectRoot = projectRootFromRequest(request);
      const result = await testServer(projectRoot, params.name);
      return { ok: true, data: result };
    } catch (err) {
      return errorResponse(err, set);
    }
  })
  // Force-reload a server (reconnect with current config).
  .post('/:name/reload', async ({ request, set, params }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    try {
      const projectRoot = projectRootFromRequest(request);
      const status = await reloadServer(projectRoot, params.name);
      return { ok: true, data: status };
    } catch (err) {
      return errorResponse(err, set);
    }
  })
  // Get the env var keys for a server (values are never returned — secret store).
  // ─── OAuth (remote servers only) ────────────────────────────────────────
  // The flow is: start -> user completes consent in their browser -> the
  // loopback listener captures the redirect -> complete exchanges the code and
  // stores the token. Tokens live only in .koryphaios/mcp-oauth.json, never in
  // koryphaios.json.
  .post(
    '/:name/oauth/start',
    async ({ request, set, params, body }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      try {
        const projectRoot = projectRootFromRequest(request);
        const configured = readServerUrl(projectRoot, params.name);
        if (!configured) {
          throw new ValidationError(`MCP server "${params.name}" has no URL to authorize against`);
        }
        // A live client's challenge is the most accurate discovery hint; fall back
        // to well-known probing when the server has never been connected.
        const challenge = getLiveChallenge(params.name, projectRoot);
        const result = await beginAuthorization({
          projectRoot,
          serverName: params.name,
          resourceUrl: configured,
          wwwAuthenticate: challenge,
          // Servers that allow no dynamic registration need the user's own app
          // credentials; the UI asks for them after the first attempt explains why.
          manualClient: body?.clientId
            ? { clientId: body.clientId, clientSecret: body.clientSecret }
            : undefined,
        });
        return { ok: true, data: result };
      } catch (err) {
        return errorResponse(err, set);
      }
    },
    {
      // Optional overall: the common case (dynamic registration) sends no body
      // at all, and an absent body must not be a validation failure.
      body: t.Optional(
        t.Object({
          clientId: t.Optional(t.String({ maxLength: 512 })),
          clientSecret: t.Optional(t.String({ maxLength: 1024 })),
        }),
      ),
    },
  )
  .post('/:name/oauth/complete', async ({ request, set, params }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    try {
      const projectRoot = projectRootFromRequest(request);
      const summary = await completeAuthorization({
        projectRoot,
        serverName: params.name,
      });
      // Reconnect so the new token is exercised immediately and tools register.
      await reloadServer(projectRoot, params.name).catch(() => undefined);
      return { ok: true, data: { oauth: summary, server: statusFor(projectRoot, params.name) } };
    } catch (err) {
      return errorResponse(err, set);
    }
  })
  .get('/:name/oauth', ({ request, set, params }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const projectRoot = projectRootFromRequest(request);
    return { ok: true, data: authorizationStatus(projectRoot, params.name) };
  })
  .post('/:name/oauth/cancel', async ({ request, set, params }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const projectRoot = projectRootFromRequest(request);
    const cancelled = await cancelFlow(projectRoot, params.name);
    return { ok: true, data: { cancelled } };
  })
  .delete('/:name/oauth', async ({ request, set, params }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    try {
      const projectRoot = projectRootFromRequest(request);
      const revoked = await disconnectAuthorization({ projectRoot, serverName: params.name });
      return { ok: true, data: { revoked } };
    } catch (err) {
      return errorResponse(err, set);
    }
  })
  .get('/:name/env', ({ request, set, params }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    try {
      const projectRoot = projectRootFromRequest(request);
      const keys = getServerEnvKeys(projectRoot, params.name);
      return { ok: true, data: { keys, valuesMasked: true } };
    } catch (err) {
      return errorResponse(err, set);
    }
  });
