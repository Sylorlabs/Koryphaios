import type { Goal, Session } from '@koryphaios/shared';
import { getContext } from '../context';
import { ConflictError, NotFoundError } from '../errors/types';
import { revokeKoryBridgeGrantsForSession } from '../providers/bridge-grant';
import { processSupervisor } from '../process-supervisor/supervisor';

interface ArchiveLease {
  release(): void;
}

interface ArchiveRunProjection {
  status: string;
}

interface ArchiveProcessProjection {
  status: string;
}

export interface SessionArchiveDependencies {
  getSession(id: string): Promise<Session | undefined>;
  archiveSession(id: string, archivedAt?: number): Promise<Session | undefined>;
  restoreSession(id: string): Promise<Session | undefined>;
  getRun(id: string): ArchiveRunProjection | null;
  listProcesses(id: string): Promise<ArchiveProcessProjection[]>;
  listGoals(): Promise<Goal[]>;
  tryAcquireManagerBarrier(id: string): ArchiveLease | null;
  tryAcquireProcessBarrier(id: string): ArchiveLease | null;
  revokeBridgeGrants(id: string): void;
  publishSessionUpdated(session: Session): void;
}

function productionDependencies(): SessionArchiveDependencies {
  const { sessions, kory, runs, goals, wsManager } = getContext();
  return {
    getSession: (id) => sessions.get(id),
    archiveSession: (id, archivedAt) => sessions.archive(id, archivedAt),
    restoreSession: (id) => sessions.restore(id),
    getRun: (id) => runs.get(id),
    listProcesses: (id) => processSupervisor.getProcessesBySession(id),
    listGoals: () => goals.list(),
    tryAcquireManagerBarrier: (id) => kory.tryAcquireSessionMutationBarrier(id),
    tryAcquireProcessBarrier: (id) => processSupervisor.tryAcquireAgentToolBarrier(id),
    revokeBridgeGrants: (id) => revokeKoryBridgeGrantsForSession(id),
    publishSessionUpdated: (session) =>
      wsManager.broadcastEphemeral({
        type: 'session.updated',
        payload: { session },
        timestamp: Date.now(),
        sessionId: session.id,
      }),
  };
}

function busyRun(run: ArchiveRunProjection | null): boolean {
  return run?.status === 'active' || run?.status === 'waiting';
}

function isDispatchingGoal(goal: Goal, sessionId: string): boolean {
  return (
    goal.execution?.sessionId === sessionId &&
    (goal.status === 'queued' || goal.status === 'planning' || goal.status === 'running')
  );
}

async function withArchiveBarriers<T>(
  sessionId: string,
  deps: SessionArchiveDependencies,
  operation: () => Promise<T>,
): Promise<T> {
  const managerLease = deps.tryAcquireManagerBarrier(sessionId);
  if (!managerLease) {
    throw new ConflictError(
      'Wait for active chat work to finish before changing its archive state.',
    );
  }
  const processLease = deps.tryAcquireProcessBarrier(sessionId);
  if (!processLease) {
    managerLease.release();
    throw new ConflictError(
      'Wait for the chat background process to finish before changing its archive state.',
    );
  }
  try {
    return await operation();
  } finally {
    processLease.release();
    managerLease.release();
  }
}

/** Archive without erasing any chat-owned data. Both lifecycle barriers are
 * installed before the durable checks, closing manager/provider and agent-tool
 * start races. Authoritative run and Goal projections must also be idle. */
export async function archiveSessionCoordinated(
  sessionId: string,
  dependencies?: SessionArchiveDependencies,
  archivedAt = Date.now(),
): Promise<Session> {
  const deps = dependencies ?? productionDependencies();
  if (!(await deps.getSession(sessionId))) throw new NotFoundError('Session', sessionId);

  return withArchiveBarriers(sessionId, deps, async () => {
    const current = await deps.getSession(sessionId);
    if (!current) throw new NotFoundError('Session', sessionId);
    if (busyRun(deps.getRun(sessionId))) {
      throw new ConflictError('Stop or finish the active chat run before archiving this chat.');
    }
    const activeProcess = (await deps.listProcesses(sessionId)).find(
      (process) => process.status === 'starting' || process.status === 'running',
    );
    if (activeProcess) {
      throw new ConflictError('Stop the chat process before archiving this chat.');
    }
    const activeGoal = (await deps.listGoals()).find((goal) => isDispatchingGoal(goal, sessionId));
    if (activeGoal) {
      throw new ConflictError('Pause or finish the Goal using this chat before archiving it.', {
        goalId: activeGoal.id,
      });
    }

    // Revocation happens while both start barriers are held. A stale CLI must
    // not retain a capability that can mutate a chat after it leaves the active list.
    deps.revokeBridgeGrants(sessionId);
    if (current.archivedAt !== undefined) return current;

    const archived = await deps.archiveSession(sessionId, archivedAt);
    if (!archived) {
      throw new ConflictError('The chat changed while it was being archived. Refresh and retry.');
    }
    deps.publishSessionUpdated(archived);
    return archived;
  });
}

/** Recover an archived chat without touching its messages, files, checkpoints,
 * usage, goals, or audit history. The same barriers serialize restore against
 * deletion and any corrupt/stale lifecycle producer. */
export async function restoreSessionCoordinated(
  sessionId: string,
  dependencies?: SessionArchiveDependencies,
): Promise<Session> {
  const deps = dependencies ?? productionDependencies();
  if (!(await deps.getSession(sessionId))) throw new NotFoundError('Session', sessionId);

  return withArchiveBarriers(sessionId, deps, async () => {
    const current = await deps.getSession(sessionId);
    if (!current) throw new NotFoundError('Session', sessionId);
    if (busyRun(deps.getRun(sessionId))) {
      throw new ConflictError(
        'The archived chat has unresolved active work and cannot be recovered.',
      );
    }
    if (current.archivedAt === undefined) return current;

    const restored = await deps.restoreSession(sessionId);
    if (!restored) {
      throw new ConflictError('The chat changed while it was being recovered. Refresh and retry.');
    }
    deps.publishSessionUpdated(restored);
    return restored;
  });
}
