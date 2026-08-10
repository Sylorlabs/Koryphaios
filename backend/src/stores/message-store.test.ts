import { beforeAll, describe, expect, it } from 'bun:test';
import { db, initDb, messages, sessions, sessionCompactions } from '../db';
import { eq } from 'drizzle-orm';
import { MessageStore } from './message-store';

beforeAll(async () => {
  await initDb();
});

describe('MessageStore history editing', () => {
  it('deletes a single message and decrements session counters', async () => {
    const suffix = `${Date.now()}-${Math.random()}`;
    const sessionId = `del-${suffix}`;
    const userId = `del-u-${suffix}`;
    const assistantId = `del-a-${suffix}`;
    await db.insert(sessions).values({
      id: sessionId,
      title: 'Delete test',
      createdAt: new Date(1_000),
      updatedAt: new Date(1_000),
    });
    const store = new MessageStore();
    await store.add(sessionId, {
      id: userId,
      sessionId,
      role: 'user',
      content: 'hello',
      tokensIn: 10,
      tokensOut: 0,
      cost: 0.01,
      createdAt: 2_000,
    });
    await store.add(sessionId, {
      id: assistantId,
      sessionId,
      role: 'assistant',
      content: 'hi there',
      tokensIn: 20,
      tokensOut: 30,
      cost: 0.02,
      createdAt: 3_000,
    });

    // Sanity: two messages, counters reflect both
    expect(await store.getAll(sessionId)).toHaveLength(2);

    // Delete the assistant message
    const deleted = await store.deleteMessage(sessionId, assistantId);
    expect(deleted).toBe(true);

    // Only the user message remains
    const remaining = await store.getAll(sessionId);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(userId);
    expect(
      (
        await db
          .select({ providerRevision: sessions.providerConversationRevision })
          .from(sessions)
          .where(eq(sessions.id, sessionId))
      )[0]?.providerRevision,
    ).toBe(1);

    // Deleting a non-existent message returns false
    const again = await store.deleteMessage(sessionId, assistantId);
    expect(again).toBe(false);

    // Deleting from the wrong session returns false (no cross-session deletion)
    const cross = await store.deleteMessage('wrong-session', userId);
    expect(cross).toBe(false);

    await db.delete(sessions).where(eq(sessions.id, sessionId));
  });

  it('replaces the selected user message and hides later turns without deleting them', async () => {
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
    expect(
      await db.select({ id: messages.id }).from(messages).where(eq(messages.sessionId, sessionId)),
    ).toHaveLength(3);
    expect(
      (
        await db
          .select({ providerRevision: sessions.providerConversationRevision })
          .from(sessions)
          .where(eq(sessions.id, sessionId))
      )[0]?.providerRevision,
    ).toBe(1);
    await db.delete(sessions).where(eq(sessions.id, sessionId));
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
    await db.delete(sessions).where(eq(sessions.id, sessionId));
  });

  it('atomically advances context while preserving the original revision as local history', async () => {
    const suffix = `${Date.now()}-${Math.random()}`;
    const sessionId = `compact-${suffix}`;
    await db.insert(sessions).values({
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
    const [compactedSession] = await db
      .select({
        messageCount: sessions.messageCount,
        tokensIn: sessions.tokensIn,
        tokensOut: sessions.tokensOut,
        providerRevision: sessions.providerConversationRevision,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(compactedSession).toEqual({
      messageCount: 4,
      tokensIn: 100,
      tokensOut: 20,
      providerRevision: 1,
    });

    await db.delete(sessions).where(eq(sessions.id, sessionId));
    expect(await store.getAll(sessionId)).toHaveLength(0);
    expect(
      await db.select().from(sessionCompactions).where(eq(sessionCompactions.sessionId, sessionId)),
    ).toHaveLength(0);
  });

  it('moves a durable active boundary without deleting rows, counters, or attachments', async () => {
    const suffix = `${Date.now()}-${Math.random()}`;
    const sessionId = `lineage-${suffix}`;
    const ids = [`u1-${suffix}`, `a1-${suffix}`, `u2-${suffix}`, `a2-${suffix}`];
    await db.insert(sessions).values({
      id: sessionId,
      title: 'Retained lineage test',
      createdAt: new Date(1_000),
      updatedAt: new Date(1_000),
    });
    const store = new MessageStore();
    for (const [index, id] of ids.entries()) {
      await store.add(sessionId, {
        id,
        sessionId,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `message-${index}`,
        attachments:
          index === 3
            ? [
                {
                  type: 'image',
                  data: Buffer.from('retained-image').toString('base64'),
                  name: 'retained.png',
                  mimeType: 'image/png',
                },
              ]
            : undefined,
        tokensIn: index + 1,
        tokensOut: (index + 1) * 10,
        cost: (index + 1) / 100,
        createdAt: 2_000 + index,
      });
    }

    const receipt = await store.setActiveBoundary(sessionId, ids[1]!, {
      expectedActiveMessageId: ids[3],
    });
    expect(receipt.previous.messageId).toBe(ids[3]);
    expect((await store.getAll(sessionId)).map((message) => message.id)).toEqual(ids.slice(0, 2));
    expect((await store.getRecent(sessionId, 1)).map((message) => message.id)).toEqual([ids[1]]);

    const [rewound] = await db
      .select({
        activeMessageId: sessions.activeMessageId,
        messageCount: sessions.messageCount,
        tokensIn: sessions.tokensIn,
        tokensOut: sessions.tokensOut,
        totalCost: sessions.totalCost,
        providerRevision: sessions.providerConversationRevision,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(rewound).toMatchObject({
      activeMessageId: ids[1],
      messageCount: 2,
      tokensIn: 3,
      tokensOut: 30,
      totalCost: 0.03,
      providerRevision: 1,
    });
    expect(
      await db.select({ id: messages.id }).from(messages).where(eq(messages.sessionId, sessionId)),
    ).toHaveLength(4);

    // A fresh store instance proves the persisted head is sufficient after a restart.
    const restarted = new MessageStore();
    await restarted.setActiveBoundary(sessionId, ids[3]!, {
      expectedActiveMessageId: ids[1],
    });
    const redone = await restarted.getAll(sessionId);
    expect(redone.map((message) => message.id)).toEqual(ids);
    expect(redone[3]?.attachments).toMatchObject([{ name: 'retained.png' }]);
    expect(
      (
        await db
          .select({ providerRevision: sessions.providerConversationRevision })
          .from(sessions)
          .where(eq(sessions.id, sessionId))
      )[0]?.providerRevision,
    ).toBe(2);

    await db.delete(sessions).where(eq(sessions.id, sessionId));
  });

  it('forks from a rewound head while retaining the original future for redo', async () => {
    const suffix = `${Date.now()}-${Math.random()}`;
    const sessionId = `branch-${suffix}`;
    const firstId = `first-${suffix}`;
    const oldFutureId = `old-future-${suffix}`;
    const forkId = `fork-${suffix}`;
    await db.insert(sessions).values({
      id: sessionId,
      title: 'Branch test',
      createdAt: new Date(1_000),
      updatedAt: new Date(1_000),
    });
    const store = new MessageStore();
    await store.add(sessionId, {
      id: firstId,
      sessionId,
      role: 'user',
      content: 'first',
      createdAt: 2_000,
    });
    await store.add(sessionId, {
      id: oldFutureId,
      sessionId,
      role: 'assistant',
      content: 'old future',
      createdAt: 3_000,
    });
    await store.setActiveBoundary(sessionId, firstId, {
      expectedActiveMessageId: oldFutureId,
    });
    await store.add(sessionId, {
      id: forkId,
      sessionId,
      role: 'assistant',
      content: 'new branch',
      createdAt: 4_000,
    });
    expect((await store.getAll(sessionId)).map((message) => message.id)).toEqual([firstId, forkId]);
    expect(
      await db.select({ id: messages.id }).from(messages).where(eq(messages.sessionId, sessionId)),
    ).toHaveLength(3);

    await store.setActiveBoundary(sessionId, oldFutureId, {
      expectedActiveMessageId: forkId,
    });
    expect((await store.getAll(sessionId)).map((message) => message.id)).toEqual([
      firstId,
      oldFutureId,
    ]);
    await db.delete(sessions).where(eq(sessions.id, sessionId));
  });

  it('fails closed for missing, cross-session, stale, and unsafe compensation boundaries', async () => {
    const suffix = `${Date.now()}-${Math.random()}`;
    const sessionId = `guard-${suffix}`;
    const otherSessionId = `guard-other-${suffix}`;
    const firstId = `guard-first-${suffix}`;
    const secondId = `guard-second-${suffix}`;
    const otherId = `guard-other-message-${suffix}`;
    for (const id of [sessionId, otherSessionId]) {
      await db.insert(sessions).values({
        id,
        title: 'Boundary guard test',
        createdAt: new Date(1_000),
        updatedAt: new Date(1_000),
      });
    }
    const store = new MessageStore();
    await store.add(sessionId, {
      id: firstId,
      sessionId,
      role: 'user',
      content: 'first',
      createdAt: 2_000,
    });
    await store.add(sessionId, {
      id: secondId,
      sessionId,
      role: 'assistant',
      content: 'second',
      createdAt: 3_000,
    });
    await store.add(otherSessionId, {
      id: otherId,
      sessionId: otherSessionId,
      role: 'user',
      content: 'other',
      createdAt: 2_000,
    });

    await expect(store.setActiveBoundary(sessionId, 'missing')).rejects.toThrow(/not found/);
    await expect(store.setActiveBoundary(sessionId, otherId)).rejects.toThrow(/this session/);
    await expect(
      store.setActiveBoundary(sessionId, firstId, { expectedActiveMessageId: 'stale' }),
    ).rejects.toThrow(/changed/);
    expect(await store.getActiveBoundary(sessionId)).toMatchObject({ messageId: secondId });

    const receipt = await store.setActiveBoundary(sessionId, firstId, {
      expectedActiveMessageId: secondId,
    });
    await store.restoreActiveBoundary(receipt);
    expect(await store.getActiveBoundary(sessionId)).toMatchObject({ messageId: secondId });

    const unsafeReceipt = await store.setActiveBoundary(sessionId, firstId, {
      expectedActiveMessageId: secondId,
    });
    await store.add(sessionId, {
      id: `concurrent-${suffix}`,
      sessionId,
      role: 'assistant',
      content: 'concurrent turn',
      createdAt: 4_000,
    });
    await expect(store.restoreActiveBoundary(unsafeReceipt)).rejects.toThrow(/refusing/);
    expect((await store.getAll(sessionId)).at(-1)?.content).toBe('concurrent turn');

    await db.delete(sessions).where(eq(sessions.id, sessionId));
    await db.delete(sessions).where(eq(sessions.id, otherSessionId));
  });

  it('restores the pivot context revision and bounds a corrupt lineage cycle', async () => {
    const suffix = `${Date.now()}-${Math.random()}`;
    const sessionId = `context-rewind-${suffix}`;
    const firstId = `context-first-${suffix}`;
    const secondId = `context-second-${suffix}`;
    await db.insert(sessions).values({
      id: sessionId,
      title: 'Context rewind test',
      createdAt: new Date(1_000),
      updatedAt: new Date(1_000),
    });
    const store = new MessageStore();
    await store.add(sessionId, {
      id: firstId,
      sessionId,
      role: 'user',
      content: 'revision zero',
      createdAt: 2_000,
    });
    await store.commitCompaction({
      id: `context-compact-${suffix}`,
      sessionId,
      provider: 'codex',
      model: 'gpt-test',
      automatic: false,
      summary: 'retained compaction',
      sourceMessageCount: 1,
      sourceTokens: 10,
      checkpointTokens: 2,
    });
    await store.add(sessionId, {
      id: secondId,
      sessionId,
      role: 'assistant',
      content: 'revision one',
      createdAt: 4_000,
    });
    await store.setActiveBoundary(sessionId, firstId, {
      expectedActiveMessageId: secondId,
    });
    expect(await store.getActiveBoundary(sessionId)).toEqual({
      messageId: firstId,
      contextRevision: 0,
    });
    expect((await store.getContextMessages(sessionId)).map((message) => message.id)).toEqual([
      firstId,
    ]);

    // Deliberate corruption must terminate rather than recurse forever.
    await db.update(messages).set({ parentMessageId: secondId }).where(eq(messages.id, firstId));
    const bounded = await store.getAll(sessionId);
    expect(new Set(bounded.map((message) => message.id)).size).toBe(bounded.length);
    expect(bounded.length).toBeGreaterThan(0);
    await expect(
      store.setActiveBoundary(sessionId, secondId, { expectedActiveMessageId: firstId }),
    ).rejects.toThrow(/cycle/);
    expect(await store.getActiveBoundary(sessionId)).toMatchObject({ messageId: firstId });

    await db.delete(sessions).where(eq(sessions.id, sessionId));
  });
});
