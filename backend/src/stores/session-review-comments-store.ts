import type { ReviewComment, ReviewCommentSide, ReviewCommentStatus } from '@koryphaios/shared';
import { REVIEW_COMMENT_MAX_PER_SESSION } from '@koryphaios/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db, sessionReviewComments } from '../db';

type Row = typeof sessionReviewComments.$inferSelect;

function mapRow(row: Row): ReviewComment {
  return {
    id: row.id,
    sessionId: row.sessionId,
    filePath: row.filePath,
    line: row.line,
    side: row.side as ReviewCommentSide,
    staged: row.staged === 1,
    body: row.body,
    ...(row.hunkHeader ? { hunkHeader: row.hunkHeader } : {}),
    status: row.status as ReviewCommentStatus,
    ...(row.sentBatchId ? { sentBatchId: row.sentBatchId } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.resolvedAt != null ? { resolvedAt: row.resolvedAt } : {}),
  };
}

export class SessionLimitError extends Error {
  constructor() {
    super(
      `A chat can hold at most ${REVIEW_COMMENT_MAX_PER_SESSION} review comments. Resolve or delete some first.`,
    );
    this.name = 'SessionLimitError';
  }
}

export interface NewReviewCommentRow {
  sessionId: string;
  filePath: string;
  line: number;
  side: ReviewCommentSide;
  staged: boolean;
  body: string;
  hunkHeader?: string;
}

/** Durable review comments. Every query is scoped by sessionId. */
export async function listReviewComments(
  sessionId: string,
  status: ReviewCommentStatus | 'all' = 'all',
): Promise<ReviewComment[]> {
  const rows = await db
    .select()
    .from(sessionReviewComments)
    .where(
      and(
        eq(sessionReviewComments.sessionId, sessionId),
        status === 'all' ? undefined : eq(sessionReviewComments.status, status),
      ),
    )
    .orderBy(asc(sessionReviewComments.createdAt), asc(sessionReviewComments.id));
  return rows.map(mapRow);
}

export function createReviewComment(input: NewReviewCommentRow, now = Date.now()): ReviewComment {
  return db.transaction(
    (tx) => {
      const count = tx
        .select({ id: sessionReviewComments.id })
        .from(sessionReviewComments)
        .where(eq(sessionReviewComments.sessionId, input.sessionId))
        .all().length;
      if (count >= REVIEW_COMMENT_MAX_PER_SESSION) throw new SessionLimitError();
      const row: Row = {
        id: nanoid(16),
        sessionId: input.sessionId,
        filePath: input.filePath,
        line: input.line,
        side: input.side,
        staged: input.staged ? 1 : 0,
        body: input.body,
        hunkHeader: input.hunkHeader ?? null,
        status: 'open',
        sentBatchId: null,
        createdAt: now,
        updatedAt: now,
        resolvedAt: null,
      };
      tx.insert(sessionReviewComments).values(row).run();
      return mapRow(row);
    },
    { behavior: 'immediate' },
  );
}

/** Returns the updated row, or null when the id does not belong to this chat. */
export async function resolveReviewComment(
  sessionId: string,
  id: string,
  now = Date.now(),
): Promise<ReviewComment | null> {
  const [row] = await db
    .update(sessionReviewComments)
    .set({ status: 'resolved', updatedAt: now, resolvedAt: now })
    .where(and(eq(sessionReviewComments.sessionId, sessionId), eq(sessionReviewComments.id, id)))
    .returning();
  return row ? mapRow(row) : null;
}

export async function deleteReviewComment(sessionId: string, id: string): Promise<boolean> {
  const deleted = await db
    .delete(sessionReviewComments)
    .where(and(eq(sessionReviewComments.sessionId, sessionId), eq(sessionReviewComments.id, id)))
    .returning({ id: sessionReviewComments.id });
  return deleted.length > 0;
}

/**
 * Atomically read every open comment of the chat and stamp it with a batch id.
 * The batch is one steering message; a failed dispatch releases it again.
 */
export function claimOpenReviewCommentsForBatch(
  sessionId: string,
  batchId: string,
  now = Date.now(),
): ReviewComment[] {
  return db.transaction(
    (tx) => {
      const rows = tx
        .select()
        .from(sessionReviewComments)
        .where(
          and(
            eq(sessionReviewComments.sessionId, sessionId),
            eq(sessionReviewComments.status, 'open'),
          ),
        )
        .orderBy(asc(sessionReviewComments.createdAt), asc(sessionReviewComments.id))
        .all();
      if (rows.length === 0) return [];
      tx.update(sessionReviewComments)
        .set({ sentBatchId: batchId, updatedAt: now })
        .where(
          and(
            eq(sessionReviewComments.sessionId, sessionId),
            inArray(
              sessionReviewComments.id,
              rows.map((row) => row.id),
            ),
          ),
        )
        .run();
      return rows.map((row) => mapRow({ ...row, sentBatchId: batchId, updatedAt: now }));
    },
    { behavior: 'immediate' },
  );
}

/** Undo a claim whose steering message was never accepted. */
export async function releaseReviewCommentBatch(sessionId: string, batchId: string): Promise<void> {
  await db
    .update(sessionReviewComments)
    .set({ sentBatchId: null })
    .where(
      and(
        eq(sessionReviewComments.sessionId, sessionId),
        eq(sessionReviewComments.sentBatchId, batchId),
      ),
    );
}
