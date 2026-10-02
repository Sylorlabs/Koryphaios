// Messaging Types
// Domain: Inter-agent messaging (AgentMail) between sessions/projects

/** Role of the agent that sent or receives an inter-agent message. */
export type AgentMessagePartyRole = 'manager' | 'worker';

/** Delivery lifecycle of an inter-agent message. */
export type AgentMessageStatus =
  'queued' | 'pending_approval' | 'delivered' | 'answered' | 'declined' | 'failed';

/** A persisted inter-agent message routed through the shared mailbox. */
export interface AgentMessage {
  id: string;
  threadId: string;
  /** Session that authored the message. */
  fromSessionId: string;
  /** Agent id within the sending session (e.g. `kory-manager`, `worker-ab12cd34`). */
  fromAgentId: string;
  fromRole: AgentMessagePartyRole;
  /** Human-facing sender label, e.g. "(my-app) manager" or "backend agent". */
  fromLabel: string;
  /** Session the message is addressed to. */
  toSessionId: string;
  /** Optional target agent inside the receiving session. Omitted = session manager. */
  toAgentId?: string;
  toRole: AgentMessagePartyRole;
  /** Human-facing target label, e.g. "(other-project) manager" or "backend agent". */
  toLabel: string;
  /** True when sender and target live in different project folders. */
  crossProject: boolean;
  /** True when a worker asked its manager to forward a message to another manager. */
  isRelayRequest: boolean;
  subject: string;
  body: string;
  /** Set when this message replies to an earlier message. */
  replyToMessageId?: string;
  status: AgentMessageStatus;
  /** Reason attached to declined/failed terminal states. */
  statusReason?: string;
  /** Reply text recorded when the target answers via replyToMessageId. */
  reply?: string;
  createdAt: number;
  deliveredAt?: number;
  answeredAt?: number;
}

/** Payload emitted on the `agent.message` WebSocket event for live UI updates. */
export interface AgentMessageEventPayload {
  message: AgentMessage;
}
