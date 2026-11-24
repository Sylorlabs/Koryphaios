import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderName } from '@koryphaios/shared';
import type { CliBridgeContext, CliMcpServerConfig } from './cli-bridge';
import { getKoryBridgeGrant } from './bridge-grant';

/** Locate the kory MCP bridge entry point. Source runs sit next to the .ts;
 * packaged builds ship only the bundled .js beside server.js. An explicit
 * KORY_MCP_BRIDGE_SCRIPT always wins. `dir` is an injection seam for tests. */
export function resolveKoryBridgeScript(dir: string = import.meta.dir): string | null {
  const configured = process.env.KORY_MCP_BRIDGE_SCRIPT?.trim();
  if (configured) return configured;
  for (const name of ['kory-mcp-bridge.ts', 'kory-mcp-bridge.js']) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** The managed turn can proceed without the bridge only in research-only
 * flows; a session-scoped turn with no bridge script must fail closed rather
 * than run the CLI silently tool-less. */
export function koryBridgeUnavailableError(provider: ProviderName): string {
  return `${provider}: Kory tool bridge is unavailable (bridge script not found); refusing to run without tools.`;
}

/** Build the one allowed MCP server for a managed native CLI turn. The private
 * grant is scoped to this Kory session, role, and MCP actions; it never enters
 * the prompt or process arguments. */
export function buildKoryCliMcpConfig(
  ctx: CliBridgeContext,
  provider: ProviderName,
): CliMcpServerConfig[] | null {
  if (!ctx.sessionId) return null;
  const script = resolveKoryBridgeScript();
  if (!script) return null;

  const port = process.env.KORYPHAIOS_PORT ?? '3001';
  const host = process.env.KORYPHAIOS_HOST ?? '127.0.0.1';
  const backendUrl = process.env.KORY_BACKEND_URL?.trim() || `http://${host}:${port}`;
  const grant = ctx.bridgeGrantLease
    ? ctx.bridgeGrantLease.grant(['mcp:catalog', 'mcp:execute'])
    : getKoryBridgeGrant(ctx.sessionId, ctx.role, ['mcp:catalog', 'mcp:execute']);
  return [
    {
      name: 'kory',
      command: process.env.KORY_MCP_BRIDGE_COMMAND?.trim() || process.execPath,
      args: [script, '--provider', provider],
      env: {
        KORY_BACKEND_URL: backendUrl,
        KORY_BRIDGE_AUTH_FILE: grant.path,
      },
      transport: 'stdio',
    },
  ];
}

export function serializeKoryMcpServers(servers: CliMcpServerConfig[]): Record<string, unknown> {
  const mcpServers: Record<string, unknown> = {};
  for (const server of servers) {
    mcpServers[server.name] = {
      command: server.command,
      args: server.args,
      env: server.env ?? {},
      ...(server.transport === 'stdio' ? { type: 'stdio' } : { type: server.transport }),
    };
  }
  return { mcpServers };
}
