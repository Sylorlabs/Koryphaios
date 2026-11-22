import { afterEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KoryphaiosConfig } from '@koryphaios/shared';
import type { ProviderRegistry, ToolRegistry } from '../../providers';
import type { IMessageStore } from '../../stores/message-store';
import type { ISessionStore } from '../../stores/session-store';
import { SessionStateService } from '../services/SessionStateService';
import { KoryManager } from '../manager';

const testDirectories: string[] = [];

function createManager(sessions?: ISessionStore) {
  const directory = mkdtempSync(join(tmpdir(), 'kory-manager-barrier-'));
  testDirectories.push(directory);
  const resolveProvider = mock(async () => undefined);
  const providers = {
    resolveProvider,
    getAvailable: () => [],
    getStatus: () => [],
    isQuotaError: () => false,
  } as unknown as ProviderRegistry;
  const messages = {
    getById: async () => undefined,
  } as unknown as IMessageStore;
  const manager = new KoryManager(
    providers,
    {} as ToolRegistry,
    directory,
    {} as KoryphaiosConfig,
    sessions,
    messages,
  );
  return { manager, resolveProvider };
}

function managerState(manager: KoryManager): SessionStateService {
  return (manager as unknown as { state: SessionStateService }).state;
}

afterEach(() => {
  for (const directory of testDirectories.splice(0)) {
    if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
  }
});

describe('KoryManager session mutation barrier', () => {
  test('is exclusive and its release lease is idempotent', () => {
    const { manager } = createManager();
    try {
      const lease = manager.tryAcquireSessionMutationBarrier('session-a');
      expect(lease).not.toBeNull();
      expect(manager.isSessionRunning('session-a')).toBe(true);
      expect(manager.tryAcquireSessionMutationBarrier('session-a')).toBeNull();

      lease!.release();
      lease!.release();
      expect(manager.isSessionRunning('session-a')).toBe(false);

      const reacquired = manager.tryAcquireSessionMutationBarrier('session-a');
      expect(reacquired).not.toBeNull();
      reacquired!.release();
    } finally {
      manager.shutdown();
    }
  });

  test('agent Git switching permits its owning manager run but excludes workers and other mutations', () => {
    const { manager } = createManager();
    const internal = manager as unknown as {
      runtimes: { get(id: string): Record<string, unknown> };
      workers: { hasSessionWorkers(id: string): boolean };
    };
    const previous = internal.workers.hasSessionWorkers;
    try {
      internal.runtimes.get('git-agent').abort = new AbortController();
      expect(manager.tryAcquireSessionMutationBarrier('git-agent')).toBeNull();
      internal.workers.hasSessionWorkers = () => true;
      expect(manager.tryAcquireAgentGitMutationBarrier('git-agent')).toBeNull();
      internal.workers.hasSessionWorkers = () => false;
      const lease = manager.tryAcquireAgentGitMutationBarrier('git-agent');
      expect(lease).not.toBeNull();
      expect(manager.tryAcquireAgentGitMutationBarrier('git-agent')).toBeNull();
      lease!.release();
      lease!.release();
      const next = manager.tryAcquireAgentGitMutationBarrier('git-agent');
      expect(next).not.toBeNull();
      next!.release();
    } finally {
      internal.workers.hasSessionWorkers = previous;
      internal.runtimes.get('git-agent').abort = undefined;
      manager.shutdown();
    }
  });

  test('prevents processTask from entering provider resolution while held', async () => {
    const { manager, resolveProvider } = createManager();
    try {
      const lease = manager.tryAcquireSessionMutationBarrier('session-b');
      expect(lease).not.toBeNull();

      await manager.processTask('session-b', 'must not start during recovery');

      expect(resolveProvider).not.toHaveBeenCalled();
      expect(manager.isSessionRunning('session-b')).toBe(true);
      lease!.release();
      expect(manager.isSessionRunning('session-b')).toBe(false);
    } finally {
      manager.shutdown();
    }
  });

  test('cannot be acquired while session title generation is in flight', () => {
    const { manager } = createManager();
    try {
      const internal = manager as unknown as {
        runtimes: { get(id: string): Record<string, unknown> };
      };
      internal.runtimes.get('session-title').titleAbort = new AbortController();

      expect(manager.tryAcquireSessionMutationBarrier('session-title')).toBeNull();

      internal.runtimes.get('session-title').titleAbort = undefined;
      const lease = manager.tryAcquireSessionMutationBarrier('session-title');
      expect(lease).not.toBeNull();
      lease?.release();
    } finally {
      manager.shutdown();
    }
  });

  test('cancellation resolves pending input before any manager controller exists', async () => {
    const { manager } = createManager();
    try {
      const state = managerState(manager);
      const pending = state.requestUserInput('session-c', 0);
      expect(state.hasPendingInput('session-c')).toBe(true);

      await manager.cancelSessionWorkers('session-c');

      await expect(pending).resolves.toBe('__cancelled__');
      expect(state.hasPendingInput('session-c')).toBe(false);
    } finally {
      manager.shutdown();
    }
  });

  test('local execution owner terminalizes only after its abort-time persistence settles', async () => {
    const { manager } = createManager();
    try {
      const timeline: string[] = [];
      const cancelCurrent = mock(async (..._args: unknown[]) => {
        timeline.push('external-terminal');
      });
      const finish = mock(async (..._args: unknown[]) => {
        timeline.push('owner-terminal');
      });
      const controller = new AbortController();
      controller.signal.addEventListener('abort', () => timeline.push('abort-requested'));
      const internal = manager as unknown as {
        runtimes: { get(id: string): Record<string, unknown> };
        runLifecycle: { cancelCurrent: typeof cancelCurrent; finish: typeof finish };
      };
      internal.runtimes.get('session-owned').runClaimed = true;
      internal.runtimes.get('session-owned').abort = controller;
      internal.runLifecycle.cancelCurrent = cancelCurrent;
      internal.runLifecycle.finish = finish;

      const cancellation = manager.cancelSessionWorkers('session-owned');
      await Promise.resolve();
      timeline.push('partial-response-persisted');
      await internal.runLifecycle.finish({}, 'cancel', 'cancelled');
      internal.runtimes.get('session-owned').abort = undefined;
      internal.runtimes.get('session-owned').runClaimed = false;
      await cancellation;

      expect(controller.signal.aborted).toBe(true);
      expect(cancelCurrent).not.toHaveBeenCalled();
      expect(timeline).toEqual(['abort-requested', 'partial-response-persisted', 'owner-terminal']);
    } finally {
      manager.shutdown();
    }
  });

  test('durable wait without a local stack is terminalized directly on cancellation', async () => {
    const { manager } = createManager();
    try {
      const cancelCurrent = mock(async (..._args: unknown[]) => {});
      const internal = manager as unknown as {
        runLifecycle: { cancelCurrent: typeof cancelCurrent };
      };
      internal.runLifecycle.cancelCurrent = cancelCurrent;

      await manager.cancelSessionWorkers('restart-safe-wait');

      expect(cancelCurrent).toHaveBeenCalledWith('restart-safe-wait', 'cancelled_by_user');
    } finally {
      manager.shutdown();
    }
  });

  test('an answer racing a locally-owned cancellation never steals terminal ownership as failure', async () => {
    const { manager } = createManager();
    try {
      const handle = Object.freeze({ sessionId: 'question-race', runId: 'question-run' });
      const controller = new AbortController();
      controller.abort(new DOMException('Stopped by user', 'AbortError'));
      const finish = mock(async (..._args: unknown[]) => {});
      const internal = manager as unknown as {
        state: {
          hasPendingInput(sessionId: string): boolean;
          resolveUserInput(sessionId: string, value: string): boolean;
        };
        runLifecycle: {
          answerQuestion: ReturnType<typeof mock>;
          finish: typeof finish;
        };
        runControllerByHandle: WeakMap<object, AbortController>;
      };
      internal.state.hasPendingInput = () => true;
      internal.state.resolveUserInput = () => false;
      internal.runLifecycle.answerQuestion = mock(async () => ({
        question: { questionId: 'question-id', question: 'Continue?', options: ['Yes'] },
        handle,
        handoff: null,
      }));
      internal.runLifecycle.finish = finish;
      internal.runControllerByHandle.set(handle, controller);

      await manager.handleUserInput('question-race', 'Yes', undefined, 'question-id');

      expect(finish).not.toHaveBeenCalled();
    } finally {
      await manager.shutdown();
    }
  });

  test('a cancelled process wake is terminalized as cancel rather than fail', async () => {
    const { manager } = createManager();
    try {
      const sessionId = 'process-wake-cancel';
      const handle = Object.freeze({ sessionId, runId: 'process-wake-run' });
      const controller = new AbortController();
      controller.abort(new DOMException('Stopped by user', 'AbortError'));
      const finish = mock(async (..._args: unknown[]) => {});
      const internal = manager as unknown as {
        runtimes: { get(id: string): Record<string, unknown> };
        runLifecycle: {
          resumeProcessWait: ReturnType<typeof mock>;
          finish: typeof finish;
        };
        continueProcessWake: ReturnType<typeof mock>;
        wakeForProcessCompletionsWithClaim(sessionId: string, events: unknown[]): Promise<void>;
      };
      internal.runtimes.get(sessionId).abort = controller;
      internal.runLifecycle.resumeProcessWait = mock(async () => ({
        handle,
        processIds: ['process-id'],
        continuationId: 'continuation-id',
        expectedBoundary: { activeMessageId: null, providerConversationRevision: 0 },
      }));
      internal.runLifecycle.finish = finish;
      internal.continueProcessWake = mock(async () => {
        throw new DOMException('Stopped by user', 'AbortError');
      });

      await internal.wakeForProcessCompletionsWithClaim(sessionId, []);

      expect(finish).toHaveBeenCalledWith(handle, 'cancel', 'cancelled_by_user');
    } finally {
      await manager.shutdown();
    }
  });

  test('compaction is cancellable while active-session preflight is still pending', async () => {
    let releaseLookup!: (value: { id: string; archivedAt?: number }) => void;
    const lookup = new Promise<{ id: string; archivedAt?: number }>((resolve) => {
      releaseLookup = resolve;
    });
    const getActive = mock(async () => lookup);
    const sessions = { getActive } as unknown as ISessionStore;
    const { manager, resolveProvider } = createManager(sessions);
    try {
      const compaction = manager.compactSession({
        sessionId: 'compaction-preflight',
        selectedModel: 'openai:test-model',
      });

      expect(getActive).toHaveBeenCalledWith('compaction-preflight');
      expect(manager.hasActiveSessionExecution('compaction-preflight')).toBe(true);

      await manager.cancelSessionWorkers('compaction-preflight');
      releaseLookup({ id: 'compaction-preflight' });

      await expect(compaction).rejects.toMatchObject({ name: 'AbortError' });
      expect(resolveProvider).not.toHaveBeenCalled();
      expect(manager.hasActiveSessionExecution('compaction-preflight')).toBe(false);
    } finally {
      await manager.shutdown();
    }
  });

  test('idle cleanup cannot dismantle a live manager or user-input wait', async () => {
    const { manager } = createManager();
    try {
      const state = managerState(manager);
      state.ensureSession('live-manager');
      state.touchSession('live-manager', 1);
      const internal = manager as unknown as {
        runtimes: { get(id: string): Record<string, unknown> };
      };
      internal.runtimes.get('live-manager').runClaimed = true;

      const pending = state.requestUserInput('waiting-user', 0);
      state.touchSession('waiting-user', 1);
      manager.cleanupAbandonedResources(1);

      expect(state.hasSession('live-manager')).toBe(true);
      expect(state.hasSession('waiting-user')).toBe(true);
      state.resolveUserInput('waiting-user', '__cancelled__');
      await pending;
    } finally {
      manager.shutdown();
    }
  });
});

describe('KoryManager ask_user wait serialization', () => {
  test('concurrent question waits queue instead of cancelling each other', async () => {
    const { manager } = createManager();
    const parked: string[] = [];
    const emitted: string[] = [];
    const internal = manager as unknown as {
      runLifecycle: {
        handleForSession: (sessionId: string) => unknown;
        waitForQuestion: (
          handle: unknown,
          question: { question: string },
        ) => Promise<{ questionId: string }>;
      };
      emitWSMessage: (sessionId: string, type: string, payload: unknown) => void;
      waitForUserInputInternal: (
        sessionId: string,
        question: string,
        options: string[],
      ) => Promise<string>;
    };
    internal.runLifecycle.handleForSession = (sessionId) => ({
      sessionId,
      runId: 'run-1',
      revision: 1,
    });
    internal.runLifecycle.waitForQuestion = async (_handle, question) => {
      parked.push(question.question);
      return { ...question, questionId: `q-${parked.length}` };
    };
    internal.emitWSMessage = (_sessionId, type) => emitted.push(type);
    try {
      const first = internal.waitForUserInputInternal('qs', 'Pick a color?', ['Red', 'Blue']);
      const second = internal.waitForUserInputInternal('qs', 'Pick a size?', ['Small', 'Large']);
      // Let the queue settle: only the first wait may park and emit.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(parked).toEqual(['Pick a color?']);
      expect(emitted).toEqual(['kory.ask_user']);

      const state = managerState(manager);
      expect(state.resolveUserInput('qs', 'Red')).toBe(true);
      await expect(first).resolves.toBe('Red');
      // The queued second wait parks only after the first released the queue.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(parked).toEqual(['Pick a color?', 'Pick a size?']);
      expect(emitted).toEqual(['kory.ask_user', 'kory.ask_user']);

      expect(state.resolveUserInput('qs', 'Large')).toBe(true);
      await expect(second).resolves.toBe('Large');
      expect(await first).not.toBe('__cancelled__');
      expect(await second).not.toBe('__cancelled__');
    } finally {
      manager.shutdown();
    }
  });
});
