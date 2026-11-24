export type AgentSteeringStatus =
  'queued' | 'dispatching' | 'running' | 'completed' | 'cancelled' | 'failed';

export interface AgentSteeringCommand {
  id: string;
  sessionId: string;
  agentId: string;
  content: string;
  model?: string;
  reasoningLevel?: string;
  status: AgentSteeringStatus;
  position: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
}
