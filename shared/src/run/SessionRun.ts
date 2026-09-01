/**
 * Authoritative session-run lifecycle contract.
 *
 * A run is a durable aggregate, not a conclusion inferred from stream chunks.
 * Every mutation advances `revision`; consumers may therefore reject stale or
 * duplicate projections without guessing from transport order.
 */

export const SESSION_RUN_ACTIVE_PHASES = [
  'analyzing',
  'thinking',
  'streaming',
  'tool_calling',
  'compacting',
] as const;

export const SESSION_RUN_WAITING_PHASES = ['waiting_terminal', 'waiting_user'] as const;
export const SESSION_RUN_TERMINAL_PHASES = ['done', 'error', 'cancelled'] as const;

export type SessionRunActivePhase = (typeof SESSION_RUN_ACTIVE_PHASES)[number];
export type SessionRunWaitingPhase = (typeof SESSION_RUN_WAITING_PHASES)[number];
export type SessionRunTerminalPhase = (typeof SESSION_RUN_TERMINAL_PHASES)[number];
export type SessionRunPhase =
  'idle' | SessionRunActivePhase | SessionRunWaitingPhase | SessionRunTerminalPhase;
export type SessionRunStatus = 'idle' | 'active' | 'waiting' | 'terminal';

export interface SessionRunSnapshot {
  sessionId: string;
  runId: string | null;
  revision: number;
  phase: SessionRunPhase;
  status: SessionRunStatus;
  waitingReason: string;
  /** Durable continuation that alone is allowed to resume a waiting run. */
  continuationId: string | null;
  activeAgentIds: string[];
  startedAt: number | null;
  updatedAt: number;
  finishedAt: number | null;
  terminalReason: string | null;
}

export type SessionRunCommand =
  | { kind: 'start'; runId: string; reason?: string; activeAgentIds?: string[] }
  | {
      kind: 'phase';
      expectedRunId: string;
      expectedRevision: number;
      phase: SessionRunActivePhase;
      activeAgentIds?: string[];
      reason?: string;
    }
  | {
      kind: 'wait';
      expectedRunId: string;
      expectedRevision: number;
      phase: SessionRunWaitingPhase;
      reason: string;
      continuationId: string;
      activeAgentIds?: string[];
    }
  | {
      kind: 'resume';
      expectedRunId: string;
      expectedRevision: number;
      expectedWaitingPhase: SessionRunWaitingPhase;
      phase?: SessionRunActivePhase;
      activeAgentIds?: string[];
      reason?: string;
    }
  | { kind: 'complete'; expectedRunId: string; expectedRevision: number; reason?: string }
  | { kind: 'fail'; expectedRunId: string; expectedRevision: number; reason: string }
  | { kind: 'cancel'; expectedRunId: string; expectedRevision: number; reason?: string };

export interface SessionRunTransition {
  eventId: string;
  sessionId: string;
  runId: string | null;
  revision: number;
  command: SessionRunCommand['kind'];
  previousPhase: SessionRunPhase;
  phase: SessionRunPhase;
  reason: string | null;
  occurredAt: number;
}

export interface SessionRunStatePayload {
  snapshot: SessionRunSnapshot;
  transition: SessionRunTransition | null;
}

export class SessionRunTransitionError extends Error {
  constructor(
    message: string,
    readonly code:
      'RUN_ALREADY_ACTIVE' | 'RUN_NOT_ACTIVE' | 'STALE_RUN' | 'STALE_REVISION' | 'INVALID_PHASE',
  ) {
    super(message);
    this.name = 'SessionRunTransitionError';
  }
}

export function sessionRunStatusForPhase(phase: SessionRunPhase): SessionRunStatus {
  if (phase === 'idle') return 'idle';
  if ((SESSION_RUN_ACTIVE_PHASES as readonly string[]).includes(phase)) return 'active';
  if ((SESSION_RUN_WAITING_PHASES as readonly string[]).includes(phase)) return 'waiting';
  return 'terminal';
}

export function createIdleSessionRun(sessionId: string, now = Date.now()): SessionRunSnapshot {
  return {
    sessionId,
    runId: null,
    revision: 0,
    phase: 'idle',
    status: 'idle',
    waitingReason: '',
    continuationId: null,
    activeAgentIds: [],
    startedAt: null,
    updatedAt: now,
    finishedAt: null,
    terminalReason: null,
  };
}

function assertExpectedRun(
  current: SessionRunSnapshot,
  expectedRunId: string,
  expectedRevision: number,
): void {
  if (current.runId !== expectedRunId) {
    throw new SessionRunTransitionError(
      `Stale run transition for ${current.sessionId}: expected ${expectedRunId}, current ${current.runId ?? 'none'}`,
      'STALE_RUN',
    );
  }
  if (current.revision !== expectedRevision) {
    throw new SessionRunTransitionError(
      `Stale run revision for ${current.sessionId}: expected ${expectedRevision}, current ${current.revision}`,
      'STALE_REVISION',
    );
  }
}

function normalizeAgents(agentIds: string[] | undefined, fallback: string[]): string[] {
  return [...new Set(agentIds ?? fallback)].filter(Boolean).sort();
}

/** Pure aggregate reducer. Persistence and publication live outside this file. */
export function reduceSessionRun(
  current: SessionRunSnapshot,
  command: SessionRunCommand,
  now = Date.now(),
): SessionRunSnapshot {
  if (command.kind === 'start') {
    if (current.status === 'active' || current.status === 'waiting') {
      throw new SessionRunTransitionError(
        `Session ${current.sessionId} already has live run ${current.runId}`,
        'RUN_ALREADY_ACTIVE',
      );
    }
    return {
      sessionId: current.sessionId,
      runId: command.runId,
      revision: current.revision + 1,
      phase: 'analyzing',
      status: 'active',
      waitingReason: '',
      continuationId: null,
      activeAgentIds: normalizeAgents(command.activeAgentIds, ['kory-manager']),
      startedAt: now,
      updatedAt: now,
      finishedAt: null,
      terminalReason: null,
    };
  }

  assertExpectedRun(current, command.expectedRunId, command.expectedRevision);
  if (current.status === 'terminal' || current.status === 'idle') {
    throw new SessionRunTransitionError(
      `Run ${command.expectedRunId} is already ${current.phase}`,
      'RUN_NOT_ACTIVE',
    );
  }

  const base = {
    ...current,
    revision: current.revision + 1,
    updatedAt: now,
  };

  switch (command.kind) {
    case 'phase': {
      if (current.status !== 'active') {
        throw new SessionRunTransitionError(
          `Run ${command.expectedRunId} cannot enter ${command.phase} from ${current.phase}`,
          'INVALID_PHASE',
        );
      }
      return {
        ...base,
        phase: command.phase,
        status: 'active',
        waitingReason: '',
        continuationId: null,
        activeAgentIds: normalizeAgents(command.activeAgentIds, current.activeAgentIds),
      };
    }
    case 'wait': {
      if (current.status !== 'active') {
        throw new SessionRunTransitionError(
          `Run ${command.expectedRunId} cannot wait from ${current.phase}`,
          'INVALID_PHASE',
        );
      }
      return {
        ...base,
        phase: command.phase,
        status: 'waiting',
        waitingReason: command.reason,
        continuationId: command.continuationId,
        activeAgentIds: normalizeAgents(command.activeAgentIds, []),
      };
    }
    case 'resume': {
      if (current.status !== 'waiting' || current.phase !== command.expectedWaitingPhase) {
        throw new SessionRunTransitionError(
          `Run ${command.expectedRunId} expected ${command.expectedWaitingPhase}, current ${current.phase}`,
          'INVALID_PHASE',
        );
      }
      return {
        ...base,
        phase: command.phase ?? 'analyzing',
        status: 'active',
        waitingReason: '',
        continuationId: null,
        activeAgentIds: normalizeAgents(command.activeAgentIds, ['kory-manager']),
      };
    }
    case 'complete':
      return {
        ...base,
        phase: 'done',
        status: 'terminal',
        waitingReason: '',
        continuationId: null,
        activeAgentIds: [],
        finishedAt: now,
        terminalReason: command.reason ?? 'completed',
      };
    case 'fail':
      return {
        ...base,
        phase: 'error',
        status: 'terminal',
        waitingReason: '',
        continuationId: null,
        activeAgentIds: [],
        finishedAt: now,
        terminalReason: command.reason,
      };
    case 'cancel':
      return {
        ...base,
        phase: 'cancelled',
        status: 'terminal',
        waitingReason: '',
        continuationId: null,
        activeAgentIds: [],
        finishedAt: now,
        terminalReason: command.reason ?? 'cancelled_by_user',
      };
  }
}
