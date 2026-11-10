import { describe, expect, test } from 'bun:test';
import { SessionStore } from './session-store';
import { db, sessionChanges } from '../db';
import {
  acceptSessionReview,
  beginSessionReviewRejection,
  completeSessionReviewRejection,
  ensurePendingSessionReview,
  getPendingSessionReview,
  getSessionReview,
  listPendingSessionReviewSessionIds,
  terminalizeSessionReview,
} from './session-review-store';

const sessions = new SessionStore();

const CHANGE = {
  path: 'src/reload.ts',
  operation: 'edit' as const,
  linesAdded: 4,
  linesDeleted: 1,
};

describe('durable session change reviews', () => {
  test('preserves the first verified rollback baseline while refreshing review evidence', async () => {
    const session = await sessions.create('local-user', 'Review baseline persistence');

    const first = await ensurePendingSessionReview({
      sessionId: session.id,
      changes: [CHANGE],
      projectRoot: '/projects/reload-test',
      rollback: { kind: 'git', baselineHash: 'baseline-first' },
    });
    const refreshed = await ensurePendingSessionReview({
      sessionId: session.id,
      changes: [{ ...CHANGE, path: 'src/second.ts' }],
      projectRoot: '/projects/incorrect-later-root',
      rollback: { kind: 'git', baselineHash: 'baseline-later' },
    });

    expect(refreshed.reviewId).toBe(first.reviewId);
    expect(refreshed.reviewRevision).not.toBe(first.reviewRevision);
    expect(refreshed.rollback).toEqual({ kind: 'git', baselineHash: 'baseline-first' });
    expect(refreshed.projectRoot).toBe('/projects/reload-test');
    expect(refreshed.changes).toEqual([{ ...CHANGE, path: 'src/second.ts' }]);
    expect(await getPendingSessionReview(session.id)).toEqual(refreshed);
    expect(await listPendingSessionReviewSessionIds()).toContain(session.id);
  });

  test('refuses stale decisions across equal timestamps and A to B to A refreshes', async () => {
    const session = await sessions.create('local-user', 'Review revision identity');
    const input = {
      sessionId: session.id,
      changes: [CHANGE],
      projectRoot: '/projects/revision-test',
      rollback: { kind: 'git' as const, baselineHash: 'first' },
    };
    const first = await ensurePendingSessionReview(input, 1234);
    const second = await ensurePendingSessionReview({ ...input, changes: [{ ...CHANGE, linesAdded: 8 }] }, 1234);
    const third = await ensurePendingSessionReview(input, 1234);
    expect(new Set([first.reviewRevision, second.reviewRevision, third.reviewRevision]).size).toBe(3);
    expect(await acceptSessionReview(first)).toBeNull();
    expect(await beginSessionReviewRejection(second)).toBeNull();
    expect(await terminalizeSessionReview(first, 'stale caller')).toBeNull();
    expect(await getPendingSessionReview(session.id)).toEqual(third);
    expect((await acceptSessionReview(third))?.status).toBe('accepted');
    expect(await acceptSessionReview(third)).toBeNull();
  });

  test('serializes concurrent first publications and retains their first rollback binding', async () => {
    const session = await sessions.create('local-user', 'Concurrent review creation');
    const published = await Promise.all(Array.from({ length: 8 }, (_, index) => ensurePendingSessionReview({
      sessionId: session.id,
      changes: [{ ...CHANGE, linesAdded: index }],
      projectRoot: `/projects/concurrent-${index}`,
      rollback: { kind: 'git', baselineHash: `baseline-${index}` },
    }, 1234)));
    expect(new Set(published.map((review) => review.reviewId)).size).toBe(1);
    expect(new Set(published.map((review) => review.reviewRevision)).size).toBe(8);
    expect(published.every((review) => review.projectRoot === '/projects/concurrent-0')).toBe(true);
    expect(published.every((review) => review.rollback.kind === 'git' && review.rollback.baselineHash === 'baseline-0')).toBe(true);
    expect(await getPendingSessionReview(session.id)).toEqual(published[7]);
    for (const stale of published.slice(0, -1)) expect(await acceptSessionReview(stale)).toBeNull();
  });

  test('a repeat publication gets a new revision even when the visible metadata is identical', async () => {
    const session = await sessions.create('local-user', 'Repeated review publication');
    const input = { sessionId: session.id, changes: [CHANGE], projectRoot: null, rollback: { kind: 'unavailable' as const, reason: 'No Git' } };
    const first = await ensurePendingSessionReview(input, 1234);
    const second = await ensurePendingSessionReview(input, 1234);
    expect(second.reviewRevision).not.toBe(first.reviewRevision);
    expect(await beginSessionReviewRejection(first)).toBeNull();
  });

  test('does not create an actionable replacement while rollback is claimed', async () => {
    const session = await sessions.create('local-user', 'Publication during rejection');
    const input = { sessionId: session.id, changes: [CHANGE], projectRoot: '/projects/reject', rollback: { kind: 'git' as const, baselineHash: 'first' } };
    const first = await ensurePendingSessionReview(input);
    const claimed = await beginSessionReviewRejection(first);
    expect((await ensurePendingSessionReview(input))?.status).toBe('rejecting');
    expect(await getPendingSessionReview(session.id)).toBeNull();
    expect((await completeSessionReviewRejection(claimed!))?.status).toBe('rejected');
  });

  test('gives legacy records a stable snapshot revision and accepts only that observed snapshot', async () => {
    const session = await sessions.create('local-user', 'Legacy review revision');
    const legacy = { version: 1, reviewId: `legacy-${session.id}`, sessionId: session.id, status: 'pending', changes: [CHANGE], projectRoot: null, rollback: { kind: 'unavailable', reason: 'No Git' }, createdAt: 1234, updatedAt: 1234 };
    await db.insert(sessionChanges).values({ id: legacy.reviewId, sessionId: session.id, changeType: 'kory_review:pending', changeData: JSON.stringify(legacy), createdAt: new Date(1234) });
    const observed = await getPendingSessionReview(session.id);
    expect(typeof observed?.reviewRevision).toBe('string');
    expect(observed?.reviewRevision).toBe((await getPendingSessionReview(session.id))?.reviewRevision);
    expect((await acceptSessionReview(observed!))?.status).toBe('accepted');
  });

  test('terminalizes an interrupted rejection rather than making rollback retryable', async () => {
    const session = await sessions.create('local-user', 'Review rejection recovery');
    const pending = await ensurePendingSessionReview({
      sessionId: session.id,
      changes: [CHANGE],
      projectRoot: '/projects/rejection-test',
      rollback: { kind: 'git', baselineHash: 'baseline-reject' },
    });
    const rejecting = await beginSessionReviewRejection(pending);
    expect(rejecting?.status).toBe('rejecting');

    const terminal = await terminalizeSessionReview(
      rejecting!,
      'Backend restarted while a rejection rollback was in progress.',
    );
    expect(terminal).toMatchObject({
      reviewId: pending.reviewId,
      status: 'terminalized',
      resolutionReason: 'Backend restarted while a rejection rollback was in progress.',
    });
    expect(await getPendingSessionReview(session.id)).toBeNull();
    expect(await getSessionReview(session.id)).toMatchObject({ status: 'terminalized' });
    expect(await listPendingSessionReviewSessionIds()).not.toContain(session.id);
  });

  test('makes accept and completed rejection durable terminal decisions', async () => {
    const acceptedSession = await sessions.create('local-user', 'Review accept persistence');
    const rejectedSession = await sessions.create('local-user', 'Review reject persistence');

    const accepting = await ensurePendingSessionReview({
      sessionId: acceptedSession.id,
      changes: [CHANGE],
      projectRoot: '/projects/accept-test',
      rollback: { kind: 'git', baselineHash: 'baseline-accept' },
    });
    expect((await acceptSessionReview(accepting))?.status).toBe('accepted');
    expect(await getPendingSessionReview(acceptedSession.id)).toBeNull();

    const rejecting = await ensurePendingSessionReview({
      sessionId: rejectedSession.id,
      changes: [CHANGE],
      projectRoot: '/projects/reject-test',
      rollback: { kind: 'git', baselineHash: 'baseline-reject-complete' },
    });
    const claimed = await beginSessionReviewRejection(rejecting);
    expect((await completeSessionReviewRejection(claimed!))?.status).toBe('rejected');
    expect(await getPendingSessionReview(rejectedSession.id)).toBeNull();
  });
});
