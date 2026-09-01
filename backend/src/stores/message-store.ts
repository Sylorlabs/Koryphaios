import type { MessageAttachment, StoredMessage } from '@koryphaios/shared';
import {
  db,
  getDb,
  messages,
  sessions,
  sessionCompactions,
  type Message as DbMessage,
} from '../db';
import { eq, and, sql, inArray, isNull } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { serverLog } from '../logger';
import { ConflictError } from '../errors/types';

export interface IMessageStore {
  add(sessionId: string, msg: StoredMessage): Promise<void>;
  addIdempotent(sessionId: string, msg: StoredMessage): Promise<'inserted' | 'existing'>;
  addIdempotentAtBoundary(
    sessionId: string,
    msg: StoredMessage,
    expected: MessageAppendBoundary,
  ): Promise<'inserted' | 'existing'>;
  getById(sessionId: string, messageId: string): Promise<StoredMessage | undefined>;
  getAll(sessionId: string, limit?: number): Promise<StoredMessage[]>;
  /** Active conversation plus retained sibling responses needed by the feed's variant picker. */
  getDisplayMessages(sessionId: string, limit?: number): Promise<StoredMessage[]>;
  getRecent(sessionId: string, limit?: number): Promise<StoredMessage[]>;
  getContextMessages(sessionId: string, limit?: number): Promise<StoredMessage[]>;
  getContextMessagesAtBoundary(
    sessionId: string,
    messageId: string,
    limit?: number,
  ): Promise<StoredMessage[]>;
  /** Count user image blocks without hydrating their base64 payloads into application memory. */
  countContextImageAttachments?(sessionId: string, limit?: number): Promise<number>;
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
  getRegenerationCandidate(
    sessionId: string,
    messageId: string,
  ): Promise<RegenerationCandidate | undefined>;
  prepareRegenerationBranch(
    input: PrepareRegenerationBranchInput,
  ): Promise<RegenerationBranchReservation>;
  commitRegeneratedResponse(
    reservation: RegenerationBranchReservation,
    message: StoredMessage,
  ): Promise<void>;
  /** @deprecated Use setActiveBoundary. This compatibility method no longer deletes history. */
  truncateAfter(sessionId: string, messageId: string): Promise<void>;
  assignVariantGroup(messageId: string, groupId: string, index: number): Promise<void>;
  replaceAndTruncate(sessionId: string, messageId: string, content: string): Promise<number>;
  deleteMessage(sessionId: string, messageId: string): Promise<boolean>;
}

export interface MessageAppendBoundary {
  activeMessageId: string | null;
  providerConversationRevision: number;
}

export interface ConversationBoundary {
  messageId: string | null;
  contextRevision: number;
  /** Present on authoritative boundary reads; omitted from legacy recovery receipts. */
  providerConversationRevision?: number;
}

export interface ActivateResponseVariantInput {
  sessionId: string;
  messageId: string;
  expectedActiveMessageId: string;
  expectedProviderConversationRevision: number;
}

export interface VariantActivationResult {
  previousActiveMessageId: string;
  activeMessageId: string;
  conversationRevision: number;
  providerConversationRevision: number;
  rewoundMessageCount: number;
}

export interface MessageDisplayProjection {
  messages: StoredMessage[];
  activeMessageId: string | null;
  conversationRevision: number;
  providerConversationRevision: number;
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

export interface RegenerationCandidate {
  target: StoredMessage;
  prompt: StoredMessage;
  boundary: ConversationBoundary;
  providerConversationRevision: number;
}

export interface PrepareRegenerationBranchInput {
  sessionId: string;
  targetMessageId: string;
  promptMessageId: string;
  expectedActiveMessageId: string | null;
  expectedProviderConversationRevision: number;
}

export interface RegenerationBranchReservation {
  sessionId: string;
  targetMessageId: string;
  promptMessageId: string;
  expectedActiveMessageId: string;
  expectedProviderConversationRevision: number;
  contextRevision: number;
  groupId: string;
  index: number;
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

function writeActiveBoundary(
  tx: MessageStoreTransaction,
  input: {
    sessionId: string;
    messageId: string | null;
    contextRevision: number;
    updatedAt: Date;
    expected?: MessageAppendBoundary;
  },
): void {
  const [health] = tx.values<[number, number, number, number]>(sql`
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

  const boundaryCondition = input.expected
    ? and(
        eq(sessions.id, input.sessionId),
        input.expected.activeMessageId === null
          ? isNull(sessions.activeMessageId)
          : eq(sessions.activeMessageId, input.expected.activeMessageId),
        sql`COALESCE(${sessions.providerConversationRevision}, 0) = ${input.expected.providerConversationRevision}`,
      )
    : eq(sessions.id, input.sessionId);
  const updated = tx
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
    .where(boundaryCondition)
    .returning({ id: sessions.id })
    .all();
  if (input.expected && updated.length !== 1) {
    throw new ConflictError('Conversation changed before the response variant was activated.');
  }

  // Aggregate only the active parent chain. The path guard prevents a corrupt
  // cycle from hanging startup/recovery, while the depth cap bounds work on a
  // damaged or adversarial database.
  tx.run(sql`
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

  private getMessagesByActiveIds(ids: string[]): StoredMessage[] {
    if (ids.length === 0) return [];
    const rows = db.select().from(messages).where(inArray(messages.id, ids)).all();
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
  async getById(sessionId: string, messageId: string): Promise<StoredMessage | undefined> {
    const [row] = await db
      .select()
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.sessionId, sessionId)))
      .limit(1);
    return row ? toStoredMessage(row) : undefined;
  }

  async addIdempotent(sessionId: string, msg: StoredMessage): Promise<'inserted' | 'existing'> {
    const expectedContent = serializeStoredContent(msg.content, msg.attachments);
    const assertExistingMatches = async (): Promise<boolean> => {
      const [row] = await db.select().from(messages).where(eq(messages.id, msg.id)).limit(1);
      if (!row) return false;
      if (
        row.sessionId !== sessionId ||
        row.role !== msg.role ||
        row.content !== expectedContent ||
        (row.model ?? undefined) !== msg.model ||
        (row.provider ?? undefined) !== msg.provider ||
        (row.variantGroupId ?? undefined) !== msg.variantGroupId ||
        (row.variantIndex ?? 0) !== (msg.variantIndex ?? 0) ||
        (row.tokensIn ?? 0) !== (msg.tokensIn ?? 0) ||
        (row.tokensOut ?? 0) !== (msg.tokensOut ?? 0) ||
        (row.cost ?? 0) !== (msg.cost ?? 0)
      ) {
        throw new ConflictError(`Message id ${msg.id} was already used for different content.`);
      }
      return true;
    };
    if (await assertExistingMatches()) return 'existing';
    try {
      await this.add(sessionId, msg);
      return 'inserted';
    } catch (error) {
      // A concurrent retry may win the primary-key race. Accept only the exact
      // same command projection; every other collision remains a hard error.
      if (await assertExistingMatches()) return 'existing';
      throw error;
    }
  }

  /** Append one deterministic command projection only at the conversation
   * generation it was created for. An existing exact row is accepted only
   * while it is still the active head; it never authorizes a silent rebase. */
  async addIdempotentAtBoundary(
    sessionId: string,
    msg: StoredMessage,
    expected: MessageAppendBoundary,
  ): Promise<'inserted' | 'existing'> {
    const content = serializeStoredContent(msg.content, msg.attachments);
    const tokensIn = msg.tokensIn ?? 0;
    const tokensOut = msg.tokensOut ?? 0;
    const cost = msg.cost ?? 0;
    return db.transaction((tx) => {
      const [session] = tx
        .select({
          revision: sessions.conversationRevision,
          activeMessageId: sessions.activeMessageId,
          providerConversationRevision: sessions.providerConversationRevision,
          archivedAt: sessions.archivedAt,
        })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1)
        .all();
      if (!session) throw new Error('Session not found');
      if (session.archivedAt !== null) {
        throw new ConflictError('Recover this archived chat before adding messages.');
      }

      const [existing] = tx
        .select()
        .from(messages)
        .where(eq(messages.id, msg.id))
        .limit(1)
        .all();
      if (existing) {
        if (
          existing.sessionId !== sessionId ||
          existing.role !== msg.role ||
          existing.content !== content ||
          (existing.model ?? undefined) !== msg.model ||
          (existing.provider ?? undefined) !== msg.provider ||
          (existing.variantGroupId ?? undefined) !== msg.variantGroupId ||
          (existing.variantIndex ?? 0) !== (msg.variantIndex ?? 0) ||
          (existing.tokensIn ?? 0) !== tokensIn ||
          (existing.tokensOut ?? 0) !== tokensOut ||
          (existing.cost ?? 0) !== cost
        ) {
          throw new ConflictError(`Message id ${msg.id} was already used for different content.`);
        }
        if (
          session.activeMessageId !== msg.id ||
          (session.providerConversationRevision ?? 0) !== expected.providerConversationRevision
        ) {
          throw new ConflictError(
            'The durable command already started on an older conversation generation.',
          );
        }
        return 'existing';
      }

      if (
        session.activeMessageId !== expected.activeMessageId ||
        (session.providerConversationRevision ?? 0) !== expected.providerConversationRevision
      ) {
        throw new ConflictError(
          'Conversation changed before the durable command could be appended.',
        );
      }
      tx.insert(messages)
        .values({
          id: msg.id,
          sessionId,
          role: msg.role,
          content,
          model: msg.model ?? null,
          provider: msg.provider ?? null,
          tokensIn,
          tokensOut,
          cost,
          variantGroupId: msg.variantGroupId ?? null,
          variantIndex: msg.variantIndex ?? 0,
          contextRevision: msg.contextRevision ?? session.revision ?? 0,
          parentMessageId: expected.activeMessageId,
          createdAt: new Date(msg.createdAt),
        })
        .run();
      tx
        .update(sessions)
        .set({
          messageCount: sql`COALESCE(${sessions.messageCount}, 0) + 1`,
          tokensIn: sql`COALESCE(${sessions.tokensIn}, 0) + ${tokensIn}`,
          tokensOut: sql`COALESCE(${sessions.tokensOut}, 0) + ${tokensOut}`,
          totalCost: sql`COALESCE(${sessions.totalCost}, 0) + ${cost}`,
          activeMessageId: msg.id,
          updatedAt: new Date(msg.createdAt),
        })
        .where(eq(sessions.id, sessionId))
        .run();
      return 'inserted';
    });
  }

  async add(sessionId: string, msg: StoredMessage): Promise<void> {
    const msgTokensIn = msg.tokensIn ?? 0;
    const msgTokensOut = msg.tokensOut ?? 0;
    const msgCost = msg.cost ?? 0;
    // Insert the message and update the parent session's aggregate counters
    // in a single transaction so the sidebar's "N msgs · $X.XXX" is always
    // accurate — not just in the demo.
    db.transaction((tx) => {
      const [session] = tx
        .select({
          revision: sessions.conversationRevision,
          activeMessageId: sessions.activeMessageId,
          archivedAt: sessions.archivedAt,
        })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1)
        .all();
      if (!session) throw new Error('Session not found');
      if (session.archivedAt !== null) {
        throw new ConflictError('Recover this archived chat before adding messages.');
      }
      tx.insert(messages)
        .values({
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
        })
        .run();
      tx
        .update(sessions)
        .set({
          messageCount: sql`COALESCE(${sessions.messageCount}, 0) + 1`,
          tokensIn: sql`COALESCE(${sessions.tokensIn}, 0) + ${msgTokensIn}`,
          tokensOut: sql`COALESCE(${sessions.tokensOut}, 0) + ${msgTokensOut}`,
          totalCost: sql`COALESCE(${sessions.totalCost}, 0) + ${msgCost}`,
          activeMessageId: msg.id,
          updatedAt: new Date(msg.createdAt),
        })
        .where(eq(sessions.id, sessionId))
        .run();
    });
  }

  private getAllSync(sessionId: string, limit = 1000): StoredMessage[] {
    return this.getMessagesByActiveIds(this.getActiveLineageIds(sessionId, limit, 'oldest'));
  }

  async getAll(sessionId: string, limit = 1000): Promise<StoredMessage[]> {
    return this.getAllSync(sessionId, limit);
  }

  private getDisplayMessagesSync(sessionId: string, limit = 1000): StoredMessage[] {
    const active = this.getAllSync(sessionId, limit);
    const activeIds = new Set(active.map((message) => message.id));
    const activeProjection = active.map((message) => ({
      ...message,
      isActiveBranch: true,
    }));
    const variantGroupIds = [
      ...new Set(
        active.flatMap((message) => (message.variantGroupId ? [message.variantGroupId] : [])),
      ),
    ];
    if (variantGroupIds.length === 0) return activeProjection;

    const siblingRows = db
      .select()
      .from(messages)
      .where(
        and(eq(messages.sessionId, sessionId), inArray(messages.variantGroupId, variantGroupIds)),
      )
      .all();
    const byId = new Map(activeProjection.map((message) => [message.id, message]));
    for (const row of siblingRows) {
      const message = toStoredMessage(row);
      byId.set(row.id, { ...message, isActiveBranch: activeIds.has(row.id) });
    }
    return [...byId.values()].sort(
      (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
    );
  }

  async getDisplayMessages(sessionId: string, limit = 1000): Promise<StoredMessage[]> {
    return this.getDisplayMessagesSync(sessionId, limit);
  }

  /** Read display rows and their compare-and-swap boundary from one SQLite snapshot. */
  async getDisplayProjection(sessionId: string, limit = 1000): Promise<MessageDisplayProjection> {
    return db.transaction((tx) => {
      // Bun SQLite transactions are synchronous. Keep the entire projection
      // on the stack until commit; an async callback would commit at its first
      // await and pair rows with a boundary from another generation.
      const projectedMessages = this.getDisplayMessagesSync(sessionId, limit);
      const [session] = tx
        .select({
          activeMessageId: sessions.activeMessageId,
          conversationRevision: sessions.conversationRevision,
          providerConversationRevision: sessions.providerConversationRevision,
        })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1)
        .all();
      if (!session) throw new Error('Session not found');
      return {
        messages: projectedMessages,
        activeMessageId: session.activeMessageId,
        conversationRevision: session.conversationRevision ?? 0,
        providerConversationRevision: session.providerConversationRevision ?? 0,
      };
    });
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

  async getContextMessagesAtBoundary(
    sessionId: string,
    messageId: string,
    limit = 1000,
  ): Promise<StoredMessage[]> {
    const boundedLimit = normalizedLimit(limit);
    if (boundedLimit === 0) return [];
    const [pivot] = await db
      .select({ contextRevision: messages.contextRevision })
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.sessionId, sessionId)))
      .limit(1);
    if (!pivot) throw new Error('Conversation boundary message not found in this session');
    const statement = getDb().query(`
      WITH RECURSIVE anchored_lineage(
        id, parent_message_id, context_revision, depth, visited
      ) AS (
        SELECT
          message.id,
          message.parent_message_id,
          message.context_revision,
          0,
          ',' || hex(message.id) || ','
        FROM messages AS message
        WHERE message.id = ?
          AND message.session_id = ?

        UNION ALL

        SELECT
          parent.id,
          parent.parent_message_id,
          parent.context_revision,
          anchored_lineage.depth + 1,
          anchored_lineage.visited || hex(parent.id) || ','
        FROM messages AS parent
        JOIN anchored_lineage ON parent.id = anchored_lineage.parent_message_id
        WHERE parent.session_id = ?
          AND anchored_lineage.depth < ?
          AND instr(anchored_lineage.visited, ',' || hex(parent.id) || ',') = 0
      )
      SELECT id
      FROM anchored_lineage
      WHERE context_revision = ?
      ORDER BY depth DESC
      LIMIT ?
    `);
    const ids = (
      statement.all(
        messageId,
        sessionId,
        sessionId,
        MAX_ACTIVE_LINEAGE_DEPTH - 1,
        pivot.contextRevision ?? 0,
        boundedLimit,
      ) as Array<{ id: string }>
    ).map((row) => row.id);
    return this.getMessagesByActiveIds(ids);
  }

  async countContextImageAttachments(sessionId: string, limit = 1000): Promise<number> {
    const [session] = await db
      .select({ revision: sessions.conversationRevision })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (!session) return 0;

    const ids = this.getActiveLineageIds(sessionId, limit, 'oldest', session.revision ?? 0);
    let count = 0;
    // Keep well below SQLite's host-parameter limit even when callers request
    // the maximum active-lineage depth.
    for (let offset = 0; offset < ids.length; offset += 500) {
      const chunk = ids.slice(offset, offset + 500);
      const placeholders = chunk.map(() => '?').join(', ');
      const row = getDb()
        .query(
          `SELECT COUNT(*) AS count
           FROM messages AS message
           JOIN json_each(
             CASE WHEN json_valid(message.content)
               THEN CASE WHEN json_type(message.content) = 'array' THEN message.content ELSE '[]' END
               ELSE '[]'
             END
           ) AS block
           WHERE message.id IN (${placeholders})
             AND message.role = 'user'
             AND json_extract(message.content, '$[' || block.key || '].type') = 'image'
             AND json_type(message.content, '$[' || block.key || '].data') = 'text'
             AND json_type(message.content, '$[' || block.key || '].name') = 'text'`,
        )
        .get(...chunk) as { count?: number } | null;
      count += Number(row?.count ?? 0);
    }
    return count;
  }

  async commitCompaction(
    input: CompactionCommit,
  ): Promise<{ sourceRevision: number; targetRevision: number }> {
    return db.transaction((tx) => {
      const [session] = tx
        .select({
          revision: sessions.conversationRevision,
          activeMessageId: sessions.activeMessageId,
        })
        .from(sessions)
        .where(eq(sessions.id, input.sessionId))
        .limit(1)
        .all();
      if (!session) throw new Error('Session not found');
      const sourceRevision = session.revision ?? 0;
      const targetRevision = sourceRevision + 1;
      const createdAt = new Date();
      const summaryHash = createHash('sha256').update(input.summary).digest('hex');
      tx.insert(sessionCompactions)
        .values({
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
        })
        .run();
      tx
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
        .where(eq(sessions.id, input.sessionId))
        .run();
      tx.insert(messages)
        .values({
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
        })
        .run();
      return { sourceRevision, targetRevision };
    });
  }

  async getActiveBoundary(sessionId: string): Promise<ConversationBoundary> {
    const [session] = await db
      .select({
        messageId: sessions.activeMessageId,
        contextRevision: sessions.conversationRevision,
        providerConversationRevision: sessions.providerConversationRevision,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (!session) throw new Error('Session not found');
    return {
      messageId: session.messageId,
      contextRevision: session.contextRevision ?? 0,
      providerConversationRevision: session.providerConversationRevision ?? 0,
    };
  }

  async activateResponseVariant(
    input: ActivateResponseVariantInput,
  ): Promise<VariantActivationResult | undefined> {
    return db.transaction(
      (tx) => {
        const [session] = tx
          .select({
            activeMessageId: sessions.activeMessageId,
            conversationRevision: sessions.conversationRevision,
            providerConversationRevision: sessions.providerConversationRevision,
            messageCount: sessions.messageCount,
            archivedAt: sessions.archivedAt,
          })
          .from(sessions)
          .where(eq(sessions.id, input.sessionId))
          .limit(1)
          .all();
        if (!session) return undefined;
        if (session.archivedAt !== null) {
          throw new ConflictError(
            'Recover this archived chat before selecting a response variant.',
          );
        }
        if (
          session.activeMessageId !== input.expectedActiveMessageId ||
          (session.providerConversationRevision ?? 0) !== input.expectedProviderConversationRevision
        ) {
          throw new ConflictError(
            'Conversation changed before the response variant was activated.',
            {
              expectedRevision: input.expectedProviderConversationRevision,
              currentRevision: session.providerConversationRevision ?? 0,
            },
          );
        }

        const [target] = tx
          .select({
            role: messages.role,
            parentMessageId: messages.parentMessageId,
            variantGroupId: messages.variantGroupId,
            contextRevision: messages.contextRevision,
          })
          .from(messages)
          .where(and(eq(messages.id, input.messageId), eq(messages.sessionId, input.sessionId)))
          .limit(1)
          .all();
        if (!target) return undefined;
        if (target.role !== 'assistant' || !target.parentMessageId || !target.variantGroupId) {
          throw new ConflictError('The selected message is not a retained response variant.');
        }

        const [prompt] = tx
          .select({
            role: messages.role,
            contextRevision: messages.contextRevision,
          })
          .from(messages)
          .where(
            and(eq(messages.id, target.parentMessageId), eq(messages.sessionId, input.sessionId)),
          )
          .limit(1)
          .all();
        if (
          !prompt ||
          prompt.role !== 'user' ||
          (prompt.contextRevision ?? 0) !== (target.contextRevision ?? 0)
        ) {
          throw new ConflictError('The selected response variant has an invalid prompt boundary.');
        }

        const [activeGroupHealth] = tx.values<[number, number, number]>(sql`
          WITH RECURSIVE active_lineage(
            id, role, parent_message_id, variant_group_id, depth, visited
          ) AS (
            SELECT
              "id",
              "role",
              "parent_message_id",
              "variant_group_id",
              0,
              ',' || hex("id") || ','
            FROM ${messages}
            WHERE "id" = ${session.activeMessageId}
              AND "session_id" = ${input.sessionId}

            UNION ALL

            SELECT
              parent."id",
              parent."role",
              parent."parent_message_id",
              parent."variant_group_id",
              active_lineage.depth + 1,
              active_lineage.visited || hex(parent."id") || ','
            FROM ${messages} AS parent
            JOIN active_lineage ON parent."id" = active_lineage.parent_message_id
            WHERE parent."session_id" = ${input.sessionId}
              AND active_lineage.depth < ${MAX_ACTIVE_LINEAGE_DEPTH - 1}
              AND instr(active_lineage.visited, ',' || hex(parent."id") || ',') = 0
          )
          SELECT
            COUNT(*) AS group_count,
            COALESCE(SUM(CASE
              WHEN role = 'assistant' AND parent_message_id = ${target.parentMessageId}
              THEN 1 ELSE 0
            END), 0) AS valid_group_count,
            COALESCE(SUM(CASE WHEN id = ${target.parentMessageId} THEN 1 ELSE 0 END), 0)
              AS prompt_count
          FROM active_lineage
          WHERE variant_group_id = ${target.variantGroupId}
             OR id = ${target.parentMessageId}
        `);
        const [groupCount = 0, validGroupCount = 0, promptCount = 0] = activeGroupHealth ?? [];
        if (groupCount - promptCount < 1 || validGroupCount !== groupCount - promptCount) {
          throw new ConflictError(
            'This response group is no longer selected on the active conversation.',
          );
        }
        if (promptCount !== 1) {
          throw new ConflictError('The response prompt is no longer on the active conversation.');
        }

        writeActiveBoundary(tx, {
          sessionId: input.sessionId,
          messageId: input.messageId,
          contextRevision: target.contextRevision ?? 0,
          updatedAt: new Date(),
          expected: {
            activeMessageId: input.expectedActiveMessageId,
            providerConversationRevision: input.expectedProviderConversationRevision,
          },
        });
        const [activated] = tx
          .select({
            messageCount: sessions.messageCount,
            providerConversationRevision: sessions.providerConversationRevision,
          })
          .from(sessions)
          .where(eq(sessions.id, input.sessionId))
          .limit(1)
          .all();
        if (!activated) throw new Error('Session disappeared while activating a response variant');

        return {
          previousActiveMessageId: input.expectedActiveMessageId,
          activeMessageId: input.messageId,
          conversationRevision: target.contextRevision ?? 0,
          providerConversationRevision: activated.providerConversationRevision ?? 0,
          rewoundMessageCount: Math.max(
            (session.messageCount ?? 0) - (activated.messageCount ?? 0),
            0,
          ),
        };
      },
      { behavior: 'immediate' },
    );
  }

  async setActiveBoundary(
    sessionId: string,
    messageId: string | null,
    options: SetConversationBoundaryOptions = {},
  ): Promise<ConversationBoundaryReceipt> {
    return db.transaction((tx) => {
      const [session] = tx
        .select({
          activeMessageId: sessions.activeMessageId,
          contextRevision: sessions.conversationRevision,
          updatedAt: sessions.updatedAt,
        })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1)
        .all();
      if (!session) throw new Error('Session not found');

      const pivot =
        messageId === null
          ? null
          : (
              tx
                .select({
                  sessionId: messages.sessionId,
                  contextRevision: messages.contextRevision,
                })
                .from(messages)
                .where(and(eq(messages.id, messageId), eq(messages.sessionId, sessionId)))
                .limit(1)
                .all()
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
      writeActiveBoundary(tx, {
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
    db.transaction((tx) => {
      const [session] = tx
        .select({
          activeMessageId: sessions.activeMessageId,
          contextRevision: sessions.conversationRevision,
        })
        .from(sessions)
        .where(eq(sessions.id, receipt.sessionId))
        .limit(1)
        .all();
      if (!session) throw new Error('Session not found');
      if (
        session.activeMessageId !== receipt.current.messageId ||
        (session.contextRevision ?? 0) !== receipt.current.contextRevision
      ) {
        throw new Error('Conversation changed after the recovery step; refusing to overwrite it');
      }
      if (receipt.previous.messageId) {
        const [previous] = tx
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
          .limit(1)
          .all();
        if (!previous) throw new Error('Previous conversation boundary is no longer available');
        if ((previous.contextRevision ?? 0) !== receipt.previous.contextRevision) {
          throw new Error('Previous conversation boundary receipt is invalid');
        }
      }
      writeActiveBoundary(tx, {
        sessionId: receipt.sessionId,
        messageId: receipt.previous.messageId,
        contextRevision: receipt.previous.contextRevision,
        updatedAt: new Date(),
      });
    });
  }

  async getRegenerationCandidate(
    sessionId: string,
    messageId: string,
  ): Promise<RegenerationCandidate | undefined> {
    const [target] = await db
      .select()
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.sessionId, sessionId)))
      .limit(1);
    if (!target || target.role !== 'assistant' || !target.parentMessageId) return undefined;
    const [prompt] = await db
      .select()
      .from(messages)
      .where(and(eq(messages.id, target.parentMessageId), eq(messages.sessionId, sessionId)))
      .limit(1);
    if (!prompt || prompt.role !== 'user') return undefined;

    const [session] = await db
      .select({
        messageId: sessions.activeMessageId,
        contextRevision: sessions.conversationRevision,
        providerConversationRevision: sessions.providerConversationRevision,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (!session) return undefined;
    const boundary = {
      messageId: session.messageId,
      contextRevision: session.contextRevision ?? 0,
    };
    const activeIds = new Set(
      this.getActiveLineageIds(sessionId, MAX_ACTIVE_LINEAGE_DEPTH, 'oldest'),
    );
    // A retained sibling answer is a valid target, but its prompt must still
    // belong to the active branch. This rejects stale UI actions after rewind.
    if (!activeIds.has(prompt.id)) return undefined;
    return {
      target: toStoredMessage(target),
      prompt: toStoredMessage(prompt),
      boundary,
      providerConversationRevision: session.providerConversationRevision ?? 0,
    };
  }

  async prepareRegenerationBranch(
    input: PrepareRegenerationBranchInput,
  ): Promise<RegenerationBranchReservation> {
    return db.transaction((tx) => {
      const [session] = tx
        .select({
          activeMessageId: sessions.activeMessageId,
          providerConversationRevision: sessions.providerConversationRevision,
          archivedAt: sessions.archivedAt,
        })
        .from(sessions)
        .where(eq(sessions.id, input.sessionId))
        .limit(1)
        .all();
      if (!session) throw new Error('Session not found');
      if (session.archivedAt !== null) {
        throw new ConflictError('Recover this archived chat before regenerating a response.');
      }
      if (session.activeMessageId !== input.expectedActiveMessageId) {
        throw new ConflictError('Conversation changed before regeneration could start.');
      }
      if (
        (session.providerConversationRevision ?? 0) !== input.expectedProviderConversationRevision
      ) {
        throw new ConflictError('Conversation history changed before regeneration could start.');
      }
      if (!session.activeMessageId) {
        throw new ConflictError('The active conversation has no response to regenerate.');
      }

      const [target] = tx
        .select()
        .from(messages)
        .where(and(eq(messages.id, input.targetMessageId), eq(messages.sessionId, input.sessionId)))
        .limit(1)
        .all();
      const [prompt] = tx
        .select()
        .from(messages)
        .where(and(eq(messages.id, input.promptMessageId), eq(messages.sessionId, input.sessionId)))
        .limit(1)
        .all();
      if (
        !target ||
        target.role !== 'assistant' ||
        !prompt ||
        prompt.role !== 'user' ||
        target.parentMessageId !== prompt.id
      ) {
        throw new ConflictError('The response is no longer attached to its original prompt.');
      }

      const [reachability] = tx.values<[number]>(sql`
        WITH RECURSIVE active_lineage(id, parent_message_id, depth, visited) AS (
          SELECT
            "id",
            "parent_message_id",
            0,
            ',' || hex("id") || ','
          FROM ${messages}
          WHERE "id" = ${session.activeMessageId}
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
        SELECT COUNT(*)
        FROM active_lineage
        WHERE id = ${prompt.id}
      `);
      if ((reachability?.[0] ?? 0) !== 1) {
        throw new ConflictError('The original prompt is no longer on the active conversation.');
      }

      const groupId = target.variantGroupId ?? `response-${prompt.id}`;
      if (!target.variantGroupId) {
        tx
          .update(messages)
          .set({ variantGroupId: groupId, variantIndex: 0 })
          .where(and(eq(messages.id, target.id), eq(messages.sessionId, input.sessionId)))
          .run();
      }
      const [variantAggregate] = tx
        .select({
          maxIndex: sql<number>`COALESCE(MAX(${messages.variantIndex}), -1)`.as('max_index'),
        })
        .from(messages)
        .where(and(eq(messages.sessionId, input.sessionId), eq(messages.variantGroupId, groupId)))
        .all();
      const index = Number(variantAggregate?.maxIndex ?? -1) + 1;
      return {
        sessionId: input.sessionId,
        targetMessageId: target.id,
        promptMessageId: prompt.id,
        expectedActiveMessageId: session.activeMessageId,
        expectedProviderConversationRevision: session.providerConversationRevision ?? 0,
        contextRevision: prompt.contextRevision ?? 0,
        groupId,
        index,
      };
    });
  }

  async commitRegeneratedResponse(
    reservation: RegenerationBranchReservation,
    message: StoredMessage,
  ): Promise<void> {
    if (message.sessionId !== reservation.sessionId || message.role !== 'assistant') {
      throw new Error('Regenerated response does not match its branch reservation');
    }
    if (
      message.variantGroupId !== reservation.groupId ||
      message.variantIndex !== reservation.index
    ) {
      throw new Error('Regenerated response variant identity does not match its reservation');
    }
    const msgTokensIn = message.tokensIn ?? 0;
    const msgTokensOut = message.tokensOut ?? 0;
    const msgCost = message.cost ?? 0;
    db.transaction((tx) => {
      const [session] = tx
        .select({
          activeMessageId: sessions.activeMessageId,
          providerConversationRevision: sessions.providerConversationRevision,
          archivedAt: sessions.archivedAt,
        })
        .from(sessions)
        .where(eq(sessions.id, reservation.sessionId))
        .limit(1)
        .all();
      if (!session) throw new Error('Session not found');
      if (session.archivedAt !== null) {
        throw new ConflictError('Recover this archived chat before regenerating a response.');
      }
      if (session.activeMessageId !== reservation.expectedActiveMessageId) {
        throw new ConflictError('Conversation changed while the regenerated response was running.');
      }
      if (
        (session.providerConversationRevision ?? 0) !==
        reservation.expectedProviderConversationRevision
      ) {
        throw new ConflictError(
          'Conversation history changed while the regenerated response was running.',
        );
      }
      const [target] = tx
        .select({
          role: messages.role,
          parentMessageId: messages.parentMessageId,
          variantGroupId: messages.variantGroupId,
        })
        .from(messages)
        .where(
          and(
            eq(messages.id, reservation.targetMessageId),
            eq(messages.sessionId, reservation.sessionId),
          ),
        )
        .limit(1)
        .all();
      const [prompt] = tx
        .select({
          role: messages.role,
          contextRevision: messages.contextRevision,
        })
        .from(messages)
        .where(
          and(
            eq(messages.id, reservation.promptMessageId),
            eq(messages.sessionId, reservation.sessionId),
          ),
        )
        .limit(1)
        .all();
      if (
        !target ||
        target.role !== 'assistant' ||
        target.parentMessageId !== reservation.promptMessageId ||
        target.variantGroupId !== reservation.groupId ||
        !prompt ||
        prompt.role !== 'user' ||
        (prompt.contextRevision ?? 0) !== reservation.contextRevision
      ) {
        throw new ConflictError('Regeneration branch reservation is stale or invalid.');
      }
      const [collision] = tx
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.sessionId, reservation.sessionId),
            eq(messages.variantGroupId, reservation.groupId),
            eq(messages.variantIndex, reservation.index),
          ),
        )
        .limit(1)
        .all();
      if (collision) throw new ConflictError('This response variant has already been committed.');

      tx.insert(messages)
        .values({
          id: message.id,
          sessionId: reservation.sessionId,
          role: 'assistant',
          content: serializeStoredContent(message.content, message.attachments),
          model: message.model ?? null,
          provider: message.provider ?? null,
          tokensIn: msgTokensIn,
          tokensOut: msgTokensOut,
          cost: msgCost,
          variantGroupId: reservation.groupId,
          variantIndex: reservation.index,
          contextRevision: reservation.contextRevision,
          parentMessageId: reservation.promptMessageId,
          createdAt: new Date(message.createdAt),
        })
        .run();
      writeActiveBoundary(tx, {
        sessionId: reservation.sessionId,
        messageId: message.id,
        contextRevision: reservation.contextRevision,
        updatedAt: new Date(message.createdAt),
      });
    });
  }

  /** Compatibility path for older callers. No rows are deleted. */
  async truncateAfter(sessionId: string, messageId: string): Promise<void> {
    await this.setActiveBoundary(sessionId, messageId);
  }

  async replaceAndTruncate(sessionId: string, messageId: string, content: string): Promise<number> {
    return db.transaction((tx) => {
      const [pivot] = tx
        .select({
          content: messages.content,
          role: messages.role,
          contextRevision: messages.contextRevision,
        })
        .from(messages)
        .where(and(eq(messages.id, messageId), eq(messages.sessionId, sessionId)))
        .limit(1)
        .all();
      if (!pivot || pivot.role !== 'user') throw new Error('Editable user message not found');
      const [session] = tx
        .select({ messageCount: sessions.messageCount })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1)
        .all();
      if (!session) throw new Error('Session not found');
      const stored = parseStoredContent(pivot.content);
      tx
        .update(messages)
        .set({ content: serializeStoredContent(content, stored.attachments) })
        .where(and(eq(messages.id, messageId), eq(messages.sessionId, sessionId)))
        .run();
      writeActiveBoundary(tx, {
        sessionId,
        messageId,
        contextRevision: pivot.contextRevision ?? 0,
        updatedAt: new Date(),
      });
      const [rewritten] = tx
        .select({ messageCount: sessions.messageCount })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1)
        .all();
      return Math.max((session.messageCount ?? 0) - (rewritten?.messageCount ?? 0), 0);
    });
  }

  /** Permanently delete one coherent conversation subtree. Descendants cannot
   *  be spliced around the removed node: doing so manufactures user->user or
   *  assistant->assistant histories that no provider actually saw.
   *  Returns true if the target existed, false if it was not found. */
  async deleteMessage(sessionId: string, messageId: string): Promise<boolean> {
    return db.transaction((tx) => {
      const [target] = tx
        .select({ parentMessageId: messages.parentMessageId })
        .from(messages)
        .where(and(eq(messages.id, messageId), eq(messages.sessionId, sessionId)))
        .limit(1)
        .all();
      if (!target) return false;
      const [session] = tx
        .select({
          activeMessageId: sessions.activeMessageId,
          contextRevision: sessions.conversationRevision,
          archivedAt: sessions.archivedAt,
        })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1)
        .all();
      if (!session) return false;
      if (session.archivedAt !== null) {
        throw new ConflictError('Recover this archived chat before deleting messages.');
      }

      const descendants = tx.all<{ id: string }>(sql`
        WITH RECURSIVE descendants(id) AS (
          SELECT "id"
          FROM ${messages}
          WHERE "session_id" = ${sessionId} AND "id" = ${messageId}

          UNION

          SELECT child."id"
          FROM ${messages} AS child
          JOIN descendants ON child."parent_message_id" = descendants.id
          WHERE child."session_id" = ${sessionId}
        )
        SELECT id FROM descendants
      `);
      const activeBranchWasPruned =
        session.activeMessageId !== null &&
        descendants.some((descendant) => descendant.id === session.activeMessageId);
      const nextHead = activeBranchWasPruned
        ? target.parentMessageId
        : session.activeMessageId;
      let nextContextRevision = session.contextRevision ?? 0;
      if (activeBranchWasPruned) {
        if (nextHead) {
          const [parent] = tx
            .select({ contextRevision: messages.contextRevision })
            .from(messages)
            .where(and(eq(messages.id, nextHead), eq(messages.sessionId, sessionId)))
            .limit(1)
            .all();
          nextContextRevision = parent?.contextRevision ?? 0;
        } else {
          nextContextRevision = 0;
        }
      }

      tx.run(sql`
        WITH RECURSIVE descendants(id) AS (
          SELECT "id"
          FROM ${messages}
          WHERE "session_id" = ${sessionId} AND "id" = ${messageId}

          UNION

          SELECT child."id"
          FROM ${messages} AS child
          JOIN descendants ON child."parent_message_id" = descendants.id
          WHERE child."session_id" = ${sessionId}
        )
        DELETE FROM ${messages}
        WHERE "session_id" = ${sessionId}
          AND "id" IN (SELECT id FROM descendants)
      `);
      writeActiveBoundary(tx, {
        sessionId,
        messageId: nextHead,
        contextRevision: nextContextRevision,
        updatedAt: new Date(),
      });
      return true;
    });
  }
}
