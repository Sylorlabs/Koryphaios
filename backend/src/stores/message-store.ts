import type { StoredMessage } from '@koryphaios/shared';
import { db, messages, type Message as DbMessage } from '../db';
import { eq, desc, sql, and, gt } from 'drizzle-orm';

export interface IMessageStore {
  add(sessionId: string, msg: StoredMessage): Promise<void>;
  getAll(sessionId: string, limit?: number): Promise<StoredMessage[]>;
  getRecent(sessionId: string, limit?: number): Promise<StoredMessage[]>;
  truncateAfter(sessionId: string, messageId: string): Promise<void>;
}

function toStoredMessage(m: DbMessage): StoredMessage {
  let contentStr: string;
  try {
    const content = JSON.parse(m.content);
    if (
      Array.isArray(content) &&
      content.length > 0 &&
      typeof content[0] === 'object' &&
      content[0] !== null
    ) {
      contentStr = content.map((b: any) => b.text ?? '').join('');
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
    model: m.model ?? undefined,
    provider: m.provider ?? undefined,
    tokensIn: m.tokensIn ?? 0,
    tokensOut: m.tokensOut ?? 0,
    cost: m.cost ?? 0,
    createdAt: m.createdAt.getTime(),
  };
}

export class MessageStore implements IMessageStore {
  async add(sessionId: string, msg: StoredMessage): Promise<void> {
    await db.insert(messages).values({
      id: msg.id,
      sessionId,
      role: msg.role,
      content: JSON.stringify([{ type: 'text', text: msg.content }]),
      model: msg.model ?? null,
      provider: msg.provider ?? null,
      tokensIn: msg.tokensIn ?? 0,
      tokensOut: msg.tokensOut ?? 0,
      cost: msg.cost ?? 0,
      createdAt: new Date(msg.createdAt),
    });
  }

  async getAll(sessionId: string, limit = 1000): Promise<StoredMessage[]> {
    const results = await db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
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
      .where(
        and(
          eq(messages.sessionId, sessionId),
          gt(messages.createdAt, pivot.createdAt)
        )
      );
  }
}
