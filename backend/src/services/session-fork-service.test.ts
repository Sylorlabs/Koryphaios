import { beforeAll, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { TranscriptPart } from '@koryphaios/shared';
import {
  db,
  initDb,
  messages,
  sessionCompactions,
  sessionFeedEntries,
  sessionTurnCommands,
  sessions,
} from '../db';
import { ConflictError, ValidationError } from '../errors/types';
import { withDisplayParts } from '../routes/v1/messages';
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

/* ───────────── Fork points, parts, attachments, lineage, isolation ───────────── */

let forkSeq = 0;
function uniq(label: string): string {
  forkSeq += 1;
  return `${label}-${Date.now()}-${forkSeq}-${Math.random().toString(36).slice(2, 7)}`;
}

async function newChat(title = 'Source chat', extra: Partial<typeof sessions.$inferInsert> = {}) {
  const id = uniq('chat');
  await db.insert(sessions).values({
    id,
    title,
    workingDirectory: '/tmp/fork-project',
    createdAt: new Date(1_000),
    updatedAt: new Date(1_000),
    ...extra,
  });
  return id;
}

/** Ids a turn command owns. The ledger's CHECKs bind both message ids to the key. */
function turnIds() {
  const commandKey = randomBytes(20).toString('hex');
  return {
    commandKey,
    userMessageId: `command-user-${commandKey}`,
    responseMessageId: `command-response-${commandKey}`,
  };
}

/** Records a turn command in the same shape the ledger writes it. */
async function recordTurn(
  sessionId: string,
  ids: ReturnType<typeof turnIds>,
  status: 'active' | 'waiting' | 'completed' | 'failed' | 'cancelled',
) {
  const settled = status === 'failed' || status === 'cancelled' || status === 'completed';
  await db.insert(sessionTurnCommands).values({
    commandKey: ids.commandKey,
    sessionId,
    source: 'user',
    sourceCommandId: uniq('src'),
    inputHash: randomBytes(32).toString('hex'),
    userMessageId: ids.userMessageId,
    responseMessageId: ids.responseMessageId,
    runId: uniq('run'),
    status,
    terminalReason: settled ? `${status}_for_test` : null,
    createdAt: 2_000,
    updatedAt: 2_000,
    finishedAt: settled ? 2_000 : null,
  });
}

/** The reload path: what the HTTP history route returns for a chat. */
async function reloadedTranscript(sessionId: string) {
  const projection = await new MessageStore().getDisplayProjection(sessionId);
  return projection.messages.map(withDisplayParts).map((message) => ({
    role: message.role,
    content: message.content,
    parts: message.parts,
    attachments: message.attachments,
    variantIndex: message.variantIndex,
    isActiveBranch: message.isActiveBranch,
  }));
}

const IMAGE_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('forkSessionAtMessage fork points', () => {
  it('forks at a failed turn whose reply was never persisted', async () => {
    const sourceId = await newChat();
    const store = new MessageStore();
    await store.add(sourceId, { id: `u1-${sourceId}`, sessionId: sourceId, role: 'user', content: 'hello', createdAt: 2_000 });
    await store.add(sourceId, { id: `a1-${sourceId}`, sessionId: sourceId, role: 'assistant', content: 'hi', createdAt: 2_001 });
    const failed = turnIds();
    await store.add(sourceId, { id: failed.userMessageId, sessionId: sourceId, role: 'user', content: 'fail me', createdAt: 2_002 });
    await recordTurn(sourceId, failed, 'failed');

    const { session, copiedMessageCount, forkMessageId } = forkSessionAtMessage({
      sourceSessionId: sourceId,
      messageId: failed.userMessageId,
    });

    expect(copiedMessageCount).toBe(3);
    expect(forkMessageId).toBe(failed.userMessageId);
    const forked = await store.getAll(session.id);
    expect(forked.map((message) => message.content)).toEqual(['hello', 'hi', 'fail me']);
  });

  it('forks at an interrupted or cancelled turn, and at the latest finished message by default', async () => {
    const sourceId = await newChat();
    const store = new MessageStore();
    const cancelled = turnIds();
    await store.add(sourceId, { id: cancelled.userMessageId, sessionId: sourceId, role: 'user', content: 'one', createdAt: 2_000 });
    await store.add(sourceId, { id: cancelled.responseMessageId, sessionId: sourceId, role: 'assistant', content: 'partial', createdAt: 2_001 });
    await store.add(sourceId, { id: `sys-${sourceId}`, sessionId: sourceId, role: 'system', content: 'Stopped by user.', createdAt: 2_002 });
    await recordTurn(sourceId, cancelled, 'cancelled');

    const latest = forkSessionAtMessage({ sourceSessionId: sourceId });
    expect(latest.copiedMessageCount).toBe(3);
    expect(latest.forkMessageId).toBe(`sys-${sourceId}`);
    expect((await store.getAll(latest.session.id)).map((m) => m.content)).toEqual([
      'one',
      'partial',
      'Stopped by user.',
    ]);
  });

  it('steps back past a running turn when no message is named, and refuses to fork from it', async () => {
    const sourceId = await newChat();
    const store = new MessageStore();
    await store.add(sourceId, { id: `u1-${sourceId}`, sessionId: sourceId, role: 'user', content: 'done', createdAt: 2_000 });
    await store.add(sourceId, { id: `a1-${sourceId}`, sessionId: sourceId, role: 'assistant', content: 'done reply', createdAt: 2_001 });
    const running = turnIds();
    await store.add(sourceId, { id: running.userMessageId, sessionId: sourceId, role: 'user', content: 'still running', createdAt: 2_002 });
    await recordTurn(sourceId, running, 'active');

    const latest = forkSessionAtMessage({ sourceSessionId: sourceId });
    expect((await store.getAll(latest.session.id)).map((m) => m.content)).toEqual([
      'done',
      'done reply',
    ]);
    expect(() =>
      forkSessionAtMessage({ sourceSessionId: sourceId, messageId: running.userMessageId }),
    ).toThrow(ConflictError);
    expect(() =>
      forkSessionAtMessage({ sourceSessionId: sourceId, messageId: running.userMessageId }),
    ).toThrow(ConflictError);
  });

  it('refuses a chat with nothing to fork from', async () => {
    const sourceId = await newChat();
    expect(() => forkSessionAtMessage({ sourceSessionId: sourceId })).toThrow(ValidationError);
  });

  it('uses an explicit title, with the same length and default-name rules as a rename', async () => {
    const sourceId = await newChat('Original');
    const store = new MessageStore();
    await store.add(sourceId, { id: `u1-${sourceId}`, sessionId: sourceId, role: 'user', content: 'x', createdAt: 2_000 });
    const titled = forkSessionAtMessage({ sourceSessionId: sourceId, title: '  Try   the   other way ' });
    expect(titled.session.title).toBe('Try the other way');
    expect(() => forkSessionAtMessage({ sourceSessionId: sourceId, title: 'New Session' })).toThrow(
      ValidationError,
    );
  });
});

describe('forkSessionAtMessage content and reload parity', () => {
  it('copies parts and inline image attachments so the reloaded fork matches the source', async () => {
    const sourceId = await newChat();
    const store = new MessageStore();
    const parts: TranscriptPart[] = [
      { kind: 'reasoning', text: 'look at the picture', startedAt: 10, endedAt: 11 },
      { kind: 'text', text: 'It is one pixel.', startedAt: 12 },
    ];
    await store.add(sourceId, {
      id: `u1-${sourceId}`,
      sessionId: sourceId,
      role: 'user',
      content: 'what is this?',
      attachments: [{ type: 'image', name: 'pixel.png', data: IMAGE_B64, mimeType: 'image/png' }],
      createdAt: 2_000,
    });
    await store.add(sourceId, {
      id: `a1-${sourceId}`,
      sessionId: sourceId,
      role: 'assistant',
      content: 'It is one pixel.',
      reasoningContent: 'look at the picture',
      parts,
      createdAt: 2_001,
    });

    const { session } = forkSessionAtMessage({ sourceSessionId: sourceId });
    const sourceView = await reloadedTranscript(sourceId);
    const forkView = await reloadedTranscript(session.id);

    expect(forkView).toEqual(sourceView);
    expect(forkView[0]!.attachments).toEqual([
      { type: 'image', name: 'pixel.png', data: IMAGE_B64, mimeType: 'image/png' },
    ]);
    expect(forkView[1]!.parts).toEqual(parts);
  });

  it('keeps variant siblings of copied responses so the fork shows the same alternatives', async () => {
    const sourceId = await newChat();
    const store = new MessageStore();
    await store.add(sourceId, { id: `u1-${sourceId}`, sessionId: sourceId, role: 'user', content: 'pick', createdAt: 2_000 });
    await store.add(sourceId, {
      id: `a1-${sourceId}`,
      sessionId: sourceId,
      role: 'assistant',
      content: 'option A',
      variantGroupId: `g-${sourceId}`,
      variantIndex: 0,
      createdAt: 2_001,
    });
    // Both responses answer the same request, so their parent is the user message.
    await db.update(sessions).set({ activeMessageId: `u1-${sourceId}` }).where(eq(sessions.id, sourceId));
    await store.add(sourceId, {
      id: `a1b-${sourceId}`,
      sessionId: sourceId,
      role: 'assistant',
      content: 'option B',
      variantGroupId: `g-${sourceId}`,
      variantIndex: 1,
      createdAt: 2_002,
    });
    await db.update(sessions).set({ activeMessageId: `a1-${sourceId}` }).where(eq(sessions.id, sourceId));

    const { session, copiedMessageCount } = forkSessionAtMessage({
      sourceSessionId: sourceId,
      messageId: `a1-${sourceId}`,
    });
    expect(copiedMessageCount).toBe(3);

    const forkView = await reloadedTranscript(session.id);
    const alternatives = forkView.filter((row) => row.role === 'assistant');
    expect(alternatives.map((row) => row.content).sort()).toEqual(['option A', 'option B']);
    expect(alternatives.find((row) => row.content === 'option A')?.isActiveBranch).toBe(true);
    expect(alternatives.find((row) => row.content === 'option B')?.isActiveBranch).toBe(false);
  });

  it('copies client feed errors at or before the fork point only', async () => {
    const sourceId = await newChat();
    const store = new MessageStore();
    await store.add(sourceId, { id: `u1-${sourceId}`, sessionId: sourceId, role: 'user', content: 'one', createdAt: 3_000 });
    await db.insert(sessionFeedEntries).values([
      { id: `feed-early-${sourceId}`, sessionId: sourceId, kind: 'client_error', text: 'early', timestamp: new Date(2_500), createdAt: new Date(2_500), updatedAt: new Date(2_500) },
      { id: `feed-late-${sourceId}`, sessionId: sourceId, kind: 'client_error', text: 'late', timestamp: new Date(9_000), createdAt: new Date(9_000), updatedAt: new Date(9_000) },
    ]);

    const { session } = forkSessionAtMessage({ sourceSessionId: sourceId });
    const copied = await db.select().from(sessionFeedEntries).where(eq(sessionFeedEntries.sessionId, session.id));
    expect(copied.map((entry) => entry.text)).toEqual(['early']);
  });
});

describe('forkSessionAtMessage lineage, native state and isolation', () => {
  it('records lineage on the row and exposes it on the shared session', async () => {
    const sourceId = await newChat();
    const store = new MessageStore();
    await store.add(sourceId, { id: `u1-${sourceId}`, sessionId: sourceId, role: 'user', content: 'a', createdAt: 2_000 });
    await store.add(sourceId, { id: `a1-${sourceId}`, sessionId: sourceId, role: 'assistant', content: 'b', createdAt: 2_001 });

    const { session } = forkSessionAtMessage({ sourceSessionId: sourceId, messageId: `a1-${sourceId}` });

    expect(session.forkedFromSessionId).toBe(sourceId);
    expect(session.forkedFromMessageId).toBe(`a1-${sourceId}`);
    expect(typeof session.forkedAt).toBe('number');
    expect(session.forkMergedAt).toBeUndefined();
    expect(session.parentSessionId).toBe(sourceId);

    const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id));
    expect(row.forkedFromSessionId).toBe(sourceId);
    expect(row.forkedFromMessageId).toBe(`a1-${sourceId}`);
    expect(row.forkedAt?.getTime()).toBe(session.forkedAt);
    expect(row.forkedMergedAt).toBeNull();
    // The base is the fork's own copy of its fork point, never the source id.
    const forkedMessages = await store.getAll(session.id);
    expect(row.forkedBaseMessageId).toBe(forkedMessages[forkedMessages.length - 1]!.id);
    expect(row.forkedBaseMessageId).not.toBe(`a1-${sourceId}`);
    expect(row.activeMessageId).toBe(row.forkedBaseMessageId);

    // An original chat has no lineage.
    const [original] = await db.select().from(sessions).where(eq(sessions.id, sourceId));
    expect(original.forkedFromSessionId).toBeNull();
  });

  it('never resumes or mutates provider-native state: nothing native is copied and the source is untouched', async () => {
    const sourceId = await newChat('Native source', {
      providerConversationRevision: 3,
      metadata: JSON.stringify({
        jules: { sessionId: 'remote-jules-1', url: 'https://example.invalid/s/1', updatedAt: 1 },
        gitWorkspace: { path: '/tmp/isolated' },
        planNoteId: 'note-1',
        interactionMode: 'plan',
      }),
    });
    const store = new MessageStore();
    await store.add(sourceId, { id: `u1-${sourceId}`, sessionId: sourceId, role: 'user', content: 'go', createdAt: 2_000 });
    const sourceMetadataBefore = (await db.select().from(sessions).where(eq(sessions.id, sourceId)))[0]!.metadata;

    const { session } = forkSessionAtMessage({ sourceSessionId: sourceId });

    const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id));
    expect(row.providerConversationRevision).toBe(0);
    const forkMetadata = JSON.parse(row.metadata ?? '{}');
    expect(forkMetadata.jules).toBeUndefined();
    expect(forkMetadata.gitWorkspace).toBeUndefined();
    expect(forkMetadata.planNoteId).toBeUndefined();
    expect(forkMetadata.forkedFrom).toBeUndefined();
    expect(forkMetadata.interactionMode).toBe('plan');

    const [source] = await db.select().from(sessions).where(eq(sessions.id, sourceId));
    expect(source.providerConversationRevision).toBe(3);
    expect(source.metadata).toBe(sourceMetadataBefore);
  });

  it('isolates the two chats: writes to the fork never appear in the source, and the reverse', async () => {
    const sourceId = await newChat();
    const store = new MessageStore();
    await store.add(sourceId, { id: `u1-${sourceId}`, sessionId: sourceId, role: 'user', content: 'base', createdAt: 2_000 });
    const { session } = forkSessionAtMessage({ sourceSessionId: sourceId });
    const sourceBefore = (await store.getAll(sourceId)).map((m) => m.id);

    await store.add(session.id, { id: `fork-only-${sourceId}`, sessionId: session.id, role: 'user', content: 'fork only', createdAt: 3_000 });
    expect((await store.getAll(sourceId)).map((m) => m.id)).toEqual(sourceBefore);

    await store.add(sourceId, { id: `src-only-${sourceId}`, sessionId: sourceId, role: 'user', content: 'source only', createdAt: 3_001 });
    const forked = (await store.getAll(session.id)).map((m) => m.content);
    expect(forked).not.toContain('source only');
    expect(forked).toContain('fork only');
  });
});
