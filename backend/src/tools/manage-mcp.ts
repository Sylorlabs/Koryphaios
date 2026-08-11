// ManageMcpServerTool — lets the manager agent add/remove/update/test MCP
// servers at runtime. Mutations go through the shared mcpServerService so the
// agent and the /api/v1/mcp-servers route use identical config-sync, env-secret,
// and hot-reload logic.
//
// Gate policy (per user decision):
//   • Manager-only (role: 'manager').
//   • Host approval is required in guarded/custom modes because adding an MCP
//     server grants a new process/network tool surface to future turns.
//   • Plan mode blocks mutations (add/update/remove) — only list/test/reload
//     are read-only enough for plan mode. This keeps a planning agent from
//     wiring up new tool surfaces before the user approves the plan.

import type { Tool, ToolCallInput, ToolCallOutput, ToolContext } from './registry';
import {
  listServers,
  addServer,
  updateServer,
  removeServer,
  testServer,
  reloadServer,
  type McpServerInput,
} from '../mcp/server-service';
import { KoryphaiosError } from '../errors/types';

function isPlanMode(ctx: ToolContext): boolean {
  return ctx.permissionPolicy?.mode === 'plan';
}

function formatStatusLine(s: {
  name: string;
  transport: string;
  connected: boolean;
  toolCount: number;
  protocolVersion: string;
  lastError?: string;
  configured?: boolean;
}): string {
  const state = s.connected ? 'connected' : 'disconnected';
  const err = s.lastError ? ` — ${s.lastError}` : '';
  return `  • ${s.name} (${s.transport}, ${s.protocolVersion}): ${state}, ${s.toolCount} tool(s)${err}`;
}

export class ManageMcpServerTool implements Tool {
  readonly name = 'manage_mcp_server';
  readonly role = 'manager' as const;
  readonly description =
    'Manage user-pluggable MCP servers: list, add, update, remove, test-connect, or reload. ' +
    'Adding an MCP server exposes its tools to all agents as mcp_<server>_<tool>. ' +
    'Env vars (including tokens) are stored in the 0600 secret store, never in koryphaios.json. ' +
    'Mutations are blocked in plan mode — use action mode to add or remove servers.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'add', 'update', 'remove', 'test', 'reload'],
        description: 'What to do with the MCP server',
      },
      name: {
        type: 'string',
        maxLength: 64,
        description: 'Server name (letters, numbers, hyphens, underscores only)',
      },
      type: {
        type: 'string',
        enum: ['stdio', 'sse'],
        description: 'Transport type (required for add/update)',
      },
      command: {
        type: 'string',
        description: 'Executable command (stdio only)',
      },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: 'Command arguments (stdio only)',
      },
      env: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'Environment variables — stored in the 0600 secret store, not koryphaios.json',
      },
      url: {
        type: 'string',
        description: 'Server URL (sse only)',
      },
      headers: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'HTTP headers (sse only)',
      },
    },
    required: ['action'],
  };

  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const start = performance.now();
    const action = call.input.action as string | undefined;
    const name = call.input.name as string | undefined;
    const projectRoot = ctx.workingDirectory;

    try {
      switch (action) {
        case 'list': {
          const servers = listServers(projectRoot);
          if (servers.length === 0) {
            return {
              callId: call.id,
              name: this.name,
              output: 'No MCP servers configured. Use action "add" to add one.',
              isError: false,
              durationMs: performance.now() - start,
            };
          }
          const lines = servers.map(formatStatusLine);
          return {
            callId: call.id,
            name: this.name,
            output: `MCP servers (${servers.length}):\n${lines.join('\n')}`,
            isError: false,
            durationMs: performance.now() - start,
          };
        }

        case 'add': {
          if (isPlanMode(ctx)) {
            return {
              callId: call.id,
              name: this.name,
              output: 'Blocked: cannot add MCP servers in plan mode. Switch to action mode.',
              isError: true,
              durationMs: performance.now() - start,
            };
          }
          if (!name) return this.missingField(call.id, 'name', start);
          const input = this.buildInput(call.input, name, 'agent');
          const status = await addServer(projectRoot, input);
          return {
            callId: call.id,
            name: this.name,
            output: `Added MCP server "${name}" (${status.transport}, ${status.protocolVersion}): ${status.connected ? 'connected' : 'disconnected'}, ${status.toolCount} tool(s).${status.lastError ? ` ${status.lastError}` : ''}`,
            isError: false,
            durationMs: performance.now() - start,
          };
        }

        case 'update': {
          if (isPlanMode(ctx)) {
            return {
              callId: call.id,
              name: this.name,
              output: 'Blocked: cannot update MCP servers in plan mode. Switch to action mode.',
              isError: true,
              durationMs: performance.now() - start,
            };
          }
          if (!name) return this.missingField(call.id, 'name', start);
          const input = this.buildInput(call.input, name, 'agent');
          const status = await updateServer(projectRoot, name, input);
          return {
            callId: call.id,
            name: this.name,
            output: `Updated MCP server "${name}" (${status.transport}, ${status.protocolVersion}): ${status.connected ? 'connected' : 'disconnected'}, ${status.toolCount} tool(s).`,
            isError: false,
            durationMs: performance.now() - start,
          };
        }

        case 'remove': {
          if (isPlanMode(ctx)) {
            return {
              callId: call.id,
              name: this.name,
              output: 'Blocked: cannot remove MCP servers in plan mode. Switch to action mode.',
              isError: true,
              durationMs: performance.now() - start,
            };
          }
          if (!name) return this.missingField(call.id, 'name', start);
          await removeServer(projectRoot, name);
          return {
            callId: call.id,
            name: this.name,
            output: `Removed MCP server "${name}" and purged its env secrets.`,
            isError: false,
            durationMs: performance.now() - start,
          };
        }

        case 'test': {
          if (!name) return this.missingField(call.id, 'name', start);
          const result = await testServer(projectRoot, name);
          if (result.connected) {
            return {
              callId: call.id,
              name: this.name,
              output: `MCP server "${name}" connected (${result.protocolVersion}). Tools: ${result.tools.length > 0 ? result.tools.join(', ') : 'none'}.`,
              isError: false,
              durationMs: performance.now() - start,
            };
          }
          return {
            callId: call.id,
            name: this.name,
            output: `MCP server "${name}" failed to connect: ${result.error ?? 'unknown error'}`,
            isError: true,
            durationMs: performance.now() - start,
          };
        }

        case 'reload': {
          if (!name) return this.missingField(call.id, 'name', start);
          const status = await reloadServer(projectRoot, name);
          return {
            callId: call.id,
            name: this.name,
            output: `Reloaded MCP server "${name}" (${status.transport}, ${status.protocolVersion}): ${status.connected ? 'connected' : 'disconnected'}, ${status.toolCount} tool(s).${status.lastError ? ` ${status.lastError}` : ''}`,
            isError: false,
            durationMs: performance.now() - start,
          };
        }

        default:
          return {
            callId: call.id,
            name: this.name,
            output: `Error: unknown action "${action}". Valid actions: list, add, update, remove, test, reload.`,
            isError: true,
            durationMs: performance.now() - start,
          };
      }
    } catch (err: unknown) {
      const message =
        err instanceof KoryphaiosError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      return {
        callId: call.id,
        name: this.name,
        output: `MCP server management error: ${message}`,
        isError: true,
        durationMs: performance.now() - start,
      };
    }
  }

  private buildInput(
    input: Record<string, unknown>,
    name: string,
    addedBy: 'human' | 'agent',
  ): McpServerInput {
    return {
      name,
      type: input.type as 'stdio' | 'sse',
      command: input.command as string | undefined,
      args: input.args as string[] | undefined,
      env: input.env as Record<string, string> | undefined,
      url: input.url as string | undefined,
      headers: input.headers as Record<string, string> | undefined,
      addedBy,
    };
  }

  private missingField(callId: string, field: string, start: number): ToolCallOutput {
    return {
      callId,
      name: this.name,
      output: `Error: "${field}" is required for this action.`,
      isError: true,
      durationMs: performance.now() - start,
    };
  }
}
