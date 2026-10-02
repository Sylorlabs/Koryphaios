// Agent Messages store — inter-agent mailbox (AgentMail) for the UI.
// Tracks messages involving the active session, fed by the `agent.message`
// WebSocket event and hydrated from /api/v1/agent-messages.

import type { AgentMessage } from '@koryphaios/shared';

const messagesBySession = $state<Record<string, AgentMessage[]>>({});
const unreadBySession = $state<Record<string, number>>({});
let hydratedSessions = $state<Record<string, true>>({});

function mergeMessage(list: AgentMessage[] | undefined, message: AgentMessage): AgentMessage[] {
  const existing = list ?? [];
  const index = existing.findIndex((candidate) => candidate.id === message.id);
  if (index >= 0) {
    const next = [...existing];
    next[index] = message;
    return next;
  }
  return [message, ...existing];
}

/** Insert or refresh a message for both sides of the conversation. */
export function upsertAgentMessage(message: AgentMessage, opts: { unread?: boolean } = {}): void {
  for (const sessionId of new Set([message.fromSessionId, message.toSessionId])) {
    if (!sessionId) continue;
    messagesBySession[sessionId] = mergeMessage(messagesBySession[sessionId], message);
    if (opts.unread) {
      unreadBySession[sessionId] = (unreadBySession[sessionId] ?? 0) + 1;
    }
  }
}

export function markAgentMessagesRead(sessionId: string): void {
  delete unreadBySession[sessionId];
}

export function agentMessagesFor(sessionId: string): AgentMessage[] {
  return messagesBySession[sessionId] ?? [];
}

export function agentMessageUnreadCount(sessionId: string): number {
  return unreadBySession[sessionId] ?? 0;
}

export function hasPendingAgentApproval(sessionId: string): boolean {
  return agentMessagesFor(sessionId).some((message) => message.status === 'pending_approval');
}

/** Pull the durable history once per session (WS covers live updates). */
export async function hydrateAgentMessages(sessionId: string): Promise<void> {
  if (!sessionId || hydratedSessions[sessionId]) return;
  hydratedSessions[sessionId] = true;
  try {
    const { apiFetch } = await import('$lib/api.svelte');
    const response = await apiFetch(
      `/api/v1/agent-messages?sessionId=${encodeURIComponent(sessionId)}`,
    );
    const payload = (await response.json()) as {
      ok?: boolean;
      data?: { messages?: AgentMessage[] };
    };
    if (payload.ok && payload.data?.messages) {
      let list: AgentMessage[] = [];
      for (const message of payload.data.messages) {
        list = mergeMessage(list, message);
      }
      messagesBySession[sessionId] = list;
    }
  } catch {
    // The panel degrades to WS-only updates when hydration fails.
    delete hydratedSessions[sessionId];
  }
}

export async function decideAgentMessage(messageId: string, approved: boolean): Promise<void> {
  const { apiFetch } = await import('$lib/api.svelte');
  const response = await apiFetch(`/api/v1/agent-messages/${messageId}/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ approved }),
  });
  const payload = (await response.json()) as {
    ok?: boolean;
    data?: { message?: AgentMessage };
  };
  if (payload.ok && payload.data?.message) {
    upsertAgentMessage(payload.data.message);
  }
}
