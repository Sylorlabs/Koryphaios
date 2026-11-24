import type { McpToolServerIdentity } from '$lib/stores/mcp-tool-registry.svelte';

/** Resolve registered tool aliases without guessing where an underscore in a
 * server name ends and one in a tool name begins. Catalog evidence takes
 * precedence; disconnected servers still have their configured names. */
export function resolveRegisteredMcpTool(
  name: string,
  servers: readonly McpToolServerIdentity[],
): { server: string; tool: string } | null {
  const catalogMatches = servers.flatMap((server) =>
    (server.tools ?? [])
      .filter(
        (tool) => name === `mcp_${server.name}_${tool}` || name === `mcp__${server.name}__${tool}`,
      )
      .map((tool) => ({ server: server.name, tool })),
  );
  if (catalogMatches.length === 1) return catalogMatches[0];
  if (catalogMatches.length > 1) return null;
  const prefixes = servers
    .flatMap((server) =>
      [`mcp_${server.name}_`, `mcp__${server.name}__`].map((prefix) => ({
        server: server.name,
        prefix,
      })),
    )
    .sort((a, b) => b.prefix.length - a.prefix.length);
  const match = prefixes.find(
    ({ prefix }) => name.startsWith(prefix) && name.length > prefix.length,
  );
  return match ? { server: match.server, tool: name.slice(match.prefix.length) } : null;
}
