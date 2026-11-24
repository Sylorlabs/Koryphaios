import { afterEach, describe, expect, mock, setSystemTime, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KoryphaiosConfig, SessionRunStatePayload, StoredMessage } from '@koryphaios/shared';
import type { ProviderRegistry } from '../../providers';
import type { IMessageStore } from '../../stores/message-store';
import type { ISessionStore } from '../../stores/session-store';
import type { ToolRegistry } from '../../tools';
import { MIGRATIONS } from '../../db/migrations';
import { SessionRunCoordinator } from '../../runs/session-run-coordinator';
import {
  canonicalSessionTurnInputHash,
  deriveSessionTurnCommandIdentity,
  SessionRunStore,
} from '../../runs/session-run-store';
import { KoryManager } from '../manager';
import type { ManagerRunHandle, ManagerRunLifecycle } from './ManagerRunLifecycle';
import { agentSteeringStore } from '../../stores/agent-steering-store';

const directories: string[] = [];

function createRunCoordinator(
  sessionIds: string | string[],
  publish: ConstructorParameters<typeof SessionRunCoordinator>[1] = () => undefined,
): {
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
  for (const version of ['0032', '0033', '0037', '0038', '0043', '0056']) {
    const migration = MIGRATIONS.find((candidate) => candidate.version === version);
    if (!migration) throw new Error(`Migration ${version} is missing`);
    sqlite.exec(migration.up);
  }
  return {
    sqlite,
    coordinator: new SessionRunCoordinator(new SessionRunStore(sqlite), publish),
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
  // A turn resolves its chat's isolated checkout before provider routing, so the
  // manager needs a session row it can migrate that checkout from and persist.
  type Row = { id: string; workingDirectory: string; version: number; gitWorkspace?: unknown };
  const rows = new Map<string, Row>();
  const sessions = {
    get: async (id: string): Promise<Row> =>
      rows.get(id) ?? { id, workingDirectory: directory, version: 1 },
    update: async (id: string, updates: { gitWorkspace?: unknown }, version: number) => {
      const current = await sessions.get(id);
      if (current.version !== version) return undefined;
      const next: Row = { ...current, ...updates, version: version + 1 };
      rows.set(id, next);
      return next;
    },
  };
  return new KoryManager(
    providers,
    tools,
    directory,
    {} as KoryphaiosConfig,
    sessions as unknown as ISessionStore,
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
  test('terminal publication waits for manager cleanup and immediately admits the next turn', async () => {
    const sessionId = 'completion-cleanup-race';
    const cleanupEntered = deferred();
    const cleanupRelease = deferred();
    const terminalPublished = deferred();
    const publicationRelease = deferred();
    let manager!: KoryManager;
    let firstRunId: string;
    let nextAdmission: ReturnType<KoryManager['reserveSessionTurn']> | undefined;
    let busyAtTerminal: boolean | undefined;
    const { sqlite, coordinator } = createRunCoordinator(sessionId, (_sid, message) => {
      const { snapshot } = message.payload as SessionRunStatePayload;
      if (snapshot.runId === firstRunId && snapshot.status === 'terminal') {
        busyAtTerminal = manager.isSessionRunning(sessionId);
        // Model a client sending as soon as Done is visible, even while the
        // publisher has not yet acknowledged delivery of the old terminal.
        nextAdmission = manager.reserveSessionTurn(sessionId, 'user_turn');
        terminalPublished.resolve();
        return publicationRelease.promise;
      }
    });
    manager = createManager(coordinator);
    const internal = manager as unknown as {
      processTaskWithClaim(): Promise<void>;
      requireRunHandle(sessionId: string): ManagerRunHandle;
      runLifecycle: ManagerRunLifecycle;
    };
    // Reproduce the real manager's nested finish -> awaited finally ordering,
    // without a provider, filesystem checkpoint, or wall-clock race.
    internal.processTaskWithClaim = async () => {
      const handle = internal.requireRunHandle(sessionId);
      await internal.runLifecycle.phase(handle, 'streaming', 'answer_persisted');
      try {
        await internal.runLifecycle.finish(handle, 'complete', 'provider_turn_completed');
      } finally {
        cleanupEntered.resolve();
        await cleanupRelease.promise;
      }
    };
    let completion: ReturnType<KoryManager['dispatchAdmittedTask']> | undefined;
    try {
      const first = await manager.reserveSessionTurn(sessionId, 'user_turn');
      firstRunId = first!.runId;
      completion = manager.dispatchAdmittedTask(first!, { userMessage: 'First answer' });
      // A buggy terminal publisher blocks before cleanup; release it to make
      // the pre-fix failure deterministic rather than timing out.
      await Promise.race([cleanupEntered.promise, terminalPublished.promise]);
      expect(nextAdmission).toBeUndefined();
      expect(coordinator.get(sessionId)).toMatchObject({ runId: firstRunId, status: 'active' });
      expect(await manager.reserveSessionTurn(sessionId, 'user_turn')).toBeNull();

      cleanupRelease.resolve();
      await terminalPublished.promise;
      expect(busyAtTerminal).toBe(false);
      publicationRelease.resolve();
      const next = await nextAdmission!;
      expect(next).not.toBeNull();
      expect(next!.runId).not.toBe(firstRunId);
      await expect(completion).resolves.toMatchObject({ runId: firstRunId, status: 'completed' });
      expect(manager.hasActiveSessionExecution(sessionId)).toBe(true);
      expect(coordinator.get(sessionId)).toMatchObject({ runId: next!.runId, status: 'active' });
      expect(await manager.reserveSessionTurn(sessionId, 'user_turn')).toBeNull();
      await manager.rejectSessionTurn(next!, 'test_cleanup');
    } finally {
      cleanupRelease.resolve();
      publicationRelease.resolve();
      await completion;
      await manager.shutdown();
      sqlite.close();
    }
  });

  test('admitted work stays busy through workflow cleanup, including outbox replay', async () => {
    const sessionId = 'work-cleanup-race';
    const published: SessionRunStatePayload[] = [];
    const { sqlite, coordinator } = createRunCoordinator(sessionId, (_sid, message) => {
      published.push(message.payload as SessionRunStatePayload);
    });
    const manager = createManager(coordinator);
    const workEntered = deferred();
    const workRelease = deferred();
    const cleanupEntered = deferred();
    const cleanupRelease = deferred();
    manager.updateWorkflowState = async () => {
      cleanupEntered.resolve();
      await cleanupRelease.promise;
    };
    let completion: Promise<void> | undefined;
    try {
      const first = await manager.reserveSessionTurn(sessionId, 'image_turn');
      completion = manager.dispatchAdmittedWork(
        first!,
        async () => {
          workEntered.resolve();
          await workRelease.promise;
        },
        'work_completed',
      );
      await workEntered.promise;
      expect(await manager.reserveSessionTurn(sessionId, 'user_turn')).toBeNull();
      expect(first!.signal.aborted).toBe(false);
      workRelease.resolve();
      await cleanupEntered.promise;
      expect(await manager.reserveSessionTurn(sessionId, 'user_turn')).toBeNull();
      await coordinator.drainOutbox();
      expect(coordinator.get(sessionId)?.status).toBe('active');
      expect(published.some(({ snapshot }) => snapshot.status === 'terminal')).toBe(false);
      cleanupRelease.resolve();
      await completion;
      expect(coordinator.get(sessionId)?.phase).toBe('done');
      const next = await manager.reserveSessionTurn(sessionId, 'user_turn');
      expect(next).not.toBeNull();
      await manager.rejectSessionTurn(next!, 'test_cleanup');
    } finally {
      workRelease.resolve();
      cleanupRelease.resolve();
      await completion;
      await manager.shutdown();
      sqlite.close();
    }
  });

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

  test('recovers a durable active run with no local execution before admitting a new turn', async () => {
    const sessionId = 'orphaned-active-run';
    const { sqlite, coordinator } = createRunCoordinator(sessionId);
    const manager = createManager(coordinator);
    try {
      const orphan = await coordinator.start(sessionId, 'user_turn');
      expect(orphan.status).toBe('active');

      const admission = await manager.reserveSessionTurn(sessionId, 'user_turn');

      expect(admission).not.toBeNull();
      expect(coordinator.get(sessionId)).toMatchObject({
        runId: admission!.runId,
        status: 'active',
        phase: 'analyzing',
      });
      expect(admission!.runId).not.toBe(orphan.runId);
      expect(orphan.terminalReason).toBeNull();

      await manager.rejectSessionTurn(admission!, 'test_cleanup');
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
      if (first.accepted !== true) throw new Error('Expected first command to be admitted');
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
        replay: 'terminal',
        userMessageId: persisted[0]?.id,
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
      if (accepted.accepted === true) await accepted.completion;
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
      if (first.accepted === true) await first.completion;

      const second = await manager.startSessionTurn({ sessionId: secondSession, ...base });
      expect(second.accepted).toBe(true);
      if (second.accepted === true) await second.completion;

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
        contextWindow: null,
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
        replay: 'completed',
        result: {
          runId: begun.command.runId,
          status: 'completed',
          reason: 'provider_turn_completed',
        },
      });

      records.set(user.id, { ...user, content: 'corrupted different input' });
      await expect(manager.startSessionTurn(command)).resolves.toMatchObject({
        accepted: false,
        replay: 'terminal',
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
        contextWindow: null,
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
        replay: 'terminal',
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

  test('direct agent follow-up queues behind a live SessionRun and dispatches when it releases', async () => {
    const sessionId = 'agent-followup-busy';
    const agentId = 'critic-followup-busy';
    const { sqlite, coordinator } = createRunCoordinator(sessionId);
    const manager = createManager(coordinator);
    const provider = installBlockedAgentFollowup(manager, sessionId, agentId);
    try {
      const owner = await manager.reserveSessionTurn(sessionId, 'user_turn');
      expect(owner).not.toBeNull();

      // A busy session is a queue, never a rejection: the message persists as
      // a steering command instead of borrowing the owner run or erroring out.
      const queued = await manager.sendMessageToAgent(
        sessionId,
        agentId,
        'Do not borrow the manager run.',
      );
      expect(queued).toMatchObject({ status: 'queued' });

      expect(provider.providerEntered()).toBe(false);
      expect(provider.getThread()?.busy).toBe(false);
      expect(coordinator.get(sessionId)).toMatchObject({
        runId: owner!.runId,
        status: 'active',
      });

      // Releasing the blocking run re-fires the drain and the follow-up runs
      // under its own SessionRun — never piggybacking on the released one.
      await manager.rejectSessionTurn(owner!, 'test_owner_released');
      await provider.started;

      expect(provider.providerEntered()).toBe(true);
      expect(provider.getThread()?.busy).toBe(true);
      const followUpRun = coordinator.get(sessionId);
      expect(followUpRun?.runId).not.toBe(owner!.runId);
      expect(followUpRun?.status).toBe('active');
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

  test('a stop that times out force-releases a hung owner and admits the next turn', async () => {
    const sessionId = 'hung-stop-admission';
    const never = deferred();
    const start = new Date('2026-11-03T20:00:00.000Z').getTime();
    const { sqlite, coordinator } = createRunCoordinator(sessionId);
    const manager = createManager(coordinator);
    const internal = manager as unknown as {
      processTaskWithClaim(): Promise<void>;
      waitForSessionExecutionToSettle(): Promise<void>;
    };
    internal.processTaskWithClaim = (async () => {
      await never.promise;
    }) as never;
    internal.waitForSessionExecutionToSettle = async () => {
      throw new Error(
        `Session ${sessionId} cancellation timed out waiting for active work to settle`,
      );
    };
    setSystemTime(start);
    let completion: ReturnType<KoryManager['dispatchAdmittedTask']> | undefined;
    try {
      const first = await manager.reserveSessionTurn(sessionId, 'user_turn');
      expect(first).not.toBeNull();
      completion = manager.dispatchAdmittedTask(first!, { userMessage: 'Hang forever' });
      manager.abortManagerRun(sessionId);
      setSystemTime(start + 60_000);
      await manager.cancelSessionWorkers(sessionId);
      expect(coordinator.get(sessionId)).toMatchObject({
        status: 'terminal',
        phase: 'cancelled',
        terminalReason: 'cancelled_by_user',
      });
      expect(manager.hasActiveSessionExecution(sessionId)).toBe(false);
      const next = await manager.reserveSessionTurn(sessionId, 'user_turn');
      expect(next).not.toBeNull();
      expect(next!.runId).not.toBe(first!.runId);
      await manager.rejectSessionTurn(next!, 'test_cleanup');
    } finally {
      setSystemTime();
      never.resolve();
      await completion;
      await manager.shutdown();
      sqlite.close();
    }
  });

  test('a user send terminalizes a durable orphan run instead of rejecting as busy', async () => {
    const sessionId = 'send-orphaned-run';
    const { sqlite, coordinator } = createRunCoordinator(sessionId);
    const { store, addIdempotent } = createMessageStore();
    const manager = createManager(coordinator, store);
    let submission: Awaited<ReturnType<KoryManager['startSessionTurn']>> | undefined;
    try {
      // The state a restart leaves behind: a live durable run whose local
      // execution stack no longer exists.
      const orphan = await coordinator.start(sessionId, 'user_turn');
      expect(orphan.status).toBe('active');

      submission = await manager.startSessionTurn({
        sessionId,
        source: 'user',
        sourceCommandId: 'send-after-restart',
        userMessage: 'Message after the backend came back.',
      });

      expect(submission.accepted).toBe(true);
      if (submission.accepted !== true) throw new Error('Expected the send to be admitted');
      expect(submission.runId).not.toBe(orphan.runId);
      expect(addIdempotent).toHaveBeenCalledTimes(1);
      const orphanTerminal = sqlite
        .query<{ count: number }, []>(
          `SELECT COUNT(*) AS count FROM session_run_events
            WHERE json_extract(payload, '$.transition.command') = 'fail'
              AND json_extract(payload, '$.transition.reason') = 'orphaned_active_run_recovered'`,
        )
        .get()?.count;
      expect(orphanTerminal).toBe(1);
      expect(coordinator.get(sessionId)).toMatchObject({
        runId: submission.runId,
        status: 'active',
      });
      await expect(submission.completion).resolves.toMatchObject({
        runId: submission.runId,
        status: 'failed',
      });
    } finally {
      if (submission?.accepted === true) await submission.completion.catch(() => undefined);
      await manager.shutdown();
      sqlite.close();
    }
  });

  test('a user send supersedes a durable question wait and cancels its pending question', async () => {
    const sessionId = 'send-over-question-wait';
    const { sqlite, coordinator } = createRunCoordinator(sessionId);
    const { store } = createMessageStore();
    const manager = createManager(coordinator, store);
    let submission: Awaited<ReturnType<KoryManager['startSessionTurn']>> | undefined;
    try {
      const started = await coordinator.start(sessionId, 'user_turn');
      const parked = await coordinator.waitForQuestion(
        sessionId,
        started.runId!,
        started.revision,
        {
          question: 'Which option should I take?',
          options: ['first', 'second'],
          allowOther: true,
        },
      );
      expect(parked.snapshot.status).toBe('waiting');

      // A restart drops the parked stack; the wait and its question are
      // durable. A plain user message must steer rather than reject forever.
      submission = await manager.startSessionTurn({
        sessionId,
        source: 'user',
        sourceCommandId: 'send-instead-of-answer',
        userMessage: 'Never mind the question, do this instead.',
      });

      expect(submission.accepted).toBe(true);
      if (submission.accepted !== true) throw new Error('Expected the send to be admitted');
      expect(submission.runId).not.toBe(started.runId);
      const question = sqlite
        .query<{ status: string }, [string, string]>(
          'SELECT status FROM user_inputs WHERE id = ? AND session_id = ?',
        )
        .get(parked.question.questionId!, sessionId);
      expect(question?.status).toBe('cancelled');
      expect(coordinator.get(sessionId)).toMatchObject({
        runId: submission.runId,
        status: 'active',
      });
    } finally {
      if (submission?.accepted === true) await submission.completion.catch(() => undefined);
      await manager.shutdown();
      sqlite.close();
    }
  });

  test('a user send queues behind a live run while internal producers still reject', async () => {
    const sessionId = 'send-steers-live-run';
    const { sqlite, coordinator } = createRunCoordinator(sessionId);
    const { store, records } = createMessageStore();
    const manager = createManager(coordinator, store);
    let submission: Awaited<ReturnType<KoryManager['startSessionTurn']>> | undefined;
    try {
      const owner = await manager.reserveSessionTurn(sessionId, 'user_turn');
      expect(owner).not.toBeNull();

      const internalRejected = await manager.startSessionTurn({
        sessionId,
        source: 'internal',
        sourceCommandId: 'monitor-during-live-run',
        userMessage: 'Internal work must still wait.',
      });
      expect(internalRejected).toMatchObject({
        accepted: false,
        result: { status: 'rejected', reason: 'session_busy' },
      });

      submission = await manager.startSessionTurn({
        sessionId,
        source: 'user',
        sourceCommandId: 'steer-during-live-run',
        userMessage: 'Steer the running turn with this instead.',
      });

      // A live run is steered, not killed: the send parks behind it durably,
      // its message is already persisted, and the owner is never aborted.
      expect(owner!.signal.aborted).toBe(false);
      if (submission.accepted !== 'queued') throw new Error('Expected the send to queue');
      const parkedMessage = records.get(submission.userMessageId);
      expect(parkedMessage).toMatchObject({
        role: 'user',
        content: 'Steer the running turn with this instead.',
      });
      const queuedSteers = await agentSteeringStore.list(sessionId, 'kory-manager');
      expect(queuedSteers).toHaveLength(1);
      expect(queuedSteers[0]).toMatchObject({
        id: submission.steeringCommandId,
        content: 'Steer the running turn with this instead.',
        status: 'queued',
      });
      // Replaying the same producer id returns the same parked receipt.
      const replay = await manager.startSessionTurn({
        sessionId,
        source: 'user',
        sourceCommandId: 'steer-during-live-run',
        userMessage: 'Steer the running turn with this instead.',
      });
      expect(replay).toMatchObject({
        accepted: 'queued',
        steeringCommandId: submission.steeringCommandId,
        userMessageId: submission.userMessageId,
      });
      expect(coordinator.get(sessionId)).toMatchObject({
        runId: owner!.runId,
        status: 'active',
      });

      // When the run releases, the drain admits the parked send as the next
      // turn through the normal command-ledger path.
      await manager.rejectSessionTurn(owner!, 'test_owner_released');
      const identity = deriveSessionTurnCommandIdentity({
        sessionId,
        source: 'user',
        sourceCommandId: 'steer-during-live-run',
      });
      for (let attempt = 0; attempt < 50; attempt++) {
        if (coordinator.getSessionTurnCommand(identity.commandKey)) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(coordinator.getSessionTurnCommand(identity.commandKey)).toBeTruthy();
      expect(records.get(identity.userMessageId)).toBeTruthy();
    } finally {
      await agentSteeringStore
        .remove(`usrsteer_${sessionId}_steer-during-live-run`)
        .catch(() => undefined);
      await manager.shutdown();
      sqlite.close();
    }
  });

  test('a stop cancels a queued user steer so it never dispatches', async () => {
    const sessionId = 'stop-cancels-queued-steer';
    const { sqlite, coordinator } = createRunCoordinator(sessionId);
    const { store, records } = createMessageStore();
    const manager = createManager(coordinator, store);
    try {
      const owner = await manager.reserveSessionTurn(sessionId, 'user_turn');
      expect(owner).not.toBeNull();
      const submission = await manager.startSessionTurn({
        sessionId,
        source: 'user',
        sourceCommandId: 'steer-cancelled-by-stop',
        userMessage: 'Never mind, stop everything.',
      });
      if (submission.accepted !== 'queued') throw new Error('Expected the send to queue');

      const internal = manager as unknown as {
        performSessionCancellation(id: string): Promise<void>;
        waitForSessionExecutionToSettle(): Promise<void>;
      };
      internal.waitForSessionExecutionToSettle = async () => {};
      await internal.performSessionCancellation(sessionId);

      expect(
        await agentSteeringStore.getById(`usrsteer_${sessionId}_steer-cancelled-by-stop`),
      ).toMatchObject({ status: 'cancelled' });

      // Releasing the run fires the deferred drain; the cancelled row must
      // never dispatch — stop cannot resurrect a parked send.
      await manager.rejectSessionTurn(owner!, 'test_owner_released').catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 30));
      const identity = deriveSessionTurnCommandIdentity({
        sessionId,
        source: 'user',
        sourceCommandId: 'steer-cancelled-by-stop',
      });
      expect(coordinator.getSessionTurnCommand(identity.commandKey)).toBeFalsy();
      // The eagerly persisted user message stays — it was real input.
      expect(records.get(identity.userMessageId)).toBeTruthy();
    } finally {
      await manager.shutdown();
      sqlite.close();
    }
  });

  test('a queued steer survives losing its parked input and drains from the durable row', async () => {
    const sessionId = 'restart-drains-queued-steer';
    const { sqlite, coordinator } = createRunCoordinator(sessionId);
    const { store, records } = createMessageStore();
    const manager = createManager(coordinator, store);
    try {
      const owner = await manager.reserveSessionTurn(sessionId, 'user_turn');
      expect(owner).not.toBeNull();
      const submission = await manager.startSessionTurn({
        sessionId,
        source: 'user',
        sourceCommandId: 'steer-survives-restart',
        userMessage: 'Deliver me after the restart.',
      });
      if (submission.accepted !== 'queued') throw new Error('Expected the send to queue');

      // A restart drops the process-local parked input; the durable row must
      // carry enough to dispatch the same command with the same identity.
      const internal = manager as unknown as {
        runtimes: {
          peek(id: string): { pendingSteerInputs: Map<string, unknown> } | undefined;
        };
      };
      internal.runtimes.peek(sessionId)?.pendingSteerInputs.clear();

      await manager.rejectSessionTurn(owner!, 'test_owner_released');
      const identity = deriveSessionTurnCommandIdentity({
        sessionId,
        source: 'user',
        sourceCommandId: 'steer-survives-restart',
      });
      for (let attempt = 0; attempt < 50; attempt++) {
        if (coordinator.getSessionTurnCommand(identity.commandKey)) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const command = coordinator.getSessionTurnCommand(identity.commandKey);
      expect(command).toBeTruthy();
      expect(command!.userMessageId).toBe(identity.userMessageId);
      expect(records.get(identity.userMessageId)).toMatchObject({
        role: 'user',
        content: 'Deliver me after the restart.',
      });
    } finally {
      await agentSteeringStore
        .remove(`usrsteer_${sessionId}_steer-survives-restart`)
        .catch(() => undefined);
      await manager.shutdown();
      sqlite.close();
    }
  });

  test('admission reclaims a stale aborted run claim instead of rejecting forever', async () => {
    const sessionId = 'stale-abort-recovery';
    const never = deferred();
    const start = new Date('2026-11-03T20:00:00.000Z').getTime();
    const { sqlite, coordinator } = createRunCoordinator(sessionId);
    const manager = createManager(coordinator);
    const internal = manager as unknown as {
      processTaskWithClaim(): Promise<void>;
    };
    internal.processTaskWithClaim = (async () => {
      await never.promise;
    }) as never;
    setSystemTime(start);
    let completion: ReturnType<KoryManager['dispatchAdmittedTask']> | undefined;
    try {
      const first = await manager.reserveSessionTurn(sessionId, 'user_turn');
      expect(first).not.toBeNull();
      completion = manager.dispatchAdmittedTask(first!, { userMessage: 'Hung owner' });
      manager.abortManagerRun(sessionId);
      // The owner never produced another durable transition.
      setSystemTime(start + 60_000);
      const next = await manager.reserveSessionTurn(sessionId, 'user_turn');
      expect(next).not.toBeNull();
      expect(next!.runId).not.toBe(first!.runId);
      expect(coordinator.get(sessionId)).toMatchObject({
        runId: next!.runId,
        status: 'active',
      });
      await manager.rejectSessionTurn(next!, 'test_cleanup');
    } finally {
      setSystemTime();
      never.resolve();
      await completion;
      await manager.shutdown();
      sqlite.close();
    }
  });

  test('admission re-checks a cached provider failure before refusing the turn', async () => {
    const sessionId = 'admission-recheck';
    const { sqlite, coordinator } = createRunCoordinator(sessionId);
    const { store } = createMessageStore();
    (store as unknown as { getContextMessages(): Promise<never[]> }).getContextMessages =
      async () => [];
    const manager = createManager(coordinator, store);
    const internal = manager as unknown as {
      providers: {
        resolveProvider: ReturnType<typeof mock>;
        executeWithRetry: ReturnType<typeof mock>;
        get?: (name: string) => unknown;
      };
    };
    // Model Freebuff's contract: the synchronous gate serves a cached probe
    // failure until refreshAvailability re-probes and flips it.
    let available = false;
    const refreshAvailability = mock(async () => {
      available = true;
      return true;
    });
    let streamed = false;
    const provider = {
      name: 'openai',
      refreshAvailability,
      isAvailable: () => available,
      streamResponse: () => {
        streamed = true;
        return (async function* () {
          yield { type: 'text', text: 'ok' };
        })();
      },
    };
    internal.providers.get = () => provider;
    internal.providers.resolveProvider = mock(async () => (available ? provider : undefined));
    internal.providers.executeWithRetry = mock(() => {
      streamed = true;
      return (async function* () {
        yield { type: 'text', text: 'ok' };
      })();
    });
    try {
      const turn = await manager.startSessionTurn({
        sessionId,
        source: 'user',
        sourceCommandId: 'admission-recheck-cmd',
        userMessage: 'Run after a transient probe failure.',
      });
      expect(turn.accepted).toBe(true);
      if (turn.accepted !== true) throw new Error('Expected the turn to be admitted');
      const result = await turn.completion;
      expect(refreshAvailability).toHaveBeenCalledTimes(1);
      // The cached failure must not be what ends the turn: resolveProvider saw
      // the refreshed adapter and the stream was entered.
      expect(streamed).toBe(true);
      expect(result).not.toMatchObject({ status: 'failed', reason: 'provider_unavailable' });
    } finally {
      await manager.shutdown();
      sqlite.close();
    }
  });

  describe('background worker delivery', () => {
    type Internal = {
      runtimes: {
        get(id: string): {
          runClaimed: boolean;
          pendingSteerInputs: Map<string, unknown>;
          asyncChildren: {
            get(id: string): { delivery: string; status: string; result?: string } | undefined;
          };
        };
        peek(id: string): { runClaimed: boolean; pendingSteerInputs: Map<string, unknown> } | undefined;
      };
      runWorkerPipeline: (...args: unknown[]) => Promise<string>;
      startSessionTurn: (input: { source: string; userMessage: string }) => Promise<unknown>;
      delegateWorkerForCaller: (sessionId: string, request: Record<string, unknown>) => Promise<string>;
      waitForAsyncChildren: (sessionId: string, input: Record<string, unknown>) => Promise<string>;
    };

    async function until(check: () => boolean): Promise<void> {
      for (let attempt = 0; attempt < 200 && !check(); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }

    test('a finished background worker is admitted as a host-authored internal turn when the chat is idle', async () => {
      const sessionId = 'async-idle-delivery';
      const { sqlite, coordinator } = createRunCoordinator(sessionId);
      const { store } = createMessageStore();
      const manager = createManager(coordinator, store);
      const internal = manager as unknown as Internal;
      const admitted: Array<{ source: string; userMessage: string }> = [];
      internal.runWorkerPipeline = async () => 'Worker found the answer.';
      internal.startSessionTurn = async (input) => {
        admitted.push(input);
        return { accepted: true, completion: Promise.resolve({ status: 'completed' }) };
      };
      try {
        const handle = await internal.delegateWorkerForCaller(sessionId, {
          task: 'Find the answer',
          wait: false,
        });
        const agentId = /Started background worker (child-\S+?)\./.exec(handle)?.[1];
        expect(agentId).toBeTruthy();
        await until(() => admitted.length > 0);
        expect(admitted).toHaveLength(1);
        expect(admitted[0]!.source).toBe('internal');
        expect(admitted[0]!.userMessage).toContain('[Host: background worker results]');
        expect(admitted[0]!.userMessage).toContain(`Worker ${agentId} (completed).`);
        expect(admitted[0]!.userMessage).toContain('Worker found the answer.');
        expect(internal.runtimes.get(sessionId).asyncChildren.get(agentId!)?.delivery).toBe('delivered');
      } finally {
        await manager.shutdown();
        sqlite.close();
      }
    });

    test('results finished during a live run park as a steer, and wait_for_agents drops the parked continuation', async () => {
      const sessionId = 'async-live-park';
      const { sqlite, coordinator } = createRunCoordinator(sessionId);
      const { store } = createMessageStore();
      const manager = createManager(coordinator, store);
      const internal = manager as unknown as Internal;
      let finish: (text: string) => void = () => undefined;
      internal.runWorkerPipeline = () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        });
      const admitted: string[] = [];
      internal.startSessionTurn = async (input) => {
        admitted.push(input.userMessage);
        return { accepted: true, completion: Promise.resolve({ status: 'completed' }) };
      };
      try {
        internal.runtimes.get(sessionId).runClaimed = true;
        const handle = await internal.delegateWorkerForCaller(sessionId, {
          task: 'Slow check',
          wait: false,
        });
        const agentId = /Started background worker (child-\S+?)\./.exec(handle)![1]!;
        finish('Slow result.');
        await until(() => internal.runtimes.get(sessionId).pendingSteerInputs.size > 0);
        // Parked, not admitted: a live manager turn yields at its next checkpoint.
        expect(internal.runtimes.get(sessionId).pendingSteerInputs.size).toBe(1);
        expect(admitted).toHaveLength(0);

        const joined = await internal.waitForAsyncChildren(sessionId, { agentIds: [agentId] });
        expect(joined).toContain('Slow result.');
        // The claimed result must not stop the turn or be delivered again.
        expect(internal.runtimes.get(sessionId).pendingSteerInputs.size).toBe(0);
        expect(internal.runtimes.get(sessionId).asyncChildren.get(agentId)?.delivery).toBe('delivered');
        expect(admitted).toHaveLength(0);
      } finally {
        internal.runtimes.get(sessionId).runClaimed = false;
        await manager.shutdown();
        sqlite.close();
      }
    });
  });
});
