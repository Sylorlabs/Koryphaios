import { deriveToolContext, type Tool, type ToolContext, type ToolCallInput, type ToolCallOutput, type ToolRegistry } from './registry';
import { ensureProjectMcpServers } from '../mcp/server-service';
import { mcpProjectScope } from '../mcp/project-scope';
import { MCP_DISCOVERY_SCHEMA, MCP_INVOCATION_SCHEMA } from './external-mcp-schemas';

/** A stable discovery surface for CLIs that cache their startup MCP catalog. */
export class ListMcpToolsTool implements Tool {
  readonly name = 'list_mcp_tools';
  readonly role = 'worker' as const;
  readonly description = 'Discover this project’s custom MCP tools and their exact input schemas. Use after adding/reloading a server or when a CLI tool list is stale.';
  readonly inputSchema = MCP_DISCOVERY_SCHEMA;
  constructor(private registry: ToolRegistry) {}
  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const root = mcpProjectScope(ctx.settingsRoot ?? ctx.workingDirectory);
    await ensureProjectMcpServers(root);
    const tools = this.registry.getAll(root).filter((tool) => tool.mcpServerName &&
      (!call.input.server_name || tool.mcpServerName === call.input.server_name) &&
      this.registry.isAllowedForRole(tool.name, ctx.callerRole ?? 'manager', root));
    return { callId: call.id, name: this.name, isError: false, durationMs: 0, output: JSON.stringify(tools.map((tool) => ({
      server_name: tool.mcpServerName, tool_name: tool.mcpToolName, name: tool.name,
      description: tool.description, inputSchema: tool.inputSchema,
    }))) };
  }
}

/** Only dispatch scoped external tools. The nested execution still owns schema
 * validation, role checks, tool-specific blocks/approvals and error handling. */
export class InvokeMcpTool implements Tool {
  readonly name = 'invoke_mcp_tool';
  readonly role = 'worker' as const;
  readonly description = 'Invoke a custom MCP tool discovered with list_mcp_tools. Works for newly added tools during an active CLI turn. Pass its registered server_name, exact tool_name and arguments.';
  readonly inputSchema = MCP_INVOCATION_SCHEMA;
  constructor(private registry: ToolRegistry) {}
  async run(ctx: ToolContext, call: ToolCallInput): Promise<ToolCallOutput> {
    const root = mcpProjectScope(ctx.settingsRoot ?? ctx.workingDirectory);
    await ensureProjectMcpServers(root);
    const tool = this.registry.getAll(root).find((candidate) =>
      candidate.mcpServerName === call.input.server_name && candidate.mcpToolName === call.input.tool_name);
    if (!tool) return { callId: call.id, name: this.name, isError: true, durationMs: 0, output: 'MCP tool is not registered for this project. Use list_mcp_tools to discover available tools.' };
    const result = await this.registry.execute(deriveToolContext(ctx, {
      validateToolInput: true,
      // Granting the stable dispatcher permits newly discovered names. Current
      // role and per-tool permission policy still run on the nested invocation.
      ...(ctx.allowedToolNames?.has(this.name) ? {
        allowedToolNames: new Set([...ctx.allowedToolNames, tool.name]),
      } : {}),
    }), { id: `${call.id}:mcp`, name: tool.name, input: call.input.arguments as Record<string, unknown> });
    return { ...result, callId: call.id, name: this.name };
  }
}
