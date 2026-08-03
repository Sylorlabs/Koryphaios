import type { StoredMessage } from '@koryphaios/shared';
import { db, messages, type Message as DbMessage } from '../db';
import { eq, asc, desc, sql, and, gt } from 'drizzle-orm';

export interface IMessageStore {
  add(sessionId: string, msg: StoredMessage): Promise<void>;
  getAll(sessionId: string, limit?: number): Promise<StoredMessage[]>;
  getRecent(sessionId: string, limit?: number): Promise<StoredMessage[]>;
  truncateAfter(sessionId: string, messageId: string): Promise<void>;
  replaceAndTruncate(sessionId: string, messageId: string, content: string): Promise<number>;
  replaceSessionWithSummary(
    sessionId: string,
    summary: string,
    model?: string,
    provider?: string,
  ): Promise<number>;
  assignVariantGroup(messageId: string, groupId: string, index: number): Promise<void>;
}

function toStoredMessage(m: DbMessage): StoredMessage {
  let contentStr: string;
  let attachments: StoredMessage['attachments'];
  try {
    const content = JSON.parse(m.content);
    if (
      Array.isArray(content) &&
      content.length > 0 &&
      typeof content[0] === 'object' &&
      content[0] !== null
    ) {
      contentStr = content.map((b: any) => b.text ?? '').join('');
      attachments = content
        .filter((b: any) => b?.type === 'image' && typeof b.imageData === 'string')
        .map((b: any, index: number) => ({
          type: 'image' as const,
          data: b.imageData,
          name: typeof b.name === 'string' ? b.name : `image-${index + 1}`,
          mimeType: typeof b.imageMimeType === 'string' ? b.imageMimeType : 'image/png',
        }));
      if (attachments.length === 0) attachments = undefined;
    } else {
      contentStr = m.content;
    }
  } catch (e) {
    contentStr = m.content;
  }

  return {
    id: m.id,
    sessionId: m.sessionId,
    role: m.role as StoredMessage['role'],
    content: contentStr,
    attachments,
    model: m.model ?? undefined,
    provider: m.provider ?? undefined,
    tokensIn: m.tokensIn ?? 0,
    tokensOut: m.tokensOut ?? 0,
    cost: m.cost ?? 0,
    variantGroupId: m.variantGroupId ?? undefined,
    variantIndex: m.variantIndex ?? 0,
    createdAt: m.createdAt.getTime(),
  };
}

export class MessageStore implements IMessageStore {
  /** Atomically replace a completed conversation with its durable summary. */
  async replaceSessionWithSummary(
    sessionId: string,
    summary: string,
    model?: string,
    provider?: string,
  ): Promise<number> {
    return db.transaction((tx) => {
      const prior = tx
        .select({ count: sql<number>`count(*)` })
        .from(messages)
        .where(eq(messages.sessionId, sessionId))
        .get();
      tx.delete(messages).where(eq(messages.sessionId, sessionId)).run();
      tx.insert(messages)
        .values({
          id: `compact-${crypto.randomUUID()}`,
          sessionId,
          role: 'system',
          content: JSON.stringify([{ type: 'text', text: `Session summary:\n${summary}` }]),
          model: model ?? null,
          provider: provider ?? null,
          createdAt: new Date(),
        })
        .run();
      return Number(prior?.count ?? 0);
    });
  }

  async assignVariantGroup(messageId: string, groupId: string, index: number): Promise<void> {
    await db
      .update(messages)
      .set({ variantGroupId: groupId, variantIndex: index })
      .where(eq(messages.id, messageId));
  }
  async add(sessionId: string, msg: StoredMessage): Promise<void> {
    const contentBlocks: Array<Record<string, unknown>> = [{ type: 'text', text: msg.content }];
    for (const attachment of msg.attachments ?? []) {
      if (attachment.type !== 'image') continue;
      contentBlocks.push({
        type: 'image',
        imageData: attachment.data,
        imageMimeType: attachment.mimeType ?? 'image/png',
        name: attachment.name,
      });
    }
    await db.insert(messages).values({
      id: msg.id,
      sessionId,
      role: msg.role,
      content: JSON.stringify(contentBlocks),
      model: msg.model ?? null,
      provider: msg.provider ?? null,
      tokensIn: msg.tokensIn ?? 0,
      tokensOut: msg.tokensOut ?? 0,
      cost: msg.cost ?? 0,
      variantGroupId: msg.variantGroupId ?? null,
      variantIndex: msg.variantIndex ?? 0,
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
      .where(and(eq(messages.sessionId, sessionId), gt(messages.createdAt, pivot.createdAt)));
  }

  /** Replace a user message and remove every persisted turn after it in one
   * SQLite transaction. Returns the number of later messages removed. */
  async replaceAndTruncate(sessionId: string, messageId: string, content: string): Promise<number> {
    return db.transaction((tx) => {
      const pivot = tx
        .select({ createdAt: messages.createdAt, role: messages.role, content: messages.content })
        .from(messages)
        .where(and(eq(messages.id, messageId), eq(messages.sessionId, sessionId)))
        .limit(1)
        .get();
      if (!pivot || pivot.role !== 'user') throw new Error('Editable user message not found');

      const later = tx
        .select({ count: sql<number>`count(*)` })
        .from(messages)
        .where(and(eq(messages.sessionId, sessionId), gt(messages.createdAt, pivot.createdAt)))
        .get();

      let replacement: Array<Record<string, unknown>> = [{ type: 'text', text: content }];
      try {
        const prior = JSON.parse(pivot.content);
        if (Array.isArray(prior)) {
          replacement = [
            { type: 'text', text: content },
            ...prior.filter(
              (block) => block?.type === 'image' && typeof block.imageData === 'string',
            ),
          ];
        }
      } catch {
        // Legacy raw-text rows have no attachment blocks to preserve.
      }
      tx.update(messages)
        .set({ content: JSON.stringify(replacement) })
        .where(and(eq(messages.id, messageId), eq(messages.sessionId, sessionId)))
        .run();
      tx.delete(messages)
        .where(and(eq(messages.sessionId, sessionId), gt(messages.createdAt, pivot.createdAt)))
        .run();
      return Number(later?.count ?? 0);
    });
  }
}
