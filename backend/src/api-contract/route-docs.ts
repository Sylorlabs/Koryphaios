// Hand-written route documentation, merged into the generated OpenAPI document.
//
// Only prose lives here: summaries, descriptions and tag names. Shapes come
// from the running routes (see `manifest.ts`), never from this file. Every key
// must name a route the manifest enumerates; `openapi.ts` throws otherwise, so
// a route that is renamed or removed fails the drift check instead of leaving
// stale prose behind.
//
// Operations documented by the retired hand-written `openapi.yaml` that the
// backend does not implement are kept in `RETIRED_OPERATION_DOCS` (and listed in
// docs/api-contract.md) rather than published as if they existed.

export interface RouteDoc {
  readonly summary?: string;
  readonly description?: string;
  /** Overrides the plugin-derived tag. */
  readonly tag?: string;
}

/** Keyed by manifest key (`METHOD /openapi/path`). */
export const ROUTE_DOCS: Readonly<Record<string, RouteDoc>> = {
  'GET /api/sessions': { summary: 'List all sessions', tag: 'Sessions' },
  'POST /api/sessions': { summary: 'Create a new session', tag: 'Sessions' },
  'GET /api/sessions/{id}': { summary: 'Get session details', tag: 'Sessions' },
  'DELETE /api/sessions/{id}': { summary: 'Delete a session', tag: 'Sessions' },
  'POST /api/messages': {
    summary: 'Send a message',
    tag: 'Messages',
    description: 'Queues a user message for a session and starts (or steers) the agent turn.',
  },
  'GET /api/providers': { summary: 'List provider status', tag: 'Providers' },
  'PUT /api/providers/{name}': { summary: 'Configure provider credentials', tag: 'Providers' },
  'DELETE /api/providers/{name}': { summary: 'Remove provider credentials', tag: 'Providers' },
  'GET /api/health': {
    summary: 'Health check',
    tag: 'System',
    description:
      'Unauthenticated liveness and compatibility probe. The frontend halts when its version or bundle hash falls outside `compat`.',
  },
};

export interface RetiredOperationDoc {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly summary: string;
  readonly description?: string;
  /** Why it is not published. */
  readonly reason: string;
}

/**
 * Operations the old `openapi.yaml` documented for routes the backend does not
 * register. Kept as prose so the migration loses no hand-written text; they are
 * not in `openapi.json`. Re-adding one means implementing the route and
 * moving its entry into `ROUTE_DOCS`.
 */
export const RETIRED_OPERATION_DOCS: readonly RetiredOperationDoc[] = [
  {
    method: 'GET',
    path: '/api/agents/status',
    summary: 'Get active agent status',
    reason: 'No such route. Agent status is served under /api/agent/* (see agent-settings routes).',
  },
  {
    method: 'POST',
    path: '/api/agents/cancel',
    summary: 'Cancel all running agents',
    reason:
      'No such route. Agent cancellation is served under /api/agent/* and /api/sessions/{id}.',
  },
  {
    method: 'POST',
    path: '/api/v1/credentials/{id}/rotate',
    summary: 'Rotate credential encryption',
    description: 'Re-encrypt a credential with a new key (useful after password change).',
    reason: 'Not implemented. Provider credentials are managed under /api/providers.',
  },
  {
    method: 'GET',
    path: '/api/v1/credentials/{id}/audit',
    summary: 'Get credential audit trail',
    description: 'Get access history for a specific credential (answers "Who accessed my key?").',
    reason: 'Not implemented.',
  },
  {
    method: 'GET',
    path: '/api/v1/keys',
    summary: 'List API keys',
    description: 'Get all API keys for the authenticated user (does not return full keys).',
    reason: 'Not implemented. Koryphaios has no multi-user API key store.',
  },
  {
    method: 'POST',
    path: '/api/v1/keys',
    summary: 'Create API key',
    description:
      'Create a new API key for programmatic access. The key is only returned once at creation.',
    reason: 'Not implemented.',
  },
  {
    method: 'GET',
    path: '/api/v1/keys/{id}',
    summary: 'Get API key details',
    reason: 'Not implemented.',
  },
  {
    method: 'PATCH',
    path: '/api/v1/keys/{id}',
    summary: 'Update API key',
    description: 'Update name, scopes, or rate limit tier.',
    reason: 'Not implemented.',
  },
  {
    method: 'DELETE',
    path: '/api/v1/keys/{id}',
    summary: 'Revoke API key',
    description: 'Permanently revoke an API key.',
    reason: 'Not implemented.',
  },
  {
    method: 'GET',
    path: '/api/v1/audit',
    summary: 'Query audit logs',
    description: 'Search audit logs with filters (admin can query all users).',
    reason: 'Not implemented.',
  },
  {
    method: 'GET',
    path: '/api/v1/audit/me',
    summary: 'Get my activity',
    description: 'Get recent audit log entries for the current user.',
    reason: 'Not implemented.',
  },
  {
    method: 'GET',
    path: '/api/v1/audit/suspicious',
    summary: 'Detect suspicious activity',
    description: 'Check for suspicious patterns in user activity (admin only).',
    reason: 'Not implemented.',
  },
];

/** Tag display names keyed by plugin name, for plugins whose name reads badly when humanized. */
export const PLUGIN_TAG_OVERRIDES: Readonly<Record<string, string>> = {
  systemRoutes: 'System',
  sessionRoutes: 'Sessions',
  feedRoutes: 'Session feed',
  messageRoutes: 'Messages',
  providerRoutes: 'Providers',
  agentSettingsRoutes: 'Agents',
  agentMessageRoutes: 'Agent messages',
  mcpBridgeRoutes: 'MCP bridge',
  mcpServerRoutes: 'MCP servers',
  mcpRegistryRoutes: 'MCP registry',
  cliChatImportRoutes: 'CLI chat import',
  createComputerUseRoutes: 'Computer use',
  computerUseRoutes: 'Computer use',
  spendCapsRoutes: 'Spend caps',
  desktopUiRoutes: 'Desktop UI',
  updateRoutes: 'Updates',
  nativeCommandRoutes: 'Native commands',
};

/** Human tag name for a plugin: `notesRoutes` -> `Notes`. */
export function tagForPlugin(plugin: string): string {
  const override = PLUGIN_TAG_OVERRIDES[plugin];
  if (override) return override;
  const stem = plugin.replace(/Routes$/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return stem.charAt(0).toUpperCase() + stem.slice(1);
}
