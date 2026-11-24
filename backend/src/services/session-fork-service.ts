import type { Session as SharedSession, StoredMessage } from '@koryphaios/shared';
import { nanoid } from 'nanoid';
import { and, eq, inArray, lte, notInArray, sql } from 'drizzle-orm';
import { ID, SESSION } from '../constants';
import {
  db,
  messages,
  sessionCompactions,
  sessionFeedEntries,
  sessionFeedTombstones,
  sessions,
  sessionTurnCommands,
} from '../db';
import { ConflictError, NotFoundError, ValidationError } from '../errors/types';
import { MessageStore } from '../stores/message-store';
import { sanitizeSessionAgentOverrides } from '../stores/session-store';

/** Mirrors the message store's recovery bound so a corrupt chain cannot hang a fork. */
const MAX_FORK_LINEAGE_DEPTH = 10_000;
const FORK_TITLE_SUFFIX = ' (fork)';
const COMPACTION_ID_PREFIX = 'compact-';
const IN_FLIGHT_TURN_STATUSES = ['active', 'waiting'] as const;

/** Prefix of the host-authored context entry a merge-back appends to the source. */
export const FORK_MERGE_MARKER = '[KORY_FORK_MERGE]';
const MERGE_TOTAL_CHARS = 12_000;
const MERGE_MESSAGE_CHARS = 2_000;
const SUMMARY_REQUEST_CHARS = 400;
const SUMMARY_OUTCOME_CHARS = 2_000;

export type ForkMergeMode = 'summary' | 'messages';

export interface ForkSessionInput {
  sourceSessionId: string;
  /**
   * The message the fork ends at. It and every ancestor are copied. Omitted:
   * fork at the source's latest finished point (the active head, stepping back
   * past a turn that is still running).
   */
  messageId?: string;
  /** Optional title. Defaults to the source title plus " (fork)". */
  title?: string;
}

export interface ForkSessionResult {
  session: SharedSession;
  copiedMessageCount: number;
  /** The source message the fork was taken from (the source's own id). */
  forkMessageId: string;
}

function forkTitle(sourceTitle: string): string {
  const base = sourceTitle.trim() || SESSION.DEFAULT_TITLE;
  const room = SESSION.MAX_TITLE_LENGTH - FORK_TITLE_SUFFIX.length;
  return `${base.length > room ? base.slice(0, room).trimEnd() : base}${FORK_TITLE_SUFFIX}`;
}

/** Explicit titles get the same whitespace and length rules as a rename. */
function explicitForkTitle(raw: string): string {
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  if (cleaned.length > SESSION.MAX_TITLE_LENGTH) {
    throw new ValidationError(`A fork title can be at most ${SESSION.MAX_TITLE_LENGTH} characters.`);
  }
  if (cleaned.toLowerCase() === SESSION.DEFAULT_TITLE.toLowerCase()) {
    throw new ValidationError('Choose a descriptive title for the fork.');
  }
  return cleaned;
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

/** Ordered ids from the root down to `startId`, following parent links in one session. */
function lineageToRoot(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  sessionId: string,
  startId: string,
): string[] {
  const rows = tx.values<[string]>(sql`
    WITH RECURSIVE fork_lineage(id, parent_message_id, depth, visited) AS (
      SELECT
        "id",
        "parent_message_id",
        0,
        ',' || hex("id") || ','
      FROM ${messages}
      WHERE "id" = ${startId}
        AND "session_id" = ${sessionId}

      UNION ALL

      SELECT
        parent."id",
        parent."parent_message_id",
        fork_lineage.depth + 1,
        fork_lineage.visited || hex(parent."id") || ','
      FROM ${messages} AS parent
      JOIN fork_lineage ON parent."id" = fork_lineage.parent_message_id
      WHERE parent."session_id" = ${sessionId}
        AND fork_lineage.depth < ${MAX_FORK_LINEAGE_DEPTH - 1}
        AND instr(fork_lineage.visited, ',' || hex(parent."id") || ',') = 0
    )
    SELECT id FROM fork_lineage ORDER BY depth DESC
  `);
  return rows.map(([id]) => id);
}

/** Message ids of turns that have not settled yet in this chat. */
function inFlightMessageIds(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  sessionId: string,
): Set<string> {
  const rows = tx
    .select({
      userMessageId: sessionTurnCommands.userMessageId,
      responseMessageId: sessionTurnCommands.responseMessageId,
    })
    .from(sessionTurnCommands)
    .where(
      and(
        eq(sessionTurnCommands.sessionId, sessionId),
        inArray(sessionTurnCommands.status, [...IN_FLIGHT_TURN_STATUSES]),
      ),
    )
    .all();
  return new Set(rows.flatMap((row) => [row.userMessageId, row.responseMessageId]));
}

/**
 * Create a new chat whose history is the source chat's lineage up to and
 * including the fork point.
 *
 * Any finished point is a valid fork point: completed, failed, interrupted and
 * cancelled turns alike. The fork point must not belong to a turn that is still
 * running, because its reply is not yet durable and the snapshot would be
 * incomplete. Without an explicit point, the fork takes the latest finished
 * message, stepping back past a running turn.
 *
 * The copy is one SQLite transaction, so it is a consistent snapshot while the
 * source keeps running. Copied rows get fresh ids and carry zero tokens and
 * cost: that spend was already billed to the source chat, and the spend caps sum
 * `messages.cost`, so copying it would double-count usage. Content is copied
 * verbatim, so persisted `parts` (the ordered transcript) and inline attachments
 * (images included) render the same after a reload.
 *
 * Copied: the lineage, variant siblings of copied responses (so the fork shows
 * the same alternatives), compaction checkpoints, client feed errors and message
 * hide markers that sit at or before the fork point.
 *
 * Not copied, deliberately: the source's isolated Git workspace (its lifecycle
 * belongs to the source), the Plan note, any provider-native conversation state
 * (for example Jules' remote session in `metadata.jules`, or an Antigravity
 * conversation cache keyed by session id), and in-flight turn ledger rows. The
 * fork starts with `providerConversationRevision` 0, so no native transcript is
 * resumed. See docs/chat-forks.md.
 */
export function forkSessionAtMessage(input: ForkSessionInput): ForkSessionResult {
  const { sourceSessionId } = input;
  const requestedMessageId = input.messageId?.trim();
  if (input.messageId !== undefined && !requestedMessageId) {
    throw new ValidationError('Choose a message to fork from.');
  }
  const title = input.title === undefined ? undefined : explicitForkTitle(input.title);

  return db.transaction((tx) => {
    const [source] = tx
      .select()
      .from(sessions)
      .where(eq(sessions.id, sourceSessionId))
      .limit(1)
      .all();
    if (!source) throw new NotFoundError('Session', sourceSessionId);

    const inFlight = inFlightMessageIds(tx, sourceSessionId);
    let lineageIds: string[];
    if (requestedMessageId) {
      if (inFlight.has(requestedMessageId)) {
        throw new ConflictError('Wait for this turn to finish before forking from its message.');
      }
      lineageIds = lineageToRoot(tx, sourceSessionId, requestedMessageId);
      if (lineageIds.length === 0) throw new NotFoundError('Message', requestedMessageId);
    } else {
      if (!source.activeMessageId) {
        throw new ValidationError('This chat has no messages to fork from yet.');
      }
      const headLineage = lineageToRoot(tx, sourceSessionId, source.activeMessageId);
      let finishedIndex = headLineage.length - 1;
      while (finishedIndex >= 0 && inFlight.has(headLineage[finishedIndex]!)) finishedIndex -= 1;
      if (finishedIndex < 0) {
        throw new ValidationError('This chat has no finished message to fork from yet.');
      }
      lineageIds = headLineage.slice(0, finishedIndex + 1);
    }

    const rows = tx.select().from(messages).where(inArray(messages.id, lineageIds)).all();
    const byId = new Map(rows.map((row) => [row.id, row]));
    const ordered = lineageIds.flatMap((id) => {
      const row = byId.get(id);
      return row ? [row] : [];
    });
    const pivot = ordered[ordered.length - 1];
    const pivotId = pivot?.id;
    if (!pivot || (requestedMessageId && pivotId !== requestedMessageId)) {
      throw new NotFoundError('Message', requestedMessageId ?? sourceSessionId);
    }

    // Variant siblings of copied responses: the alternatives the user can switch
    // between. Only those whose parent is part of the copied lineage are kept.
    const lineageSet = new Set(ordered.map((row) => row.id));
    const variantGroupIds = [
      ...new Set(
        ordered.flatMap((row) => (row.variantGroupId ? [row.variantGroupId] : [])),
      ),
    ];
    const siblings =
      variantGroupIds.length > 0
        ? tx
            .select()
            .from(messages)
            .where(
              and(
                eq(messages.sessionId, sourceSessionId),
                inArray(messages.variantGroupId, variantGroupIds),
                notInArray(messages.id, [...lineageSet]),
              ),
            )
            .all()
            .filter((row) => row.parentMessageId !== null && lineageSet.has(row.parentMessageId))
            .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
        : [];

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

    const feedEntries = tx
      .select()
      .from(sessionFeedEntries)
      .where(
        and(
          eq(sessionFeedEntries.sessionId, sourceSessionId),
          lte(sessionFeedEntries.timestamp, pivot.createdAt),
        ),
      )
      .all();
    const tombstones = tx
      .select()
      .from(sessionFeedTombstones)
      .where(eq(sessionFeedTombstones.sessionId, sourceSessionId))
      .all();

    const sourceMetadata = parseMetadata(source.metadata);
    const agentOverrides = sanitizeSessionAgentOverrides(sourceMetadata.agentOverrides);
    const now = new Date();
    const newSessionId = nanoid(ID.SESSION_ID_LENGTH);
    const resolvedTitle = title || forkTitle(source.title);
    const metadata = {
      ...(sourceMetadata.interactionMode === 'plan' ? { interactionMode: 'plan' } : {}),
      ...(agentOverrides ? { agentOverrides } : {}),
    };

    // Compaction checkpoints are linked to their message by id, so remap both
    // together and keep the `compact-` prefix the manager relies on.
    const compactionIdMap = new Map<string, string>();
    for (const compaction of compactions) {
      compactionIdMap.set(compaction.id, nanoid(ID.SESSION_ID_LENGTH));
    }

    // Every copied message gets its new id before any row is written, so parent
    // links (including siblings' parents) can be remapped in one pass.
    const messageIdMap = new Map<string, string>();
    for (const row of [...ordered, ...siblings]) {
      const sourceCompactionId = row.id.startsWith(COMPACTION_ID_PREFIX)
        ? row.id.slice(COMPACTION_ID_PREFIX.length)
        : null;
      const mappedCompactionId = sourceCompactionId
        ? compactionIdMap.get(sourceCompactionId)
        : undefined;
      messageIdMap.set(
        row.id,
        mappedCompactionId
          ? `${COMPACTION_ID_PREFIX}${mappedCompactionId}`
          : nanoid(ID.SESSION_ID_LENGTH),
      );
    }
    const variantGroupMap = new Map<string, string>();
    for (const groupId of variantGroupIds) variantGroupMap.set(groupId, nanoid(ID.SESSION_ID_LENGTH));

    const newPivotId = messageIdMap.get(pivotId!)!;
    const totalMessages = ordered.length + siblings.length;

    tx.insert(sessions)
      .values({
        id: newSessionId,
        userId: source.userId,
        title: resolvedTitle,
        parentId: sourceSessionId,
        forkedFromSessionId: sourceSessionId,
        forkedFromMessageId: pivotId!,
        forkedAt: now,
        forkedBaseMessageId: newPivotId,
        forkedMergedAt: null,
        workingDirectory: source.workingDirectory,
        metadata: JSON.stringify(metadata),
        messageCount: totalMessages,
        tokensIn: 0,
        tokensOut: 0,
        totalCost: 0,
        conversationRevision: pivot.contextRevision ?? 0,
        // A fresh provider generation: no native CLI transcript belongs to
        // this chat yet, so providers rebuild context from the copied rows.
        providerConversationRevision: 0,
        activeMessageId: newPivotId,
        version: 1,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    for (const compaction of compactions) {
      tx.insert(sessionCompactions)
        .values({
          ...compaction,
          id: compactionIdMap.get(compaction.id)!,
          sessionId: newSessionId,
        })
        .run();
    }

    const insertCopy = (row: (typeof ordered)[number], parentMessageId: string | null) => {
      tx.insert(messages)
        .values({
          id: messageIdMap.get(row.id)!,
          sessionId: newSessionId,
          role: row.role,
          content: row.content,
          model: row.model,
          provider: row.provider,
          tokensIn: 0,
          tokensOut: 0,
          cost: 0,
          // The variant group is remapped with its members, so the fork keeps
          // the same alternatives. Spend stays with the source.
          variantGroupId: row.variantGroupId ? variantGroupMap.get(row.variantGroupId)! : null,
          variantIndex: row.variantIndex ?? 0,
          contextRevision: row.contextRevision ?? 0,
          parentMessageId,
          createdAt: row.createdAt,
        })
        .run();
    };

    let parentMessageId: string | null = null;
    for (const row of ordered) {
      insertCopy(row, parentMessageId);
      parentMessageId = messageIdMap.get(row.id)!;
    }
    for (const row of siblings) {
      insertCopy(row, messageIdMap.get(row.parentMessageId!)!);
    }

    for (const entry of feedEntries) {
      tx.insert(sessionFeedEntries)
        .values({
          ...entry,
          id: nanoid(ID.SESSION_ID_LENGTH),
          sessionId: newSessionId,
        })
        .run();
    }
    for (const tombstone of tombstones) {
      const match = /^message:(.+)$/.exec(tombstone.targetKey);
      const mapped = match ? messageIdMap.get(match[1]!) : undefined;
      if (!mapped) continue;
      tx.insert(sessionFeedTombstones)
        .values({ ...tombstone, sessionId: newSessionId, targetKey: `message:${mapped}` })
        .run();
    }

    const session: SharedSession = {
      id: newSessionId,
      title: resolvedTitle,
      status: 'active',
      parentSessionId: sourceSessionId,
      forkedFromSessionId: sourceSessionId,
      forkedFromMessageId: pivotId!,
      forkedAt: now.getTime(),
      workingDirectory: source.workingDirectory ?? undefined,
      interactionMode: metadata.interactionMode === 'plan' ? 'plan' : 'act',
      agentOverrides,
      messageCount: totalMessages,
      totalTokensIn: 0,
      totalTokensOut: 0,
      totalCost: 0,
      version: 1,
      createdAt: now.getTime(),
      updatedAt: now.getTime(),
    };
    return { session, copiedMessageCount: totalMessages, forkMessageId: pivotId! };
  });
}

/* ───────────────────────── Merge-back ───────────────────────── */

export interface ForkMergeDigest {
  sourceSessionId: string;
  forkSessionId: string;
  mode: ForkMergeMode;
  /** The deterministic host-authored entry text (starts with FORK_MERGE_MARKER). */
  content: string;
  newMessageCount: number;
  messageId: string;
}

/** The merge entry's message id is a function of the fork, so a retry of a
 * partially committed merge finds the same row (see commitForkMerge). */
export function forkMergeMessageId(forkSessionId: string): string {
  return `forkmerge-${forkSessionId}`;
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}…` : trimmed;
}

function attachmentCount(message: StoredMessage): number {
  return message.attachments?.length ?? 0;
}

function describeNewMessages(
  mode: ForkMergeMode,
  forkTitleText: string,
  fresh: StoredMessage[],
): string {
  const header = `${FORK_MERGE_MARKER}\nFrom the forked chat "${forkTitleText}" (${fresh.length} new message${fresh.length === 1 ? '' : 's'}).`;
  const attachments = fresh.reduce((sum, message) => sum + attachmentCount(message), 0);
  const attachmentNote =
    attachments > 0
      ? `\n${attachments} attachment${attachments === 1 ? '' : 's'} from the fork ${attachments === 1 ? 'was' : 'were'} not copied.`
      : '';

  if (mode === 'summary') {
    const firstRequest = fresh.find((message) => message.role === 'user' && message.content.trim());
    const lastReply = [...fresh]
      .reverse()
      .find((message) => message.role === 'assistant' && message.content.trim());
    const lines = [
      header,
      firstRequest
        ? `Requested: ${clip(firstRequest.content, SUMMARY_REQUEST_CHARS)}`
        : 'Requested: (no user request was recorded in the fork)',
      lastReply
        ? `Outcome: ${clip(lastReply.content, SUMMARY_OUTCOME_CHARS)}`
        : 'Outcome: no reply was recorded in the fork.',
    ];
    return `${lines.join('\n')}${attachmentNote}`;
  }

  // Quote the newest messages first so the outcome survives the budget.
  const picked: string[] = [];
  let used = header.length + attachmentNote.length;
  let omitted = 0;
  for (let index = fresh.length - 1; index >= 0; index -= 1) {
    const message = fresh[index]!;
    const label = message.role === 'user' ? 'User' : message.role === 'assistant' ? 'Assistant' : 'Note';
    const body = clip(message.content, MERGE_MESSAGE_CHARS) || '(no text)';
    const line = `${label}: ${body}`;
    if (used + line.length + 2 > MERGE_TOTAL_CHARS) {
      omitted = index + 1;
      break;
    }
    picked.unshift(line);
    used += line.length + 2;
  }
  const omittedNote =
    omitted > 0 ? `\n(${omitted} earlier message${omitted === 1 ? '' : 's'} omitted to fit.)` : '';
  return `${header}\n\n${picked.join('\n\n')}${omittedNote}${attachmentNote}`;
}

/**
 * Build the merge-back entry for a fork without writing anything. Throws when
 * the fork cannot be merged: not a fork, already merged, archived, nothing new,
 * or either side has a turn still running.
 *
 * "New" means the fork's active path after its base (its copy of the fork
 * point). If the base is no longer on that path, the whole path is merged.
 */
export async function buildForkMergeDigest(input: {
  forkSessionId: string;
  mode: ForkMergeMode;
}): Promise<ForkMergeDigest> {
  const { forkSessionId, mode } = input;
  const digest = db.transaction((tx) => {
    const [fork] = tx.select().from(sessions).where(eq(sessions.id, forkSessionId)).limit(1).all();
    if (!fork) throw new NotFoundError('Session', forkSessionId);
    if (!fork.forkedFromSessionId) {
      throw new ValidationError('This chat was not forked from another chat, so there is nothing to merge back.');
    }
    if (fork.forkedMergedAt) {
      throw new ConflictError('This fork was already merged into its source chat.');
    }
    if (fork.archivedAt) {
      throw new ConflictError('Recover this archived chat before merging it back.');
    }
    const sourceId = fork.forkedFromSessionId;
    const [source] = tx.select().from(sessions).where(eq(sessions.id, sourceId)).limit(1).all();
    if (!source) throw new ConflictError('The chat this fork came from no longer exists.');
    if (source.archivedAt) {
      throw new ConflictError('Recover the source chat before merging this fork back into it.');
    }
    if (inFlightMessageIds(tx, sourceId).size > 0) {
      throw new ConflictError('Wait for the source chat to finish its active turn before merging.');
    }
    if (inFlightMessageIds(tx, forkSessionId).size > 0) {
      throw new ConflictError('Wait for the fork to finish its active turn before merging.');
    }
    return { fork, sourceId };
  });

  // The whole active path, not the default page: a long fork must still find its base.
  const forkMessages = await new MessageStore().getAll(forkSessionId, 10_000);
  const base = digest.fork.forkedBaseMessageId;
  const baseIndex = base ? forkMessages.findIndex((message) => message.id === base) : -1;
  const fresh = (baseIndex >= 0 ? forkMessages.slice(baseIndex + 1) : forkMessages).filter(
    (message) => message.role !== 'system' || !message.content.startsWith(FORK_MERGE_MARKER),
  );
  if (fresh.length === 0) {
    throw new ValidationError('The fork has no new messages to merge back.');
  }

  return {
    sourceSessionId: digest.sourceId,
    forkSessionId,
    mode,
    content: describeNewMessages(mode, digest.fork.title, fresh),
    newMessageCount: fresh.length,
    messageId: forkMergeMessageId(forkSessionId),
  };
}

/**
 * Append a digest to the source transcript through the message store's
 * idempotent write path, then mark the fork merged.
 *
 * The entry is a host-authored `system` row, never a user turn, so it starts no
 * provider run. The write is retry-safe: the id is derived from the fork and
 * the content is deterministic, so if the process dies between the two steps,
 * a retry finds the identical row and only completes the mark.
 */
export async function commitForkMerge(
  digest: ForkMergeDigest,
  now = Date.now(),
): Promise<{ sourceSessionId: string; messageId: string }> {
  const message: StoredMessage = {
    id: digest.messageId,
    sessionId: digest.sourceSessionId,
    role: 'system',
    content: digest.content,
    createdAt: now,
  };
  await new MessageStore().addIdempotent(digest.sourceSessionId, message);
  db.update(sessions)
    .set({
      forkedMergedAt: new Date(now),
      version: sql`COALESCE(${sessions.version}, 1) + 1`,
      updatedAt: new Date(now),
    })
    .where(and(eq(sessions.id, digest.forkSessionId), sql`${sessions.forkedMergedAt} IS NULL`))
    .run();
  return { sourceSessionId: digest.sourceSessionId, messageId: digest.messageId };
}
