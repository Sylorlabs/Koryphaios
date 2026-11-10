import type { ChangeSummary } from '@koryphaios/shared';
import { createHash } from 'node:crypto';
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
  /** Identifies the exact publication, including identical metadata republished later. */
  reviewRevision: string;
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
      (value.reviewRevision !== undefined &&
        (typeof value.reviewRevision !== 'string' || value.reviewRevision.length === 0)) ||
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
    // Existing rows remain readable without an eager migration. Their exact
    // stored bytes identify the observed snapshot until its next publication.
    return {
      ...value,
      reviewRevision: value.reviewRevision ?? `legacy:${createHash('sha256').update(changeData).digest('hex')}`,
    } as DurableSessionReview;
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
  if (statuses.length === 2 && statuses.includes('pending') && statuses.includes('rejecting') && rows.length > 1) {
    throw new Error('Multiple unresolved change reviews require manual recovery before a decision can be applied.');
  }
  for (const row of rows) {
    const review = parseReview(row.changeType, row.changeData);
    if (review) return review;
  }
  return null;
}

/** Return only a review the UI may still act on. */
export async function getPendingSessionReview(sessionId: string): Promise<DurableSessionReview | null> {
  const review = await latestReview(sessionId, ['pending', 'rejecting']);
  return review?.status === 'pending' ? review : null;
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
  // Bun SQLite transactions are synchronous. Take the writer reservation
  // before looking up the row so concurrent first publications cannot both
  // observe absence, including publications from different host processes.
  return db.transaction((tx) => {
    const rows = tx.select().from(sessionChanges).where(and(
      eq(sessionChanges.sessionId, input.sessionId),
      inArray(sessionChanges.changeType, [REVIEW_PENDING, REVIEW_REJECTING]),
    )).all();
    if (rows.length > 1) {
      throw new Error('Multiple unresolved change reviews require manual recovery before publication.');
    }
    const row = rows[0];
    const existing = row ? parseReview(row.changeType, row.changeData) : null;
    if (row && !existing) throw new Error('The stored change review is malformed and requires recovery.');
    if (existing?.status === 'rejecting') return existing;
    const review: DurableSessionReview = existing ? {
      ...existing,
      reviewRevision: nanoid(24),
      changes: input.changes.map((change) => ({ ...change })),
      // Preserve the first root and rollback baseline throughout a review.
      updatedAt: now,
    } : {
      version: 1,
      reviewId: nanoid(16),
      reviewRevision: nanoid(24),
      sessionId: input.sessionId,
      status: 'pending',
      changes: input.changes.map((change) => ({ ...change })),
      projectRoot: input.projectRoot,
      rollback: { ...input.rollback },
      createdAt: now,
      updatedAt: now,
    };
    if (row) {
      tx.update(sessionChanges).set({ changeData: JSON.stringify(review) })
        .where(eq(sessionChanges.id, row.id)).run();
    } else {
      tx.insert(sessionChanges).values({
        id: review.reviewId,
        sessionId: review.sessionId,
        changeType: REVIEW_PENDING,
        changeData: JSON.stringify(review),
        createdAt: new Date(now),
      }).run();
    }
    return review;
  }, { behavior: 'immediate' });
}

async function transitionReview(
  review: DurableSessionReview,
  expected: SessionReviewStatus,
  next: SessionReviewStatus,
  now: number,
  resolutionReason?: string,
): Promise<DurableSessionReview | null> {
  return db.transaction((tx) => {
    const row = tx.select().from(sessionChanges).where(and(
      eq(sessionChanges.id, review.reviewId),
      eq(sessionChanges.sessionId, review.sessionId),
      eq(sessionChanges.changeType, changeTypeFor(expected)),
    )).get();
    if (!row) return null;
    const current = parseReview(row.changeType, row.changeData);
    if (!current || current.reviewRevision !== review.reviewRevision) return null;
    const updated: DurableSessionReview = {
      ...current,
      status: next,
      updatedAt: now,
      ...(next === 'accepted' || next === 'rejected' || next === 'terminalized'
        ? { resolvedAt: now, ...(resolutionReason ? { resolutionReason } : {}) }
        : {}),
    };
    // Compare the stored snapshot as well as the status. In particular, never
    // write a stale caller's contents over a refreshed pending publication.
    const result = tx.update(sessionChanges).set({
      changeType: changeTypeFor(next), changeData: JSON.stringify(updated),
    }).where(and(
      eq(sessionChanges.id, row.id),
      eq(sessionChanges.changeType, changeTypeFor(expected)),
      eq(sessionChanges.changeData, row.changeData),
    )).returning().get();
    return result ? updated : null;
  }, { behavior: 'immediate' });
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

