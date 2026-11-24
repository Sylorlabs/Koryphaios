import { beforeAll, describe, expect, it } from 'bun:test';
import { randomBytes } from 'node:crypto';
import type { Session, WSEventType } from '@koryphaios/shared';
import { eq } from 'drizzle-orm';
import { db, initDb, sessionTurnCommands, sessions } from '../db';
import { ConflictError, NotFoundError, ValidationError } from '../errors/types';
import { MessageStore } from '../stores/message-store';
import { SessionStore } from '../stores/session-store';
import {
  commitForkMerge,
  buildForkMergeDigest,
  forkMergeMessageId,
  FORK_MERGE_MARKER,
} from './session-fork-service';
import {
  forkChatCoordinated,
  mergeForkCoordinated,
  type ForkCoordinatorDependencies,
} from './session-fork-coordinator';

beforeAll(async () => {
  await initDb();
});

let seq = 0;
function uniq(label: string): string {
  seq += 1;
  return `${label}-${Date.now()}-${seq}-${Math.random().toString(36).slice(2, 7)}`;
}

interface Published {
  type: WSEventType;
  sessionId: string;
  payload: Record<string, unknown>;
}

function harness(overrides: Partial<ForkCoordinatorDependencies> = {}) {
  const published: Published[] = [];
  const prepared: string[] = [];
  const store = new SessionStore();
  const deps: ForkCoordinatorDependencies = {
    getSession: (id) => store.get(id),
    tryAcquireCreationLease: () => ({ release() {} }),
    tryAcquireMutationBarrier: () => ({ release() {} }),
    prepareForkedSession: (session: Session) => {
      prepared.push(session.id);
    },
    publish: (type, sessionId, payload) => {
      published.push({ type, sessionId, payload });
    },
    ...overrides,
  };
  return { deps, published, prepared };
}

async function newChat(title = 'Merge source') {
  const id = uniq('merge-src');
  await db.insert(sessions).values({
    id,
    title,
    workingDirectory: '/tmp/merge-project',
    createdAt: new Date(1_000),
    updatedAt: new Date(1_000),
  });
  return id;
}

/** A source with one finished exchange, then a fork that adds a new exchange. */
async function sourceWithFork(options: { attachment?: boolean } = {}) {
  const sourceId = await newChat();
  const store = new MessageStore();
  await store.add(sourceId, {
    id: `base-u-${sourceId}`,
    sessionId: sourceId,
    role: 'user',
    content: 'shared history',
    createdAt: 2_000,
  });
  await store.add(sourceId, {
    id: `base-a-${sourceId}`,
    sessionId: sourceId,
    role: 'assistant',
    content: 'shared reply',
    createdAt: 2_001,
  });
  const { session } = forkChatCoordinatedSync(sourceId);
  await store.add(session.id, {
    id: `fork-u-${session.id}`,
    sessionId: session.id,
    role: 'user',
    content: 'try the other approach',
    ...(options.attachment
      ? {
          attachments: [
            { type: 'image' as const, name: 'diagram.png', data: 'AAAA', mimeType: 'image/png' },
          ],
        }
      : {}),
    createdAt: 3_000,
  });
  await store.add(session.id, {
    id: `fork-a-${session.id}`,
    sessionId: session.id,
    role: 'assistant',
    content: 'the other approach worked',
    createdAt: 3_001,
  });
  return { sourceId, forkId: session.id, store };
}

/** Fork creation without the event harness, for fixtures. */
function forkChatCoordinatedSync(sourceId: string) {
  const { forkSessionAtMessage } =
    require('./session-fork-service') as typeof import('./session-fork-service');
  return forkSessionAtMessage({ sourceSessionId: sourceId });
}

describe('forkChatCoordinated', () => {
  it('creates the fork, prepares it, and publishes session.updated for the fork and session.forked on the source', async () => {
    const sourceId = await newChat('Coordinated source');
    await new MessageStore().add(sourceId, {
      id: uniq('m'),
      sessionId: sourceId,
      role: 'user',
      content: 'hi',
      createdAt: 2_000,
    });
    const { deps, published, prepared } = harness();

    const outcome = await forkChatCoordinated({ sourceSessionId: sourceId }, deps);

    expect(outcome.sourceSessionId).toBe(sourceId);
    expect(outcome.session.forkedFromSessionId).toBe(sourceId);
    expect(prepared).toEqual([outcome.session.id]);
    const updated = published.find((event) => event.type === 'session.updated');
    expect(updated?.sessionId).toBe(outcome.session.id);
    const forked = published.find((event) => event.type === 'session.forked');
    expect(forked).toMatchObject({
      sessionId: sourceId,
      payload: {
        sourceSessionId: sourceId,
        copiedMessageCount: 1,
        forkMessageId: outcome.forkMessageId,
      },
    });
  });

  it('refuses while the creation lease is held (delete-all in progress) and for an unknown source', async () => {
    const sourceId = await newChat();
    await new MessageStore().add(sourceId, {
      id: uniq('m'),
      sessionId: sourceId,
      role: 'user',
      content: 'hi',
      createdAt: 2_000,
    });
    const blocked = harness({ tryAcquireCreationLease: () => null });
    await expect(forkChatCoordinated({ sourceSessionId: sourceId }, blocked.deps)).rejects.toThrow(
      ConflictError,
    );
    expect(blocked.published).toHaveLength(0);
    await expect(
      forkChatCoordinated({ sourceSessionId: uniq('missing') }, harness().deps),
    ).rejects.toThrow(NotFoundError);
  });
});

describe('mergeForkCoordinated', () => {
  it('summary mode appends one host-authored system entry to the source and marks the fork merged', async () => {
    const { sourceId, forkId, store } = await sourceWithFork();
    const sourceBefore = (await store.getAll(sourceId)).map((m) => m.id);
    const { deps, published } = harness();

    const outcome = await mergeForkCoordinated({ forkSessionId: forkId, mode: 'summary' }, deps);

    expect(outcome.messageId).toBe(forkMergeMessageId(forkId));
    const sourceAfter = await store.getAll(sourceId);
    expect(sourceAfter.map((m) => m.id)).toEqual([...sourceBefore, outcome.messageId]);
    const entry = sourceAfter[sourceAfter.length - 1]!;
    expect(entry.role).toBe('system');
    expect(entry.content.startsWith(FORK_MERGE_MARKER)).toBe(true);
    expect(entry.content).toContain('Requested: try the other approach');
    expect(entry.content).toContain('Outcome: the other approach worked');
    expect(entry.content).not.toContain('shared history');

    // The fork itself never receives the entry; the source never gets fork rows.
    expect((await store.getAll(forkId)).map((m) => m.id)).not.toContain(outcome.messageId);
    expect(outcome.fork.forkMergedAt).toBeDefined();
    expect(outcome.source.id).toBe(sourceId);

    const merged = published.find((event) => event.type === 'session.merged');
    expect(merged).toMatchObject({
      sessionId: sourceId,
      payload: {
        sourceSessionId: sourceId,
        forkSessionId: forkId,
        mode: 'summary',
        messageId: outcome.messageId,
      },
    });
    expect(
      published
        .filter((event) => event.type === 'session.updated')
        .map((event) => event.sessionId)
        .sort(),
    ).toEqual([forkId, sourceId].sort());
  });

  it('messages mode quotes only the fork new messages, in order, and notes skipped attachments', async () => {
    const { sourceId, forkId, store } = await sourceWithFork({ attachment: true });
    const outcome = await mergeForkCoordinated(
      { forkSessionId: forkId, mode: 'messages' },
      harness().deps,
    );

    const entry = (await store.getAll(sourceId)).find((m) => m.id === outcome.messageId)!;
    expect(entry.content).toContain(
      'User: try the other approach\n\nAssistant: the other approach worked',
    );
    expect(entry.content).not.toContain('shared history');
    expect(entry.content).toContain('1 attachment from the fork was not copied.');
  });

  it('merges a fork once: the second attempt is a conflict and writes nothing', async () => {
    const { sourceId, forkId, store } = await sourceWithFork();
    await mergeForkCoordinated({ forkSessionId: forkId, mode: 'summary' }, harness().deps);
    const count = (await store.getAll(sourceId)).length;

    await expect(
      mergeForkCoordinated({ forkSessionId: forkId, mode: 'messages' }, harness().deps),
    ).rejects.toThrow(ConflictError);
    expect((await store.getAll(sourceId)).length).toBe(count);
  });

  it('refuses a fork with nothing new, a chat that is not a fork, and an invalid mode', async () => {
    const sourceId = await newChat();
    const store = new MessageStore();
    await store.add(sourceId, {
      id: uniq('m'),
      sessionId: sourceId,
      role: 'user',
      content: 'x',
      createdAt: 2_000,
    });
    const { session } = forkChatCoordinatedSync(sourceId);

    await expect(
      mergeForkCoordinated({ forkSessionId: session.id, mode: 'summary' }, harness().deps),
    ).rejects.toThrow(ValidationError);
    await expect(
      mergeForkCoordinated({ forkSessionId: sourceId, mode: 'summary' }, harness().deps),
    ).rejects.toThrow(ValidationError);
    await expect(
      mergeForkCoordinated(
        { forkSessionId: session.id, mode: 'everything' as 'summary' },
        harness().deps,
      ),
    ).rejects.toThrow(ValidationError);
  });

  it('holds both mutation barriers: a busy source or fork is refused before any write', async () => {
    const { sourceId, forkId, store } = await sourceWithFork();
    const before = (await store.getAll(sourceId)).length;

    const busySource = harness({
      tryAcquireMutationBarrier: (id) => (id === sourceId ? null : { release() {} }),
    });
    await expect(
      mergeForkCoordinated({ forkSessionId: forkId, mode: 'summary' }, busySource.deps),
    ).rejects.toThrow(ConflictError);

    let released = 0;
    const busyFork = harness({
      tryAcquireMutationBarrier: (id) =>
        id === forkId
          ? null
          : {
              release() {
                released += 1;
              },
            },
    });
    await expect(
      mergeForkCoordinated({ forkSessionId: forkId, mode: 'summary' }, busyFork.deps),
    ).rejects.toThrow(ConflictError);
    // The source barrier taken before the fork check is released again.
    expect(released).toBe(1);

    expect((await store.getAll(sourceId)).length).toBe(before);
    const [row] = await db.select().from(sessions).where(eq(sessions.id, forkId));
    expect(row.forkedMergedAt).toBeNull();
  });

  it('refuses while the source has a running turn, even when no barrier is visible', async () => {
    const { sourceId, forkId, store } = await sourceWithFork();
    await db
      .insert(sessionTurnCommands)
      .values({
        commandKey: randomBytes(20).toString('hex'),
        sessionId: sourceId,
        source: 'user',
        sourceCommandId: uniq('src'),
        inputHash: randomBytes(32).toString('hex'),
        userMessageId: 'command-user-placeholder',
        responseMessageId: 'command-response-placeholder',
        runId: uniq('run'),
        status: 'active',
        terminalReason: null,
        createdAt: 2_000,
        updatedAt: 2_000,
        finishedAt: null,
      })
      .catch(() => undefined);
    // The fixture above is only a probe of the ledger shape; the real check uses a
    // properly derived id pair below.
    const commandKey = randomBytes(20).toString('hex');
    await db.insert(sessionTurnCommands).values({
      commandKey,
      sessionId: sourceId,
      source: 'user',
      sourceCommandId: uniq('src'),
      inputHash: randomBytes(32).toString('hex'),
      userMessageId: `command-user-${commandKey}`,
      responseMessageId: `command-response-${commandKey}`,
      runId: uniq('run'),
      status: 'active',
      terminalReason: null,
      createdAt: 2_000,
      updatedAt: 2_000,
      finishedAt: null,
    });
    const before = (await store.getAll(sourceId)).length;
    await expect(buildForkMergeDigest({ forkSessionId: forkId, mode: 'summary' })).rejects.toThrow(
      ConflictError,
    );
    expect((await store.getAll(sourceId)).length).toBe(before);
  });

  it('a retried commit after a crash between the two steps completes without a duplicate entry', async () => {
    const { sourceId, forkId, store } = await sourceWithFork();
    const digest = await buildForkMergeDigest({ forkSessionId: forkId, mode: 'summary' });
    // First attempt wrote the entry but died before marking the fork merged.
    await new MessageStore().addIdempotent(sourceId, {
      id: digest.messageId,
      sessionId: sourceId,
      role: 'system',
      content: digest.content,
      createdAt: 9_000,
    });

    await commitForkMerge(digest, 9_001);
    await commitForkMerge(digest, 9_002);

    const entries = (await store.getAll(sourceId)).filter((m) => m.id === digest.messageId);
    expect(entries).toHaveLength(1);
    const [row] = await db.select().from(sessions).where(eq(sessions.id, forkId));
    expect(row.forkedMergedAt?.getTime()).toBe(9_001);
  });

  it('refuses to merge into a source that no longer exists', async () => {
    const { sourceId, forkId } = await sourceWithFork();
    await db.delete(sessions).where(eq(sessions.id, sourceId));
    await expect(
      mergeForkCoordinated({ forkSessionId: forkId, mode: 'summary' }, harness().deps),
    ).rejects.toThrow(ConflictError);
  });
});
