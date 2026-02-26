/**
 * MCP Tool Bridge — registers MCP-discovered tools into the main ToolRegistry.
 *
 * This is a convenience wrapper around the existing MCPToolWrapper / MCPManager
 * flow, useful when you have a connected MCPClient and want to register its
 * tools without going through the full MCPManager lifecycle.
 */

import { mcpLog } from "../logger";
import { ToolRegistry } from "../tools/registry";
import { MCPClient, MCPToolWrapper } from "./client";

/**
 * Discover tools from a connected MCPClient and register each one in the
 * ToolRegistry with an `mcp_<server>_` prefix.
 *
 * @returns The number of tools successfully registered.
 */
export async function registerMCPToolsInRegistry(
  registry: ToolRegistry,
  client: MCPClient,
): Promise<number> {
  const tools = client.availableTools;
  if (tools.length === 0) {
    mcpLog.info({ server: client.name }, "MCP server exposes no tools — nothing to register");
    return 0;
  }

  let registered = 0;
  for (const toolDef of tools) {
    try {
      const wrapper = new MCPToolWrapper(client, toolDef);
      registry.register(wrapper);
      registered++;
      mcpLog.info({ tool: wrapper.name }, "Registered MCP tool via bridge");
    } catch (err: any) {
      mcpLog.error({ tool: toolDef.name, err: err.message }, "Failed to register MCP tool");
    }
  }

  mcpLog.info({ server: client.name, count: registered }, "MCP tool bridge registration complete");
  return registered;
}
