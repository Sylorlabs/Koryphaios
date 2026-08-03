import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderName } from '@koryphaios/shared';
import { localAuth } from '../auth/local-auth';
import { buildLocalBearerToken } from '../auth/local-route-auth';
import type { CliBridgeContext, CliMcpServerConfig } from './cli-bridge';

const BRIDGE_AUTH_MAX_AGE_MS = 23 * 60 * 60 * 1000;
const bridgeAuth = new Map<string, { bearer: string; createdAt: number }>();

function scopedBearer(sessionId: string, role: string): string {
  const key = `${sessionId}:${role}`;
  const cached = bridgeAuth.get(key);
  if (cached && Date.now() - cached.createdAt < BRIDGE_AUTH_MAX_AGE_MS) return cached.bearer;
  const auth = localAuth.createSession([`mcp:${sessionId}:${role}`]);
  const bearer = buildLocalBearerToken(auth);
  bridgeAuth.set(key, { bearer, createdAt: Date.now() });
  return bearer;
}

/** Build the one allowed MCP server for a managed native CLI turn. The bearer
 * token is scoped to this Kory session and role; it never enters the prompt. */
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
  return [
    {
      name: 'kory',
      command: process.env.KORY_MCP_BRIDGE_COMMAND?.trim() || process.execPath,
      args: [
        script,
        '--session-id',
        ctx.sessionId,
        '--role',
        ctx.role,
        '--provider',
        provider,
        '--working-dir',
        ctx.workingDirectory,
      ],
      env: {
        KORY_BACKEND_URL: `http://${host}:${port}`,
        KORY_LOCAL_AUTH: scopedBearer(ctx.sessionId, ctx.role),
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
