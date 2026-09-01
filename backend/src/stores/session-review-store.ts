import type { ChangeSummary } from '@koryphaios/shared';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db, sessionChanges } from '../db';
import { serverLog } from '../logger';

const REVIEW_CHANGE_TYPE_PREFIX = 'kory_review:';
const REVIEW_PENDING = `${REVIEW_CHANGE_TYPE_PREFIX}pending`;
const REVIEW_REJECTING = `${REVIEW_CHANGE_TYPE_PREFIX}rejecting`;
const REVIEW_ACCEPTED = `${REVIEW_CHANGE_TYPE_PREFIX}accepted`;
const REVIEW_REJECTED = `${REVIEW_CHANGE_TYPE_PREFIX}rejected`;
const REVIEW_TERMINALIZED = `${REVIEW_CHANGE_TYPE_PREFIX}terminalized`;

export type SessionReviewStatus =
  | 'pending'
  | 'rejecting'
  | 'accepted'
  | 'rejected'
  | 'terminalized';

export type SessionReviewRollback =
  | { kind: 'git'; baselineHash: string }
  | { kind: 'unavailable'; reason: string };

/**
 * The user-facing change-review decision is a durable projection, separate
 * from the process-local tool-change accumulator.  It contains only file
 * metadata and a verified rollback baseline; never prompt or file contents.
 */
export interface DurableSessionReview {
  version: 1;
  reviewId: string;
  sessionId: string;
  status: SessionReviewStatus;
  changes: ChangeSummary[];
  projectRoot: string | null;
  rollback: SessionReviewRollback;
  createdAt: number;
  updatedAt: number;
  resolvedAt?: number;
  resolutionReason?: string;
}

export interface PendingSessionReviewInput {
  sessionId: string;
  changes: ChangeSummary[];
  projectRoot: string | null;
  rollback: SessionReviewRollback;
}

function changeTypeFor(status: SessionReviewStatus): string {
  switch (status) {
    case 'pending':
      return REVIEW_PENDING;
    case 'rejecting':
      return REVIEW_REJECTING;
    case 'accepted':
      return REVIEW_ACCEPTED;
    case 'rejected':
      return REVIEW_REJECTED;
    case 'terminalized':
      return REVIEW_TERMINALIZED;
  }
}

function statusFromChangeType(changeType: string): SessionReviewStatus | null {
  switch (changeType) {
    case REVIEW_PENDING:
      return 'pending';
    case REVIEW_REJECTING:
      return 'rejecting';
    case REVIEW_ACCEPTED:
      return 'accepted';
    case REVIEW_REJECTED:
      return 'rejected';
    case REVIEW_TERMINALIZED:
      return 'terminalized';
    default:
      return null;
  }
}

function isChangeSummary(value: unknown): value is ChangeSummary {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ChangeSummary>;
  return (
    typeof candidate.path === 'string' &&
    typeof candidate.linesAdded === 'number' &&
    typeof candidate.linesDeleted === 'number' &&
    (candidate.operation === 'create' || candidate.operation === 'edit' || candidate.operation === 'delete')
  );
}

function isRollback(value: unknown): value is SessionReviewRollback {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<SessionReviewRollback>;
  if (candidate.kind === 'git') {
    return typeof (candidate as { baselineHash?: unknown }).baselineHash === 'string';
  }
  return (
    candidate.kind === 'unavailable' &&
    typeof (candidate as { reason?: unknown }).reason === 'string'
  );
}

function parseReview(
  changeType: string,
  changeData: string,
): DurableSessionReview | null {
  const status = statusFromChangeType(changeType);
  if (!status) return null;
  try {
    const value = JSON.parse(changeData) as Partial<DurableSessionReview>;
    if (
      value.version !== 1 ||
      typeof value.reviewId !== 'string' ||
      typeof value.sessionId !== 'string' ||
      value.status !== status ||
      !Array.isArray(value.changes) ||
      !value.changes.every(isChangeSummary) ||
      (value.projectRoot !== null && typeof value.projectRoot !== 'string') ||
      !isRollback(value.rollback) ||
      !Number.isSafeInteger(value.createdAt) ||
      !Number.isSafeInteger(value.updatedAt)
    ) {
      return null;
    }
    return value as DurableSessionReview;
  } catch (error) {
    serverLog.debug(
      { error: error instanceof Error ? error.message : String(error) },
      'Ignoring malformed durable session review record',
    );
    return null;
  }
}

async function latestReview(
  sessionId: string,
  statuses: readonly SessionReviewStatus[],
): Promise<DurableSessionReview | null> {
  if (statuses.length === 0) return null;
  const rows = await db
    .select()
    .from(sessionChanges)
    .where(
      and(
        eq(sessionChanges.sessionId, sessionId),
        inArray(
          sessionChanges.changeType,
          statuses.map(changeTypeFor),
        ),
      ),
    )
    .orderBy(desc(sessionChanges.createdAt));
  for (const row of rows) {
    const review = parseReview(row.changeType, row.changeData);
    if (review) return review;
  }
  return null;
}

/** Return only a review the UI may still act on. */
export function getPendingSessionReview(sessionId: string): Promise<DurableSessionReview | null> {
  return latestReview(sessionId, ['pending']);
}

/** Durable current projection for a completed/in-progress review when needed for diagnostics. */
export function getSessionReview(
  sessionId: string,
): Promise<DurableSessionReview | null> {
  return latestReview(sessionId, ['pending', 'rejecting', 'accepted', 'rejected', 'terminalized']);
}

/**
 * Create a pending review, or refresh the visible change list of the existing
 * review without ever replacing its original rollback baseline.
 */
export async function ensurePendingSessionReview(
  input: PendingSessionReviewInput,
  now = Date.now(),
): Promise<DurableSessionReview> {
  const existing = await getPendingSessionReview(input.sessionId);
  if (existing) {
    const refreshed: DurableSessionReview = {
      ...existing,
      changes: input.changes.map((change) => ({ ...change })),
      // Do not overwrite a verified review project with a later session-level
      // default. A changed project root means the current review can no longer
      // be safely rejected, so preserve the original binding for the response
      // gate to verify.
      projectRoot: existing.projectRoot,
      updatedAt: now,
    };
    const [updated] = await db
      .update(sessionChanges)
      .set({ changeData: JSON.stringify(refreshed) })
      .where(
        and(
          eq(sessionChanges.id, existing.reviewId),
          eq(sessionChanges.changeType, REVIEW_PENDING),
        ),
      )
      .returning();
    if (updated) return refreshed;
    // Another backend moved the review while this manager was preparing its
    // projection. Never create a second actionable review in that race.
    const current = await getSessionReview(input.sessionId);
    if (current) return current;
    throw new Error('The pending session review changed while it was being updated');
  }

  const review: DurableSessionReview = {
    version: 1,
    reviewId: nanoid(16),
    sessionId: input.sessionId,
    status: 'pending',
    changes: input.changes.map((change) => ({ ...change })),
    projectRoot: input.projectRoot,
    rollback: input.rollback,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(sessionChanges).values({
    id: review.reviewId,
    sessionId: review.sessionId,
    changeType: REVIEW_PENDING,
    changeData: JSON.stringify(review),
    createdAt: new Date(now),
  });
  return review;
}

async function transitionReview(
  review: DurableSessionReview,
  expected: SessionReviewStatus,
  next: SessionReviewStatus,
  now: number,
  resolutionReason?: string,
): Promise<DurableSessionReview | null> {
  const updated: DurableSessionReview = {
    ...review,
    status: next,
    updatedAt: now,
    ...(next === 'accepted' || next === 'rejected' || next === 'terminalized'
      ? { resolvedAt: now, ...(resolutionReason ? { resolutionReason } : {}) }
      : {}),
  };
  const [row] = await db
    .update(sessionChanges)
    .set({
      changeType: changeTypeFor(next),
      changeData: JSON.stringify(updated),
    })
    .where(
      and(
        eq(sessionChanges.id, review.reviewId),
        eq(sessionChanges.changeType, changeTypeFor(expected)),
      ),
    )
    .returning();
  return row ? updated : null;
}

/** Claim the destructive reject path before any workspace mutation. */
export function beginSessionReviewRejection(
  review: DurableSessionReview,
  now = Date.now(),
): Promise<DurableSessionReview | null> {
  return transitionReview(review, 'pending', 'rejecting', now);
}

export function acceptSessionReview(
  review: DurableSessionReview,
  now = Date.now(),
): Promise<DurableSessionReview | null> {
  return transitionReview(review, 'pending', 'accepted', now);
}

export function completeSessionReviewRejection(
  review: DurableSessionReview,
  now = Date.now(),
): Promise<DurableSessionReview | null> {
  return transitionReview(review, 'rejecting', 'rejected', now);
}

export async function terminalizeSessionReview(
  review: DurableSessionReview,
  reason: string,
  now = Date.now(),
): Promise<DurableSessionReview | null> {
  if (review.status !== 'pending' && review.status !== 'rejecting') return null;
  return transitionReview(review, review.status, 'terminalized', now, reason);
}

/**
 * A process cannot prove whether a Git reset completed if it died between the
 * filesystem command and the database acknowledgement. Mark such records
 * terminal rather than retrying a potentially destructive rollback.
 */
export async function terminalizeInterruptedSessionReviewRejections(
  now = Date.now(),
): Promise<DurableSessionReview[]> {
  const rows = await db
    .select()
    .from(sessionChanges)
    .where(eq(sessionChanges.changeType, REVIEW_REJECTING));
  const terminalized: DurableSessionReview[] = [];
  for (const row of rows) {
    const review = parseReview(row.changeType, row.changeData);
    if (!review) continue;
    const result = await terminalizeSessionReview(
      review,
      'Backend restarted while a rejection rollback was in progress. No additional rollback was attempted.',
      now,
    );
    if (result) terminalized.push(result);
  }
  return terminalized;
}

/** Small durable index for a fresh renderer; it does not expose review contents. */
export async function listPendingSessionReviewSessionIds(limit = 200): Promise<string[]> {
  const rows = await db
    .select({ sessionId: sessionChanges.sessionId })
    .from(sessionChanges)
    .where(eq(sessionChanges.changeType, REVIEW_PENDING))
    .orderBy(desc(sessionChanges.createdAt))
    .limit(Math.max(1, Math.min(500, Math.trunc(limit))));
  return [...new Set(rows.map((row) => row.sessionId))];
}

