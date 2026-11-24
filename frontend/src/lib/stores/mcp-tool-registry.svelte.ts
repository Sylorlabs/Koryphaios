import { onSessionRemoved, onSessionsRemoved } from './session-removal';

export interface McpToolServerIdentity {
  name: string;
  tools?: string[];
}

// Names are scoped to the chat's source project. Using whichever project's
// settings panel was opened last could mislabel another chat's MCP calls.
const registries = new Map<string, McpToolServerIdentity[]>();
let revision = $state(0);
onSessionRemoved((sessionId) => {
  if (registries.delete(sessionId)) revision++;
});
onSessionsRemoved((sessionIds) => {
  let changed = false;
  for (const sessionId of sessionIds) changed = registries.delete(sessionId) || changed;
  if (changed) revision++;
});

export function setSessionMcpToolRegistry(
  sessionId: string,
  servers: McpToolServerIdentity[],
): void {
  registries.set(
    sessionId,
    servers.map((server) => ({
      name: server.name,
      tools: server.tools ? [...server.tools] : undefined,
    })),
  );
  revision++;
}

export function getSessionMcpToolRegistry(sessionId: unknown): readonly McpToolServerIdentity[] {
  void revision;
  return typeof sessionId === 'string' ? (registries.get(sessionId) ?? []) : [];
}
