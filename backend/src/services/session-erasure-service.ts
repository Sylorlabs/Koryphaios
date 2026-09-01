import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Session } from '@koryphaios/shared';
import { getContext } from '../context';
import { getCreditDb } from '../credit-accountant/db';
import { getDb } from '../db';
import { ConflictError, KoryphaiosError, NotFoundError } from '../errors/types';
import { CheckpointStore } from '../kory/checkpoint-store';
import { getContextArchive } from '../kory/context-archive';
import type { GoalSessionErasureLease } from '../kory/goal-drive-service';
import type { ManagerSessionErasureLease } from '../kory/manager';
import { serverLog } from '../logger';
import { revokeKoryBridgeGrantsForSession } from '../providers/bridge-grant';
import {
  processSupervisor,
  type SessionErasureBarrierLease,
} from '../process-supervisor/supervisor';
import { PROJECT_ROOT } from '../runtime/paths';
import {
  recoverSessionFileErasures,
  SessionFileErasureLease,
  stageSessionFilesForErasure,
} from '../stores/session-file-erasure';
import {
  eraseCreditUsageTransaction,
  eraseSessionDataTransaction,
  inventorySessionIdsForErasure,
  type SessionErasureReport,
  type SessionErasureScope,
} from '../stores/session-erasure';
import type { WSManager } from '../ws/ws-manager';

export type CoordinatedSessionErasureScope =
  { kind: 'selected'; sessionId: string } | { kind: 'all' };

export interface CoordinatedSessionErasureResult {
  operationId: string;
  deleted: number;
  report: SessionErasureReport;
}

interface ArchiveErasureBoundary {
  beginSessionErasure(sessionId: string): void;
  cancelSessionErasure(sessionId: string): void;
  completeSessionErasure(sessionId: string): void;
}

interface FileErasureLease {
  readonly operationId: string;
  readonly recoveryReceiptPath: string;
  readonly sessionIds: readonly string[];
  readonly projectRoots: readonly string[];
  markDatabaseCommitStarted(): void;
  markDatabaseCommitted(): void;
  recordPartial(error: unknown): void;
  rollback(): void;
  finalize(): void;
}

export interface SessionErasureDependencies {
  getSession(id: string): Promise<Session | undefined>;
  listSessions(): Promise<Session[]>;
  inventorySessionIds(): string[];
  getTrackedProcessSessionIds(): string[];
  tryAcquireProcessBarrier(sessionId: string): SessionErasureBarrierLease | null;
  tryAcquireManagerBarrier(sessionId: string): ManagerSessionErasureLease | null;
  tryAcquireGoalBarrier(sessionId: string): GoalSessionErasureLease | null;
  terminateProcesses(sessionId: string): Promise<number>;
  completeProcessErasure(sessionId: string): void;
  archive: ArchiveErasureBoundary;
  stageFiles(input: {
    receiptRoot: string;
    projectRoots: readonly string[];
    sessionIds: readonly string[];
    scope: 'selected' | 'all';
  }): FileErasureLease;
  eraseDatabase(scope: SessionErasureScope): SessionErasureReport;
  eraseCredit(scope: SessionErasureScope): void;
  eraseCheckpoints(root: string, sessionId: string): Promise<void>;
  revokeBridgeGrants(sessionId: string): void;
  wsManager: Pick<WSManager, 'forgetSession' | 'broadcastEphemeral'>;
  receiptRoot: string;
}

export class SessionErasurePartialError extends KoryphaiosError {
  constructor(operationId: string, receiptPath: string, cause: unknown) {
    super(
      `Session data was erased, but post-commit cleanup is incomplete. Recovery operation: ${operationId}. Receipt: ${receiptPath}`,
      'SESSION_ERASURE_PARTIAL',
      500,
      true,
      { operationId, receiptPath },
    );
    this.cause = cause;
  }
}

export interface SessionErasureStartupRecoveryDependencies {
  receiptRoot: string;
  sessionExists(sessionId: string): boolean;
  eraseCredit(scope: 'selected' | 'all', sessionIds: readonly string[]): Promise<void>;
  eraseCheckpoints(root: string, sessionId: string): Promise<void>;
}

/** Complete or roll back interrupted erasures before runtime producers and
 * HTTP readiness are enabled. Any unreconciled receipt fails startup closed. */
export async function recoverInterruptedSessionErasures(
  dependencies?: SessionErasureStartupRecoveryDependencies,
): Promise<number> {
  const deps: SessionErasureStartupRecoveryDependencies = dependencies ?? {
    receiptRoot: PROJECT_ROOT,
    sessionExists: (sessionId) =>
      Boolean(getDb().query('SELECT 1 FROM sessions WHERE id = ?').get(sessionId)),
    eraseCredit: async (scope, sessionIds) => {
      eraseCreditUsageTransaction(
        getCreditDb(),
        scope === 'all' ? { kind: 'all' } : { kind: 'selected', sessionIds },
      );
    },
    eraseCheckpoints: async (root, sessionId) => {
      if (!existsSync(join(root, '.git'))) return;
      await new CheckpointStore(root).eraseSession(sessionId);
    },
  };
  const results = await recoverSessionFileErasures({
    receiptRoot: deps.receiptRoot,
    sessionExists: deps.sessionExists,
    eraseCredit: deps.eraseCredit,
    eraseCheckpoints: deps.eraseCheckpoints,
  });
  const failed = results.filter((result) => result.action === 'failed');
  if (failed.length > 0) {
    throw new KoryphaiosError(
      `Startup refused with ${failed.length} unreconciled session-erasure receipt(s).`,
      'SESSION_ERASURE_RECOVERY_REQUIRED',
      503,
      true,
      { operationIds: failed.map((result) => result.operationId) },
    );
  }
  return results.length;
}

let deleteAllInProgress = false;
let sessionCreationsInFlight = 0;

/** Prevent delete-all from racing a session INSERT before its inventory pass. */
export function tryAcquireSessionCreationLease(): { release(): void } | null {
  if (deleteAllInProgress) return null;
  sessionCreationsInFlight++;
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      sessionCreationsInFlight = Math.max(0, sessionCreationsInFlight - 1);
    },
  };
}

function acquireDeleteAllLease(): { release(): void } | null {
  if (deleteAllInProgress || sessionCreationsInFlight > 0) return null;
  deleteAllInProgress = true;
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      deleteAllInProgress = false;
    },
  };
}

function productionDependencies(): SessionErasureDependencies {
  const { sessions, kory, goalDriver, wsManager } = getContext();
  const archive = getContextArchive();
  if (!archive) throw new Error('Context archive is unavailable; session erasure refused');
  return {
    getSession: (id) => sessions.get(id),
    // Permanent delete-all must inventory active and archived chats alike so
    // archived project roots, receipts, counts, and lifecycle broadcasts are
    // never silently omitted by the normal active-chat view.
    listSessions: () => sessions.listAll(),
    inventorySessionIds: () => inventorySessionIdsForErasure(getDb()),
    getTrackedProcessSessionIds: () => processSupervisor.getTrackedSessionIds(),
    tryAcquireProcessBarrier: (id) => processSupervisor.tryAcquireSessionErasureBarrier(id),
    tryAcquireManagerBarrier: (id) => kory.tryBeginSessionErasure(id),
    tryAcquireGoalBarrier: (id) => goalDriver.tryBeginSessionErasure(id),
    terminateProcesses: (id) => processSupervisor.terminateProcessesForSession(id),
    completeProcessErasure: (id) => processSupervisor.completeSessionErasure(id),
    archive,
    stageFiles: (input) => stageSessionFilesForErasure(input),
    eraseDatabase: (scope) => eraseSessionDataTransaction(getDb(), scope),
    eraseCredit: (scope) => {
      eraseCreditUsageTransaction(getCreditDb(), scope);
    },
    eraseCheckpoints: async (root, sessionId) => {
      if (!existsSync(join(root, '.git'))) return;
      await new CheckpointStore(root).eraseSession(sessionId);
    },
    revokeBridgeGrants: (sessionId) => revokeKoryBridgeGrantsForSession(sessionId),
    wsManager,
    receiptRoot: PROJECT_ROOT,
  };
}

/**
 * Fail-closed session erasure coordinator. Reversible filesystem moves and
 * producer barriers precede the SQLite commit. Git/shadow cleanup follows the
 * commit under a durable receipt and is retried after restart if interrupted.
 */
export async function eraseSessionsCoordinated(
  scope: CoordinatedSessionErasureScope,
  dependencies?: SessionErasureDependencies,
): Promise<CoordinatedSessionErasureResult> {
  const deps = dependencies ?? productionDependencies();
  const deleteAllLease = scope.kind === 'all' ? acquireDeleteAllLease() : null;
  if (scope.kind === 'all' && !deleteAllLease) {
    throw new ConflictError('Wait for session creation or another delete-all operation to finish.');
  }
  try {
    return await eraseSessionsCoordinatedWithLease(scope, deps);
  } finally {
    deleteAllLease?.release();
  }
}

async function eraseSessionsCoordinatedWithLease(
  scope: CoordinatedSessionErasureScope,
  deps: SessionErasureDependencies,
): Promise<CoordinatedSessionErasureResult> {
  const sessions =
    scope.kind === 'selected'
      ? await (async () => {
          const session = await deps.getSession(scope.sessionId);
          if (!session) throw new NotFoundError('Session', scope.sessionId);
          return [session];
        })()
      : await deps.listSessions();
  const ids = new Set(
    scope.kind === 'selected'
      ? [scope.sessionId]
      : [
          ...sessions.map((session) => session.id),
          ...deps.inventorySessionIds(),
          ...deps.getTrackedProcessSessionIds(),
        ],
  );
  const projectRoots = new Set([
    deps.receiptRoot,
    ...sessions
      .map((session) => session.workingDirectory?.trim())
      .filter((dir): dir is string => !!dir && existsSync(dir)),
  ]);
  const processLeases = new Map<string, SessionErasureBarrierLease>();
  const managerLeases = new Map<string, ManagerSessionErasureLease>();
  const goalLeases = new Map<string, GoalSessionErasureLease>();
  const archived = new Set<string>();
  let fileLease: FileErasureLease | undefined;
  let databaseCommitted = false;
  const wsTombstones = new Set<string>();
  const goalTombstones = new Set<string>();
  const managerTombstones = new Set<string>();
  const processTombstones = new Set<string>();
  const archiveTombstones = new Set<string>();
  const revokedGrantSessions = new Set<string>();

  const acquireBoundaries = (sessionId: string) => {
    if (processLeases.has(sessionId)) return;
    const processLease = deps.tryAcquireProcessBarrier(sessionId);
    if (!processLease) {
      throw new ConflictError(
        `Session ${sessionId} has a process start in flight; retry deletion after it settles.`,
      );
    }
    processLeases.set(sessionId, processLease);
    const managerLease = deps.tryAcquireManagerBarrier(sessionId);
    if (!managerLease) {
      throw new ConflictError(
        `Session ${sessionId} is already mutating or being erased; retry after it settles.`,
      );
    }
    managerLeases.set(sessionId, managerLease);
    const goalLease = deps.tryAcquireGoalBarrier(sessionId);
    if (!goalLease) {
      throw new ConflictError(`Session ${sessionId} already has Goal erasure in progress.`);
    }
    goalLeases.set(sessionId, goalLease);
    deps.archive.beginSessionErasure(sessionId);
    archived.add(sessionId);
    deps.revokeBridgeGrants(sessionId);
    revokedGrantSessions.add(sessionId);
  };

  const installLiveTombstones = () => {
    const errors: unknown[] = [];
    for (const sessionId of ids) {
      const attempt = (completed: Set<string>, action: () => void) => {
        if (completed.has(sessionId)) return;
        try {
          action();
          completed.add(sessionId);
        } catch (error) {
          errors.push(error);
        }
      };
      attempt(wsTombstones, () => deps.wsManager.forgetSession(sessionId));
      attempt(goalTombstones, () => goalLeases.get(sessionId)?.complete());
      attempt(managerTombstones, () => managerLeases.get(sessionId)?.complete());
      attempt(processTombstones, () => deps.completeProcessErasure(sessionId));
      if (archived.has(sessionId)) {
        attempt(archiveTombstones, () => deps.archive.completeSessionErasure(sessionId));
      }
      attempt(revokedGrantSessions, () => deps.revokeBridgeGrants(sessionId));
    }
    if (errors.length > 0) throw new AggregateError(errors, 'One or more live tombstones failed');
  };

  try {
    for (const sessionId of ids) acquireBoundaries(sessionId);
    await Promise.all([
      ...Array.from(managerLeases.values(), (lease) => lease.waitForIdle()),
      ...Array.from(goalLeases.values(), (lease) => lease.waitForIdle()),
    ]);
    await Promise.all(Array.from(ids, (sessionId) => deps.terminateProcesses(sessionId)));

    fileLease = deps.stageFiles({
      receiptRoot: deps.receiptRoot,
      projectRoots: [...projectRoots],
      sessionIds: [...ids],
      scope: scope.kind,
    });
    // Delete-all may discover orphan filesystem namespaces that have no DB
    // row. Tombstone those identifiers before the database commit too.
    for (const sessionId of fileLease.sessionIds) {
      if (!ids.has(sessionId)) {
        ids.add(sessionId);
        acquireBoundaries(sessionId);
        await managerLeases.get(sessionId)!.waitForIdle();
        await goalLeases.get(sessionId)!.waitForIdle();
        await deps.terminateProcesses(sessionId);
      }
    }

    fileLease.markDatabaseCommitStarted();
    const databaseScope: SessionErasureScope =
      scope.kind === 'all' ? { kind: 'all' } : { kind: 'selected', sessionIds: [...ids] };
    const report = deps.eraseDatabase(databaseScope);
    databaseCommitted = true;
    fileLease.markDatabaseCommitted();

    // From this point onward, stale producers and WS publications must be
    // rejected even if checkpoint/file finalization needs restart recovery.
    installLiveTombstones();
    deps.eraseCredit(databaseScope);
    for (const root of fileLease.projectRoots) {
      for (const sessionId of fileLease.sessionIds) {
        await deps.eraseCheckpoints(root, sessionId);
      }
    }
    fileLease.finalize();

    for (const session of sessions) {
      deps.wsManager.broadcastEphemeral({
        type: 'session.deleted',
        payload: { sessionId: session.id },
        timestamp: Date.now(),
      });
    }
    return { operationId: fileLease.operationId, deleted: sessions.length, report };
  } catch (error) {
    if (databaseCommitted) {
      let tombstoneError: unknown;
      try {
        installLiveTombstones();
      } catch (installError) {
        tombstoneError = installError;
      }
      const partialCause = tombstoneError
        ? new AggregateError([error, tombstoneError], 'Post-commit cleanup and tombstoning failed')
        : error;
      try {
        fileLease?.recordPartial(partialCause);
      } catch (receiptError) {
        serverLog.error({ receiptError }, 'Failed to update the session erasure recovery receipt');
      }
      const operationId = fileLease?.operationId ?? crypto.randomUUID();
      const receiptPath = fileLease?.recoveryReceiptPath ?? 'unavailable';
      serverLog.error(
        { error: partialCause, operationId, receiptPath },
        'Session erasure committed with incomplete post-commit cleanup',
      );
      throw new SessionErasurePartialError(operationId, receiptPath, partialCause);
    }

    const rollbackErrors: unknown[] = [];
    if (fileLease) {
      try {
        fileLease.rollback();
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    for (const sessionId of archived) deps.archive.cancelSessionErasure(sessionId);
    for (const lease of managerLeases.values()) lease.rollback();
    for (const lease of goalLeases.values()) {
      try {
        await lease.rollback();
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new KoryphaiosError(
        'Session deletion was not committed, but lifecycle/file rollback needs recovery.',
        'SESSION_ERASURE_ROLLBACK_INCOMPLETE',
        500,
        true,
        { recoveryReceiptPath: fileLease?.recoveryReceiptPath },
      );
    }
    throw error;
  } finally {
    for (const lease of processLeases.values()) lease.release();
  }
}
