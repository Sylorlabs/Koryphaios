import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderName } from '@koryphaios/shared';
import type { CliBridgeContext, CliMcpServerConfig } from './cli-bridge';
import { getKoryBridgeGrant } from './bridge-grant';

/** Build the one allowed MCP server for a managed native CLI turn. The private
 * grant is scoped to this Kory session, role, and MCP actions; it never enters
 * the prompt or process arguments. */
export function buildKoryCliMcpConfig(
  ctx: CliBridgeContext,
  provider: ProviderName,
): CliMcpServerConfig[] | null {
  if (!ctx.sessionId) return null;
  const configuredScript = process.env.KORY_MCP_BRIDGE_SCRIPT?.trim();
  const bundledScript = join(import.meta.dir, 'kory-mcp-bridge.ts');
  const script = configuredScript || (existsSync(bundledScript) ? bundledScript : '');
  if (!script) return null;

  const port = process.env.KORYPHAIOS_PORT ?? '3001';
  const host = process.env.KORYPHAIOS_HOST ?? '127.0.0.1';
  const grant = ctx.bridgeGrantLease
    ? ctx.bridgeGrantLease.grant(['mcp:catalog', 'mcp:execute'])
    : getKoryBridgeGrant(ctx.sessionId, ctx.role, ['mcp:catalog', 'mcp:execute']);
  return [
    {
      name: 'kory',
      command: process.env.KORY_MCP_BRIDGE_COMMAND?.trim() || process.execPath,
      args: [
        script,
        '--provider',
        provider,
      ],
      env: {
        KORY_BACKEND_URL: `http://${host}:${port}`,
        KORY_BRIDGE_AUTH_FILE: grant.path,
      },
      transport: 'stdio',
    },
  ];
}

export function serializeKoryMcpServers(
  servers: CliMcpServerConfig[],
  cline = false,
): Record<string, unknown> {
  const mcpServers: Record<string, unknown> = {};
  for (const server of servers) {
    mcpServers[server.name] = {
      command: server.command,
      args: server.args,
      env: server.env ?? {},
      ...(cline ? { disabled: false, autoApprove: [] } : {}),
    };
  }
  return { mcpServers };
}
