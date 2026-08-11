// /api/v1/mcp-servers — CRUD for user-pluggable MCP servers.
//
// All mutations go through the shared mcpServerService so config sync, env
// secret handling, validation, and hot-reload are identical for the HTTP route
// and the ManageMcpServerTool agent tool. Auth is the same local-route guard
// every other settings route uses.

import { Elysia, t } from 'elysia';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';
import { getRequestProjectRoot } from '../../runtime/request-project';
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

// Elysia's `set.status` is a wide union of number | status-name strings.
// Use a loose type here so the helper accepts the route handler's `set`.
/* eslint-disable @typescript-eslint/no-explicit-any */
function errorResponse(err: unknown, set: any) {
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
  // Update an existing MCP server (full replace).
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
