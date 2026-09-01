import { beforeAll, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db, initDb, sessions } from '../db';
import {
  FeedPersistenceStore,
  isValidFeedTargetKey,
  normalizeClientFeedErrorText,
} from './feed-persistence-store';

beforeAll(async () => {
  await initDb();
});

describe('FeedPersistenceStore', () => {
  it('replays explicit client errors and exact view tombstones only within their session', async () => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const sessionId = `feed-persistence-${suffix}`;
    const store = new FeedPersistenceStore();
    await db.insert(sessions).values({
      id: sessionId,
      title: 'Feed persistence',
      createdAt: new Date(1_000),
      updatedAt: new Date(1_000),
    });

    await store.recordClientError({
      id: `client-error-${suffix}`,
      sessionId,
      text: 'Renderer could not recover the selected transcript.',
      timestamp: 2_000,
    });
    // The client can retry safely without creating a duplicate transcript row.
    await store.recordClientError({
      id: `client-error-${suffix}`,
      sessionId,
      text: 'This later retry must not overwrite the original evidence.',
      timestamp: 3_000,
    });
    await store.setVisibility(sessionId, ['event:4:8:10', 'thread:thread_1'], 'hidden');
    await store.setVisibility(sessionId, ['archive:archive_1'], 'deleted');

    expect(await store.getState(sessionId)).toEqual({
      entries: [
        {
          id: `client-error-${suffix}`,
          kind: 'client_error',
          text: 'Renderer could not recover the selected transcript.',
          timestamp: 2_000,
        },
      ],
      tombstones: expect.arrayContaining([
        { targetKey: 'event:4:8:10', visibility: 'hidden' },
        { targetKey: 'thread:thread_1', visibility: 'hidden' },
        { targetKey: 'archive:archive_1', visibility: 'deleted' },
      ]),
    });

    await store.setVisibility(sessionId, ['thread:thread_1'], 'visible');
    expect((await store.getState(sessionId)).tombstones).not.toContainEqual({
      targetKey: 'thread:thread_1',
      visibility: 'hidden',
    });

    await db.delete(sessions).where(eq(sessions.id, sessionId));
    expect(await store.getState(sessionId)).toEqual({ entries: [], tombstones: [] });
  });

  it('accepts only bounded exact replay identities and safe error text', () => {
    expect(isValidFeedTargetKey('event:1:2:4097')).toBe(true);
    // A coalesced streamed card can cover many ordered events. It is still
    // exact (not a wildcard), so it must remain hideable after reload.
    expect(isValidFeedTargetKey('event:1:2:4098')).toBe(true);
    expect(isValidFeedTargetKey('event:1:2:*')).toBe(false);
    expect(isValidFeedTargetKey('thread:worker_1')).toBe(true);
    expect(normalizeClientFeedErrorText('  useful failure\r\n  ')).toBe('useful failure');
    expect(() => normalizeClientFeedErrorText('\u0000')).toThrow('unsupported control');
  });
});
