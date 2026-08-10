import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { db, initDb, messages, sessions } from '../../db';
import { MessageStore, type SetConversationBoundaryOptions } from '../../stores/message-store';
import { CheckpointStore } from '../../kory/checkpoint-store';
import { TimeTravelService } from '../timetravel';

const temporaryRepositories: string[] = [];
const temporarySessions: string[] = [];

beforeAll(async () => {
  await initDb();
});

afterEach(async () => {
  for (const sessionId of temporarySessions.splice(0)) {
    await db.delete(sessions).where(eq(sessions.id, sessionId));
  }
  for (const repository of temporaryRepositories.splice(0)) {
    rmSync(repository, { recursive: true, force: true });
  }
});

function git(repository: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: repository,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function createRepository(): string {
  const repository = mkdtempSync(join(tmpdir(), 'kory-timetravel-lineage-'));
  temporaryRepositories.push(repository);
  git(repository, 'init');
  git(repository, 'config', 'user.name', 'Koryphaios Test');
  git(repository, 'config', 'user.email', 'koryphaios-test@example.invalid');
  writeFileSync(join(repository, 'README.md'), 'baseline\n');
  git(repository, 'add', 'README.md');
  git(repository, 'commit', '-m', 'baseline');
  return repository;
}

interface Scenario {
  repository: string;
  sessionId: string;
  firstMessageId: string;
  secondMessageId: string;
  firstHash: string;
  secondHash: string;
}

async function createScenario(): Promise<Scenario> {
  const suffix = `${Date.now()}-${Math.random()}`;
  const repository = createRepository();
  const sessionId = `timetravel-lineage-${suffix}`;
  const firstMessageId = `timetravel-first-${suffix}`;
  const secondMessageId = `timetravel-second-${suffix}`;
  temporarySessions.push(sessionId);
  await db.insert(sessions).values({
    id: sessionId,
    title: 'Time Travel lineage integration',
    workingDirectory: repository,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const store = new MessageStore();
  const service = new TimeTravelService(repository, store);
  await store.add(sessionId, {
    id: firstMessageId,
    sessionId,
    role: 'user',
    content: 'Create version one',
    tokensIn: 3,
    tokensOut: 0,
    cost: 0.01,
    createdAt: Date.now(),
  });
  writeFileSync(join(repository, 'state.txt'), 'version one\n');
  const first = await service.checkpoint('Version one', {
    agentId: sessionId,
    messageId: firstMessageId,
    checkpointType: 'turn_end',
    changedFiles: [{ path: 'state.txt', operation: 'create' }],
  });
  expect(first).toMatchObject({ success: true });

  await store.add(sessionId, {
    id: secondMessageId,
    sessionId,
    role: 'assistant',
    content: 'Created version two',
    tokensIn: 5,
    tokensOut: 7,
    cost: 0.02,
    createdAt: Date.now() + 1,
  });
  writeFileSync(join(repository, 'state.txt'), 'version two\n');
  const second = await service.checkpoint('Version two', {
    agentId: sessionId,
    messageId: secondMessageId,
    checkpointType: 'turn_end',
    changedFiles: [{ path: 'state.txt', operation: 'edit' }],
  });
  expect(second).toMatchObject({ success: true });

  return {
    repository,
    sessionId,
    firstMessageId,
    secondMessageId,
    firstHash: first.hash!,
    secondHash: second.hash!,
  };
}

class FailingBoundaryStore extends MessageStore {
  override async setActiveBoundary(
    _sessionId: string,
    _messageId: string | null,
    _options?: SetConversationBoundaryOptions,
  ): Promise<never> {
    throw new Error('injected conversation boundary failure');
  }
}

describe('TimeTravelService retained conversation integration', () => {
  test('code-only undo and redo preserve an explicitly empty conversation boundary', async () => {
    const repository = createRepository();
    const sessionId = `timetravel-empty-${Date.now()}-${Math.random()}`;
    temporarySessions.push(sessionId);
    await db.insert(sessions).values({
      id: sessionId,
      title: 'Time Travel empty conversation integration',
      workingDirectory: repository,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const service = new TimeTravelService(repository, new MessageStore());
    writeFileSync(join(repository, 'state.txt'), 'version one\n');
    const first = await service.checkpoint('Version one without messages', {
      agentId: sessionId,
      checkpointType: 'tool_call',
      changedFiles: [{ path: 'state.txt', operation: 'create' }],
    });
    writeFileSync(join(repository, 'state.txt'), 'version two\n');
    const second = await service.checkpoint('Version two without messages', {
      agentId: sessionId,
      checkpointType: 'tool_call',
      changedFiles: [{ path: 'state.txt', operation: 'edit' }],
    });
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);

    expect((await service.undo(sessionId)).success).toBe(true);
    expect(readFileSync(join(repository, 'state.txt'), 'utf8')).toBe('version one\n');
    expect(await new MessageStore().getActiveBoundary(sessionId)).toMatchObject({
      messageId: null,
      contextRevision: 0,
    });

    const restarted = new TimeTravelService(repository, new MessageStore());
    expect((await restarted.redo(sessionId)).success).toBe(true);
    expect(readFileSync(join(repository, 'state.txt'), 'utf8')).toBe('version two\n');
    expect(await new MessageStore().getActiveBoundary(sessionId)).toMatchObject({
      messageId: null,
      contextRevision: 0,
    });
  });

  test('undo and redo retain physical rows and survive a fresh store/service instance', async () => {
    const scenario = await createScenario();
    const firstRuntime = new TimeTravelService(scenario.repository, new MessageStore());

    expect((await firstRuntime.undo(scenario.sessionId)).success).toBe(true);
    expect(readFileSync(join(scenario.repository, 'state.txt'), 'utf8')).toBe('version one\n');
    expect((await firstRuntime.getState(scenario.sessionId)).currentHash).toBe(scenario.firstHash);
    expect(
      (await new MessageStore().getAll(scenario.sessionId)).map((message) => message.id),
    ).toEqual([scenario.firstMessageId]);
    expect(
      (
        await db
          .select({
            activeMessageId: sessions.activeMessageId,
            messageCount: sessions.messageCount,
            tokensIn: sessions.tokensIn,
            tokensOut: sessions.tokensOut,
            totalCost: sessions.totalCost,
          })
          .from(sessions)
          .where(eq(sessions.id, scenario.sessionId))
      )[0],
    ).toMatchObject({
      activeMessageId: scenario.firstMessageId,
      messageCount: 1,
      tokensIn: 3,
      tokensOut: 0,
      totalCost: 0.01,
    });
    expect(
      await db
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.sessionId, scenario.sessionId)),
    ).toHaveLength(2);

    // Reconstruct both collaborators to model a backend restart. The shadow
    // cursor and conversation head are independently durable and converge.
    const restartedRuntime = new TimeTravelService(scenario.repository, new MessageStore());
    expect((await restartedRuntime.redo(scenario.sessionId)).success).toBe(true);
    expect(readFileSync(join(scenario.repository, 'state.txt'), 'utf8')).toBe('version two\n');
    expect(
      (await new MessageStore().getAll(scenario.sessionId)).map((message) => message.id),
    ).toEqual([scenario.firstMessageId, scenario.secondMessageId]);
    expect(
      (
        await db
          .select({
            activeMessageId: sessions.activeMessageId,
            messageCount: sessions.messageCount,
            tokensIn: sessions.tokensIn,
            tokensOut: sessions.tokensOut,
            totalCost: sessions.totalCost,
          })
          .from(sessions)
          .where(eq(sessions.id, scenario.sessionId))
      )[0],
    ).toMatchObject({
      activeMessageId: scenario.secondMessageId,
      messageCount: 2,
      tokensIn: 8,
      tokensOut: 7,
      totalCost: 0.03,
    });
    expect((await restartedRuntime.getState(scenario.sessionId)).currentHash).toBe(
      scenario.secondHash,
    );
  });

  test('a conversation-boundary failure compensates the workspace and durable cursor', async () => {
    const scenario = await createScenario();
    const failingRuntime = new TimeTravelService(scenario.repository, new FailingBoundaryStore());

    const result = await failingRuntime.undo(scenario.sessionId);
    expect(result).toMatchObject({ success: false });
    expect(result.message).toContain('workspace and cursor were restored');
    expect(readFileSync(join(scenario.repository, 'state.txt'), 'utf8')).toBe('version two\n');
    expect((await failingRuntime.getState(scenario.sessionId)).currentHash).toBe(
      scenario.secondHash,
    );
    expect(await new MessageStore().getActiveBoundary(scenario.sessionId)).toMatchObject({
      messageId: scenario.secondMessageId,
    });
    expect(
      await db
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.sessionId, scenario.sessionId)),
    ).toHaveLength(2);
  });

  test('restart cancels a prepared-only recovery without overwriting a newer edit', async () => {
    const scenario = await createScenario();
    const checkpoints = new CheckpointStore(scenario.repository);
    const prepared = await checkpoints.prepareRecoveryOperation({
      agentId: scenario.sessionId,
      targetHash: scenario.firstHash,
      expectedCurrentHash: scenario.secondHash,
      previousMessageId: scenario.secondMessageId,
      targetMessageId: scenario.firstMessageId,
      changedFiles: [{ path: 'state.txt', operation: 'edit' }],
    });
    expect(prepared.success).toBe(true);

    writeFileSync(join(scenario.repository, 'state.txt'), 'newer user edit\n');
    const restarted = new TimeTravelService(scenario.repository, new MessageStore());
    expect((await restarted.getState(scenario.sessionId)).currentHash).toBe(scenario.secondHash);
    expect(readFileSync(join(scenario.repository, 'state.txt'), 'utf8')).toBe('newer user edit\n');
    expect(await checkpoints.getPendingRecoveryOperations(scenario.sessionId)).toHaveLength(0);
  });

  test('restart compensates workspace recovery that crashed before the conversation move', async () => {
    const scenario = await createScenario();
    const checkpoints = new CheckpointStore(scenario.repository);
    const prepared = await checkpoints.prepareRecoveryOperation({
      agentId: scenario.sessionId,
      targetHash: scenario.firstHash,
      expectedCurrentHash: scenario.secondHash,
      previousMessageId: scenario.secondMessageId,
      targetMessageId: scenario.firstMessageId,
      changedFiles: [{ path: 'state.txt', operation: 'edit' }],
    });
    expect(prepared.success).toBe(true);
    expect(
      (
        await checkpoints.recover(scenario.firstHash, {
          agentId: scenario.sessionId,
          expectedCurrentHash: scenario.secondHash,
          changedFiles: [{ path: 'state.txt', operation: 'edit' }],
          operationId: prepared.operation!.id,
        })
      ).success,
    ).toBe(true);
    expect(readFileSync(join(scenario.repository, 'state.txt'), 'utf8')).toBe('version one\n');

    const restarted = new TimeTravelService(scenario.repository, new MessageStore());
    expect((await restarted.getState(scenario.sessionId)).currentHash).toBe(scenario.secondHash);
    expect(readFileSync(join(scenario.repository, 'state.txt'), 'utf8')).toBe('version two\n');
    expect(await new MessageStore().getActiveBoundary(scenario.sessionId)).toMatchObject({
      messageId: scenario.secondMessageId,
    });
    expect(await checkpoints.getPendingRecoveryOperations(scenario.sessionId)).toHaveLength(0);
  });

  test('restart acknowledges a recovery that committed both participants before cleanup', async () => {
    const scenario = await createScenario();
    const checkpoints = new CheckpointStore(scenario.repository);
    const prepared = await checkpoints.prepareRecoveryOperation({
      agentId: scenario.sessionId,
      targetHash: scenario.firstHash,
      expectedCurrentHash: scenario.secondHash,
      previousMessageId: scenario.secondMessageId,
      targetMessageId: scenario.firstMessageId,
      changedFiles: [{ path: 'state.txt', operation: 'edit' }],
    });
    expect(prepared.success).toBe(true);
    expect(
      (
        await checkpoints.recover(scenario.firstHash, {
          agentId: scenario.sessionId,
          expectedCurrentHash: scenario.secondHash,
          changedFiles: [{ path: 'state.txt', operation: 'edit' }],
          operationId: prepared.operation!.id,
        })
      ).success,
    ).toBe(true);
    await new MessageStore().setActiveBoundary(scenario.sessionId, scenario.firstMessageId, {
      expectedActiveMessageId: scenario.secondMessageId,
    });

    const restarted = new TimeTravelService(scenario.repository, new MessageStore());
    expect((await restarted.getState(scenario.sessionId)).currentHash).toBe(scenario.firstHash);
    expect(readFileSync(join(scenario.repository, 'state.txt'), 'utf8')).toBe('version one\n');
    expect(await new MessageStore().getActiveBoundary(scenario.sessionId)).toMatchObject({
      messageId: scenario.firstMessageId,
    });
    expect(await checkpoints.getPendingRecoveryOperations(scenario.sessionId)).toHaveLength(0);
  });

  test('restart refuses to overwrite an arbitrary edit made after workspace recovery', async () => {
    const scenario = await createScenario();
    const checkpoints = new CheckpointStore(scenario.repository);
    const prepared = await checkpoints.prepareRecoveryOperation({
      agentId: scenario.sessionId,
      targetHash: scenario.firstHash,
      expectedCurrentHash: scenario.secondHash,
      previousMessageId: scenario.secondMessageId,
      targetMessageId: scenario.firstMessageId,
      changedFiles: [{ path: 'state.txt', operation: 'edit' }],
    });
    expect(prepared.success).toBe(true);
    expect(
      (
        await checkpoints.recover(scenario.firstHash, {
          agentId: scenario.sessionId,
          expectedCurrentHash: scenario.secondHash,
          changedFiles: [{ path: 'state.txt', operation: 'edit' }],
          operationId: prepared.operation!.id,
        })
      ).success,
    ).toBe(true);
    writeFileSync(join(scenario.repository, 'state.txt'), 'post-crash external edit\n');

    const restarted = new TimeTravelService(scenario.repository, new MessageStore());
    await expect(restarted.getState(scenario.sessionId)).rejects.toThrow(
      'interrupted recovery was not overwritten',
    );
    expect(readFileSync(join(scenario.repository, 'state.txt'), 'utf8')).toBe(
      'post-crash external edit\n',
    );
    expect(await checkpoints.getPendingRecoveryOperations(scenario.sessionId)).toHaveLength(1);
  });

  test('active recovery holds prevent prune and GC from deleting either snapshot', async () => {
    const scenario = await createScenario();
    const checkpoints = new CheckpointStore(scenario.repository);
    const prepared = await checkpoints.prepareRecoveryOperation({
      agentId: scenario.sessionId,
      targetHash: scenario.firstHash,
      expectedCurrentHash: scenario.secondHash,
      previousMessageId: scenario.secondMessageId,
      targetMessageId: scenario.firstMessageId,
      changedFiles: [{ path: 'state.txt', operation: 'edit' }],
    });
    expect(prepared.success).toBe(true);
    expect((await checkpoints.prune(-1)).removed).toBe(0);
    expect(await checkpoints.getGhostCommit(scenario.firstHash)).not.toBeNull();
    expect(await checkpoints.getGhostCommit(scenario.secondHash)).not.toBeNull();
    expect(
      (await checkpoints.completeRecoveryOperation(scenario.sessionId, prepared.operation!.id))
        .success,
    ).toBe(true);
  });
});
