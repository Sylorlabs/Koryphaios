import type { WSMessage } from '@koryphaios/shared';
import type { WSManager } from './ws/ws-manager';

const MAX_REPLY_LENGTH = 256_000;
const MAX_AGENTS = 32;

/** Project only the hosted chat's answer/status events onto the relay feed. */
export function startRemoteInstanceEvents(
  sessionId: string,
  broadcast: (event: Record<string, unknown>) => void,
  events: Pick<WSManager, 'onSessionEvent'>,
): () => Promise<void> {
  const replies = new Map<string, string>();
  let runRevision = -1;
  const flush = (agentId: string) => {
    const content = replies.get(agentId);
    replies.delete(agentId);
    if (content) broadcast({ type: 'chat', from: 'agent', content });
  };
  const consume = (message: WSMessage) => {
    if (message.sessionId !== sessionId || message.replayed) return;
    if (!message.payload || typeof message.payload !== 'object') return;
    const payload = message.payload as Record<string, unknown>;
    if (message.type === 'run.state') {
      const snapshot = payload.snapshot as Record<string, unknown> | undefined;
      if (!snapshot || typeof snapshot.revision !== 'number' || snapshot.revision <= runRevision)
        return;
      runRevision = snapshot.revision;
      if (typeof snapshot.phase === 'string') {
        if (snapshot.status === 'terminal') for (const id of replies.keys()) flush(id);
        broadcast({ type: 'agent-status', status: `Remote run: ${snapshot.phase}` });
      }
      return;
    }
    if (message.type === 'system.error') {
      broadcast({ type: 'agent-status', status: 'Remote run: error' });
      const error = typeof payload.error === 'string' ? payload.error : payload.message;
      if (typeof error === 'string')
        broadcast({ type: 'chat', from: 'agent', content: error.slice(0, MAX_REPLY_LENGTH) });
      return;
    }
    const agentId = typeof payload.agentId === 'string' ? payload.agentId : message.agentId;
    if (!agentId) return;
    if (message.type === 'stream.delta' && typeof payload.content === 'string') {
      if (!replies.has(agentId) && replies.size >= MAX_AGENTS) return;
      const current = replies.get(agentId) ?? '';
      const next = current + payload.content;
      // Bounded chunks rather than truncation, preserving long answers.
      for (let offset = 0; offset + MAX_REPLY_LENGTH <= next.length; offset += MAX_REPLY_LENGTH) {
        broadcast({
          type: 'chat',
          from: 'agent',
          content: next.slice(offset, offset + MAX_REPLY_LENGTH),
        });
      }
      replies.set(
        agentId,
        next.slice(Math.floor(next.length / MAX_REPLY_LENGTH) * MAX_REPLY_LENGTH),
      );
    } else if (message.type === 'stream.clear_content') {
      replies.delete(agentId);
    } else if (message.type === 'stream.complete') {
      flush(agentId);
    } else if (message.type === 'agent.status' && typeof payload.status === 'string') {
      if (['done', 'error', 'idle'].includes(payload.status)) flush(agentId);
      broadcast({ type: 'agent-status', status: `${agentId}: ${payload.status}` });
    }
  };
  const unsubscribe = events.onSessionEvent(sessionId, consume);
  return async () => {
    unsubscribe();
    replies.clear();
  };
}
