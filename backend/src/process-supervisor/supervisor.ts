/**
 * Process Supervisor
 */

import { nanoid } from 'nanoid';
import { readFileSync, readlinkSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { serverLog } from '../logger';
import { requireBash } from '../runtime/shell';
import { getSafeSubprocessEnv } from '../runtime/safe-env';
import { redactSecretsInText } from '../security';
import {
  isAgentBackgroundProcess,
  type ProcessClassification,
  type ProcessProvenance,
  type ProcessStatus,
  type ProcessSupervision,
  type ProcessTerminalReason,
} from '@koryphaios/shared';
import {
  initProcessSupervisorTables,
  persistProcess,
  updateProcessStatus,
  incrementRestartCount,
  getProcessById,
  getActiveProcessesStrict,
  getProcessesBySession,
  cleanupOldProcesses,
  logProcessEvent,
  updateHealthCheck,
  preparePersistedProcessCommand,
  type PersistedProcess,
} from './database';

export interface SubprocessLike {
  pid: number;
  exited: Promise<number>;
  kill?(signal?: string | number): void | boolean;
  stdin: unknown;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
}

export interface SupervisedProcess extends PersistedProcess {
  proc?: SubprocessLike;
  stdout: string;
  stderr: string;
  lastOutputAt: number;
  /** True only after restart recovery revalidated the persisted PID's command
   * and cwd. Proc-less recovered entries with false ownership stay in the
   * authoritative map, but must never be signalled because the PID may have
   * been reused by an unrelated process. */
  recoveredOwnershipVerified?: boolean;
  recoveredFromBackendRestart?: boolean;
  stdoutDrain?: Promise<void>;
  stderrDrain?: Promise<void>;
  terminalEventEmitted?: boolean;
  /** A child was created, but its running state could not be persisted. */
  spawnFailureError?: string;
  requestedTerminalReason?: Extract<
    ProcessTerminalReason,
    'killed-by-user' | 'killed-for-restart' | 'session-cancelled'
  >;
  healthCheckTimer?: Timer;
  restartTimer?: Timer;
  /** Coalesces concurrent user/session cancellation requests. The process
   * remains in the authoritative live map until this promise has verified the
   * owned process group exited and the durable terminal transition published. */
  terminationPromise?: Promise<boolean>;
  /** Bun reports the shell leader independently from descendants in the
   * detached POSIX process group. Do not publish a terminal outcome merely
   * because this leader exited. */
  leaderExited?: boolean;
  leaderExitCode?: number;
  leaderExitError?: string;
  /** Coalesces the Bun exit callback, health reconciliation, and explicit
   * cancellation onto one durable terminal publication. */
  exitFinalizationPromise?: Promise<void>;
  /** Prevent repeated degraded events if group liveness becomes unknowable. */
  groupLivenessDegraded?: boolean;
  /** POSIX process-group ids are reusable. Once absence is observed after the
   * leader exits, this generation is irreversibly gone; a later group with
   * the same numeric id is unrelated and must never be signalled. */
  ownedGroupObservedGone?: boolean;
}

type ProcessGroupState = 'alive' | 'gone' | 'unknown';

type ProcessSpawner = (command: string[], options: Record<string, unknown>) => SubprocessLike;

export interface SupervisorConfig {
  maxRestarts: number;
  restartDelayMs: number;
  healthCheckIntervalMs: number;
  maxConsecutiveFailures: number;
  orphanCheckOnStartup: boolean;
  logRetentionDays: number;
  /** Grace after TERM before an owned process group is escalated to KILL. */
  terminationGraceMs: number;
  /** Bounded time to verify process-group reap and terminal publication. */
  killReapTimeoutMs: number;
  /** Deterministic spawn-failure injection for focused tests. */
  spawnProcess?: ProcessSpawner;
}

export function shouldKillRecoveredProcess(
  persisted: Pick<PersistedProcess, 'pid' | 'command' | 'cwd'>,
  observed: { cmdline: string; cwd: string } | null,
  protectedPids: ReadonlySet<number>,
): boolean {
  if (persisted.pid <= 1 || protectedPids.has(persisted.pid) || !observed) return false;
  if (resolve(observed.cwd) !== resolve(persisted.cwd)) return false;
  const expectedBinary = basename(persisted.command.trim().split(/\s+/)[0] ?? '');
  if (!expectedBinary) return false;
  return observed.cmdline.split('\0').some((part) => basename(part) === expectedBinary);
}

function protectedProcessPids(): Set<number> {
  const protectedPids = new Set<number>([process.pid]);
  let pid = process.ppid;
  while (pid > 1 && !protectedPids.has(pid)) {
    protectedPids.add(pid);
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      pid = Number(stat.slice(close + 2).split(' ')[1] ?? 0);
    } catch {
      break;
    }
  }
  return protectedPids;
}

function observeProcess(pid: number): { cmdline: string; cwd: string } | null {
  if (process.platform !== 'linux') return null;
  try {
    return {
      cmdline: readFileSync(`/proc/${pid}/cmdline`, 'utf8'),
      cwd: readlinkSync(`/proc/${pid}/cwd`),
    };
  } catch {
    return null;
  }
}

const DEFAULT_CONFIG: SupervisorConfig = {
  maxRestarts: 3,
  restartDelayMs: 5000,
  healthCheckIntervalMs: 30000,
  maxConsecutiveFailures: 3,
  orphanCheckOnStartup: true,
  logRetentionDays: 7,
  terminationGraceMs: 1_500,
  killReapTimeoutMs: 1_500,
};

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

export interface ProcessLifecycleEvent {
  type: 'started' | 'exited' | 'degraded';
  id: string;
  name: string;
  command: string;
  sessionId?: string;
  pid?: number;
  exitCode?: number;
  status: ProcessStatus | 'degraded';
  provenance: ProcessProvenance;
  supervision: ProcessSupervision;
  isBackground: boolean;
  terminalReason?: ProcessTerminalReason;
  terminalError?: string;
  willRestart?: boolean;
  logsTail?: string;
  recovered?: boolean;
}

export interface StartProcessOptions {
  name: string;
  command: string;
  cwd?: string;
  sessionId: string;
  restartPolicy?: PersistedProcess['restartPolicy'];
  maxRestarts?: number;
  metadata?: Record<string, unknown>;
}

export interface AgentToolBarrierLease {
  release(): void;
}

export interface SessionErasureBarrierLease {
  release(): void;
}

export class ProcessSupervisor {
  private static instance: ProcessSupervisor;
  private config: SupervisorConfig;
  private processes = new Map<string, SupervisedProcess>();
  private isRunning = false;
  private initializationPromise?: Promise<void>;
  private cleanupTimer?: Timer;
  private readonly MAX_LOG_SIZE = 100_000;
  private readonly spawnProcess: ProcessSpawner;
  private readonly agentToolBarriers = new Map<string, symbol>();
  private readonly agentStartsInFlight = new Map<string, number>();
  private readonly sessionErasureBarriers = new Map<string, symbol>();
  private readonly sessionStartsInFlight = new Map<string, number>();
  private readonly erasedSessions = new Set<string>();

  private constructor(config: Partial<SupervisorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.spawnProcess =
      config.spawnProcess ??
      ((command, options) =>
        Bun.spawn(
          command,
          options as unknown as Bun.SpawnOptions.SpawnOptions<
            Bun.SpawnOptions.Writable,
            'pipe',
            'pipe'
          >,
        ));
  }

  static getInstance(config?: Partial<SupervisorConfig>): ProcessSupervisor {
    if (!ProcessSupervisor.instance) ProcessSupervisor.instance = new ProcessSupervisor(config);
    return ProcessSupervisor.instance;
  }

  // ── Lifecycle listeners ────────────────────────────────────────────────
  // The manager subscribes to surface background terminals in chat and to
  // wake the agent when a process it was waiting on finishes.
  private lifecycleListeners: Array<(e: ProcessLifecycleEvent) => void> = [];

  onLifecycle(cb: (e: ProcessLifecycleEvent) => void): () => void {
    this.lifecycleListeners.push(cb);
    return () => {
      const index = this.lifecycleListeners.indexOf(cb);
      if (index >= 0) this.lifecycleListeners.splice(index, 1);
    };
  }

  private emitLifecycle(e: ProcessLifecycleEvent): void {
    for (const cb of this.lifecycleListeners) {
      try {
        cb(e);
      } catch (err: unknown) {
        serverLog.debug(
          { err: err instanceof Error ? err.message : String(err) },
          'Process lifecycle listener threw',
        );
      }
    }
  }

  /** True only for an intentional, Kory-owned agent background process. */
  hasActiveAgentToolForSession(sessionId: string): boolean {
    if ((this.agentStartsInFlight.get(sessionId) ?? 0) > 0) return true;
    for (const p of this.processes.values()) {
      // Terminal processes are removed from this map unless an automatic
      // restart is pending, so the same predicate also covers restart gaps.
      if (p.sessionId === sessionId && isAgentBackgroundProcess(p)) {
        return true;
      }
    }
    return false;
  }

  hasAgentBackgroundProcessForSession(sessionId: string): boolean {
    return this.hasActiveAgentToolForSession(sessionId);
  }

  /** @deprecated Use hasAgentBackgroundProcessForSession for explicit semantics. */
  hasRunningForSession(sessionId: string): boolean {
    return this.hasActiveAgentToolForSession(sessionId);
  }

  /**
   * Atomically block new agent-tool processes while a workspace mutation such
   * as Time Travel is in progress. A synchronous token plus in-flight-start
   * count closes the gap before async persistence/spawn reaches the live map.
   */
  tryAcquireAgentToolBarrier(sessionId: string): AgentToolBarrierLease | null {
    if (
      !this.isRunning ||
      this.agentToolBarriers.has(sessionId) ||
      this.hasActiveAgentToolForSession(sessionId)
    ) {
      return null;
    }
    const token = Symbol(sessionId);
    this.agentToolBarriers.set(sessionId, token);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        if (this.agentToolBarriers.get(sessionId) === token) {
          this.agentToolBarriers.delete(sessionId);
        }
      },
    };
  }

  /** Block every process provenance while a chat's durable state is erased. */
  tryAcquireSessionErasureBarrier(sessionId: string): SessionErasureBarrierLease | null {
    if (
      !this.isRunning ||
      this.erasedSessions.has(sessionId) ||
      this.sessionErasureBarriers.has(sessionId) ||
      (this.sessionStartsInFlight.get(sessionId) ?? 0) > 0
    ) {
      return null;
    }
    const token = Symbol(sessionId);
    this.sessionErasureBarriers.set(sessionId, token);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        if (this.sessionErasureBarriers.get(sessionId) === token) {
          this.sessionErasureBarriers.delete(sessionId);
        }
      },
    };
  }

  completeSessionErasure(sessionId: string): void {
    this.erasedSessions.add(sessionId);
  }

  /** Include orphan live sessions in delete-all coordination before their
   * durable rows are removed. */
  getTrackedSessionIds(): string[] {
    return [
      ...new Set(
        Array.from(this.processes.values(), (process) => process.sessionId).filter(
          (sessionId): sessionId is string => typeof sessionId === 'string' && sessionId.length > 0,
        ),
      ),
    ];
  }

  async initialize(): Promise<void> {
    if (this.isRunning) return;
    if (this.initializationPromise) return this.initializationPromise;
    const pending = this.initializeOnce();
    this.initializationPromise = pending;
    try {
      await pending;
    } finally {
      if (this.initializationPromise === pending) this.initializationPromise = undefined;
    }
  }

  private async initializeOnce(): Promise<void> {
    initProcessSupervisorTables();
    await cleanupOldProcesses(this.config.logRetentionDays);
    if (this.config.orphanCheckOnStartup) await this.cleanupOrphans();
    this.cleanupTimer = setInterval(
      () => cleanupOldProcesses(this.config.logRetentionDays),
      3600000,
    );
    this.isRunning = true;
  }

  /** Manual/API services are never allowed to masquerade as agent work. */
  async startProcess(options: StartProcessOptions): Promise<SupervisedProcess> {
    return this.startClassifiedProcessWithGuard(options, {
      provenance: 'manual-service',
      supervision: 'owned-child',
      isBackground: true,
    });
  }

  async startManualProcess(options: StartProcessOptions): Promise<SupervisedProcess> {
    return this.startProcess(options);
  }

  /** Only the agent Bash tool may enter the wait/wake/Monitoring contract. */
  async startAgentBackgroundProcess(options: StartProcessOptions): Promise<SupervisedProcess> {
    return this.startClassifiedProcessWithGuard(options, {
      provenance: 'agent-tool',
      supervision: 'owned-child',
      isBackground: true,
    });
  }

  private async startClassifiedProcessWithGuard(
    options: StartProcessOptions,
    classification: ProcessClassification,
    prior?: PersistedProcess,
  ): Promise<SupervisedProcess> {
    if (
      this.erasedSessions.has(options.sessionId) ||
      this.sessionErasureBarriers.has(options.sessionId)
    ) {
      throw new Error('Process start blocked because this session is being deleted');
    }
    const agentOwned = isAgentBackgroundProcess(classification);
    if (agentOwned && this.agentToolBarriers.has(options.sessionId)) {
      throw new Error('Agent background process start blocked by an active workspace barrier');
    }
    this.sessionStartsInFlight.set(
      options.sessionId,
      (this.sessionStartsInFlight.get(options.sessionId) ?? 0) + 1,
    );
    if (agentOwned) {
      this.agentStartsInFlight.set(
        options.sessionId,
        (this.agentStartsInFlight.get(options.sessionId) ?? 0) + 1,
      );
    }
    let released = false;
    const releaseInFlight = () => {
      if (released) return;
      released = true;
      const allRemaining = (this.sessionStartsInFlight.get(options.sessionId) ?? 1) - 1;
      if (allRemaining > 0) this.sessionStartsInFlight.set(options.sessionId, allRemaining);
      else this.sessionStartsInFlight.delete(options.sessionId);
      if (agentOwned) {
        const agentRemaining = (this.agentStartsInFlight.get(options.sessionId) ?? 1) - 1;
        if (agentRemaining > 0) this.agentStartsInFlight.set(options.sessionId, agentRemaining);
        else this.agentStartsInFlight.delete(options.sessionId);
      }
    };
    try {
      return await this.startClassifiedProcess(options, classification, prior, releaseInFlight);
    } finally {
      releaseInFlight();
    }
  }

  private async startClassifiedProcess(
    options: StartProcessOptions,
    classification: ProcessClassification,
    prior?: PersistedProcess,
    beforeSpawnFailureEvent?: () => void,
  ): Promise<SupervisedProcess> {
    if (!this.isRunning) {
      throw new Error('Process supervisor is not initialized; process start refused');
    }
    const id = prior?.id ?? nanoid(12);
    const now = Date.now();
    const commandReplayable = preparePersistedProcessCommand(options.command).replayable;
    const persisted: PersistedProcess = {
      id,
      name: options.name,
      command: options.command,
      commandReplayable,
      cwd: options.cwd ?? process.cwd(),
      pid: 0,
      sessionId: options.sessionId,
      status: 'starting',
      ...classification,
      restartCount: prior?.restartCount ?? 0,
      maxRestarts: options.maxRestarts ?? this.config.maxRestarts,
      restartPolicy: options.restartPolicy ?? 'on-failure',
      createdAt: prior?.createdAt ?? now,
      updatedAt: now,
      metadata: options.metadata ? JSON.stringify(options.metadata) : undefined,
    };
    try {
      await persistProcess(persisted);
      await logProcessEvent(id, prior ? 'restart_requested' : 'start_requested', {
        command: options.command,
        provenance: classification.provenance,
        supervision: classification.supervision,
        isBackground: classification.isBackground,
      });
    } catch (error) {
      await this.recordSpawnFailure(
        persisted,
        classification,
        new Error(`Failed to initialize process supervision: ${this.sanitizeTerminalError(error)}`),
        beforeSpawnFailureEvent,
      );
      throw error;
    }

    let proc: SubprocessLike | undefined;
    try {
      const shell = requireBash();
      proc = this.spawnProcess([shell.command, ...shell.args, options.command], {
        cwd: persisted.cwd,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        // Agent tools receive only the safe subprocess allowlist. Manual/API
        // services retain their existing explicitly authorized host-env
        // contract and are never classified as agent background work.
        ...(isAgentBackgroundProcess(classification) && { env: getSafeSubprocessEnv() }),
        // Own a process group on POSIX so cancellation and failure cleanup do
        // not leave grandchildren (watchers, dev servers, pipelines) alive.
        detached: process.platform !== 'win32',
      });
      if (!proc || typeof proc.pid !== 'number' || !proc.exited) {
        throw new Error('Process spawner returned no usable child handle');
      }
    } catch (error) {
      await this.recordSpawnFailure(persisted, classification, error, beforeSpawnFailureEvent);
      throw error;
    }

    persisted.pid = proc.pid;
    persisted.status = 'running';
    persisted.updatedAt = Date.now();
    const supervised: SupervisedProcess = {
      ...persisted,
      proc,
      stdout: '',
      stderr: '',
      lastOutputAt: now,
    };
    // Close the pre-persistence race: once an OS child exists it belongs in
    // the authoritative live map, even if the running-state write fails.
    this.processes.set(id, supervised);
    supervised.stdoutDrain = this.readStream(proc.stdout.getReader(), id, 'stdout');
    supervised.stderrDrain = this.readStream(proc.stderr.getReader(), id, 'stderr');
    try {
      await persistProcess(persisted);
    } catch (error) {
      await this.abortSpawnedProcessAfterPersistenceFailure(
        supervised,
        classification,
        error,
        beforeSpawnFailureEvent,
      );
      throw error;
    }
    this.emitLifecycle({
      type: 'started',
      id,
      name: supervised.name,
      command: supervised.command,
      sessionId: supervised.sessionId,
      pid: supervised.pid,
      status: 'running',
      ...classification,
    });
    this.monitorExit(supervised);
    this.startHealthChecks(id);
    return supervised;
  }

  /**
   * Track a background command started by an agentic CLI harness (e.g. Claude
   * Code's native background Bash). We did not spawn it and have no pid/exit
   * handle, so persist an explicit detached outcome. Quiet output must never
   * be presented as authoritative completion.
   */
  async registerExternal(options: {
    name: string;
    command: string;
    sessionId: string;
    outputFile?: string;
  }): Promise<string> {
    if (
      this.erasedSessions.has(options.sessionId) ||
      this.sessionErasureBarriers.has(options.sessionId)
    ) {
      throw new Error('Process registration blocked because this session is being deleted');
    }
    this.sessionStartsInFlight.set(
      options.sessionId,
      (this.sessionStartsInFlight.get(options.sessionId) ?? 0) + 1,
    );
    try {
    const id = `ext-${nanoid(10)}`;
    const now = Date.now();
    const classification: ProcessClassification = {
      provenance: 'agent-external-cli',
      supervision: 'external-detached',
      isBackground: true,
    };
    const persisted: PersistedProcess = {
      id,
      name: options.name,
      command: options.command,
      commandReplayable: preparePersistedProcessCommand(options.command).replayable,
      cwd: process.cwd(),
      pid: 0,
      sessionId: options.sessionId,
      status: 'detached',
      ...classification,
      terminalReason: 'external-handle-unavailable',
      restartCount: 0,
      maxRestarts: 0,
      restartPolicy: 'never',
      createdAt: now,
      updatedAt: now,
      endedAt: now,
      metadata: JSON.stringify({ external: true, outputFile: options.outputFile }),
    };
    await persistProcess(persisted);
    await logProcessEvent(id, 'external_detached', {
      command: options.command,
      reason: 'No authoritative OS process handle was provided',
    });
    this.emitLifecycle({
      type: 'exited',
      id,
      name: persisted.name,
      command: persisted.command,
      sessionId: persisted.sessionId,
      pid: 0,
      status: 'detached',
      ...classification,
      terminalReason: 'external-handle-unavailable',
      willRestart: false,
    });
    return id;
    } finally {
      const remaining = (this.sessionStartsInFlight.get(options.sessionId) ?? 1) - 1;
      if (remaining > 0) this.sessionStartsInFlight.set(options.sessionId, remaining);
      else this.sessionStartsInFlight.delete(options.sessionId);
    }
  }

  async killProcess(
    id: string,
    signal: string = 'SIGTERM',
    terminalReason: Extract<
      ProcessTerminalReason,
      'killed-by-user' | 'killed-for-restart' | 'session-cancelled'
    > = 'killed-by-user',
  ): Promise<boolean> {
    const proc = this.processes.get(id);
    if (!proc) return false;
    if (proc.terminationPromise) return proc.terminationPromise;

    const pending = this.terminateOwnedProcess(proc, signal, terminalReason).finally(() => {
      if (proc.terminationPromise === pending) proc.terminationPromise = undefined;
    });
    proc.terminationPromise = pending;
    return pending;
  }

  /**
   * Terminate an owned child without creating an unsafe "dead in the UI, alive
   * in the workspace" gap. TERM is allowed a short grace period, then the
   * complete detached process group is KILLed. The live-map entry (and thus
   * the Time Travel barrier) is retained until both OS reap and durable
   * terminal publication are verified.
   */
  private async terminateOwnedProcess(
    proc: SupervisedProcess,
    signal: string,
    terminalReason: Extract<
      ProcessTerminalReason,
      'killed-by-user' | 'killed-for-restart' | 'session-cancelled'
    >,
  ): Promise<boolean> {
    try {
      if (proc.recoveredOwnershipVerified === false) {
        await this.publishUnverifiedTermination(
          proc,
          'Refusing to signal a recovered process whose OS identity could not be verified',
        );
        return false;
      }
      proc.signal = signal;
      proc.requestedTerminalReason ??= terminalReason;
      try {
        await logProcessEvent(proc.id, 'kill_requested', { signal, terminalReason });
      } catch (error) {
        serverLog.error(
          { processId: proc.id, error: this.sanitizeTerminalError(error) },
          'Failed to persist process kill request; continuing with cancellation',
        );
      }
      this.signalSupervisedProcess(proc, signal);

      const initialWait =
        signal === 'SIGKILL' ? this.config.killReapTimeoutMs : this.config.terminationGraceMs;
      let exit = await this.waitForOwnedProcessExit(proc, initialWait);

      if (!exit.verified && signal !== 'SIGKILL') {
        proc.signal = 'SIGKILL';
        try {
          await logProcessEvent(proc.id, 'kill_escalated', {
            fromSignal: signal,
            signal: 'SIGKILL',
            terminalReason: proc.requestedTerminalReason,
          });
        } catch (error) {
          serverLog.error(
            { processId: proc.id, error: this.sanitizeTerminalError(error) },
            'Failed to persist process kill escalation; continuing with SIGKILL',
          );
        }
        this.signalSupervisedProcess(proc, 'SIGKILL');
        exit = await this.waitForOwnedProcessExit(proc, this.config.killReapTimeoutMs);
      }

      if (!exit.verified) {
        await this.publishUnverifiedTermination(proc);
        return false;
      }

      // monitorExit observes the same promise, but explicitly trigger the
      // idempotent finalizer so killProcess does not return before persistence
      // and the active-map removal are complete.
      void this.handleProcessExit(proc, exit.code, exit.error).catch((error: unknown) => {
        serverLog.error(
          { processId: proc.id, error: this.sanitizeTerminalError(error) },
          'Failed to publish verified process termination',
        );
      });
      const publicationDeadline = Date.now() + this.config.killReapTimeoutMs;
      while (this.processes.get(proc.id) === proc && Date.now() < publicationDeadline) {
        await wait(10);
      }
      if (this.processes.get(proc.id) === proc) {
        await this.publishUnverifiedTermination(
          proc,
          'The process group exited, but its durable terminal transition could not be verified',
        );
        return false;
      }
      return true;
    } catch (err: unknown) {
      await this.publishUnverifiedTermination(
        proc,
        `Cancellation failed: ${this.sanitizeTerminalError(err)}`,
      );
      return false;
    }
  }

  private signalSupervisedProcess(proc: SupervisedProcess, signal: string): void {
    if (proc.proc) {
      // After the original leader exits, only a still-present verified group
      // may be signalled. A missing or unknowable PGID is not permission to
      // fall through to a possibly reused positive pid.
      if (process.platform !== 'win32' && proc.leaderExited) {
        if (proc.ownedGroupObservedGone) return;
        const groupState = this.ownedProcessGroupState(proc);
        if (groupState === 'gone') proc.ownedGroupObservedGone = true;
        if (groupState !== 'alive') return;
        try {
          process.kill(-proc.pid, signal as NodeJS.Signals);
        } catch {
          // The verified group may have disappeared between observation and
          // delivery. Never fall back to the exited leader's reusable pid.
        }
        return;
      }
      this.signalOwnedChild(proc.proc, signal);
      return;
    }
    // A recovered live entry can lack its original Bun handle. Never signal a
    // proc-less PID unless restart recovery proved its command and cwd. This
    // guards PID reuse and also makes the negative-PGID path authoritative for
    // descendants left behind by a dead group leader.
    if (proc.pid <= 1 || proc.recoveredOwnershipVerified !== true) return;
    if (process.platform !== 'win32') {
      try {
        process.kill(-proc.pid, signal as NodeJS.Signals);
        return;
      } catch {
        // A legacy owned child may not be a process-group leader. Revalidate
        // its exact positive PID immediately before using that narrower path.
      }
    }
    const observed = observeProcess(proc.pid);
    if (!shouldKillRecoveredProcess(proc, observed, protectedProcessPids())) return;
    try {
      process.kill(proc.pid, signal as NodeJS.Signals);
    } catch {
      // Reap verification below distinguishes an already-gone PID from a
      // process that ignored or could not receive the signal.
    }
  }

  private isOwnedProcessAlive(proc: SupervisedProcess): boolean {
    if (proc.pid <= 1) return false;
    if (process.platform !== 'win32') {
      if (proc.proc && proc.leaderExited && proc.ownedGroupObservedGone) return false;
      const groupState = this.ownedProcessGroupState(proc);
      if (proc.proc && proc.leaderExited && groupState === 'gone') {
        proc.ownedGroupObservedGone = true;
        return false;
      }
      if (groupState !== 'gone') return true;
      // A locally spawned POSIX child is always detached into a group whose
      // id is its original pid. Once that group is gone, never fall back to a
      // positive pid that the OS may already have reused for an unrelated
      // process. Recovered legacy entries retain the revalidated narrow-pid
      // compatibility path below.
      if (proc.proc) return false;
    }
    try {
      process.kill(proc.pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  private ownedProcessGroupState(proc: Pick<SupervisedProcess, 'pid'>): ProcessGroupState {
    if (process.platform === 'win32' || proc.pid <= 1) return 'gone';
    try {
      process.kill(-proc.pid, 0);
      return 'alive';
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM') return 'alive';
      if (code === 'ESRCH') return 'gone';
      return 'unknown';
    }
  }

  /**
   * Bun's `exited` promise tracks the shell leader, not every descendant in
   * its detached POSIX group. Keep the durable record, agent wait predicate,
   * cancellation target, and Time Travel barrier active until the complete
   * group has stably disappeared. Unknown liveness fails closed as degraded
   * active truth and, critically, is never authorization to signal a raw
   * PGID that may have been reused.
   */
  private async waitForSpawnedProcessGroupReap(proc: SupervisedProcess): Promise<void> {
    if (process.platform === 'win32' || !proc.proc) return;
    let missingSince: number | undefined;
    while (true) {
      const state = this.ownedProcessGroupState(proc);
      if (state === 'gone') proc.ownedGroupObservedGone = true;
      if (proc.ownedGroupObservedGone) {
        missingSince ??= Date.now();
        if (Date.now() - missingSince >= 25) return;
      } else {
        missingSince = undefined;
      }

      if (state === 'unknown' && !proc.groupLivenessDegraded) {
        proc.groupLivenessDegraded = true;
        await this.publishUnverifiedTermination(
          proc,
          'The shell leader exited, but detached process-group liveness could not be verified; retaining active supervision',
        );
      }
      await wait(state === 'unknown' ? 250 : 25);
    }
  }

  private async waitForOwnedProcessExit(
    proc: SupervisedProcess,
    timeoutMs: number,
  ): Promise<{ verified: boolean; code: number | null; error?: string }> {
    let settled = false;
    let code: number | null = null;
    let error: string | undefined;
    let missingSince: number | undefined;
    if (proc.proc?.exited) {
      void Promise.resolve(proc.proc.exited).then(
        (value: unknown) => {
          settled = true;
          code = typeof value === 'number' ? value : null;
        },
        (reason: unknown) => {
          settled = true;
          error = this.sanitizeTerminalError(reason);
        },
      );
    }

    const deadline = Date.now() + Math.max(0, timeoutMs);
    do {
      const alive = this.isOwnedProcessAlive(proc);
      // On POSIX, checking the detached group as well as the leader prevents a
      // shell that exited after TERM from abandoning an ignoring grandchild.
      if (!alive) {
        if (!proc.proc?.exited) return { verified: true, code, error };
        // A just-spawned detached child can briefly be absent from both PID
        // and PGID lookup before the Bun exit handle settles. Require stable
        // non-existence so that transient pre-exec absence is not mistaken for
        // reap (the post-spawn persistence-failure race depends on this).
        missingSince ??= Date.now();
        if (settled && Date.now() - missingSince >= 25) {
          return { verified: true, code, error };
        }
      } else {
        missingSince = undefined;
      }
      if (Date.now() >= deadline) break;
      await wait(Math.min(25, Math.max(1, deadline - Date.now())));
    } while (true);
    return { verified: false, code, error };
  }

  private async publishUnverifiedTermination(
    proc: SupervisedProcess,
    detail = 'The owned process group did not exit after TERM and KILL',
  ): Promise<void> {
    const terminalError = this.sanitizeTerminalError(detail);
    proc.terminalError = terminalError;
    proc.updatedAt = Date.now();
    try {
      await updateProcessStatus(proc.id, proc.status, {
        signal: proc.signal,
        terminalError,
        stdoutSnapshot: proc.stdout,
        stderrSnapshot: proc.stderr,
      });
      await updateHealthCheck(proc.id, false, terminalError);
      await logProcessEvent(proc.id, 'kill_unverified', {
        signal: proc.signal,
        terminalReason: proc.requestedTerminalReason,
        error: terminalError,
      });
    } catch (error) {
      serverLog.error(
        { processId: proc.id, error: this.sanitizeTerminalError(error) },
        'Failed to persist unverified process termination',
      );
    }
    this.emitLifecycle({
      type: 'degraded',
      id: proc.id,
      name: proc.name,
      command: proc.command,
      sessionId: proc.sessionId,
      pid: proc.pid,
      status: 'degraded',
      ...this.classificationOf(proc),
      terminalError,
    });
  }

  async writeInput(id: string, input: string): Promise<boolean> {
    const supervised = this.processes.get(id);
    const stdin = supervised?.proc?.stdin as
      | { write(data: string): unknown; flush?(): Promise<void> }
      | null
      | undefined;
    if (!stdin || !supervised || supervised.status !== 'running') return false;
    try {
      stdin.write(input);
      await stdin.flush?.();
      await logProcessEvent(id, 'stdin_written', { bytes: Buffer.byteLength(input) });
      return true;
    } catch (err: unknown) {
      serverLog.debug(
        { err: err instanceof Error ? err.message : String(err), id },
        'Failed to write input to process stdin',
      );
      return false;
    }
  }

  getProcess(id: string): SupervisedProcess | undefined {
    return this.processes.get(id);
  }

  async cancelAgentBackgroundProcessesForSession(
    sessionId: string,
    signal: string = 'SIGTERM',
  ): Promise<number> {
    const owned = Array.from(this.processes.values()).filter(
      (process) => process.sessionId === sessionId && isAgentBackgroundProcess(process),
    );
    const results = await Promise.all(
      owned.map((process) => this.killProcess(process.id, signal, 'session-cancelled')),
    );
    return results.filter(Boolean).length;
  }

  /**
   * Terminate every live process attached to a session before erasing its
   * durable rows. A process whose ownership/death cannot be verified blocks
   * deletion; its logs and monitor record remain available for recovery.
   */
  async terminateProcessesForSession(
    sessionId: string,
    signal: string = 'SIGTERM',
  ): Promise<number> {
    const attached = Array.from(this.processes.values()).filter(
      (process) => process.sessionId === sessionId,
    );
    const outcomes = await Promise.all(
      attached.map((process) => this.killProcess(process.id, signal, 'session-cancelled')),
    );
    const failed = attached.filter((_, index) => !outcomes[index]);
    if (failed.length > 0) {
      throw new Error(
        `Session deletion blocked: ${failed.length} supervised process termination(s) could not be verified`,
      );
    }
    return outcomes.filter(Boolean).length;
  }

  async getAgentBackgroundProcessesBySession(sessionId: string): Promise<PersistedProcess[]> {
    return (await getProcessesBySession(sessionId)).filter(isAgentBackgroundProcess);
  }

  async getProcessLogs(id: string): Promise<{ stdout: string; stderr: string } | null> {
    const live = this.processes.get(id);
    if (live) return { stdout: live.stdout, stderr: live.stderr };
    const persisted = await getProcessById(id);
    if (!persisted) return null;
    return {
      stdout: persisted.stdoutSnapshot ?? '',
      stderr: persisted.stderrSnapshot ?? '',
    };
  }

  async killAgentBackgroundProcessForSession(
    id: string,
    sessionId: string,
    signal: string = 'SIGTERM',
  ): Promise<boolean> {
    const process = this.processes.get(id);
    if (!process || process.sessionId !== sessionId || !isAgentBackgroundProcess(process)) {
      return false;
    }
    return this.killProcess(id, signal, 'killed-by-user');
  }

  async restartProcess(id: string): Promise<SupervisedProcess | null> {
    const persisted = await getProcessById(id);
    if (!persisted) return null;
    if (persisted.commandReplayable !== true) {
      await logProcessEvent(id, 'restart_refused', {
        reason: 'Durable command was redacted or truncated and cannot be replayed',
      });
      return null;
    }

    // A restart must never overlap the old owned process. If cancellation
    // cannot prove the process group exited, retain the authoritative live
    // record/barrier and refuse to spawn a duplicate writer.
    if (this.processes.has(id)) {
      const terminated = await this.killProcess(id, 'SIGTERM', 'killed-for-restart').catch(
        () => false,
      );
      if (!terminated) return null;
    }

    let metadata: Record<string, unknown> | undefined;
    try {
      metadata = persisted.metadata ? JSON.parse(persisted.metadata) : undefined;
    } catch {
      metadata = undefined;
    }

    const classification: ProcessClassification = isAgentBackgroundProcess(persisted)
      ? {
          provenance: persisted.provenance,
          supervision: persisted.supervision,
          isBackground: persisted.isBackground,
        }
      : {
          provenance: 'manual-service',
          supervision: 'owned-child',
          isBackground: true,
        };

    return this.startClassifiedProcessWithGuard(
      {
        name: persisted.name,
        command: persisted.command,
        cwd: persisted.cwd,
        sessionId: persisted.sessionId,
        restartPolicy: persisted.restartPolicy,
        maxRestarts: persisted.maxRestarts,
        metadata,
      },
      classification,
    );
  }

  getProcessByPid(pid: number): SupervisedProcess | undefined {
    return Array.from(this.processes.values()).find((p) => p.pid === pid);
  }

  async getProcessesBySession(sessionId: string): Promise<PersistedProcess[]> {
    return await getProcessesBySession(sessionId);
  }

  /** Release supervisor-owned timers/listeners (primarily for orderly tests/shutdown). */
  shutdown(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
    for (const process of this.processes.values()) this.cleanupTimers(process);
    this.processes.clear();
    this.lifecycleListeners.length = 0;
    this.agentToolBarriers.clear();
    this.agentStartsInFlight.clear();
    this.sessionErasureBarriers.clear();
    this.sessionStartsInFlight.clear();
    this.erasedSessions.clear();
    this.isRunning = false;
  }

  private async readStream(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    id: string,
    type: 'stdout' | 'stderr',
  ): Promise<void> {
    const decoder = new TextDecoder();
    const proc = this.processes.get(id);
    if (!proc) return;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);
        if (type === 'stdout') proc.stdout = (proc.stdout + chunk).slice(-this.MAX_LOG_SIZE);
        else proc.stderr = (proc.stderr + chunk).slice(-this.MAX_LOG_SIZE);
        proc.lastOutputAt = Date.now();
      }
    } catch (err) {
      // The stream reader throws when the child exits and the pipe closes.
      // Expected on normal termination; log at debug in case of a real I/O error.
      serverLog.debug(
        { err: err instanceof Error ? err.message : String(err), id, type },
        'Process output stream read ended',
      );
      // Emit a degraded lifecycle event so listeners can react to I/O failures
      // without treating the process as exited (it may still be running).
      this.emitLifecycle({
        type: 'degraded',
        id,
        name: proc.name,
        command: proc.command,
        sessionId: proc.sessionId,
        pid: proc.pid,
        status: 'degraded',
        provenance: proc.provenance,
        supervision: proc.supervision,
        isBackground: proc.isBackground,
      });
    }
  }

  private monitorExit(proc: SupervisedProcess): void {
    if (!proc.proc) return;
    void Promise.resolve(proc.proc.exited)
      .then(
        (code: number) => {
          proc.leaderExited = true;
          proc.leaderExitCode = code;
          return this.handleProcessExit(proc, code);
        },
        (error: unknown) => {
          proc.leaderExited = true;
          proc.leaderExitError = this.sanitizeTerminalError(
            error instanceof Error ? error.message : String(error),
          );
          return this.handleProcessExit(proc, null, proc.leaderExitError);
        },
      )
      .catch((error: unknown) =>
        serverLog.error(
          { processId: proc.id, error: this.sanitizeTerminalError(error) },
          'Failed to finalize process lifecycle',
        ),
      );
  }

  private handleProcessExit(
    proc: SupervisedProcess,
    code: number | null,
    error?: string,
  ): Promise<void> {
    proc.leaderExited = true;
    if (typeof code === 'number') proc.leaderExitCode = code;
    if (error) proc.leaderExitError = this.sanitizeTerminalError(error);
    if (proc.exitFinalizationPromise) return proc.exitFinalizationPromise;

    const pending = this.finalizeProcessExit(proc, code, error).finally(() => {
      if (proc.exitFinalizationPromise === pending) proc.exitFinalizationPromise = undefined;
    });
    proc.exitFinalizationPromise = pending;
    return pending;
  }

  private async finalizeProcessExit(
    proc: SupervisedProcess,
    initialCode: number | null,
    initialError?: string,
  ): Promise<void> {
    // A detached descendant can outlive the shell leader even after closing
    // inherited stdout/stderr. Group reap, not leader exit or quiet output, is
    // the authoritative terminal boundary.
    await this.waitForSpawnedProcessGroupReap(proc);
    await Promise.allSettled([proc.stdoutDrain, proc.stderrDrain].filter(Boolean));

    const code = proc.leaderExitCode ?? initialCode;
    const error = proc.leaderExitError ?? initialError;

    // An already-published terminal event may race this Bun exit callback. In
    // that case only refresh the durable output snapshot; never publish twice.
    if (proc.terminalEventEmitted) {
      await updateProcessStatus(proc.id, proc.status, {
        stdoutSnapshot: proc.stdout,
        stderrSnapshot: proc.stderr,
      });
      return;
    }

    if (proc.spawnFailureError) {
      await this.finalizeSpawnFailure(proc, this.classificationOf(proc));
      return;
    }

    if (proc.requestedTerminalReason) {
      await this.finalizeTerminal(proc, {
        status: 'killed',
        terminalReason: proc.requestedTerminalReason,
        exitCode: code ?? undefined,
        signal: proc.signal,
        terminalError: error ? this.sanitizeTerminalError(error) : undefined,
        willRestart: false,
      });
      return;
    }

    const isCrash = code !== 0 || code === null;
    const status: PersistedProcess['status'] = isCrash ? 'crashed' : 'exited';
    const terminalReason: ProcessTerminalReason =
      code === null ? 'process-missing' : code === 0 ? 'exit-zero' : 'exit-nonzero';
    const willRestart = this.shouldRestart(proc, isCrash);
    await this.finalizeTerminal(proc, {
      status,
      terminalReason,
      exitCode: code ?? undefined,
      terminalError: error ? this.sanitizeTerminalError(error) : undefined,
      willRestart,
    });
    if (willRestart) this.scheduleRestart(proc);
  }

  private classificationOf(process: Partial<PersistedProcess>): ProcessClassification {
    return {
      provenance: process.provenance ?? 'legacy-unknown',
      supervision: process.supervision ?? 'legacy-unknown',
      isBackground: process.isBackground === true,
    };
  }

  private sanitizeTerminalError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return redactSecretsInText(message.replace(/[\r\n\t]+/g, ' '), 1_000);
  }

  private signalOwnedChild(
    proc: { pid?: number; kill?: (signal: string | number) => unknown },
    signal: string,
  ) {
    if (process.platform !== 'win32' && (proc.pid ?? 0) > 1) {
      try {
        process.kill(-(proc.pid as number), signal as NodeJS.Signals);
        return;
      } catch {
        // The group may already be gone or the injected spawner may not have
        // created one. Fall through to the direct owned handle.
      }
    }
    try {
      proc.kill?.(signal);
    } catch {
      // The eventual exit/health path will reconcile an already-gone child.
    }
  }

  private async recordSpawnFailure(
    persisted: PersistedProcess,
    classification: ProcessClassification,
    error: unknown,
    beforeEvent?: () => void,
  ): Promise<void> {
    const terminalError = this.sanitizeTerminalError(error);
    persisted.status = 'spawn_failed';
    persisted.terminalReason = 'spawn-failed';
    persisted.terminalError = terminalError;
    persisted.endedAt = Date.now();
    persisted.updatedAt = persisted.endedAt;

    let persistenceError: unknown;
    try {
      await persistProcess(persisted);
      await logProcessEvent(persisted.id, 'spawn_failed', {
        error: terminalError,
        provenance: classification.provenance,
      });
    } catch (error) {
      persistenceError = error;
    }

    // Make the terminal event authoritative for remaining-process checks: the
    // failed attempt is no longer counted when completion coordination sees it.
    beforeEvent?.();
    this.emitLifecycle({
      type: 'exited',
      id: persisted.id,
      name: persisted.name,
      command: persisted.command,
      sessionId: persisted.sessionId,
      pid: persisted.pid,
      status: 'spawn_failed',
      ...classification,
      terminalReason: 'spawn-failed',
      terminalError,
      willRestart: false,
    });

    if (persistenceError) throw persistenceError;
  }

  /**
   * A child exists even though its running-state persistence failed. Kill and
   * reap the owned group before publishing spawn_failed. If OS death or the
   * durable terminal transition cannot be verified, retain the live-map entry
   * so session and Time Travel barriers remain closed.
   */
  private async abortSpawnedProcessAfterPersistenceFailure(
    proc: SupervisedProcess,
    classification: ProcessClassification,
    error: unknown,
    beforeEvent?: () => void,
  ): Promise<void> {
    proc.spawnFailureError = `Failed to persist spawned process: ${this.sanitizeTerminalError(error)}`;
    proc.signal = 'SIGKILL';
    this.signalSupervisedProcess(proc, 'SIGKILL');
    const exit = await this.waitForOwnedProcessExit(proc, this.config.killReapTimeoutMs);
    if (!exit.verified) {
      await this.publishUnverifiedTermination(
        proc,
        `${proc.spawnFailureError}; the owned process group did not exit after SIGKILL`,
      );
      return;
    }

    await Promise.allSettled([proc.stdoutDrain, proc.stderrDrain].filter(Boolean));
    try {
      await this.finalizeSpawnFailure(proc, classification, beforeEvent);
    } catch (publicationError) {
      await this.publishUnverifiedTermination(
        proc,
        `${proc.spawnFailureError}; OS exit was verified but durable spawn-failed publication failed: ${this.sanitizeTerminalError(publicationError)}`,
      );
    }
  }

  private async finalizeSpawnFailure(
    proc: SupervisedProcess,
    classification: ProcessClassification,
    beforeEvent?: () => void,
  ): Promise<void> {
    if (proc.terminalEventEmitted) return;
    const terminalError = proc.spawnFailureError ?? 'Process spawn failed';
    const endedAt = Date.now();
    await persistProcess({
      ...proc,
      status: 'spawn_failed',
      terminalReason: 'spawn-failed',
      terminalError,
      endedAt,
      updatedAt: endedAt,
      stdoutSnapshot: proc.stdout,
      stderrSnapshot: proc.stderr,
    });
    await logProcessEvent(proc.id, 'spawn_failed', {
      error: terminalError,
      provenance: classification.provenance,
      signal: proc.signal,
    });

    proc.terminalEventEmitted = true;
    proc.status = 'spawn_failed';
    proc.terminalReason = 'spawn-failed';
    proc.terminalError = terminalError;
    proc.endedAt = endedAt;
    proc.updatedAt = endedAt;
    proc.stdoutSnapshot = proc.stdout;
    proc.stderrSnapshot = proc.stderr;
    this.cleanupTimers(proc);
    this.processes.delete(proc.id);
    beforeEvent?.();
    this.emitLifecycle({
      type: 'exited',
      id: proc.id,
      name: proc.name,
      command: proc.command,
      sessionId: proc.sessionId,
      pid: proc.pid,
      status: 'spawn_failed',
      ...classification,
      terminalReason: 'spawn-failed',
      terminalError,
      willRestart: false,
      logsTail: [proc.stdout, proc.stderr].filter(Boolean).join('\n').slice(-2_000) || undefined,
    });
  }

  private async finalizeTerminal(
    proc: SupervisedProcess,
    result: {
      status: Extract<PersistedProcess['status'], 'exited' | 'killed' | 'crashed'>;
      terminalReason: ProcessTerminalReason;
      exitCode?: number;
      signal?: string;
      terminalError?: string;
      willRestart: boolean;
    },
  ): Promise<void> {
    if (proc.terminalEventEmitted) return;
    proc.terminalEventEmitted = true;
    proc.status = result.status;
    proc.exitCode = result.exitCode;
    proc.signal = result.signal ?? proc.signal;
    proc.terminalReason = result.terminalReason;
    proc.terminalError = result.terminalError;
    proc.stdoutSnapshot = proc.stdout;
    proc.stderrSnapshot = proc.stderr;
    proc.endedAt = Date.now();
    proc.updatedAt = proc.endedAt;

    try {
      await updateProcessStatus(proc.id, result.status, {
        exitCode: result.exitCode,
        signal: proc.signal,
        endedAt: proc.endedAt,
        terminalReason: result.terminalReason,
        terminalError: result.terminalError,
        stdoutSnapshot: proc.stdout,
        stderrSnapshot: proc.stderr,
      });
      await logProcessEvent(proc.id, 'process_terminal', {
        status: result.status,
        terminalReason: result.terminalReason,
        exitCode: result.exitCode,
        signal: proc.signal,
        error: result.terminalError,
        willRestart: result.willRestart,
      });
    } catch (error) {
      proc.terminalEventEmitted = false;
      throw error;
    }
    this.cleanupTimers(proc);
    if (!result.willRestart) this.processes.delete(proc.id);

    this.emitLifecycle({
      type: 'exited',
      id: proc.id,
      name: proc.name,
      command: proc.command,
      sessionId: proc.sessionId,
      pid: proc.pid,
      exitCode: result.exitCode,
      status: result.status,
      ...this.classificationOf(proc),
      terminalReason: result.terminalReason,
      terminalError: result.terminalError,
      willRestart: result.willRestart,
      logsTail: [proc.stdout, proc.stderr].filter(Boolean).join('\n').slice(-2_000) || undefined,
    });
  }

  private shouldRestart(proc: SupervisedProcess, isCrash: boolean): boolean {
    if (proc.restartPolicy === 'never') return false;
    return proc.restartCount < proc.maxRestarts && (proc.restartPolicy === 'always' || isCrash);
  }

  private scheduleRestart(proc: SupervisedProcess): void {
    if (proc.restartCount >= proc.maxRestarts) return;

    // Exponential backoff: 5s, 10s, 20s, 40s, 60s (capped at 60s).
    // Formula: delay = min(restartDelayMs * 2^restartCount, 60000)
    const delay = Math.min(this.config.restartDelayMs * Math.pow(2, proc.restartCount), 60_000);

    proc.restartTimer = setTimeout(async () => {
      let restartStarted = false;
      try {
        const restartCount = await incrementRestartCount(proc.id);
        const classification = this.classificationOf(proc);
        let metadata: Record<string, unknown> | undefined;
        try {
          metadata = proc.metadata ? JSON.parse(proc.metadata) : undefined;
        } catch {
          metadata = undefined;
        }
        this.processes.delete(proc.id);
        restartStarted = true;
        await this.startClassifiedProcessWithGuard(
          {
            name: proc.name,
            command: proc.command,
            cwd: proc.cwd,
            sessionId: proc.sessionId,
            restartPolicy: proc.restartPolicy,
            maxRestarts: proc.maxRestarts,
            metadata,
          },
          classification,
          { ...proc, restartCount },
        );
      } catch (error) {
        if (!restartStarted) await this.abandonRestart(proc, error);
        serverLog.warn(
          { processId: proc.id, error: this.sanitizeTerminalError(error) },
          'Automatic process restart failed',
        );
      }
    }, delay);
  }

  private async abandonRestart(proc: SupervisedProcess, error: unknown): Promise<void> {
    const terminalError = this.sanitizeTerminalError(error);
    const endedAt = Date.now();
    proc.status = 'crashed';
    proc.terminalReason = 'restart-failed';
    proc.terminalError = terminalError;
    proc.endedAt = endedAt;
    proc.updatedAt = endedAt;
    this.cleanupTimers(proc);
    this.processes.delete(proc.id);

    try {
      await updateProcessStatus(proc.id, 'crashed', {
        endedAt,
        terminalReason: 'restart-failed',
        terminalError,
        stdoutSnapshot: proc.stdout,
        stderrSnapshot: proc.stderr,
      });
      await logProcessEvent(proc.id, 'restart_failed', { error: terminalError });
    } catch (persistenceError) {
      serverLog.error(
        { processId: proc.id, error: this.sanitizeTerminalError(persistenceError) },
        'Failed to persist automatic restart failure',
      );
    }

    // The first crash event advertised willRestart:true and was intentionally
    // ignored by the completion coordinator. Publish the corrected final
    // outcome so the session cannot remain parked forever.
    this.emitLifecycle({
      type: 'exited',
      id: proc.id,
      name: proc.name,
      command: proc.command,
      sessionId: proc.sessionId,
      pid: proc.pid,
      status: 'crashed',
      ...this.classificationOf(proc),
      terminalReason: 'restart-failed',
      terminalError,
      willRestart: false,
      logsTail: [proc.stdout, proc.stderr].filter(Boolean).join('\n').slice(-2_000) || undefined,
    });
  }

  private startHealthChecks(id: string): void {
    const proc = this.processes.get(id);
    if (!proc || proc.healthCheckTimer) return;
    proc.healthCheckTimer = setInterval(
      () => this.checkHealth(id),
      this.config.healthCheckIntervalMs,
    );
  }

  private async checkHealth(id: string): Promise<void> {
    const proc = this.processes.get(id);
    if (!proc || proc.status !== 'running') return;
    if (this.isOwnedProcessAlive(proc)) {
      try {
        await updateHealthCheck(id, true);
      } catch (err: unknown) {
        serverLog.debug(
          { err: err instanceof Error ? err.message : String(err), id },
          'Failed to persist process health check',
        );
      }
      return;
    }
    try {
      await updateHealthCheck(id, false, 'Process group not found');
      if (proc.recoveredFromBackendRestart) {
        await this.finalizeRecoveredOrphan(
          proc,
          proc.recoveredOwnershipVerified ? 'backend-restart-orphaned' : 'backend-restart-missing',
          proc.signal,
        );
        return;
      }
      await this.handleProcessExit(proc, null, 'Process missing');
    } catch (err: unknown) {
      serverLog.debug(
        { err: err instanceof Error ? err.message : String(err), id },
        'Failed to reconcile missing process',
      );
    }
  }

  private recoveredProcess(proc: PersistedProcess, ownershipVerified: boolean): SupervisedProcess {
    return {
      ...proc,
      stdout: proc.stdoutSnapshot ?? '',
      stderr: proc.stderrSnapshot ?? '',
      lastOutputAt: proc.updatedAt,
      recoveredOwnershipVerified: ownershipVerified,
      recoveredFromBackendRestart: true,
    };
  }

  private async retainRecoveredProcessDegraded(
    proc: SupervisedProcess,
    detail: string,
  ): Promise<void> {
    const terminalError = this.sanitizeTerminalError(detail);
    proc.terminalReason = 'backend-restart-unverified';
    proc.terminalError = terminalError;
    proc.updatedAt = Date.now();
    try {
      await updateProcessStatus(proc.id, proc.status, {
        signal: proc.signal,
        terminalReason: 'backend-restart-unverified',
        terminalError,
        stdoutSnapshot: proc.stdout,
        stderrSnapshot: proc.stderr,
      });
      await updateHealthCheck(proc.id, false, terminalError);
      await logProcessEvent(proc.id, 'backend_restart_recovery_degraded', {
        pid: proc.pid,
        ownershipVerified: proc.recoveredOwnershipVerified === true,
        signal: proc.signal,
        error: terminalError,
      });
    } catch (error) {
      serverLog.error(
        { processId: proc.id, error: this.sanitizeTerminalError(error) },
        'Failed to persist degraded restart recovery',
      );
    }
    this.emitLifecycle({
      type: 'degraded',
      id: proc.id,
      name: proc.name,
      command: proc.command,
      sessionId: proc.sessionId,
      pid: proc.pid,
      status: 'degraded',
      ...this.classificationOf(proc),
      terminalReason: 'backend-restart-unverified',
      terminalError,
      recovered: true,
    });
    this.startHealthChecks(proc.id);
  }

  private async finalizeRecoveredOrphan(
    proc: SupervisedProcess,
    terminalReason: Extract<
      ProcessTerminalReason,
      'backend-restart-orphaned' | 'backend-restart-missing'
    >,
    signal?: string,
  ): Promise<void> {
    if (proc.terminalEventEmitted) return;
    const endedAt = Date.now();
    await updateProcessStatus(proc.id, 'orphaned', {
      endedAt,
      signal,
      terminalReason,
      stdoutSnapshot: proc.stdout,
      stderrSnapshot: proc.stderr,
    });
    await logProcessEvent(proc.id, 'backend_restart_recovery', {
      terminalReason,
      pid: proc.pid,
      signal,
    });
    proc.terminalEventEmitted = true;
    proc.status = 'orphaned';
    proc.terminalReason = terminalReason;
    proc.signal = signal;
    proc.endedAt = endedAt;
    proc.updatedAt = endedAt;
    this.cleanupTimers(proc);
    this.processes.delete(proc.id);
    this.emitLifecycle({
      type: 'exited',
      id: proc.id,
      name: proc.name,
      command: proc.command,
      sessionId: proc.sessionId,
      pid: proc.pid,
      status: 'orphaned',
      ...this.classificationOf(proc),
      terminalReason,
      willRestart: false,
      recovered: true,
      logsTail: [proc.stdout, proc.stderr].filter(Boolean).join('\n').slice(-2_000) || undefined,
    });
  }

  private async cleanupRecoveredProcess(proc: PersistedProcess): Promise<void> {
    const candidate = this.recoveredProcess(proc, false);
    this.processes.set(proc.id, candidate);
    if (!this.isOwnedProcessAlive(candidate)) {
      await this.finalizeRecoveredOrphan(candidate, 'backend-restart-missing');
      return;
    }

    const observed = observeProcess(proc.pid);
    candidate.recoveredOwnershipVerified = shouldKillRecoveredProcess(
      proc,
      observed,
      protectedProcessPids(),
    );
    if (!candidate.recoveredOwnershipVerified) {
      serverLog.warn(
        { processId: proc.id, pid: proc.pid },
        'Refusing to signal unverified recovered PID; retaining authoritative active state',
      );
      await this.retainRecoveredProcessDegraded(
        candidate,
        'Recovered process is still live, but its OS identity could not be verified; no signal was sent',
      );
      return;
    }

    candidate.signal = 'SIGKILL';
    this.signalSupervisedProcess(candidate, 'SIGKILL');
    const exit = await this.waitForOwnedProcessExit(candidate, this.config.killReapTimeoutMs);
    if (!exit.verified) {
      await this.retainRecoveredProcessDegraded(
        candidate,
        'Recovered owned process group remained live after SIGKILL; terminal state is unverified',
      );
      return;
    }
    await this.finalizeRecoveredOrphan(candidate, 'backend-restart-orphaned', 'SIGKILL');
  }

  private async cleanupOrphans(): Promise<void> {
    const activeFromDb = await getActiveProcessesStrict();
    for (const proc of activeFromDb) {
      try {
        await this.cleanupRecoveredProcess(proc);
      } catch (err: unknown) {
        const candidate = this.processes.get(proc.id) ?? this.recoveredProcess(proc, false);
        this.processes.set(proc.id, candidate);
        await this.retainRecoveredProcessDegraded(
          candidate,
          `Restart recovery could not publish an authoritative outcome: ${this.sanitizeTerminalError(err)}`,
        );
      }
    }
  }

  private cleanupTimers(proc: SupervisedProcess): void {
    if (proc.healthCheckTimer) clearInterval(proc.healthCheckTimer);
    if (proc.restartTimer) clearTimeout(proc.restartTimer);
  }
}

export const processSupervisor = ProcessSupervisor.getInstance();
