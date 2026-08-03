import type { MessageAttachment, StoredMessage } from '@koryphaios/shared';
import { db, messages, sessions, sessionCompactions, type Message as DbMessage } from '../db';
import { eq, asc, desc, and, gt } from 'drizzle-orm';
import { createHash } from 'node:crypto';

export interface IMessageStore {
  add(sessionId: string, msg: StoredMessage): Promise<void>;
  getAll(sessionId: string, limit?: number): Promise<StoredMessage[]>;
  getRecent(sessionId: string, limit?: number): Promise<StoredMessage[]>;
  getContextMessages(sessionId: string, limit?: number): Promise<StoredMessage[]>;
  commitCompaction(input: CompactionCommit): Promise<{ sourceRevision: number; targetRevision: number }>;
  truncateAfter(sessionId: string, messageId: string): Promise<void>;
  assignVariantGroup(messageId: string, groupId: string, index: number): Promise<void>;
  replaceAndTruncate(sessionId: string, messageId: string, content: string): Promise<number>;
}

export interface CompactionCommit {
  id: string;
  sessionId: string;
  provider: string;
  model: string;
  automatic: boolean;
  summary: string;
  sourceMessageCount: number;
  sourceTokens: number;
  checkpointTokens: number;
}

function parseStoredContent(raw: string): { text: string; attachments: MessageAttachment[] } {
  try {
    const blocks = JSON.parse(raw);
    if (!Array.isArray(blocks)) return { text: raw, attachments: [] };
    const attachments = blocks.filter(
      (block): block is MessageAttachment =>
        block &&
        (block.type === 'image' || block.type === 'file') &&
        typeof block.data === 'string' &&
        typeof block.name === 'string',
    );
    return {
      text: blocks
        .filter((block) => block?.type === 'text' || typeof block?.text === 'string')
        .map((block) => block.text ?? '')
        .join(''),
      attachments,
    };
  } catch {
    return { text: raw, attachments: [] };
  }
}

function serializeStoredContent(content: string, attachments: MessageAttachment[] = []): string {
  return JSON.stringify([
    { type: 'text', text: content },
    ...attachments.map((attachment) => {
      if (attachment.mimeType) return attachment;
      const name = attachment.name.toLowerCase();
      const mimeType = name.endsWith('.jpg') || name.endsWith('.jpeg')
        ? 'image/jpeg'
        : name.endsWith('.webp')
          ? 'image/webp'
          : name.endsWith('.gif')
            ? 'image/gif'
            : attachment.type === 'image'
              ? 'image/png'
              : 'application/octet-stream';
      return { ...attachment, mimeType };
    }),
  ]);
}

function toStoredMessage(m: DbMessage): StoredMessage {
  const stored = parseStoredContent(m.content);

  return {
    id: m.id,
    sessionId: m.sessionId,
    role: m.role as StoredMessage['role'],
    content: stored.text,
    attachments: stored.attachments.length > 0 ? stored.attachments : undefined,
    model: m.model ?? undefined,
    provider: m.provider ?? undefined,
    tokensIn: m.tokensIn ?? 0,
    tokensOut: m.tokensOut ?? 0,
    cost: m.cost ?? 0,
    variantGroupId: m.variantGroupId ?? undefined,
    variantIndex: m.variantIndex ?? 0,
    contextRevision: m.contextRevision ?? 0,
    createdAt: m.createdAt.getTime(),
  };
}

export class MessageStore implements IMessageStore {
  async assignVariantGroup(messageId: string, groupId: string, index: number): Promise<void> {
    await db.update(messages).set({ variantGroupId: groupId, variantIndex: index }).where(eq(messages.id, messageId));
  }
  async add(sessionId: string, msg: StoredMessage): Promise<void> {
    const [session] = await db.select({ revision: sessions.conversationRevision }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    await db.insert(messages).values({
      id: msg.id,
      sessionId,
      role: msg.role,
      content: serializeStoredContent(msg.content, msg.attachments),
      model: msg.model ?? null,
      provider: msg.provider ?? null,
      tokensIn: msg.tokensIn ?? 0,
      tokensOut: msg.tokensOut ?? 0,
      cost: msg.cost ?? 0,
      variantGroupId: msg.variantGroupId ?? null,
      variantIndex: msg.variantIndex ?? 0,
      contextRevision: msg.contextRevision ?? session?.revision ?? 0,
      createdAt: new Date(msg.createdAt),
    });
  }

  async getAll(sessionId: string, limit = 1000): Promise<StoredMessage[]> {
    const results = await db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(asc(messages.createdAt))
      .limit(limit);
    return results.map(toStoredMessage);
  }

  async getRecent(sessionId: string, limit = 10): Promise<StoredMessage[]> {
    const results = await db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(desc(messages.createdAt))
      .limit(limit);
    return results.map(toStoredMessage).reverse();
  }

  async getContextMessages(sessionId: string, limit = 1000): Promise<StoredMessage[]> {
    const [session] = await db.select({ revision: sessions.conversationRevision }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    if (!session) return [];
    const results = await db.select().from(messages)
      .where(and(eq(messages.sessionId, sessionId), eq(messages.contextRevision, session.revision ?? 0)))
      .orderBy(asc(messages.createdAt)).limit(limit);
    return results.map(toStoredMessage);
  }

  async commitCompaction(input: CompactionCommit): Promise<{ sourceRevision: number; targetRevision: number }> {
    return db.transaction(async (tx) => {
      const [session] = await tx.select({ revision: sessions.conversationRevision }).from(sessions).where(eq(sessions.id, input.sessionId)).limit(1);
      if (!session) throw new Error('Session not found');
      const sourceRevision = session.revision ?? 0;
      const targetRevision = sourceRevision + 1;
      const createdAt = new Date();
      const summaryHash = createHash('sha256').update(input.summary).digest('hex');
      await tx.insert(sessionCompactions).values({
        id: input.id, sessionId: input.sessionId, sourceRevision, targetRevision,
        provider: input.provider, model: input.model, automatic: input.automatic,
        sourceMessageCount: input.sourceMessageCount, sourceTokens: input.sourceTokens,
        checkpointTokens: input.checkpointTokens, summaryHash, summary: input.summary, createdAt,
      });
      await tx.update(sessions).set({ conversationRevision: targetRevision, updatedAt: createdAt }).where(eq(sessions.id, input.sessionId));
      await tx.insert(messages).values({
        id: `compact-${input.id}`, sessionId: input.sessionId, role: 'system',
        content: serializeStoredContent(`[KORY_COMPACTION]\n${input.summary}`),
        model: input.model, provider: input.provider, tokensIn: input.sourceTokens,
        tokensOut: input.checkpointTokens, cost: 0, variantGroupId: null, variantIndex: 0,
        contextRevision: targetRevision, createdAt,
      });
      return { sourceRevision, targetRevision };
    });
  }

  async truncateAfter(sessionId: string, messageId: string): Promise<void> {
    // Find the timestamp of the pivot message
    const [pivot] = await db
      .select({ createdAt: messages.createdAt })
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1);

    if (!pivot) return;

    // Delete all messages strictly newer than the pivot
    await db
      .delete(messages)
      .where(
        and(
          eq(messages.sessionId, sessionId),
          gt(messages.createdAt, pivot.createdAt)
        )
      );
  }

  async replaceAndTruncate(
    sessionId: string,
    messageId: string,
    content: string,
  ): Promise<number> {
    return db.transaction(async (tx) => {
      const [pivot] = await tx
        .select({ createdAt: messages.createdAt, content: messages.content, role: messages.role })
        .from(messages)
        .where(and(eq(messages.id, messageId), eq(messages.sessionId, sessionId)))
        .limit(1);
      if (!pivot || pivot.role !== 'user') throw new Error('Editable user message not found');
      const stored = parseStoredContent(pivot.content);
      await tx
        .update(messages)
        .set({ content: serializeStoredContent(content, stored.attachments) })
        .where(and(eq(messages.id, messageId), eq(messages.sessionId, sessionId)));
      const removed = await tx
        .delete(messages)
        .where(and(eq(messages.sessionId, sessionId), gt(messages.createdAt, pivot.createdAt)))
        .returning({ id: messages.id });
      return removed.length;
    });
  }
}
