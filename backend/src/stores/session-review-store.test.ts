import { describe, expect, test } from 'bun:test';
import { SessionStore } from './session-store';
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
    expect(refreshed.rollback).toEqual({ kind: 'git', baselineHash: 'baseline-first' });
    expect(refreshed.projectRoot).toBe('/projects/reload-test');
    expect(refreshed.changes).toEqual([{ ...CHANGE, path: 'src/second.ts' }]);
    expect(await getPendingSessionReview(session.id)).toEqual(refreshed);
    expect(await listPendingSessionReviewSessionIds()).toContain(session.id);
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
