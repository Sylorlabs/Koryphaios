import { describe, expect, test } from 'bun:test';
import type { Goal, Session } from '@koryphaios/shared';
import { ConflictError } from '../errors/types';
import {
  archiveSessionCoordinated,
  restoreSessionCoordinated,
  type SessionArchiveDependencies,
} from './session-archive-service';

const SESSION_ID = 'archive-chat';

function activeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: SESSION_ID,
    title: 'Durable chat',
    messageCount: 4,
    totalTokensIn: 120,
    totalTokensOut: 80,
    totalCost: 0.05,
    version: 7,
    createdAt: 1_000,
    updatedAt: 2_000,
    status: 'active',
    ...overrides,
  };
}

function dependencies(overrides: Partial<SessionArchiveDependencies> = {}) {
  const trace: string[] = [];
  let session: Session | undefined = activeSession();
  const deps: SessionArchiveDependencies = {
    getSession: async () => session,
    archiveSession: async (_id, archivedAt = Date.now()) => {
      trace.push('archive');
      if (!session || session.archivedAt !== undefined) return session;
      session = {
        ...session,
        archivedAt,
        status: 'archived',
        version: (session.version ?? 1) + 1,
      };
      return session;
    },
    restoreSession: async () => {
      trace.push('restore');
      if (!session || session.archivedAt === undefined) return session;
      const { archivedAt: _archivedAt, ...active } = session;
      session = {
        ...active,
        status: 'active',
        version: (session.version ?? 1) + 1,
      };
      return session;
    },
    getRun: () => null,
    listProcesses: async () => [],
    listGoals: async () => [],
    tryAcquireManagerBarrier: () => {
      trace.push('manager-acquire');
      return { release: () => trace.push('manager-release') };
    },
    tryAcquireProcessBarrier: () => {
      trace.push('process-acquire');
      return { release: () => trace.push('process-release') };
    },
    revokeBridgeGrants: () => trace.push('revoke'),
    publishSessionUpdated: () => trace.push('publish'),
    ...overrides,
  };
  return {
    deps,
    trace,
    getSession: () => session,
    setSession: (next?: Session) => (session = next),
  };
}

describe('coordinated chat archive lifecycle', () => {
  test('holds both barriers through revocation, durable transition, and publication', async () => {
    const harness = dependencies();

    const archived = await archiveSessionCoordinated(SESSION_ID, harness.deps, 9_000);

    expect(archived).toMatchObject({ archivedAt: 9_000, status: 'archived', version: 8 });
    expect(archived.updatedAt).toBe(2_000);
    expect(harness.trace).toEqual([
      'manager-acquire',
      'process-acquire',
      'revoke',
      'archive',
      'publish',
      'process-release',
      'manager-release',
    ]);
  });

  test('fails closed when either lifecycle barrier is busy', async () => {
    const managerBusy = dependencies({ tryAcquireManagerBarrier: () => null });
    await expect(archiveSessionCoordinated(SESSION_ID, managerBusy.deps)).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(managerBusy.trace).toEqual([]);

    const processBusy = dependencies({
      tryAcquireProcessBarrier: () => {
        processBusy.trace.push('process-busy');
        return null;
      },
    });
    await expect(archiveSessionCoordinated(SESSION_ID, processBusy.deps)).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(processBusy.trace).toEqual(['manager-acquire', 'process-busy', 'manager-release']);
  });

  test('rejects authoritative active and waiting runs', async () => {
    for (const status of ['active', 'waiting']) {
      const harness = dependencies({ getRun: () => ({ status }) });
      await expect(archiveSessionCoordinated(SESSION_ID, harness.deps)).rejects.toThrow(
        'active chat run',
      );
      expect(harness.trace).not.toContain('archive');
      expect(harness.trace).not.toContain('revoke');
      expect(harness.trace.slice(-2)).toEqual(['process-release', 'manager-release']);
    }
  });

  test('rejects starting or running manual processes before hiding the chat', async () => {
    for (const status of ['starting', 'running']) {
      const harness = dependencies({ listProcesses: async () => [{ status }] });
      await expect(archiveSessionCoordinated(SESSION_ID, harness.deps)).rejects.toThrow(
        'Stop the chat process',
      );
      expect(harness.trace).not.toContain('archive');
      expect(harness.trace).not.toContain('revoke');
    }
  });

  test('rejects queued, planning, or running Goal Mode work with an actionable conflict', async () => {
    for (const status of ['queued', 'planning', 'running'] as const) {
      const goal = {
        id: `goal-${status}`,
        status,
        execution: { sessionId: SESSION_ID },
      } as Goal;
      const harness = dependencies({ listGoals: async () => [goal] });
      try {
        await archiveSessionCoordinated(SESSION_ID, harness.deps);
        throw new Error('expected archive conflict');
      } catch (error) {
        expect(error).toBeInstanceOf(ConflictError);
        expect((error as Error).message).toContain('Pause or finish the Goal');
        expect((error as ConflictError).details).toEqual({ goalId: goal.id });
      }
      expect(harness.trace).not.toContain('archive');
      expect(harness.trace).not.toContain('revoke');
    }
  });

  test('archive and restore retries are no-ops without version or ordering churn', async () => {
    const harness = dependencies();
    const first = await archiveSessionCoordinated(SESSION_ID, harness.deps, 9_000);
    harness.trace.length = 0;

    const archiveRetry = await archiveSessionCoordinated(SESSION_ID, harness.deps, 99_000);
    expect(archiveRetry).toEqual(first);
    expect(harness.trace).toEqual([
      'manager-acquire',
      'process-acquire',
      'revoke',
      'process-release',
      'manager-release',
    ]);

    const restored = await restoreSessionCoordinated(SESSION_ID, harness.deps);
    expect(restored).toMatchObject({ status: 'active', version: 9, updatedAt: 2_000 });
    harness.trace.length = 0;

    const restoreRetry = await restoreSessionCoordinated(SESSION_ID, harness.deps);
    expect(restoreRetry).toEqual(restored);
    expect(harness.trace).toEqual([
      'manager-acquire',
      'process-acquire',
      'process-release',
      'manager-release',
    ]);
  });
});
