// Agent Message Store — durable inter-agent mailbox (AgentMail).
// Persists every message crossing session/project boundaries so both sides,
// and the user, can audit the full conversation.

import { and, asc, desc, eq, inArray, ne, or } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from '../db';
import { agentMessages } from '../db/schema';
import type { AgentMessage, AgentMessageStatus } from '@koryphaios/shared';

type AgentMessageRow = typeof agentMessages.$inferSelect;

function toAgentMessage(row: AgentMessageRow): AgentMessage {
  return {
    id: row.id,
    threadId: row.threadId,
    fromSessionId: row.fromSessionId,
    fromAgentId: row.fromAgentId,
    fromRole: row.fromRole,
    fromLabel: row.fromLabel,
    toSessionId: row.toSessionId,
    ...(row.toAgentId ? { toAgentId: row.toAgentId } : {}),
    toRole: row.toRole,
    toLabel: row.toLabel,
    crossProject: Boolean(row.crossProject),
    isRelayRequest: Boolean(row.isRelayRequest),
    subject: row.subject,
    body: row.body,
    ...(row.replyToMessageId ? { replyToMessageId: row.replyToMessageId } : {}),
    status: row.status,
    ...(row.statusReason ? { statusReason: row.statusReason } : {}),
    ...(row.reply ? { reply: row.reply } : {}),
    createdAt: row.createdAt.getTime(),
    ...(row.deliveredAt ? { deliveredAt: row.deliveredAt.getTime() } : {}),
    ...(row.answeredAt ? { answeredAt: row.answeredAt.getTime() } : {}),
  };
}

export interface InsertAgentMessageInput {
  fromSessionId: string;
  fromAgentId: string;
  fromRole: 'manager' | 'worker';
  fromLabel: string;
  toSessionId: string;
  toAgentId?: string;
  toRole: 'manager' | 'worker';
  toLabel: string;
  crossProject: boolean;
  isRelayRequest?: boolean;
  subject: string;
  body: string;
  replyToMessageId?: string;
  status: AgentMessageStatus;
  statusReason?: string;
}

/** New messages in an ongoing thread inherit the thread id of the parent. */
export async function insertAgentMessage(input: InsertAgentMessageInput): Promise<AgentMessage> {
  const id = nanoid(16);
  let threadId = id;
  if (input.replyToMessageId) {
    const [parent] = await db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.id, input.replyToMessageId))
      .limit(1);
    if (parent) threadId = parent.threadId;
  }
  const now = new Date();
  await db.insert(agentMessages).values({
    id,
    threadId,
    fromSessionId: input.fromSessionId,
    fromAgentId: input.fromAgentId,
    fromRole: input.fromRole,
    fromLabel: input.fromLabel,
    toSessionId: input.toSessionId,
    toAgentId: input.toAgentId ?? null,
    toRole: input.toRole,
    toLabel: input.toLabel,
    crossProject: input.crossProject,
    isRelayRequest: input.isRelayRequest ?? false,
    subject: input.subject,
    body: input.body,
    replyToMessageId: input.replyToMessageId ?? null,
    status: input.status,
    statusReason: input.statusReason ?? null,
    createdAt: now,
  });
  return (await getAgentMessage(id))!;
}

export async function getAgentMessage(id: string): Promise<AgentMessage | null> {
  const [row] = await db.select().from(agentMessages).where(eq(agentMessages.id, id)).limit(1);
  return row ? toAgentMessage(row) : null;
}

/** Undelivered messages addressed to a session, oldest first. */
export async function listPendingForSession(toSessionId: string): Promise<AgentMessage[]> {
  const rows = await db
    .select()
    .from(agentMessages)
    .where(
      and(
        eq(agentMessages.toSessionId, toSessionId),
        inArray(agentMessages.status, ['queued', 'pending_approval']),
      ),
    )
    .orderBy(asc(agentMessages.createdAt));
  return rows.map(toAgentMessage);
}

/** Full inbox for a session: anything addressed to it, newest first. */
export async function listInboxForSession(
  toSessionId: string,
  limit = 100,
): Promise<AgentMessage[]> {
  const rows = await db
    .select()
    .from(agentMessages)
    .where(eq(agentMessages.toSessionId, toSessionId))
    .orderBy(desc(agentMessages.createdAt))
    .limit(Math.min(Math.max(limit, 1), 500));
  return rows.map(toAgentMessage);
}

/** Messages a session sent or received — the audit log for both UI panels. */
export async function listThreadActivity(sessionId: string, limit = 100): Promise<AgentMessage[]> {
  const rows = await db
    .select()
    .from(agentMessages)
    .where(or(eq(agentMessages.fromSessionId, sessionId), eq(agentMessages.toSessionId, sessionId)))
    .orderBy(desc(agentMessages.createdAt))
    .limit(Math.min(Math.max(limit, 1), 500));
  return rows.map(toAgentMessage);
}

export async function updateAgentMessageStatus(
  id: string,
  status: AgentMessageStatus,
  patch: { statusReason?: string; reply?: string } = {},
): Promise<AgentMessage | null> {
  const updates: Partial<AgentMessageRow> = { status };
  if (status === 'delivered') updates.deliveredAt = new Date();
  if (status === 'answered') updates.answeredAt = new Date();
  if (patch.statusReason !== undefined) updates.statusReason = patch.statusReason;
  if (patch.reply !== undefined) updates.reply = patch.reply;
  await db.update(agentMessages).set(updates).where(eq(agentMessages.id, id));
  return getAgentMessage(id);
}

/** Messages due for push-delivery retry: queued, addressed to another session's
 *  manager, and older than the backoff window. Same-session mail stays pull-only. */
export async function listDueForDelivery(before: Date, limit = 20): Promise<AgentMessage[]> {
  const rows = await db
    .select()
    .from(agentMessages)
    .where(
      and(
        eq(agentMessages.status, 'queued'),
        eq(agentMessages.toRole, 'manager'),
        ne(agentMessages.fromSessionId, agentMessages.toSessionId),
      ),
    )
    .orderBy(asc(agentMessages.createdAt))
    .limit(limit);
  return rows.map(toAgentMessage).filter((message) => message.createdAt <= before.getTime());
}
