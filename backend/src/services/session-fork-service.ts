import type { Session as SharedSession } from '@koryphaios/shared';
import { nanoid } from 'nanoid';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { ID, SESSION } from '../constants';
import { db, messages, sessionCompactions, sessions } from '../db';
import { NotFoundError, ValidationError } from '../errors/types';
import { sanitizeSessionAgentOverrides } from '../stores/session-store';

/** Mirrors the message store's recovery bound so a corrupt chain cannot hang a fork. */
const MAX_FORK_LINEAGE_DEPTH = 10_000;
const FORK_TITLE_SUFFIX = ' (fork)';
const COMPACTION_ID_PREFIX = 'compact-';

export interface ForkSessionInput {
  sourceSessionId: string;
  /** The message the fork ends at. It and every ancestor are copied. */
  messageId: string;
}

export interface ForkSessionResult {
  session: SharedSession;
  copiedMessageCount: number;
}

function forkTitle(sourceTitle: string): string {
  const base = sourceTitle.trim() || SESSION.DEFAULT_TITLE;
  const room = SESSION.MAX_TITLE_LENGTH - FORK_TITLE_SUFFIX.length;
  return `${base.length > room ? base.slice(0, room).trimEnd() : base}${FORK_TITLE_SUFFIX}`;
}

function parseMetadata(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Create a new chat whose history is the source chat's lineage up to and
 * including `messageId`.
 *
 * The copy is a snapshot taken in one SQLite transaction, so it is safe while
 * the source chat keeps running. Copied rows get fresh ids and carry zero
 * tokens and cost: that spend was already billed to the source chat, and the
 * spend caps sum `messages.cost`, so copying it would double-count usage.
 *
 * The source's isolated Git workspace is deliberately not inherited. Its
 * lifecycle belongs to the source chat (erasure may remove it), so the fork
 * shares the same working directory without claiming ownership of it.
 */
export function forkSessionAtMessage(input: ForkSessionInput): ForkSessionResult {
  const { sourceSessionId, messageId } = input;
  if (!messageId.trim()) throw new ValidationError('Choose a message to fork from.');

  return db.transaction((tx) => {
    const [source] = tx
      .select()
      .from(sessions)
      .where(eq(sessions.id, sourceSessionId))
      .limit(1)
      .all();
    if (!source) throw new NotFoundError('Session', sourceSessionId);

    // Walk parent links from the fork point back to the root. Every revision
    // is copied: pre-compaction rows stay visible as history and the
    // compaction checkpoint row keeps the post-compaction context intact.
    const lineageRows = tx.values<[string]>(sql`
      WITH RECURSIVE fork_lineage(id, parent_message_id, depth, visited) AS (
        SELECT
          "id",
          "parent_message_id",
          0,
          ',' || hex("id") || ','
        FROM ${messages}
        WHERE "id" = ${messageId}
          AND "session_id" = ${sourceSessionId}

        UNION ALL

        SELECT
          parent."id",
          parent."parent_message_id",
          fork_lineage.depth + 1,
          fork_lineage.visited || hex(parent."id") || ','
        FROM ${messages} AS parent
        JOIN fork_lineage ON parent."id" = fork_lineage.parent_message_id
        WHERE parent."session_id" = ${sourceSessionId}
          AND fork_lineage.depth < ${MAX_FORK_LINEAGE_DEPTH - 1}
          AND instr(fork_lineage.visited, ',' || hex(parent."id") || ',') = 0
      )
      SELECT id FROM fork_lineage ORDER BY depth DESC
    `);
    const lineageIds = lineageRows.map(([id]) => id);
    if (lineageIds.length === 0) {
      throw new NotFoundError('Message', messageId);
    }

    const rows = tx.select().from(messages).where(inArray(messages.id, lineageIds)).all();
    const byId = new Map(rows.map((row) => [row.id, row]));
    const ordered = lineageIds.flatMap((id) => {
      const row = byId.get(id);
      return row ? [row] : [];
    });
    const pivot = ordered[ordered.length - 1];
    if (!pivot || pivot.id !== messageId) throw new NotFoundError('Message', messageId);

    const sourceCompactionIds = ordered
      .filter((row) => row.id.startsWith(COMPACTION_ID_PREFIX))
      .map((row) => row.id.slice(COMPACTION_ID_PREFIX.length));
    const compactions =
      sourceCompactionIds.length > 0
        ? tx
            .select()
            .from(sessionCompactions)
            .where(
              and(
                eq(sessionCompactions.sessionId, sourceSessionId),
                inArray(sessionCompactions.id, sourceCompactionIds),
              ),
            )
            .all()
        : [];

    const sourceMetadata = parseMetadata(source.metadata);
    const agentOverrides = sanitizeSessionAgentOverrides(sourceMetadata.agentOverrides);
    const now = new Date();
    const newSessionId = nanoid(ID.SESSION_ID_LENGTH);
    const title = forkTitle(source.title);
    const metadata = {
      ...(sourceMetadata.interactionMode === 'plan' ? { interactionMode: 'plan' } : {}),
      ...(agentOverrides ? { agentOverrides } : {}),
      forkedFrom: {
        sessionId: sourceSessionId,
        messageId,
        forkedAt: now.getTime(),
      },
    };

    tx.insert(sessions)
      .values({
        id: newSessionId,
        userId: source.userId,
        title,
        parentId: sourceSessionId,
        workingDirectory: source.workingDirectory,
        metadata: JSON.stringify(metadata),
        messageCount: 0,
        tokensIn: 0,
        tokensOut: 0,
        totalCost: 0,
        conversationRevision: pivot.contextRevision ?? 0,
        // A fresh provider generation: no native CLI transcript belongs to
        // this chat yet, so providers rebuild context from the copied rows.
        providerConversationRevision: 0,
        activeMessageId: null,
        version: 1,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    // Compaction checkpoints are linked to their message by id, so remap both
    // together and keep the `compact-` prefix the manager relies on.
    const compactionIdMap = new Map<string, string>();
    for (const compaction of compactions) {
      const newCompactionId = nanoid(ID.SESSION_ID_LENGTH);
      compactionIdMap.set(compaction.id, newCompactionId);
      tx.insert(sessionCompactions)
        .values({ ...compaction, id: newCompactionId, sessionId: newSessionId })
        .run();
    }

    let parentMessageId: string | null = null;
    for (const row of ordered) {
      const sourceCompactionId = row.id.startsWith(COMPACTION_ID_PREFIX)
        ? row.id.slice(COMPACTION_ID_PREFIX.length)
        : null;
      const mappedCompactionId = sourceCompactionId
        ? compactionIdMap.get(sourceCompactionId)
        : undefined;
      const newMessageId = mappedCompactionId
        ? `${COMPACTION_ID_PREFIX}${mappedCompactionId}`
        : nanoid(ID.SESSION_ID_LENGTH);
      tx.insert(messages)
        .values({
          id: newMessageId,
          sessionId: newSessionId,
          role: row.role,
          content: row.content,
          model: row.model,
          provider: row.provider,
          tokensIn: 0,
          tokensOut: 0,
          cost: 0,
          // Sibling responses stay in the source chat; the fork holds one branch.
          variantGroupId: null,
          variantIndex: 0,
          contextRevision: row.contextRevision ?? 0,
          parentMessageId,
          createdAt: row.createdAt,
        })
        .run();
      parentMessageId = newMessageId;
    }

    tx.update(sessions)
      .set({ activeMessageId: parentMessageId, messageCount: ordered.length })
      .where(eq(sessions.id, newSessionId))
      .run();

    const session: SharedSession = {
      id: newSessionId,
      title,
      status: 'active',
      parentSessionId: sourceSessionId,
      workingDirectory: source.workingDirectory ?? undefined,
      interactionMode: metadata.interactionMode === 'plan' ? 'plan' : 'act',
      agentOverrides,
      messageCount: ordered.length,
      totalTokensIn: 0,
      totalTokensOut: 0,
      totalCost: 0,
      version: 1,
      createdAt: now.getTime(),
      updatedAt: now.getTime(),
    };
    return { session, copiedMessageCount: ordered.length };
  });
}
