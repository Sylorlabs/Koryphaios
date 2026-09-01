import { beforeAll, describe, expect, it } from 'bun:test';
import { db, initDb, messages, sessions, sessionCompactions } from '../db';
import { eq } from 'drizzle-orm';
import { MessageStore } from './message-store';

beforeAll(async () => {
  await initDb();
});

describe('MessageStore history editing', () => {
  it('idempotently appends a durable command only at its captured conversation generation', async () => {
    const suffix = `${Date.now()}-${Math.random()}`;
    const sessionId = `command-boundary-${suffix}`;
    const headId = `head-${suffix}`;
    const commandId = `command-${suffix}`;
    await db.insert(sessions).values({
      id: sessionId,
      title: 'Durable command boundary',
      createdAt: new Date(1_000),
      updatedAt: new Date(1_000),
    });
    const store = new MessageStore();
    await store.add(sessionId, {
      id: headId,
      sessionId,
      role: 'assistant',
      content: 'captured head',
      createdAt: 2_000,
    });
    const expected = { activeMessageId: headId, providerConversationRevision: 0 };
    const command = {
      id: commandId,
      sessionId,
      role: 'user' as const,
      content: 'durable answer',
      createdAt: 3_000,
    };

    expect(await store.addIdempotentAtBoundary(sessionId, command, expected)).toBe('inserted');
    expect(await store.addIdempotentAtBoundary(sessionId, command, expected)).toBe('existing');
    expect(await store.getAll(sessionId)).toMatchObject([
      { id: headId },
      { id: commandId, content: 'durable answer' },
    ]);

    await store.add(sessionId, {
      id: `later-${suffix}`,
      sessionId,
      role: 'assistant',
      content: 'later turn',
      createdAt: 4_000,
    });
    await expect(store.addIdempotentAtBoundary(sessionId, command, expected)).rejects.toThrow(
      /older conversation generation/,
    );
    await expect(
      store.addIdempotentAtBoundary(
        sessionId,
        {
          id: `stale-${suffix}`,
          sessionId,
          role: 'user',
          content: 'must not silently rebase',
          createdAt: 5_000,
        },
        expected,
      ),
    ).rejects.toThrow(/Conversation changed/);
    expect(await store.getById(sessionId, `stale-${suffix}`)).toBeUndefined();

    await db.delete(sessions).where(eq(sessions.id, sessionId));
  });

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

  it('prunes descendants instead of manufacturing a conversation by splicing roles', async () => {
    const suffix = `${Date.now()}-${Math.random()}`;
    const sessionId = `delete-subtree-${suffix}`;
    const ids = {
      user1: `delete-subtree-u1-${suffix}`,
      assistant1: `delete-subtree-a1-${suffix}`,
      user2: `delete-subtree-u2-${suffix}`,
      assistant2: `delete-subtree-a2-${suffix}`,
    };
    await db.insert(sessions).values({
      id: sessionId,
      title: 'Delete subtree test',
      createdAt: new Date(1_000),
      updatedAt: new Date(1_000),
    });
    const store = new MessageStore();
    await store.add(sessionId, {
      id: ids.user1,
      sessionId,
      role: 'user',
      content: 'first prompt',
      createdAt: 2_000,
    });
    await store.add(sessionId, {
      id: ids.assistant1,
      sessionId,
      role: 'assistant',
      content: 'first answer',
      createdAt: 3_000,
    });
    await store.add(sessionId, {
      id: ids.user2,
      sessionId,
      role: 'user',
      content: 'follow-up based on first answer',
      createdAt: 4_000,
    });
    await store.add(sessionId, {
      id: ids.assistant2,
      sessionId,
      role: 'assistant',
      content: 'second answer',
      createdAt: 5_000,
    });

    expect(await store.deleteMessage(sessionId, ids.assistant1)).toBe(true);

    const remaining = await store.getAll(sessionId);
    expect(remaining.map((message) => message.id)).toEqual([ids.user1]);
    expect(await store.getActiveBoundary(sessionId)).toMatchObject({ messageId: ids.user1 });
    expect(
      await db
        .select({ id: messages.id, parentMessageId: messages.parentMessageId })
        .from(messages)
        .where(eq(messages.sessionId, sessionId)),
    ).toEqual([{ id: ids.user1, parentMessageId: null }]);

    await db.delete(sessions).where(eq(sessions.id, sessionId));
  });

  it('atomically refuses to delete messages from an archived chat', async () => {
    const suffix = `${Date.now()}-${Math.random()}`;
    const sessionId = `archived-delete-${suffix}`;
    const messageId = `archived-message-${suffix}`;
    await db.insert(sessions).values({
      id: sessionId,
      title: 'Archived delete guard',
      createdAt: new Date(1_000),
      updatedAt: new Date(1_000),
    });
    const store = new MessageStore();
    await store.add(sessionId, {
      id: messageId,
      sessionId,
      role: 'user',
      content: 'retain me',
      createdAt: 2_000,
    });
    await db
      .update(sessions)
      .set({ archivedAt: new Date(3_000) })
      .where(eq(sessions.id, sessionId));

    await expect(store.deleteMessage(sessionId, messageId)).rejects.toThrow(
      /Recover this archived chat/,
    );
    expect(
      await db.select({ id: messages.id }).from(messages).where(eq(messages.id, messageId)),
    ).toEqual([{ id: messageId }]);

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
    expect(await store.countContextImageAttachments(sessionId)).toBe(1);
    await store.replaceAndTruncate(sessionId, messageId, 'inspect this edited version');
    expect((await store.getAll(sessionId))[0]).toMatchObject({
      content: 'inspect this edited version',
      attachments: [{ type: 'image', name: 'screen.png', mimeType: 'image/png' }],
    });
    expect(await store.countContextImageAttachments(sessionId)).toBe(1);
    await db.delete(sessions).where(eq(sessions.id, sessionId));
  });

  it('ignores malformed legacy blocks while counting valid user images', async () => {
    const suffix = `${Date.now()}-${Math.random()}`;
    const sessionId = `image-count-${suffix}`;
    const messageId = `image-count-user-${suffix}`;
    await db.insert(sessions).values({
      id: sessionId,
      title: 'Image count test',
      createdAt: new Date(1_000),
      updatedAt: new Date(1_000),
    });
    const store = new MessageStore();
    await store.add(sessionId, {
      id: messageId,
      sessionId,
      role: 'user',
      content: 'legacy content placeholder',
      createdAt: 2_000,
    });
    await db
      .update(messages)
      .set({
        content: JSON.stringify([
          'legacy scalar',
          { type: 'image', data: 'valid-base64', name: 'valid.png' },
          { type: 'image', data: 7, name: 'not-text.png' },
          { type: 'image', data: 'missing-name' },
        ]),
      })
      .where(eq(messages.id, messageId));

    expect(await store.countContextImageAttachments(sessionId)).toBe(1);
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

  it('prepares regeneration as a real sibling branch and retains variants for display', async () => {
    const suffix = `${Date.now()}-${Math.random()}`;
    const sessionId = `regeneration-branch-${suffix}`;
    const promptId = `prompt-${suffix}`;
    const originalId = `original-${suffix}`;
    const laterPromptId = `later-prompt-${suffix}`;
    const laterAnswerId = `later-answer-${suffix}`;
    const regeneratedId = `regenerated-${suffix}`;
    await db.insert(sessions).values({
      id: sessionId,
      title: 'Regeneration branch test',
      createdAt: new Date(1_000),
      updatedAt: new Date(1_000),
    });
    const store = new MessageStore();
    for (const message of [
      { id: promptId, role: 'user' as const, content: 'original prompt', createdAt: 2_000 },
      { id: originalId, role: 'assistant' as const, content: 'original answer', createdAt: 3_000 },
      { id: laterPromptId, role: 'user' as const, content: 'later prompt', createdAt: 4_000 },
      { id: laterAnswerId, role: 'assistant' as const, content: 'later answer', createdAt: 5_000 },
    ]) {
      await store.add(sessionId, { ...message, sessionId });
    }

    const candidate = await store.getRegenerationCandidate(sessionId, originalId);
    expect(candidate).toMatchObject({
      target: { id: originalId },
      prompt: { id: promptId },
      boundary: { messageId: laterAnswerId },
    });
    const branch = await store.prepareRegenerationBranch({
      sessionId,
      targetMessageId: originalId,
      promptMessageId: promptId,
      expectedActiveMessageId: candidate!.boundary.messageId,
      expectedProviderConversationRevision: candidate!.providerConversationRevision,
    });
    expect(branch).toMatchObject({
      sessionId,
      targetMessageId: originalId,
      promptMessageId: promptId,
      expectedActiveMessageId: laterAnswerId,
      expectedProviderConversationRevision: 0,
      groupId: `response-${promptId}`,
      index: 1,
    });
    // Preparing a branch is crash-safe: it does not hide the current future.
    expect((await store.getContextMessages(sessionId)).map((message) => message.id)).toEqual([
      promptId,
      originalId,
      laterPromptId,
      laterAnswerId,
    ]);
    expect(
      (await store.getContextMessagesAtBoundary(sessionId, promptId)).map((message) => message.id),
    ).toEqual([promptId]);

    await store.commitRegeneratedResponse(branch, {
      id: regeneratedId,
      sessionId,
      role: 'assistant',
      content: 'regenerated answer',
      variantGroupId: branch.groupId,
      variantIndex: branch.index,
      createdAt: 6_000,
    });
    expect((await store.getAll(sessionId)).map((message) => message.id)).toEqual([
      promptId,
      regeneratedId,
    ]);
    const display = await store.getDisplayMessages(sessionId);
    expect(display.map((message) => message.id)).toEqual([promptId, originalId, regeneratedId]);
    expect(display.map(({ id, isActiveBranch }) => ({ id, isActiveBranch }))).toEqual([
      { id: promptId, isActiveBranch: true },
      { id: originalId, isActiveBranch: false },
      { id: regeneratedId, isActiveBranch: true },
    ]);
    expect(
      display
        .filter((message) => message.variantGroupId === branch.groupId)
        .map((message) => message.variantIndex),
    ).toEqual([0, 1]);

    // The original sibling remains a valid regeneration target. Variant
    // allocation is session-wide, not limited to the active lineage.
    const retainedCandidate = await store.getRegenerationCandidate(sessionId, originalId);
    const secondBranch = await store.prepareRegenerationBranch({
      sessionId,
      targetMessageId: originalId,
      promptMessageId: promptId,
      expectedActiveMessageId: retainedCandidate!.boundary.messageId,
      expectedProviderConversationRevision: retainedCandidate!.providerConversationRevision,
    });
    expect(secondBranch.index).toBe(2);
    expect((await store.getAll(sessionId)).map((message) => message.id)).toEqual([
      promptId,
      regeneratedId,
    ]);

    await db.delete(sessions).where(eq(sessions.id, sessionId));
  });

  it('CAS-activates a retained response variant and rewinds descendants without deleting them', async () => {
    const suffix = `${Date.now()}-${Math.random()}`;
    const sessionId = `variant-activation-${suffix}`;
    const promptId = `prompt-${suffix}`;
    const originalId = `original-${suffix}`;
    const oldPromptId = `old-prompt-${suffix}`;
    const oldAnswerId = `old-answer-${suffix}`;
    const regeneratedId = `regenerated-${suffix}`;
    const newPromptId = `new-prompt-${suffix}`;
    const newAnswerId = `new-answer-${suffix}`;
    await db.insert(sessions).values({
      id: sessionId,
      title: 'Variant activation test',
      createdAt: new Date(1_000),
      updatedAt: new Date(1_000),
    });
    const store = new MessageStore();
    for (const message of [
      { id: promptId, role: 'user' as const, content: 'prompt', createdAt: 2_000 },
      { id: originalId, role: 'assistant' as const, content: 'original', createdAt: 3_000 },
      { id: oldPromptId, role: 'user' as const, content: 'old follow-up', createdAt: 4_000 },
      { id: oldAnswerId, role: 'assistant' as const, content: 'old future', createdAt: 5_000 },
    ]) {
      await store.add(sessionId, { ...message, sessionId });
    }
    const candidate = await store.getRegenerationCandidate(sessionId, originalId);
    const branch = await store.prepareRegenerationBranch({
      sessionId,
      targetMessageId: originalId,
      promptMessageId: promptId,
      expectedActiveMessageId: candidate!.boundary.messageId,
      expectedProviderConversationRevision: candidate!.providerConversationRevision,
    });
    await store.commitRegeneratedResponse(branch, {
      id: regeneratedId,
      sessionId,
      role: 'assistant',
      content: 'regenerated',
      variantGroupId: branch.groupId,
      variantIndex: branch.index,
      createdAt: 6_000,
    });
    await store.add(sessionId, {
      id: newPromptId,
      sessionId,
      role: 'user',
      content: 'new follow-up',
      createdAt: 7_000,
    });
    await store.add(sessionId, {
      id: newAnswerId,
      sessionId,
      role: 'assistant',
      content: 'new future',
      createdAt: 8_000,
    });

    const boundary = await store.getActiveBoundary(sessionId);
    expect(boundary).toMatchObject({
      messageId: newAnswerId,
      contextRevision: 0,
      providerConversationRevision: 1,
    });
    const projection = await store.getDisplayProjection(sessionId);
    expect(projection).toMatchObject({
      activeMessageId: newAnswerId,
      conversationRevision: 0,
      providerConversationRevision: 1,
    });
    expect(
      projection.messages
        .filter((message) => message.variantGroupId === branch.groupId)
        .map(({ id, isActiveBranch }) => ({ id, isActiveBranch })),
    ).toEqual([
      { id: originalId, isActiveBranch: false },
      { id: regeneratedId, isActiveBranch: true },
    ]);
    await expect(
      store.activateResponseVariant({
        sessionId,
        messageId: originalId,
        expectedActiveMessageId: newAnswerId,
        expectedProviderConversationRevision: 0,
      }),
    ).rejects.toThrow(/Conversation changed/);
    expect((await store.getActiveBoundary(sessionId)).messageId).toBe(newAnswerId);

    const activated = await store.activateResponseVariant({
      sessionId,
      messageId: originalId,
      expectedActiveMessageId: newAnswerId,
      expectedProviderConversationRevision: 1,
    });
    expect(activated).toEqual({
      previousActiveMessageId: newAnswerId,
      activeMessageId: originalId,
      conversationRevision: 0,
      providerConversationRevision: 2,
      rewoundMessageCount: 2,
    });
    expect((await store.getAll(sessionId)).map((message) => message.id)).toEqual([
      promptId,
      originalId,
    ]);
    expect(
      await db.select({ id: messages.id }).from(messages).where(eq(messages.sessionId, sessionId)),
    ).toHaveLength(7);
    expect(
      (await store.getDisplayMessages(sessionId)).map(({ id, isActiveBranch }) => ({
        id,
        isActiveBranch,
      })),
    ).toEqual([
      { id: promptId, isActiveBranch: true },
      { id: originalId, isActiveBranch: true },
      { id: regeneratedId, isActiveBranch: false },
    ]);

    await expect(
      store.activateResponseVariant({
        sessionId,
        messageId: regeneratedId,
        expectedActiveMessageId: newAnswerId,
        expectedProviderConversationRevision: 1,
      }),
    ).rejects.toThrow(/Conversation changed/);
    expect((await store.getActiveBoundary(sessionId)).messageId).toBe(originalId);

    await db.delete(sessions).where(eq(sessions.id, sessionId));
  });

  it('rolls back regeneration metadata when the active-head compare-and-set is stale', async () => {
    const suffix = `${Date.now()}-${Math.random()}`;
    const sessionId = `regeneration-cas-${suffix}`;
    const promptId = `prompt-${suffix}`;
    const answerId = `answer-${suffix}`;
    const concurrentId = `concurrent-${suffix}`;
    await db.insert(sessions).values({
      id: sessionId,
      title: 'Regeneration CAS test',
      createdAt: new Date(1_000),
      updatedAt: new Date(1_000),
    });
    const store = new MessageStore();
    await store.add(sessionId, {
      id: promptId,
      sessionId,
      role: 'user',
      content: 'prompt',
      createdAt: 2_000,
    });
    await store.add(sessionId, {
      id: answerId,
      sessionId,
      role: 'assistant',
      content: 'answer',
      createdAt: 3_000,
    });
    const candidate = await store.getRegenerationCandidate(sessionId, answerId);
    await store.add(sessionId, {
      id: concurrentId,
      sessionId,
      role: 'user',
      content: 'concurrent change',
      createdAt: 4_000,
    });

    await expect(
      store.prepareRegenerationBranch({
        sessionId,
        targetMessageId: answerId,
        promptMessageId: promptId,
        expectedActiveMessageId: candidate!.boundary.messageId,
        expectedProviderConversationRevision: candidate!.providerConversationRevision,
      }),
    ).rejects.toThrow(/changed before regeneration/);
    const [answer] = await db
      .select({ variantGroupId: messages.variantGroupId })
      .from(messages)
      .where(eq(messages.id, answerId));
    expect(answer?.variantGroupId).toBeNull();
    expect(await store.getActiveBoundary(sessionId)).toMatchObject({ messageId: concurrentId });

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
      providerConversationRevision: 2,
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
