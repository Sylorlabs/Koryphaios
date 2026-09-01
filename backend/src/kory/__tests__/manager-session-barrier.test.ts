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
        titleGenerationBySession: Map<string, AbortController>;
      };
      internal.titleGenerationBySession.set('session-title', new AbortController());

      expect(manager.tryAcquireSessionMutationBarrier('session-title')).toBeNull();

      internal.titleGenerationBySession.delete('session-title');
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
        sessionRunClaims: Set<string>;
        managerAbortBySession: Map<string, AbortController>;
        runLifecycle: { cancelCurrent: typeof cancelCurrent; finish: typeof finish };
      };
      internal.sessionRunClaims.add('session-owned');
      internal.managerAbortBySession.set('session-owned', controller);
      internal.runLifecycle.cancelCurrent = cancelCurrent;
      internal.runLifecycle.finish = finish;

      await manager.cancelSessionWorkers('session-owned');
      timeline.push('partial-response-persisted');
      await internal.runLifecycle.finish({}, 'cancel', 'cancelled');

      expect(controller.signal.aborted).toBe(true);
      expect(cancelCurrent).not.toHaveBeenCalled();
      expect(timeline).toEqual([
        'abort-requested',
        'partial-response-persisted',
        'owner-terminal',
      ]);
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
        managerAbortBySession: Map<string, AbortController>;
        runLifecycle: {
          resumeProcessWait: ReturnType<typeof mock>;
          finish: typeof finish;
        };
        continueProcessWake: ReturnType<typeof mock>;
        wakeForProcessCompletionsWithClaim(sessionId: string, events: unknown[]): Promise<void>;
      };
      internal.managerAbortBySession.set(sessionId, controller);
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
        sessionRunClaims: Set<string>;
      };
      internal.sessionRunClaims.add('live-manager');

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
