import { afterEach, describe, expect, mock, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KoryphaiosConfig, StoredMessage } from '@koryphaios/shared';
import type { ProviderRegistry } from '../../providers';
import type { IMessageStore } from '../../stores/message-store';
import type { ToolRegistry } from '../../tools';
import { MIGRATIONS } from '../../db/migrations';
import { SessionRunCoordinator } from '../../runs/session-run-coordinator';
import {
  canonicalSessionTurnInputHash,
  deriveSessionTurnCommandIdentity,
  SessionRunStore,
} from '../../runs/session-run-store';
import { KoryManager } from '../manager';

const directories: string[] = [];

function createRunCoordinator(sessionIds: string | string[]): {
  sqlite: Database;
  coordinator: SessionRunCoordinator;
} {
  const ids = Array.isArray(sessionIds) ? sessionIds : [sessionIds];
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE user_inputs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      input_data TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE supervised_processes (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL,
      provenance TEXT NOT NULL,
      supervision TEXT NOT NULL,
      is_background INTEGER NOT NULL,
      terminal_reason TEXT
    );
  `);
  const insertSession = sqlite.prepare(
    'INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, 1, 1)',
  );
  for (const sessionId of ids) insertSession.run(sessionId, 'Admission test');
  for (const version of ['0032', '0033', '0037', '0038', '0043']) {
    const migration = MIGRATIONS.find((candidate) => candidate.version === version);
    if (!migration) throw new Error(`Migration ${version} is missing`);
    sqlite.exec(migration.up);
  }
  return {
    sqlite,
    coordinator: new SessionRunCoordinator(new SessionRunStore(sqlite), () => undefined),
  };
}

function createManager(coordinator: SessionRunCoordinator, messages?: IMessageStore): KoryManager {
  const directory = mkdtempSync(join(tmpdir(), 'kory-admission-'));
  directories.push(directory);
  const providers = {
    resolveProvider: mock(async () => undefined),
    executeWithRetry: mock(),
    getAvailable: () => [],
    getStatus: () => [],
    getFirstAvailableRouting: () => undefined,
    isQuotaError: () => false,
  } as unknown as ProviderRegistry;
  const tools = {
    getToolDefsForRole: () => [],
    execute: mock(),
  } as unknown as ToolRegistry;
  return new KoryManager(
    providers,
    tools,
    directory,
    {} as KoryphaiosConfig,
    undefined,
    messages,
    undefined,
    undefined,
    coordinator,
  );
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function installBlockedAgentFollowup(
  manager: KoryManager,
  sessionId: string,
  agentId: string,
): {
  started: Promise<void>;
  release(): void;
  providerEntered(): boolean;
  providerExited(): boolean;
  getThread(): { busy: boolean; activeRun?: Promise<void> } | undefined;
} {
  const providerStarted = deferred();
  const providerRelease = deferred();
  let entered = false;
  let exited = false;
  const internal = manager as unknown as {
    providers: {
      resolveProvider: ReturnType<typeof mock>;
      executeWithRetry: ReturnType<typeof mock>;
    };
    agentThreads: Map<
      string,
      {
        sessionId: string;
        identity: Record<string, unknown>;
        kind: 'critic';
        status: 'idle';
        providerName: 'openai';
        modelId: string;
        systemPrompt: string;
        promptManifestHash: string;
        taskContractHash: string;
        toolRole: 'critic';
        maxTurns: number;
        maxTokens: number;
        messages: Array<{ role: 'user'; content: string }>;
        threadEntries: [];
        ctx: Record<string, unknown>;
        abort: AbortController;
        busy: boolean;
        activeRun?: Promise<void>;
        updatedAt: number;
      }
    >;
  };
  const provider = { name: 'openai' };
  internal.providers.resolveProvider = mock(async () => provider);
  internal.providers.executeWithRetry = mock((request: { signal: AbortSignal }) =>
    (async function* () {
      entered = true;
      providerStarted.resolve();
      try {
        await providerRelease.promise;
        request.signal.throwIfAborted();
      } finally {
        exited = true;
      }
    })(),
  );
  internal.agentThreads.set(agentId, {
    sessionId,
    identity: {
      id: agentId,
      name: 'Test critic',
      role: 'critic',
      model: 'test-model',
      provider: 'openai',
      domain: 'critic',
      glowColor: '#000000',
    },
    kind: 'critic',
    status: 'idle',
    providerName: 'openai',
    modelId: 'test-model',
    systemPrompt: 'Test follow-up lifecycle.',
    promptManifestHash: 'prompt-hash',
    taskContractHash: 'contract-hash',
    toolRole: 'critic',
    maxTurns: 1,
    maxTokens: 64,
    messages: [],
    threadEntries: [],
    ctx: {
      sessionId,
      workingDirectory: '.',
      allowedPaths: ['.'],
      isSandboxed: true,
      signal: new AbortController().signal,
    },
    abort: new AbortController(),
    busy: false,
    updatedAt: Date.now(),
  });
  return {
    started: providerStarted.promise,
    release: providerRelease.resolve,
    providerEntered: () => entered,
    providerExited: () => exited,
    getThread: () => internal.agentThreads.get(agentId),
  };
}

function createMessageStore(): {
  store: IMessageStore;
  records: Map<string, StoredMessage>;
  addIdempotent: ReturnType<typeof mock>;
} {
  const records = new Map<string, StoredMessage>();
  const addIdempotent = mock(async (sessionId: string, message: StoredMessage) => {
    const existing = records.get(message.id);
    if (existing) return 'existing' as const;
    records.set(message.id, { ...message, sessionId });
    return 'inserted' as const;
  });
  return {
    records,
    addIdempotent,
    store: {
      addIdempotent,
      getById: async (sessionId: string, messageId: string) => {
        const record = records.get(messageId);
        return record?.sessionId === sessionId ? record : undefined;
      },
    } as unknown as IMessageStore,
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
  }
});

describe('KoryManager turn admission', () => {
  test('starts exactly one durable run before dispatching an admitted manager task', async () => {
    const sessionId = 'admitted-task';
    const { sqlite, coordinator } = createRunCoordinator(sessionId);
    const manager = createManager(coordinator);
    try {
      const admission = await manager.reserveSessionTurn(sessionId, 'user_turn');
      expect(admission?.runId).toBeTruthy();

      await manager.dispatchAdmittedTask(admission!, { userMessage: 'Do the work.' });

      const commands = sqlite
        .query<{ payload: string }, [string]>(
          'SELECT payload FROM session_run_events WHERE session_id = ? ORDER BY revision',
        )
        .all(sessionId)
        .map((row) => JSON.parse(row.payload).transition.command as string);
      expect(commands.filter((command) => command === 'start')).toHaveLength(1);
      expect(coordinator.get(sessionId)).toMatchObject({ status: 'terminal', phase: 'error' });
    } finally {
      await manager.shutdown();
      sqlite.close();
    }
  });

  test('consumes an admitted work token synchronously and exactly once', async () => {
    const sessionId = 'admitted-work';
    const { sqlite, coordinator } = createRunCoordinator(sessionId);
    const manager = createManager(coordinator);
    try {
      const admission = await manager.reserveSessionTurn(sessionId, 'image_turn');
      const completion = manager.dispatchAdmittedWork(
        admission!,
        async ({ phase }) => {
          await phase('streaming', 'test_work');
          return 'done';
        },
        'test_completed',
      );
      expect(() =>
        manager.dispatchAdmittedWork(admission!, async () => undefined, 'duplicate'),
      ).toThrow('already consumed');
      await expect(completion).resolves.toBe('done');
      expect(coordinator.get(sessionId)).toMatchObject({ status: 'terminal', phase: 'done' });
    } finally {
      await manager.shutdown();
      sqlite.close();
    }
  });

  test('persists one stable command input and refuses to replay an interrupted execution', async () => {
    const sessionId = 'stable-command';
    const { sqlite, coordinator } = createRunCoordinator(sessionId);
    const { store, records, addIdempotent } = createMessageStore();
    const manager = createManager(coordinator, store);
    const command = {
      sessionId,
      source: 'collaboration' as const,
      sourceCommandId: 'guest-prompt-42',
      userMessage: 'Apply the approved guest request.',
    };
    try {
      const first = await manager.startSessionTurn(command);
      expect(first.accepted).toBe(true);
      if (!first.accepted) throw new Error('Expected first command to be admitted');
      await expect(first.completion).resolves.toMatchObject({
        runId: first.runId,
        status: 'failed',
      });

      const persisted = [...records.values()];
      expect(persisted).toHaveLength(1);
      expect(persisted[0]).toMatchObject({
        role: 'user',
        content: command.userMessage,
      });
      expect(persisted[0]?.id).toStartWith('command-user-');

      const replay = await manager.startSessionTurn(command);
      expect(replay).toMatchObject({
        accepted: false,
        result: {
          runId: first.runId,
          status: 'failed',
          reason: 'provider_unavailable',
        },
      });
      expect(addIdempotent).toHaveBeenCalledTimes(1);

      const starts = sqlite
        .query<{ count: number }, []>(
          `SELECT COUNT(*) AS count
             FROM session_run_events
            WHERE json_extract(payload, '$.transition.command') = 'start'`,
        )
        .get()?.count;
      expect(starts).toBe(1);
    } finally {
      await manager.shutdown();
      sqlite.close();
    }
  });

  test('busy rejection does not persist or consume the producer command', async () => {
    const sessionId = 'busy-command';
    const { sqlite, coordinator } = createRunCoordinator(sessionId);
    const { store, records, addIdempotent } = createMessageStore();
    const manager = createManager(coordinator, store);
    try {
      const owner = await manager.reserveSessionTurn(sessionId, 'user_turn');
      expect(owner).not.toBeNull();

      const rejected = await manager.startSessionTurn({
        sessionId,
        source: 'goal',
        sourceCommandId: 'goal-attempt-item-turn',
        userMessage: 'This must remain retryable.',
      });
      expect(rejected).toMatchObject({
        accepted: false,
        result: { status: 'rejected', reason: 'session_busy' },
      });
      expect(records.size).toBe(0);
      expect(addIdempotent).not.toHaveBeenCalled();

      await manager.rejectSessionTurn(owner!, 'test_owner_released');
      const accepted = await manager.startSessionTurn({
        sessionId,
        source: 'goal',
        sourceCommandId: 'goal-attempt-item-turn',
        userMessage: 'This must remain retryable.',
      });
      expect(accepted.accepted).toBe(true);
      if (accepted.accepted) await accepted.completion;
      expect(addIdempotent).toHaveBeenCalledTimes(1);
    } finally {
      await manager.shutdown();
      sqlite.close();
    }
  });

  test('scopes producer command identity to the session and rejects changed durable input', async () => {
    const firstSession = 'command-scope-a';
    const secondSession = 'command-scope-b';
    const { sqlite, coordinator } = createRunCoordinator([firstSession, secondSession]);
    const { store, records } = createMessageStore();
    const manager = createManager(coordinator, store);
    const base = {
      source: 'collaboration' as const,
      sourceCommandId: 'relay-command-1',
      userMessage: 'Run this exact request.',
    };
    try {
      const first = await manager.startSessionTurn({ sessionId: firstSession, ...base });
      expect(first.accepted).toBe(true);
      if (first.accepted) await first.completion;

      const second = await manager.startSessionTurn({ sessionId: secondSession, ...base });
      expect(second.accepted).toBe(true);
      if (second.accepted) await second.completion;

      const userRows = [...records.values()].filter((message) => message.role === 'user');
      expect(userRows).toHaveLength(2);
      expect(new Set(userRows.map((message) => message.id)).size).toBe(2);

      await expect(
        manager.startSessionTurn({
          sessionId: firstSession,
          ...base,
          userMessage: 'A changed request must not borrow the old command id.',
        }),
      ).rejects.toThrow(/bound to a different execution payload/);
      await expect(
        manager.startSessionTurn({
          sessionId: firstSession,
          ...base,
          preferredModel: 'openai:a-different-model',
        }),
      ).rejects.toThrow(/bound to a different execution payload/);
    } finally {
      await manager.shutdown();
      sqlite.close();
    }
  });

  test('completed acknowledgement requires both a terminal receipt and matching projections', async () => {
    const sessionId = 'completed-command';
    const { sqlite, coordinator } = createRunCoordinator(sessionId);
    const { store, records } = createMessageStore();
    const manager = createManager(coordinator, store);
    const command = {
      sessionId,
      source: 'goal' as const,
      sourceCommandId: 'goal-command-complete',
      userMessage: 'Complete once.',
    };
    try {
      const inputHash = canonicalSessionTurnInputHash({
        version: 1,
        userMessage: command.userMessage,
        preferredModel: null,
        reasoningLevel: null,
        attachments: [],
        collaborationToolPolicy: null,
        responseVariant: null,
        goalContext: null,
        interactionMode: null,
        fastMode: null,
        imageInputMode: 'reject',
        regenerationBranch: null,
      });
      const begun = await coordinator.beginSessionTurnCommand({
        sessionId,
        source: command.source,
        sourceCommandId: command.sourceCommandId,
        inputHash,
        reason: 'goal_turn',
      });
      if (!begun.runTransition) throw new Error('Command run was not created');
      const started = begun.runTransition.payload.snapshot;
      await coordinator.complete(
        sessionId,
        begun.command.runId,
        started.revision,
        'provider_turn_completed',
      );
      const identity = deriveSessionTurnCommandIdentity(command);
      const user: StoredMessage = {
        id: identity.userMessageId,
        sessionId,
        role: 'user',
        content: command.userMessage,
        createdAt: Date.now(),
      };
      records.set(user.id, user);
      records.set(identity.responseMessageId, {
        id: identity.responseMessageId,
        sessionId,
        role: 'assistant',
        content: 'Completed response.',
        createdAt: Date.now(),
      });

      await expect(manager.startSessionTurn(command)).resolves.toMatchObject({
        accepted: false,
        result: {
          runId: begun.command.runId,
          status: 'completed',
          reason: 'provider_turn_completed',
        },
      });

      records.set(user.id, { ...user, content: 'corrupted different input' });
      await expect(manager.startSessionTurn(command)).resolves.toMatchObject({
        accepted: false,
        result: { status: 'failed', reason: 'command_completion_projection_missing_or_corrupt' },
      });
    } finally {
      await manager.shutdown();
      sqlite.close();
    }
  });

  test('a preserved partial response cannot turn a cancelled command into completion', async () => {
    const sessionId = 'cancelled-command';
    const { sqlite, coordinator } = createRunCoordinator(sessionId);
    const { store, records } = createMessageStore();
    const manager = createManager(coordinator, store);
    const command = {
      sessionId,
      source: 'collaboration' as const,
      sourceCommandId: 'cancelled-command-with-partial-output',
      userMessage: 'Start work, then stop.',
    };
    try {
      const inputHash = canonicalSessionTurnInputHash({
        version: 1,
        userMessage: command.userMessage,
        preferredModel: null,
        reasoningLevel: null,
        attachments: [],
        collaborationToolPolicy: null,
        responseVariant: null,
        goalContext: null,
        interactionMode: null,
        fastMode: null,
        imageInputMode: 'reject',
        regenerationBranch: null,
      });
      const begun = await coordinator.beginSessionTurnCommand({
        sessionId,
        source: command.source,
        sourceCommandId: command.sourceCommandId,
        inputHash,
        reason: 'collaboration_turn',
      });
      if (!begun.runTransition) throw new Error('Command run was not created');
      await coordinator.cancel(
        sessionId,
        begun.command.runId,
        begun.runTransition.payload.snapshot.revision,
        'cancelled_by_user',
      );
      const identity = deriveSessionTurnCommandIdentity(command);
      records.set(identity.userMessageId, {
        id: identity.userMessageId,
        sessionId,
        role: 'user',
        content: command.userMessage,
        createdAt: Date.now(),
      });
      records.set(identity.responseMessageId, {
        id: identity.responseMessageId,
        sessionId,
        role: 'assistant',
        content: 'Partial output preserved before Stop.',
        createdAt: Date.now(),
      });

      await expect(manager.startSessionTurn(command)).resolves.toMatchObject({
        accepted: false,
        result: {
          runId: begun.command.runId,
          status: 'cancelled',
          phase: 'cancelled',
          reason: 'cancelled_by_user',
        },
      });
    } finally {
      await manager.shutdown();
      sqlite.close();
    }
  });

  test('direct agent follow-up acquires and returns its durable SessionRun', async () => {
    const sessionId = 'agent-followup-admission';
    const agentId = 'critic-followup-admission';
    const { sqlite, coordinator } = createRunCoordinator(sessionId);
    const manager = createManager(coordinator);
    const provider = installBlockedAgentFollowup(manager, sessionId, agentId);
    try {
      const accepted = await manager.sendMessageToAgent(sessionId, agentId, 'Check this again.');
      await provider.started;

      expect(accepted.runId).toBeTruthy();
      expect(coordinator.get(sessionId)).toMatchObject({
        runId: accepted.runId,
        status: 'active',
        phase: 'thinking',
      });
      const activeRun = provider.getThread()?.activeRun;
      expect(activeRun).toBeInstanceOf(Promise);

      provider.release();
      await expect(activeRun!).resolves.toBeUndefined();
      expect(coordinator.get(sessionId)).toMatchObject({
        runId: accepted.runId,
        status: 'terminal',
        phase: 'done',
        terminalReason: 'agent_followup_completed',
      });
    } finally {
      provider.release();
      await manager.shutdown();
      sqlite.close();
    }
  });

  test('direct agent follow-up rejects while another SessionRun is active and never piggybacks', async () => {
    const sessionId = 'agent-followup-busy';
    const agentId = 'critic-followup-busy';
    const { sqlite, coordinator } = createRunCoordinator(sessionId);
    const manager = createManager(coordinator);
    const provider = installBlockedAgentFollowup(manager, sessionId, agentId);
    try {
      const owner = await manager.reserveSessionTurn(sessionId, 'user_turn');
      expect(owner).not.toBeNull();

      await expect(
        manager.sendMessageToAgent(sessionId, agentId, 'Do not borrow the manager run.'),
      ).rejects.toThrow(/Wait for chat lifecycle work to finish/);

      expect(provider.providerEntered()).toBe(false);
      expect(provider.getThread()?.busy).toBe(false);
      expect(coordinator.get(sessionId)).toMatchObject({
        runId: owner!.runId,
        status: 'active',
      });
      await manager.rejectSessionTurn(owner!, 'test_owner_released');
    } finally {
      provider.release();
      await manager.shutdown();
      sqlite.close();
    }
  });

  test('cancelWorker keeps the agent busy until its provider stack settles and then cancels the run', async () => {
    const sessionId = 'agent-followup-cancel';
    const agentId = 'critic-followup-cancel';
    const { sqlite, coordinator } = createRunCoordinator(sessionId);
    const manager = createManager(coordinator);
    const provider = installBlockedAgentFollowup(manager, sessionId, agentId);
    try {
      const accepted = await manager.sendMessageToAgent(sessionId, agentId, 'Block in provider.');
      await provider.started;
      const activeRun = provider.getThread()?.activeRun;
      expect(activeRun).toBeInstanceOf(Promise);

      manager.cancelWorker(agentId);

      expect(provider.getThread()?.busy).toBe(true);
      expect(provider.providerExited()).toBe(false);
      expect(coordinator.get(sessionId)).toMatchObject({
        runId: accepted.runId,
        status: 'active',
      });

      provider.release();
      await expect(activeRun!).rejects.toMatchObject({ name: 'AbortError' });
      expect(provider.providerExited()).toBe(true);
      expect(provider.getThread()?.busy).toBe(false);
      expect(coordinator.get(sessionId)).toMatchObject({
        runId: accepted.runId,
        status: 'terminal',
        phase: 'cancelled',
        terminalReason: 'cancelled_by_user',
      });
    } finally {
      provider.release();
      await manager.shutdown();
      sqlite.close();
    }
  });

  test('session erasure waits for the follow-up owner stack and leaves no live work', async () => {
    const sessionId = 'agent-followup-erasure';
    const agentId = 'critic-followup-erasure';
    const { sqlite, coordinator } = createRunCoordinator(sessionId);
    const manager = createManager(coordinator);
    const provider = installBlockedAgentFollowup(manager, sessionId, agentId);
    let erasureCompleted = false;
    try {
      const accepted = await manager.sendMessageToAgent(sessionId, agentId, 'Block until erased.');
      await provider.started;
      const activeRun = provider.getThread()?.activeRun;
      expect(activeRun).toBeInstanceOf(Promise);

      const lease = manager.tryBeginSessionErasure(sessionId);
      expect(lease).not.toBeNull();
      const waiting = lease!.waitForIdle().then(() => {
        erasureCompleted = true;
      });
      await Bun.sleep(25);

      expect(erasureCompleted).toBe(false);
      expect(provider.getThread()?.busy).toBe(true);
      expect(provider.providerExited()).toBe(false);

      provider.release();
      await expect(activeRun!).rejects.toMatchObject({ name: 'AbortError' });
      await waiting;
      lease!.complete();

      expect(provider.providerExited()).toBe(true);
      expect(manager.getAgentThreadsForSession(sessionId)).toEqual([]);
      expect(manager.hasActiveSessionExecution(sessionId)).toBe(false);
      expect(manager.hasDurableSessionRun(sessionId)).toBe(false);
      expect(coordinator.get(sessionId)).toMatchObject({
        runId: accepted.runId,
        status: 'terminal',
        phase: 'cancelled',
      });
      await expect(
        manager.sendMessageToAgent(sessionId, agentId, 'Must not survive erasure.'),
      ).rejects.toThrow(/Agent thread not found/);
    } finally {
      provider.release();
      await manager.shutdown();
      sqlite.close();
    }
  });
});
