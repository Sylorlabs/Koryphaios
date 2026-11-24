export const OPEN_AGENT_THREAD_EVENT = 'kory:open-agent-thread';
export interface AgentThreadNavigation {
  sessionId: string;
  agentId: string;
}

export function openAgentThread(sessionId: string, agentId: string): void {
  window.dispatchEvent(
    new CustomEvent<AgentThreadNavigation>(OPEN_AGENT_THREAD_EVENT, {
      detail: { sessionId, agentId },
    }),
  );
}
