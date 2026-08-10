import type { MessageAttachment, StoredMessage } from '@koryphaios/shared';
import {
  db,
  getDb,
  messages,
  sessions,
  sessionCompactions,
  type Message as DbMessage,
} from '../db';
import { eq, and, sql, inArray } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { serverLog } from '../logger';

export interface IMessageStore {
  add(sessionId: string, msg: StoredMessage): Promise<void>;
  getAll(sessionId: string, limit?: number): Promise<StoredMessage[]>;
  getRecent(sessionId: string, limit?: number): Promise<StoredMessage[]>;
  getContextMessages(sessionId: string, limit?: number): Promise<StoredMessage[]>;
  commitCompaction(
    input: CompactionCommit,
  ): Promise<{ sourceRevision: number; targetRevision: number }>;
  getActiveBoundary(sessionId: string): Promise<ConversationBoundary>;
  setActiveBoundary(
    sessionId: string,
    messageId: string | null,
    options?: SetConversationBoundaryOptions,
  ): Promise<ConversationBoundaryReceipt>;
  restoreActiveBoundary(receipt: ConversationBoundaryReceipt): Promise<void>;
  /** @deprecated Use setActiveBoundary. This compatibility method no longer deletes history. */
  truncateAfter(sessionId: string, messageId: string): Promise<void>;
  assignVariantGroup(messageId: string, groupId: string, index: number): Promise<void>;
  replaceAndTruncate(sessionId: string, messageId: string, content: string): Promise<number>;
  deleteMessage(sessionId: string, messageId: string): Promise<boolean>;
}

export interface ConversationBoundary {
  messageId: string | null;
  contextRevision: number;
}

export interface SetConversationBoundaryOptions {
  /**
   * Compare-and-set guard. Omitting the property disables the guard; passing
   * null explicitly requires the conversation to still be empty.
   */
  expectedActiveMessageId?: string | null;
}

/** Durable receipt that can safely compensate a later failed recovery step. */
export interface ConversationBoundaryReceipt {
  sessionId: string;
  previous: ConversationBoundary & { updatedAt: number };
  current: ConversationBoundary & { updatedAt: number };
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
  } catch (err: unknown) {
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'message content parse failed — returning raw text',
    );
    return { text: raw, attachments: [] };
  }
}

function serializeStoredContent(content: string, attachments: MessageAttachment[] = []): string {
  return JSON.stringify([
    { type: 'text', text: content },
    ...attachments.map((attachment) => {
      if (attachment.mimeType) return attachment;
      const name = attachment.name.toLowerCase();
      const mimeType =
        name.endsWith('.jpg') || name.endsWith('.jpeg')
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

const MAX_ACTIVE_LINEAGE_DEPTH = 10_000;

type MessageStoreTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

function normalizedLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 1000;
  return Math.max(0, Math.min(Math.floor(limit), MAX_ACTIVE_LINEAGE_DEPTH));
}

async function writeActiveBoundary(
  tx: MessageStoreTransaction,
  input: {
    sessionId: string;
    messageId: string | null;
    contextRevision: number;
    updatedAt: Date;
  },
): Promise<void> {
  const [health] = await tx.values<[number, number, number, number]>(sql`
    WITH RECURSIVE active_lineage(id, parent_message_id, depth, visited) AS (
      SELECT
        "id",
        "parent_message_id",
        0,
        ',' || hex("id") || ','
      FROM ${messages}
      WHERE "id" = ${input.messageId}
        AND "session_id" = ${input.sessionId}

      UNION ALL

      SELECT
        parent."id",
        parent."parent_message_id",
        active_lineage.depth + 1,
        active_lineage.visited || hex(parent."id") || ','
      FROM ${messages} AS parent
      JOIN active_lineage ON parent."id" = active_lineage.parent_message_id
      WHERE parent."session_id" = ${input.sessionId}
        AND active_lineage.depth < ${MAX_ACTIVE_LINEAGE_DEPTH - 1}
        AND instr(active_lineage.visited, ',' || hex(parent."id") || ',') = 0
    )
    SELECT
      COUNT(*) AS count,
      COALESCE(MAX(CASE
        WHEN parent_message_id IS NOT NULL
          AND instr(visited, ',' || hex(parent_message_id) || ',') > 0
        THEN 1 ELSE 0
      END), 0) AS cycle,
      COALESCE(MAX(CASE
        WHEN parent_message_id IS NOT NULL
          AND instr(visited, ',' || hex(parent_message_id) || ',') = 0
          AND NOT EXISTS (
            SELECT 1 FROM ${messages} AS parent
            WHERE parent."id" = active_lineage.parent_message_id
              AND parent."session_id" = ${input.sessionId}
          )
        THEN 1 ELSE 0
      END), 0) AS brokenParent,
      COALESCE(MAX(CASE
        WHEN depth = ${MAX_ACTIVE_LINEAGE_DEPTH - 1}
          AND parent_message_id IS NOT NULL
        THEN 1 ELSE 0
      END), 0) AS depthExceeded
    FROM active_lineage
  `);
  const [, cycle = 0, brokenParent = 0, depthExceeded = 0] = health ?? [];
  if (cycle !== 0) {
    throw new Error('Conversation lineage contains a cycle; active boundary was not changed');
  }
  if (brokenParent !== 0) {
    throw new Error('Conversation lineage contains a missing or cross-session parent');
  }
  if (depthExceeded !== 0) {
    throw new Error(
      `Conversation lineage exceeds the ${MAX_ACTIVE_LINEAGE_DEPTH}-message recovery limit`,
    );
  }

  await tx
    .update(sessions)
    .set({
      activeMessageId: input.messageId,
      conversationRevision: input.contextRevision,
      // Every active-history rewrite invalidates any provider-owned native
      // transcript in the same transaction. Compensation advances again; it
      // must never restore an older provider generation.
      providerConversationRevision: sql`COALESCE(${sessions.providerConversationRevision}, 0) + 1`,
      updatedAt: input.updatedAt,
    })
    .where(eq(sessions.id, input.sessionId));

  // Aggregate only the active parent chain. The path guard prevents a corrupt
  // cycle from hanging startup/recovery, while the depth cap bounds work on a
  // damaged or adversarial database.
  await tx.run(sql`
    WITH RECURSIVE active_lineage(id, parent_message_id, depth, visited) AS (
      SELECT
        "id",
        "parent_message_id",
        0,
        ',' || hex("id") || ','
      FROM ${messages}
      WHERE "id" = ${input.messageId}
        AND "session_id" = ${input.sessionId}

      UNION ALL

      SELECT
        parent."id",
        parent."parent_message_id",
        active_lineage.depth + 1,
        active_lineage.visited || hex(parent."id") || ','
      FROM ${messages} AS parent
      JOIN active_lineage ON parent."id" = active_lineage.parent_message_id
      WHERE parent."session_id" = ${input.sessionId}
        AND active_lineage.depth < ${MAX_ACTIVE_LINEAGE_DEPTH - 1}
        AND instr(
          active_lineage.visited,
          ',' || hex(parent."id") || ','
        ) = 0
    )
    UPDATE ${sessions}
    SET
      "message_count" = (SELECT COUNT(*) FROM active_lineage),
      "tokens_in" = COALESCE((
        SELECT SUM(message."tokens_in")
        FROM ${messages} AS message
        JOIN active_lineage ON active_lineage.id = message."id"
      ), 0),
      "tokens_out" = COALESCE((
        SELECT SUM(message."tokens_out")
        FROM ${messages} AS message
        JOIN active_lineage ON active_lineage.id = message."id"
      ), 0),
      "total_cost" = COALESCE((
        SELECT SUM(message."cost")
        FROM ${messages} AS message
        JOIN active_lineage ON active_lineage.id = message."id"
      ), 0)
    WHERE "id" = ${input.sessionId}
  `);
}

export class MessageStore implements IMessageStore {
  private getActiveLineageIds(
    sessionId: string,
    limit: number,
    order: 'oldest' | 'newest',
    contextRevision?: number,
  ): string[] {
    const boundedLimit = normalizedLimit(limit);
    if (boundedLimit === 0) return [];
    const contextFilter = contextRevision === undefined ? '' : 'AND context_revision = ?';
    const statement = getDb().query(`
      WITH RECURSIVE active_lineage(
        id, parent_message_id, context_revision, depth, visited
      ) AS (
        SELECT
          message.id,
          message.parent_message_id,
          message.context_revision,
          0,
          ',' || hex(message.id) || ','
        FROM sessions AS session
        JOIN messages AS message
          ON message.id = session.active_message_id
         AND message.session_id = session.id
        WHERE session.id = ?

        UNION ALL

        SELECT
          parent.id,
          parent.parent_message_id,
          parent.context_revision,
          active_lineage.depth + 1,
          active_lineage.visited || hex(parent.id) || ','
        FROM messages AS parent
        JOIN active_lineage ON parent.id = active_lineage.parent_message_id
        WHERE parent.session_id = ?
          AND active_lineage.depth < ?
          AND instr(active_lineage.visited, ',' || hex(parent.id) || ',') = 0
      )
      SELECT id
      FROM active_lineage
      WHERE 1 = 1 ${contextFilter}
      ORDER BY depth ${order === 'oldest' ? 'DESC' : 'ASC'}
      LIMIT ?
    `);
    const bindings =
      contextRevision === undefined
        ? [sessionId, sessionId, MAX_ACTIVE_LINEAGE_DEPTH - 1, boundedLimit]
        : [sessionId, sessionId, MAX_ACTIVE_LINEAGE_DEPTH - 1, contextRevision, boundedLimit];
    return (statement.all(...bindings) as Array<{ id: string }>).map((row) => row.id);
  }

  private async getMessagesByActiveIds(ids: string[]): Promise<StoredMessage[]> {
    if (ids.length === 0) return [];
    const rows = await db.select().from(messages).where(inArray(messages.id, ids));
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ids.flatMap((id) => {
      const row = byId.get(id);
      return row ? [toStoredMessage(row)] : [];
    });
  }

  async assignVariantGroup(messageId: string, groupId: string, index: number): Promise<void> {
    await db
      .update(messages)
      .set({ variantGroupId: groupId, variantIndex: index })
      .where(eq(messages.id, messageId));
  }
  async add(sessionId: string, msg: StoredMessage): Promise<void> {
    const msgTokensIn = msg.tokensIn ?? 0;
    const msgTokensOut = msg.tokensOut ?? 0;
    const msgCost = msg.cost ?? 0;
    // Insert the message and update the parent session's aggregate counters
    // in a single transaction so the sidebar's "N msgs · $X.XXX" is always
    // accurate — not just in the demo.
    await db.transaction(async (tx) => {
      const [session] = await tx
        .select({
          revision: sessions.conversationRevision,
          activeMessageId: sessions.activeMessageId,
        })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      if (!session) throw new Error('Session not found');
      await tx.insert(messages).values({
        id: msg.id,
        sessionId,
        role: msg.role,
        content: serializeStoredContent(msg.content, msg.attachments),
        model: msg.model ?? null,
        provider: msg.provider ?? null,
        tokensIn: msgTokensIn,
        tokensOut: msgTokensOut,
        cost: msgCost,
        variantGroupId: msg.variantGroupId ?? null,
        variantIndex: msg.variantIndex ?? 0,
        contextRevision: msg.contextRevision ?? session?.revision ?? 0,
        parentMessageId: session.activeMessageId,
        createdAt: new Date(msg.createdAt),
      });
      await tx
        .update(sessions)
        .set({
          messageCount: sql`COALESCE(${sessions.messageCount}, 0) + 1`,
          tokensIn: sql`COALESCE(${sessions.tokensIn}, 0) + ${msgTokensIn}`,
          tokensOut: sql`COALESCE(${sessions.tokensOut}, 0) + ${msgTokensOut}`,
          totalCost: sql`COALESCE(${sessions.totalCost}, 0) + ${msgCost}`,
          activeMessageId: msg.id,
          updatedAt: new Date(msg.createdAt),
        })
        .where(eq(sessions.id, sessionId));
    });
  }

  async getAll(sessionId: string, limit = 1000): Promise<StoredMessage[]> {
    return this.getMessagesByActiveIds(this.getActiveLineageIds(sessionId, limit, 'oldest'));
  }

  async getRecent(sessionId: string, limit = 10): Promise<StoredMessage[]> {
    const newestFirst = this.getActiveLineageIds(sessionId, limit, 'newest');
    return this.getMessagesByActiveIds(newestFirst.reverse());
  }

  async getContextMessages(sessionId: string, limit = 1000): Promise<StoredMessage[]> {
    const [session] = await db
      .select({ revision: sessions.conversationRevision })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (!session) return [];
    return this.getMessagesByActiveIds(
      this.getActiveLineageIds(sessionId, limit, 'oldest', session.revision ?? 0),
    );
  }

  async commitCompaction(
    input: CompactionCommit,
  ): Promise<{ sourceRevision: number; targetRevision: number }> {
    return db.transaction(async (tx) => {
      const [session] = await tx
        .select({
          revision: sessions.conversationRevision,
          activeMessageId: sessions.activeMessageId,
        })
        .from(sessions)
        .where(eq(sessions.id, input.sessionId))
        .limit(1);
      if (!session) throw new Error('Session not found');
      const sourceRevision = session.revision ?? 0;
      const targetRevision = sourceRevision + 1;
      const createdAt = new Date();
      const summaryHash = createHash('sha256').update(input.summary).digest('hex');
      await tx.insert(sessionCompactions).values({
        id: input.id,
        sessionId: input.sessionId,
        sourceRevision,
        targetRevision,
        provider: input.provider,
        model: input.model,
        automatic: input.automatic,
        sourceMessageCount: input.sourceMessageCount,
        sourceTokens: input.sourceTokens,
        checkpointTokens: input.checkpointTokens,
        summaryHash,
        summary: input.summary,
        createdAt,
      });
      await tx
        .update(sessions)
        .set({
          conversationRevision: targetRevision,
          providerConversationRevision: sql`COALESCE(${sessions.providerConversationRevision}, 0) + 1`,
          activeMessageId: `compact-${input.id}`,
          messageCount: sql`COALESCE(${sessions.messageCount}, 0) + 1`,
          tokensIn: sql`COALESCE(${sessions.tokensIn}, 0) + ${input.sourceTokens}`,
          tokensOut: sql`COALESCE(${sessions.tokensOut}, 0) + ${input.checkpointTokens}`,
          updatedAt: createdAt,
        })
        .where(eq(sessions.id, input.sessionId));
      await tx.insert(messages).values({
        id: `compact-${input.id}`,
        sessionId: input.sessionId,
        role: 'system',
        content: serializeStoredContent(`[KORY_COMPACTION]\n${input.summary}`),
        model: input.model,
        provider: input.provider,
        tokensIn: input.sourceTokens,
        tokensOut: input.checkpointTokens,
        cost: 0,
        variantGroupId: null,
        variantIndex: 0,
        contextRevision: targetRevision,
        parentMessageId: session.activeMessageId,
        createdAt,
      });
      return { sourceRevision, targetRevision };
    });
  }

  async getActiveBoundary(sessionId: string): Promise<ConversationBoundary> {
    const [session] = await db
      .select({
        messageId: sessions.activeMessageId,
        contextRevision: sessions.conversationRevision,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (!session) throw new Error('Session not found');
    return {
      messageId: session.messageId,
      contextRevision: session.contextRevision ?? 0,
    };
  }

  async setActiveBoundary(
    sessionId: string,
    messageId: string | null,
    options: SetConversationBoundaryOptions = {},
  ): Promise<ConversationBoundaryReceipt> {
    return db.transaction(async (tx) => {
      const [session] = await tx
        .select({
          activeMessageId: sessions.activeMessageId,
          contextRevision: sessions.conversationRevision,
          updatedAt: sessions.updatedAt,
        })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      if (!session) throw new Error('Session not found');

      const pivot =
        messageId === null
          ? null
          : (
              await tx
                .select({
                  sessionId: messages.sessionId,
                  contextRevision: messages.contextRevision,
                })
                .from(messages)
                .where(and(eq(messages.id, messageId), eq(messages.sessionId, sessionId)))
                .limit(1)
            )[0];
      if (messageId !== null && !pivot) {
        throw new Error('Conversation boundary message not found in this session');
      }

      const hasExpectedBoundary = Object.prototype.hasOwnProperty.call(
        options,
        'expectedActiveMessageId',
      );
      if (
        hasExpectedBoundary &&
        session.activeMessageId !== (options.expectedActiveMessageId ?? null)
      ) {
        throw new Error('Conversation changed after the recovery preview');
      }

      const updatedAt = new Date();
      await writeActiveBoundary(tx, {
        sessionId,
        messageId,
        contextRevision: pivot?.contextRevision ?? 0,
        updatedAt,
      });

      return {
        sessionId,
        previous: {
          messageId: session.activeMessageId,
          contextRevision: session.contextRevision ?? 0,
          updatedAt:
            session.updatedAt instanceof Date ? session.updatedAt.getTime() : updatedAt.getTime(),
        },
        current: {
          messageId,
          contextRevision: pivot?.contextRevision ?? 0,
          updatedAt: updatedAt.getTime(),
        },
      };
    });
  }

  async restoreActiveBoundary(receipt: ConversationBoundaryReceipt): Promise<void> {
    await db.transaction(async (tx) => {
      const [session] = await tx
        .select({
          activeMessageId: sessions.activeMessageId,
          contextRevision: sessions.conversationRevision,
        })
        .from(sessions)
        .where(eq(sessions.id, receipt.sessionId))
        .limit(1);
      if (!session) throw new Error('Session not found');
      if (
        session.activeMessageId !== receipt.current.messageId ||
        (session.contextRevision ?? 0) !== receipt.current.contextRevision
      ) {
        throw new Error('Conversation changed after the recovery step; refusing to overwrite it');
      }
      if (receipt.previous.messageId) {
        const [previous] = await tx
          .select({
            sessionId: messages.sessionId,
            contextRevision: messages.contextRevision,
          })
          .from(messages)
          .where(
            and(
              eq(messages.id, receipt.previous.messageId),
              eq(messages.sessionId, receipt.sessionId),
            ),
          )
          .limit(1);
        if (!previous) throw new Error('Previous conversation boundary is no longer available');
        if ((previous.contextRevision ?? 0) !== receipt.previous.contextRevision) {
          throw new Error('Previous conversation boundary receipt is invalid');
        }
      }
      await writeActiveBoundary(tx, {
        sessionId: receipt.sessionId,
        messageId: receipt.previous.messageId,
        contextRevision: receipt.previous.contextRevision,
        updatedAt: new Date(),
      });
    });
  }

  /** Compatibility path for older callers. No rows are deleted. */
  async truncateAfter(sessionId: string, messageId: string): Promise<void> {
    await this.setActiveBoundary(sessionId, messageId);
  }

  async replaceAndTruncate(sessionId: string, messageId: string, content: string): Promise<number> {
    return db.transaction(async (tx) => {
      const [pivot] = await tx
        .select({
          content: messages.content,
          role: messages.role,
          contextRevision: messages.contextRevision,
        })
        .from(messages)
        .where(and(eq(messages.id, messageId), eq(messages.sessionId, sessionId)))
        .limit(1);
      if (!pivot || pivot.role !== 'user') throw new Error('Editable user message not found');
      const [session] = await tx
        .select({ messageCount: sessions.messageCount })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      if (!session) throw new Error('Session not found');
      const stored = parseStoredContent(pivot.content);
      await tx
        .update(messages)
        .set({ content: serializeStoredContent(content, stored.attachments) })
        .where(and(eq(messages.id, messageId), eq(messages.sessionId, sessionId)));
      await writeActiveBoundary(tx, {
        sessionId,
        messageId,
        contextRevision: pivot.contextRevision ?? 0,
        updatedAt: new Date(),
      });
      const [rewritten] = await tx
        .select({ messageCount: sessions.messageCount })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      return Math.max((session.messageCount ?? 0) - (rewritten?.messageCount ?? 0), 0);
    });
  }

  /** Permanently delete a single message and decrement session aggregates.
   *  Returns true if a row was deleted, false if the message was not found. */
  async deleteMessage(sessionId: string, messageId: string): Promise<boolean> {
    return db.transaction(async (tx) => {
      const [target] = await tx
        .select({ parentMessageId: messages.parentMessageId })
        .from(messages)
        .where(and(eq(messages.id, messageId), eq(messages.sessionId, sessionId)))
        .limit(1);
      if (!target) return false;
      const [session] = await tx
        .select({
          activeMessageId: sessions.activeMessageId,
          contextRevision: sessions.conversationRevision,
        })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      if (!session) return false;

      // Preserve every descendant branch when a user explicitly deletes one
      // message by reconnecting its children to its parent.
      await tx
        .update(messages)
        .set({ parentMessageId: target.parentMessageId })
        .where(and(eq(messages.sessionId, sessionId), eq(messages.parentMessageId, messageId)));
      const removed = await tx
        .delete(messages)
        .where(and(eq(messages.id, messageId), eq(messages.sessionId, sessionId)))
        .returning({
          id: messages.id,
          tokensIn: messages.tokensIn,
          tokensOut: messages.tokensOut,
          cost: messages.cost,
        });
      if (removed.length === 0) return false;
      const nextHead =
        session.activeMessageId === messageId ? target.parentMessageId : session.activeMessageId;
      let nextContextRevision = session.contextRevision ?? 0;
      if (session.activeMessageId === messageId) {
        if (nextHead) {
          const [parent] = await tx
            .select({ contextRevision: messages.contextRevision })
            .from(messages)
            .where(and(eq(messages.id, nextHead), eq(messages.sessionId, sessionId)))
            .limit(1);
          nextContextRevision = parent?.contextRevision ?? 0;
        } else {
          nextContextRevision = 0;
        }
      }
      await writeActiveBoundary(tx, {
        sessionId,
        messageId: nextHead,
        contextRevision: nextContextRevision,
        updatedAt: new Date(),
      });
      return true;
    });
  }
}
