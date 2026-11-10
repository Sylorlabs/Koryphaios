import { beforeAll, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db, initDb, messages, sessionCompactions, sessions } from '../db';
import { MessageStore } from '../stores/message-store';
import { forkSessionAtMessage } from './session-fork-service';

beforeAll(async () => {
  await initDb();
});

async function seedSession(suffix: string) {
  const sessionId = `fork-source-${suffix}`;
  await db.insert(sessions).values({
    id: sessionId,
    title: 'Original chat',
    workingDirectory: '/tmp/fork-project',
    metadata: JSON.stringify({
      interactionMode: 'plan',
      gitWorkspace: { path: '/tmp/isolated', branch: 'kory/x' },
    }),
    createdAt: new Date(1_000),
    updatedAt: new Date(1_000),
  });
  const store = new MessageStore();
  const ids = ['u1', 'a1', 'u2', 'a2'].map((id) => `${id}-${suffix}`);
  for (const [index, id] of ids.entries()) {
    await store.add(sessionId, {
      id,
      sessionId,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `message ${index}`,
      cost: 0.25,
      tokensIn: 10,
      tokensOut: 20,
      createdAt: 2_000 + index,
    });
  }
  return { sessionId, ids, store };
}

describe('forkSessionAtMessage', () => {
  it('copies the lineage up to the chosen message into a new chat', async () => {
    const suffix = `${Date.now()}-${Math.random()}`;
    const { sessionId, ids, store } = await seedSession(suffix);

    const { session, copiedMessageCount } = forkSessionAtMessage({
      sourceSessionId: sessionId,
      messageId: ids[1],
    });

    expect(copiedMessageCount).toBe(2);
    expect(session.id).not.toBe(sessionId);
    expect(session.title).toBe('Original chat (fork)');
    expect(session.parentSessionId).toBe(sessionId);
    expect(session.workingDirectory).toBe('/tmp/fork-project');
    expect(session.interactionMode).toBe('plan');

    const forked = await store.getAll(session.id);
    expect(forked.map((message) => message.content)).toEqual(['message 0', 'message 1']);
    expect(forked.map((message) => message.role)).toEqual(['user', 'assistant']);
    // Fresh ids, and no spend copied: it was billed to the source chat.
    expect(forked.some((message) => ids.includes(message.id))).toBe(false);
    expect(forked.every((message) => (message.cost ?? 0) === 0)).toBe(true);

    const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id));
    expect(row.messageCount).toBe(2);
    expect(row.totalCost).toBe(0);
    // The source's isolated checkout is never inherited by the fork.
    expect(JSON.parse(row.metadata ?? '{}').gitWorkspace).toBeUndefined();

    // Source chat is untouched.
    expect((await store.getAll(sessionId)).map((message) => message.id)).toEqual(ids);
  });

  it('remaps compaction checkpoints and keeps the context revision', async () => {
    const suffix = `${Date.now()}-${Math.random()}`;
    const { sessionId, ids, store } = await seedSession(suffix);
    const compactionId = `cmp-${suffix}`;
    await store.commitCompaction({
      id: compactionId,
      sessionId,
      summary: 'summary of earlier turns',
      provider: 'openai',
      model: 'gpt-test',
      automatic: false,
      sourceMessageCount: 4,
      sourceTokens: 100,
      checkpointTokens: 10,
    } as Parameters<MessageStore['commitCompaction']>[0]);
    const tailId = `tail-${suffix}`;
    await store.add(sessionId, {
      id: tailId,
      sessionId,
      role: 'user',
      content: 'after compaction',
      createdAt: 9_000,
    });

    const { session, copiedMessageCount } = forkSessionAtMessage({
      sourceSessionId: sessionId,
      messageId: tailId,
    });
    expect(copiedMessageCount).toBe(ids.length + 2);

    const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id));
    expect(row.conversationRevision).toBe(1);

    const forkedRows = await db.select().from(messages).where(eq(messages.sessionId, session.id));
    const checkpoint = forkedRows.find((message) => message.role === 'system');
    expect(checkpoint?.id.startsWith('compact-')).toBe(true);
    expect(checkpoint?.id).not.toBe(`compact-${compactionId}`);

    const [copiedCompaction] = await db
      .select()
      .from(sessionCompactions)
      .where(eq(sessionCompactions.sessionId, session.id));
    expect(`compact-${copiedCompaction.id}`).toBe(checkpoint!.id);

    const context = await store.getContextMessages(session.id);
    expect(context.map((message) => message.content)).toEqual([
      '[KORY_COMPACTION]\nsummary of earlier turns',
      'after compaction',
    ]);
  });

  it('rejects a message that does not belong to the source chat', async () => {
    const suffix = `${Date.now()}-${Math.random()}`;
    const { sessionId } = await seedSession(suffix);
    expect(() =>
      forkSessionAtMessage({ sourceSessionId: sessionId, messageId: `missing-${suffix}` }),
    ).toThrow();
    expect(() =>
      forkSessionAtMessage({ sourceSessionId: `nope-${suffix}`, messageId: 'x' }),
    ).toThrow();
  });
});
