// Shared MCP server management service — the single authoritative path for
// adding/removing/updating/testing user-configured MCP servers. Both the
// /api/v1/mcp-servers HTTP route and the ManageMcpServerTool agent tool call
// into this service so config sync, validation, and hot-reload logic are never
// duplicated.

import type { MCPServerConfig as SharedMCPServerConfig } from '@koryphaios/shared';
import {
  syncMcpServersToConfig,
  removeMcpServerFromConfig,
  loadProjectMcpServers,
} from '../runtime/config';
import { loadMcpEnvSecrets } from '../security/secret-store';
import { getContext } from '../context';
import { authorizationStatus } from './oauth-service';
import type { McpOAuthGrantSummary } from './oauth-secrets';
import { lookupMcpAuthRequirement } from './auth-requirements';
import type { McpAuthRequirement } from './featured-registry';
import { ValidationError, NotFoundError } from '../errors/types';
import { mcpLog } from '../logger';
import type { McpServerStatus } from './client';
import { mcpProjectScope } from './project-scope';
import {
  safeProviderDiagnostic,
  safeProviderFailureMessage,
} from '../providers/provider-diagnostics';

/** The client-internal config shape (uses `transport` + `name`). */
interface ClientMcpServerConfig {
  name: string;
  transport: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface McpServerInput {
  name: string;
  type: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** Who added this server — surfaced in the UI for audit. */
  addedBy?: 'human' | 'agent';
}

/** Validate a single MCP server config. Throws ValidationError on failure. */
export function validateMcpServerInput(input: McpServerInput): void {
  if (!input.name || typeof input.name !== 'string' || !input.name.trim()) {
    throw new ValidationError('MCP server name is required');
  }
  if (input.name.length > 64) {
    throw new ValidationError('MCP server name must be 64 characters or fewer');
  }
  // Reject names that could collide with tool prefixes or contain path separators.
  if (!/^[a-zA-Z0-9_-]+$/.test(input.name)) {
    throw new ValidationError(
      'MCP server name may only contain letters, numbers, hyphens, and underscores',
    );
  }
  if (input.type !== 'stdio' && input.type !== 'sse') {
    throw new ValidationError('MCP server type must be "stdio" or "sse"');
  }
  if (input.type === 'stdio') {
    if (!input.command || typeof input.command !== 'string' || !input.command.trim()) {
      throw new ValidationError('command is required for stdio MCP servers');
    }
    if (input.args && !Array.isArray(input.args)) {
      throw new ValidationError('args must be an array of strings');
    }
  }
  if (input.type === 'sse') {
    if (!input.url || typeof input.url !== 'string' || !input.url.trim()) {
      throw new ValidationError('url is required for sse MCP servers');
    }
    try {
      const parsed = new URL(input.url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new ValidationError('MCP server url must use http or https');
      }
    } catch {
      throw new ValidationError('MCP server url must be a valid URL');
    }
  }
  if (input.env && (typeof input.env !== 'object' || Array.isArray(input.env))) {
    throw new ValidationError('env must be an object of string key-value pairs');
  }
  if (input.headers && (typeof input.headers !== 'object' || Array.isArray(input.headers))) {
    throw new ValidationError('headers must be an object of string key-value pairs');
  }
}

/** Convert the API/tool input shape into the client-internal config (transport + name). */
export function toClientMcpServerConfig(input: McpServerInput): ClientMcpServerConfig {
  return {
    name: input.name,
    transport: input.type,
    command: input.command,
    args: input.args,
    env: input.env,
    url: input.url,
    headers: input.headers,
  };
}

/** Convert the API/tool input shape into the shared config shape (type, no name). */
export function toSharedMcpServerConfig(input: McpServerInput): SharedMCPServerConfig {
  return {
    type: input.type,
    command: input.command,
    args: input.args,
    env: input.env,
    url: input.url,
    headers: input.headers,
  };
}

/** Read the current mcpServers map from the live config (env-hydrated). */
function readLiveServers(
  projectRoot: string,
): Record<string, SharedMCPServerConfig & { addedBy?: string }> {
  // Never read the launch-root AppContext config for a project-scoped request:
  // doing so made project B see (and overwrite) project A's MCP registrations.
  return loadProjectMcpServers(mcpProjectScope(projectRoot)) as unknown as Record<
    string,
    SharedMCPServerConfig & { addedBy?: string }
  >;
}

/** Convert a stored shared config (keyed by name, uses `type`) back into the
 *  client-internal config shape (uses `transport` + `name`). */
function sharedToClientConfig(name: string, shared: SharedMCPServerConfig): ClientMcpServerConfig {
  return {
    name,
    transport: shared.type,
    command: shared.command,
    args: shared.args,
    env: shared.env,
    url: shared.url,
    headers: shared.headers,
  };
}

/**
 * List all configured servers with live connection status.
 *
 * Remote servers also carry their OAuth state so the settings UI can offer
 * "Authorize" exactly when it is needed, and can tell a token that merely needs
 * refreshing apart from one the user has to re-consent to.
 */
export function listServers(
  projectRoot: string,
): Array<
  McpServerStatus & { configured: boolean; oauth: McpOAuthGrantSummary; auth: McpAuthRequirement }
> {
  projectRoot = mcpProjectScope(projectRoot);
  const { mcpManager } = getContext();
  const liveStatuses = mcpManager.listServers(projectRoot);
  const configured = readLiveServers(projectRoot);
  const liveByName = new Map(liveStatuses.map((s) => [s.name, s]));
  const result: Array<
    McpServerStatus & { configured: boolean; oauth: McpOAuthGrantSummary; auth: McpAuthRequirement }
  > = [];

  const withAuth = (
    name: string,
    status: McpServerStatus,
    configuredFlag: boolean,
  ): McpServerStatus & {
    configured: boolean;
    oauth: McpOAuthGrantSummary;
    auth: McpAuthRequirement;
  } => {
    // A live client knows whether the server rejected us for missing auth.
    const client = mcpManager.getClient(name, projectRoot);
    const summary = authorizationStatus(projectRoot, name);
    const needsAuthorization = status.transport !== 'stdio' && client?.needsAuthorization === true;
    return {
      ...status,
      configured: configuredFlag,
      oauth: {
        ...summary,
        // Report a 401 as "authorized but rejected" so the UI prompts to
        // re-authorize instead of showing a stale connected-looking grant.
        needsAuthorization,
      },
      auth: lookupMcpAuthRequirement(name, configured[name] ?? null),
    };
  };

  // Include configured-but-disconnected servers too.
  for (const name of Object.keys(configured)) {
    const live = liveByName.get(name);
    result.push(
      withAuth(
        name,
        live ?? {
          name,
          transport: configured[name].type,
          connected: false,
          toolCount: 0,
          protocolVersion: 'unknown',
          lastError: 'Not connected (will connect on next tool call)',
        },
        true,
      ),
    );
    liveByName.delete(name);
  }
  // Include any live servers not in config (e.g. bootstrap-added).
  for (const live of liveByName.values()) {
    result.push(withAuth(live.name, live, false));
  }
  return result;
}

/** Public display identity only: never forward MCP credentials/configuration
 * to the transcript. Tool names come from already-discovered catalogs; this
 * read does not connect a server or spawn a CLI. */
export function listToolServerIdentities(projectRoot: string): Array<{ name: string; tools: string[] }> {
  projectRoot = mcpProjectScope(projectRoot);
  const { mcpManager } = getContext();
  const names = new Set([
    ...Object.keys(readLiveServers(projectRoot)),
    ...mcpManager.listServers(projectRoot).map((server) => server.name),
  ]);
  return [...names].map((name) => ({
    name,
    tools: mcpManager.getClient(name, projectRoot)?.availableTools.map((tool) => tool.name) ?? [],
  }));
}

/** Add a new MCP server: validate, persist to config, hot-connect, register tools. */
export async function addServer(
  projectRoot: string,
  input: McpServerInput,
): Promise<McpServerStatus> {
  projectRoot = mcpProjectScope(projectRoot);
  validateMcpServerInput(input);
  const { mcpManager, tools } = getContext();
  const existing = readLiveServers(projectRoot);
  if (existing[input.name]) {
    throw new ValidationError(`An MCP server named "${input.name}" already exists`);
  }
  // Persist to config first (strips env secrets to the secret store).
  const updated = {
    ...existing,
    [input.name]: { ...toSharedMcpServerConfig(input), addedBy: input.addedBy ?? 'human' },
  };
  syncMcpServersToConfig(projectRoot, updated as Record<string, Record<string, unknown>>);
  // Hot-connect and register tools.
  const config = toClientMcpServerConfig(input);
  await mcpManager.addServer(config, tools, projectRoot);
  const status = mcpManager.listServers(projectRoot).find((s) => s.name === input.name);
  mcpLog.info({ server: input.name, addedBy: input.addedBy }, 'MCP server added');
  return (
    status ?? {
      name: input.name,
      transport: input.type,
      connected: false,
      toolCount: 0,
      protocolVersion: 'unknown',
      lastError: 'Connected but status unavailable',
    }
  );
}

/** Update an existing MCP server: validate, persist, hot-reload. */
function mergeMcpSettingsMap(
  saved: Record<string, string> | undefined,
  incoming: Record<string, string> | undefined,
  label: string,
): Record<string, string> | undefined {
  if (incoming === undefined) return saved;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    throw new ValidationError(`${label} must be an object of string key-value pairs`);
  }
  // A supplied empty map intentionally clears the field. Non-empty maps patch
  // individual keys; empty string removes a key without exposing saved values.
  if (Object.keys(incoming).length === 0) return {};
  const merged = { ...saved };
  for (const [key, value] of Object.entries(incoming)) {
    if (typeof value !== 'string') {
      throw new ValidationError(`${label} must be an object of string key-value pairs`);
    }
    if (value === '') delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

/**
 * Mobile clients can only inspect environment key names and server status.
 * Omitted fields in their PUT must retain the current project-scoped values;
 * an explicit []/{} clears a field, and a blank map value removes one key.
 * When changing transports, never carry the old transport's config forward.
 */
export function mergeMcpServerUpdate(
  name: string,
  saved: SharedMCPServerConfig,
  incoming: Omit<McpServerInput, 'name'>,
): McpServerInput {
  if (incoming.type === 'stdio') {
    const previous = saved.type === 'stdio' ? saved : undefined;
    return {
      name,
      type: 'stdio',
      command: incoming.command ?? previous?.command,
      args: incoming.args ?? previous?.args,
      env: mergeMcpSettingsMap(previous?.env, incoming.env, 'env'),
    };
  }
  if (incoming.type === 'sse') {
    const previous = saved.type === 'sse' ? saved : undefined;
    return {
      name,
      type: 'sse',
      url: incoming.url ?? previous?.url,
      headers: mergeMcpSettingsMap(previous?.headers, incoming.headers, 'headers'),
    };
  }
  // Validation below reports the same supported-type error as additions.
  return { ...incoming, name };
}

export async function updateServer(
  projectRoot: string,
  name: string,
  input: Omit<McpServerInput, 'name'>,
): Promise<McpServerStatus> {
  projectRoot = mcpProjectScope(projectRoot);
  const { mcpManager, tools } = getContext();
  const existing = readLiveServers(projectRoot);
  if (!existing[name]) {
    throw new NotFoundError('MCP server', name);
  }
  const fullInput = mergeMcpServerUpdate(name, existing[name], input);
  validateMcpServerInput(fullInput);
  const updated = {
    ...existing,
    [name]: { ...toSharedMcpServerConfig(fullInput), addedBy: existing[name].addedBy ?? 'human' },
  };
  syncMcpServersToConfig(projectRoot, updated as Record<string, Record<string, unknown>>);
  const config = toClientMcpServerConfig(fullInput);
  await mcpManager.reloadServer(name, config, tools, projectRoot);
  const status = mcpManager.listServers(projectRoot).find((s) => s.name === name);
  mcpLog.info({ server: name }, 'MCP server updated');
  return (
    status ?? {
      name,
      transport: input.type,
      connected: false,
      toolCount: 0,
      protocolVersion: 'unknown',
      lastError: 'Reloaded but status unavailable',
    }
  );
}

/** Remove an MCP server: shutdown, unregister tools, remove from config + secrets. */
export async function removeServer(projectRoot: string, name: string): Promise<void> {
  projectRoot = mcpProjectScope(projectRoot);
  const { mcpManager, tools } = getContext();
  const existing = readLiveServers(projectRoot);
  if (!existing[name]) {
    throw new NotFoundError('MCP server', name);
  }
  await mcpManager.removeServer(name, tools, projectRoot);
  removeMcpServerFromConfig(projectRoot, name);
  mcpLog.info({ server: name }, 'MCP server removed');
}

/** Test-connect to a server: connect (or reconnect) and return tool list. */
export async function testServer(
  projectRoot: string,
  name: string,
): Promise<{ connected: boolean; tools: string[]; protocolVersion: string; error?: string }> {
  projectRoot = mcpProjectScope(projectRoot);
  const { mcpManager, tools } = getContext();
  const existing = readLiveServers(projectRoot);
  if (!existing[name]) {
    throw new NotFoundError('MCP server', name);
  }
  // Reload to force a fresh connection attempt.
  const config = sharedToClientConfig(name, existing[name]);
  try {
    await mcpManager.reloadServer(name, config, tools, projectRoot);
    const client = mcpManager.getClient(name, projectRoot);
    if (!client) {
      return {
        connected: false,
        tools: [],
        protocolVersion: 'unknown',
        error: 'No client after reload',
      };
    }
    return {
      connected: client.isConnected,
      tools: client.availableTools.map((t) => t.name),
      protocolVersion: client.negotiatedProtocolVersion,
    };
  } catch (err: unknown) {
    const diagnostic = safeProviderDiagnostic('mcp', 'spawn', err);
    return {
      connected: false,
      tools: [],
      protocolVersion: 'unknown',
      error: safeProviderFailureMessage('mcp', diagnostic),
    };
  }
}

/** Force-reload a server (reconnect with current config). */
export async function reloadServer(projectRoot: string, name: string): Promise<McpServerStatus> {
  projectRoot = mcpProjectScope(projectRoot);
  const { mcpManager, tools } = getContext();
  const existing = readLiveServers(projectRoot);
  if (!existing[name]) {
    throw new NotFoundError('MCP server', name);
  }
  await mcpManager.reloadServer(
    name,
    sharedToClientConfig(name, existing[name]),
    tools,
    projectRoot,
  );
  const status = mcpManager.listServers(projectRoot).find((s) => s.name === name);
  return (
    status ?? {
      name,
      transport: existing[name].type,
      connected: false,
      toolCount: 0,
      protocolVersion: 'unknown',
      lastError: 'Reloaded but status unavailable',
    }
  );
}

/** Get the env secret keys for a server (values are masked — UI display only). */
export function getServerEnvKeys(projectRoot: string, name: string): string[] {
  const secrets = loadMcpEnvSecrets(mcpProjectScope(projectRoot));
  return Object.keys(secrets[name] ?? {});
}

/** Discover configured servers for the exact project when a turn/catalog first
 * needs them. Failed probes are negative-cached by the manager. */
export async function ensureProjectMcpServers(projectRoot: string): Promise<void> {
  projectRoot = mcpProjectScope(projectRoot);
  const configured = readLiveServers(projectRoot);
  if (Object.keys(configured).length === 0) return;
  const { mcpManager, tools } = getContext();
  await mcpManager.ensureConfiguredServers(
    Object.entries(configured).map(([name, config]) => sharedToClientConfig(name, config)),
    tools,
    projectRoot,
  );
}
