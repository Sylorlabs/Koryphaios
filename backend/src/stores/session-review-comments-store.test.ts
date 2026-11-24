import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'kory-review-comments-')));
process.env.NODE_ENV = 'test';
process.env.KORYPHAIOS_DATA_DIR = root;
process.env.DATABASE_URL = `sqlite:${join(root, 'test.sqlite')}`;
process.env.SESSION_TOKEN_SECRET ??= 'test_only_not_for_production_aaaaaaaaaa';

const { initDb } = await import('../db');
const store = await import('./session-review-comments-store');

const A = 'session-a';
const B = 'session-b';

function row(
  sessionId: string,
  overrides: Partial<Parameters<typeof store.createReviewComment>[0]> = {},
) {
  return store.createReviewComment({
    sessionId,
    filePath: 'src/app.ts',
    line: 42,
    side: 'new',
    staged: false,
    body: 'Rename this.',
    hunkHeader: '@@ -40,6 +40,7 @@',
    ...overrides,
  });
}

beforeAll(async () => {
  await initDb();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('session review comments store', () => {
  test('persists a comment with its anchor and reads it back', async () => {
    const created = row(A);
    expect(created).toMatchObject({
      sessionId: A,
      filePath: 'src/app.ts',
      line: 42,
      side: 'new',
      staged: false,
      body: 'Rename this.',
      hunkHeader: '@@ -40,6 +40,7 @@',
      status: 'open',
    });
    const listed = await store.listReviewComments(A);
    expect(listed.map((comment) => comment.id)).toContain(created.id);
    expect(listed.find((comment) => comment.id === created.id)).toEqual(created);
  });

  test('resolve and delete are scoped to the owning chat', async () => {
    const comment = row(A, { body: 'Scoped.' });
    expect(await store.resolveReviewComment(B, comment.id)).toBeNull();
    expect(await store.deleteReviewComment(B, comment.id)).toBe(false);

    const resolved = await store.resolveReviewComment(A, comment.id);
    expect(resolved).toMatchObject({ status: 'resolved' });
    expect(resolved?.resolvedAt).toBeNumber();
    expect((await store.listReviewComments(A, 'open')).map((c) => c.id)).not.toContain(comment.id);
    expect((await store.listReviewComments(A, 'resolved')).map((c) => c.id)).toContain(comment.id);

    expect(await store.deleteReviewComment(A, comment.id)).toBe(true);
    expect((await store.listReviewComments(A)).map((c) => c.id)).not.toContain(comment.id);
  });

  test('batching claims only open comments of one chat and stamps them with the batch id', async () => {
    const otherChat = row(B, { body: 'Belongs to B.' });
    const first = row(A, { body: 'first' });
    const second = row(A, { body: 'second', side: 'old', line: 7, staged: true });
    const resolvedOne = row(A, { body: 'already resolved' });
    await store.resolveReviewComment(A, resolvedOne.id);

    const claimed = store.claimOpenReviewCommentsForBatch(A, 'batch-1');
    const claimedIds = claimed.map((comment) => comment.id);
    expect(claimedIds).toContain(first.id);
    expect(claimedIds).toContain(second.id);
    expect(claimedIds).not.toContain(resolvedOne.id);
    expect(claimedIds).not.toContain(otherChat.id);
    expect(claimed.every((comment) => comment.sentBatchId === 'batch-1')).toBe(true);

    const persisted = (await store.listReviewComments(A)).find(
      (comment) => comment.id === second.id,
    );
    expect(persisted).toMatchObject({ side: 'old', staged: true, sentBatchId: 'batch-1' });
    // The other chat's comment was never claimed.
    expect(
      (await store.listReviewComments(B)).find((c) => c.id === otherChat.id)?.sentBatchId,
    ).toBeUndefined();
  });

  test('releasing a batch clears only that batch’s stamps', async () => {
    const kept = row(A, { body: 'kept' });
    store.claimOpenReviewCommentsForBatch(A, 'batch-2');
    await store.releaseReviewCommentBatch(A, 'batch-2');
    const after = (await store.listReviewComments(A)).find((comment) => comment.id === kept.id);
    expect(after?.sentBatchId).toBeUndefined();
    expect(after?.status).toBe('open');
  });

  test('claiming with nothing open returns an empty batch without writes', () => {
    const batch = store.claimOpenReviewCommentsForBatch('empty-session', 'batch-none');
    expect(batch).toEqual([]);
  });

  test('a chat is limited in how many comments it can hold', () => {
    const session = 'session-limit';
    for (let i = 0; i < 500; i += 1) row(session, { body: `c${i}` });
    expect(() => row(session, { body: 'one too many' })).toThrow(store.SessionLimitError);
  });
});
