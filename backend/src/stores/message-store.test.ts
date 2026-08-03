import { describe, expect, it } from 'bun:test';
import { db, sessions, sessionCompactions } from '../db';
import { eq } from 'drizzle-orm';
import { MessageStore } from './message-store';

describe('MessageStore history editing', () => {
  it('replaces the selected user message and atomically removes later turns', async () => {
    const suffix = `${Date.now()}-${Math.random()}`;
    const sessionId = `edit-${suffix}`;
    const firstUserId = `u1-${suffix}`;
    await db.insert(sessions).values({
      id: sessionId,
      title: 'Edit test',
      createdAt: new Date(1_000),
      updatedAt: new Date(1_000),
    });
    const store = new MessageStore();
    await store.add(sessionId, {
      id: firstUserId,
      sessionId,
      role: 'user',
      content: 'old',
      createdAt: 2_000,
    });
    await store.add(sessionId, {
      id: `a1-${suffix}`,
      sessionId,
      role: 'assistant',
      content: 'answer',
      createdAt: 3_000,
    });
    await store.add(sessionId, {
      id: `u2-${suffix}`,
      sessionId,
      role: 'user',
      content: 'later',
      createdAt: 4_000,
    });

    expect(await store.replaceAndTruncate(sessionId, firstUserId, 'edited')).toBe(2);
    expect(await store.getAll(sessionId)).toMatchObject([
      { id: firstUserId, role: 'user', content: 'edited' },
    ]);
  });

  it('persists image attachments and preserves them when the message text is edited', async () => {
    const suffix = `${Date.now()}-${Math.random()}`;
    const sessionId = `image-edit-${suffix}`;
    const messageId = `image-user-${suffix}`;
    await db.insert(sessions).values({
      id: sessionId,
      title: 'Image edit test',
      createdAt: new Date(1_000),
      updatedAt: new Date(1_000),
    });
    const store = new MessageStore();
    await store.add(sessionId, {
      id: messageId,
      sessionId,
      role: 'user',
      content: 'inspect this',
      attachments: [
        {
          type: 'image',
          data: Buffer.from('image-bytes').toString('base64'),
          name: 'screen.png',
          mimeType: 'image/png',
        },
      ],
      createdAt: 2_000,
    });

    expect((await store.getAll(sessionId))[0]?.attachments).toHaveLength(1);
    await store.replaceAndTruncate(sessionId, messageId, 'inspect this edited version');
    expect((await store.getAll(sessionId))[0]).toMatchObject({
      content: 'inspect this edited version',
      attachments: [{ type: 'image', name: 'screen.png', mimeType: 'image/png' }],
    });
  });

  it('atomically advances context while preserving the original revision as local history', async () => {
    const suffix = `${Date.now()}-${Math.random()}`;
    const sessionId = `compact-${suffix}`;
    await db
      .insert(sessions)
      .values({
        id: sessionId,
        title: 'Compaction test',
        createdAt: new Date(1_000),
        updatedAt: new Date(1_000),
      });
    const store = new MessageStore();
    await store.add(sessionId, {
      id: `u-${suffix}`,
      sessionId,
      role: 'user',
      content: 'Original request',
      createdAt: 2_000,
    });
    await store.add(sessionId, {
      id: `a-${suffix}`,
      sessionId,
      role: 'assistant',
      content: 'Original answer',
      createdAt: 3_000,
    });

    await store.commitCompaction({
      id: `c-${suffix}`,
      sessionId,
      provider: 'codex',
      model: 'gpt-test',
      automatic: false,
      summary: '# Compacted Session Checkpoint\n\nA sufficiently detailed continuation checkpoint.',
      sourceMessageCount: 2,
      sourceTokens: 100,
      checkpointTokens: 20,
    });

    expect(await store.getAll(sessionId)).toHaveLength(3);
    expect(await store.getContextMessages(sessionId)).toMatchObject([
      { role: 'system', contextRevision: 1, content: expect.stringContaining('[KORY_COMPACTION]') },
    ]);
    await store.add(sessionId, {
      id: `next-${suffix}`,
      sessionId,
      role: 'user',
      content: 'Continue',
      createdAt: 4_000,
    });
    const activeContents = (await store.getContextMessages(sessionId)).map(
      (message) => message.content,
    );
    expect(activeContents).toContain('Continue');
    expect(activeContents.some((content) => content.includes('[KORY_COMPACTION]'))).toBe(true);
    expect(
      await db.select().from(sessionCompactions).where(eq(sessionCompactions.sessionId, sessionId)),
    ).toHaveLength(1);
  });
});
