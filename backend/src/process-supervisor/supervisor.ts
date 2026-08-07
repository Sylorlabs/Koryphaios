/**
 * Process Supervisor
 */

import { nanoid } from 'nanoid';
import { readFileSync, readlinkSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { serverLog } from '../logger';
import { requireBash } from '../runtime/shell';
import {
  initProcessSupervisorTables,
  persistProcess,
  updateProcessStatus,
  incrementRestartCount,
  getProcessById,
  getActiveProcesses,
  getProcessesBySession,
  cleanupOldProcesses,
  logProcessEvent,
  updateHealthCheck,
  type PersistedProcess,
} from './database';

export interface SupervisedProcess extends PersistedProcess {
  proc?: any;
  stdout: string;
  stderr: string;
  lastOutputAt: number;
  healthCheckTimer?: Timer;
  restartTimer?: Timer;
}

export interface SupervisorConfig {
  maxRestarts: number;
  restartDelayMs: number;
  healthCheckIntervalMs: number;
  maxConsecutiveFailures: number;
  orphanCheckOnStartup: boolean;
  logRetentionDays: number;
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
};

export interface ProcessLifecycleEvent {
  type: 'started' | 'exited' | 'degraded';
  id: string;
  name: string;
  command: string;
  sessionId?: string;
  pid?: number;
  exitCode?: number;
  status?: string;
  willRestart?: boolean;
  logsTail?: string;
}

export class ProcessSupervisor {
  private static instance: ProcessSupervisor;
  private config: SupervisorConfig;
  private processes = new Map<string, SupervisedProcess>();
  private isRunning = false;
  private cleanupTimer?: Timer;
  private readonly MAX_LOG_SIZE = 100_000;

  private constructor(config: Partial<SupervisorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  static getInstance(config?: Partial<SupervisorConfig>): ProcessSupervisor {
    if (!ProcessSupervisor.instance) ProcessSupervisor.instance = new ProcessSupervisor(config);
    return ProcessSupervisor.instance;
  }

  // ── Lifecycle listeners ────────────────────────────────────────────────
  // The manager subscribes to surface background terminals in chat and to
  // wake the agent when a process it was waiting on finishes.
  private lifecycleListeners: Array<(e: ProcessLifecycleEvent) => void> = [];

  onLifecycle(cb: (e: ProcessLifecycleEvent) => void): void {
    this.lifecycleListeners.push(cb);
  }

  private emitLifecycle(e: ProcessLifecycleEvent): void {
    for (const cb of this.lifecycleListeners) {
      try {
        cb(e);
      } catch (err: unknown) {
        serverLog.debug({ err: err instanceof Error ? err.message : String(err) }, 'Process lifecycle listener threw');
      }
    }
  }

  /** True if any supervised process for this session is still running. */
  hasRunningForSession(sessionId: string): boolean {
    for (const p of this.processes.values()) {
      if (p.sessionId === sessionId && p.status === 'running') return true;
    }
    return false;
  }

  async initialize(): Promise<void> {
    if (this.isRunning) return;
    initProcessSupervisorTables();
    await cleanupOldProcesses(this.config.logRetentionDays);
    if (this.config.orphanCheckOnStartup) await this.cleanupOrphans();
    await this.recoverActiveProcesses();
    this.cleanupTimer = setInterval(
      () => cleanupOldProcesses(this.config.logRetentionDays),
      3600000,
    );
    this.isRunning = true;
  }

  async startProcess(options: any): Promise<SupervisedProcess> {
    const id = nanoid(12);
    const now = Date.now();
    const persisted: PersistedProcess = {
      id,
      name: options.name,
      command: options.command,
      cwd: options.cwd ?? process.cwd(),
      pid: 0,
      sessionId: options.sessionId,
      status: 'starting',
      restartCount: 0,
      maxRestarts: options.maxRestarts ?? this.config.maxRestarts,
      restartPolicy: options.restartPolicy ?? 'on-failure',
      createdAt: now,
      updatedAt: now,
      metadata: options.metadata ? JSON.stringify(options.metadata) : undefined,
    };
    await persistProcess(persisted);
    await logProcessEvent(id, 'start_requested', { command: options.command });
    const shell = requireBash();
    const proc = Bun.spawn([shell.command, ...shell.args, options.command], {
      cwd: options.cwd,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    persisted.pid = proc.pid;
    persisted.status = 'running';
    await persistProcess(persisted);
    const supervised: SupervisedProcess = {
      ...persisted,
      proc,
      stdout: '',
      stderr: '',
      lastOutputAt: now,
    };
    this.processes.set(id, supervised);
    this.emitLifecycle({
      type: 'started',
      id,
      name: supervised.name,
      command: supervised.command,
      sessionId: supervised.sessionId,
      pid: supervised.pid,
      status: 'running',
    });
    this.readStream(proc.stdout.getReader(), id, 'stdout');
    this.readStream(proc.stderr.getReader(), id, 'stderr');
    this.monitorExit(supervised);
    this.startHealthChecks(id);
    return supervised;
  }

  /**
   * Track a background command started by an agentic CLI harness (e.g. Claude
   * Code's native background Bash). We didn't spawn it — no pid/stdin — but it
   * must appear in the background-terminals UI with live logs (tailed from the
   * CLI's own output file). Exit is inferred when the output goes quiet.
   */
  async registerExternal(options: {
    name: string;
    command: string;
    sessionId: string;
    outputFile?: string;
  }): Promise<string> {
    const id = `ext-${nanoid(10)}`;
    const now = Date.now();
    const persisted: PersistedProcess = {
      id,
      name: options.name,
      command: options.command,
      cwd: process.cwd(),
      pid: 0,
      sessionId: options.sessionId,
      status: 'running',
      restartCount: 0,
      maxRestarts: 0,
      restartPolicy: 'never',
      createdAt: now,
      updatedAt: now,
      metadata: JSON.stringify({ external: true, outputFile: options.outputFile }),
    };
    await persistProcess(persisted);
    await logProcessEvent(id, 'external_registered', { command: options.command });
    const supervised: SupervisedProcess = {
      ...persisted,
      stdout: '',
      stderr: '',
      lastOutputAt: now,
    };
    this.processes.set(id, supervised);
    this.emitLifecycle({
      type: 'started',
      id,
      name: supervised.name,
      command: supervised.command,
      sessionId: supervised.sessionId,
      pid: 0,
      status: 'running',
    });
    // Tail the CLI's output file for logs + quiet-exit inference.
    if (options.outputFile) {
      const EXTERNAL_QUIET_EXIT_MS = 90_000;
      let lastSize = 0;
      supervised.healthCheckTimer = setInterval(() => {
        void (async () => {
          const current = this.processes.get(id);
          if (!current || current.status !== 'running') return;
          try {
            const f = Bun.file(options.outputFile!);
            if (await f.exists()) {
              const size = f.size;
              if (size > lastSize) {
                lastSize = size;
                current.lastOutputAt = Date.now();
                const text = await f.text();
                current.stdout = text.slice(-this.MAX_LOG_SIZE);
              }
            }
          } catch (err: unknown) {
            serverLog.debug({ err: err instanceof Error ? err.message : String(err), id }, 'External process output file unreadable this tick');
          }
          if (Date.now() - current.lastOutputAt > EXTERNAL_QUIET_EXIT_MS) {
            current.status = 'exited';
            current.endedAt = Date.now();
            void updateProcessStatus(id, 'exited', { endedAt: current.endedAt });
            this.cleanupTimers(current);
            this.processes.delete(id);
            this.emitLifecycle({
              type: 'exited',
              id,
              name: current.name,
              command: current.command,
              sessionId: current.sessionId,
              status: 'exited',
              logsTail: current.stdout.slice(-1_000),
            });
          }
        })();
      }, 2_000) as unknown as Timer;
    }
    return id;
  }

  async killProcess(id: string, signal: string = 'SIGTERM'): Promise<boolean> {
    const proc = this.processes.get(id);
    if (!proc) return false;
    try {
      await logProcessEvent(id, 'kill_requested', { signal });
      proc.signal = signal;
      if (proc.proc) proc.proc.kill(signal as any);
      // External (CLI-owned) entries have no pid we own — dismiss, never
      // signal pid 0 (that would hit our whole process group).
      else if (proc.pid > 0) process.kill(proc.pid, signal as any);
      proc.status = 'killed';
      proc.endedAt = Date.now();
      await updateProcessStatus(id, 'killed', { signal, endedAt: proc.endedAt });
      this.cleanupTimers(proc);
      this.processes.delete(id);
      return true;
    } catch (err: unknown) {
      serverLog.debug({ err: err instanceof Error ? err.message : String(err), id }, 'Failed to kill process');
      return false;
    }
  }

  async writeInput(id: string, input: string): Promise<boolean> {
    const supervised = this.processes.get(id);
    if (!supervised?.proc?.stdin || supervised.status !== 'running') return false;
    try {
      supervised.proc.stdin.write(input);
      await supervised.proc.stdin.flush?.();
      await logProcessEvent(id, 'stdin_written', { bytes: Buffer.byteLength(input) });
      return true;
    } catch (err: unknown) {
      serverLog.debug({ err: err instanceof Error ? err.message : String(err), id }, 'Failed to write input to process stdin');
      return false;
    }
  }

  getProcess(id: string): SupervisedProcess | undefined {
    return this.processes.get(id);
  }

  async restartProcess(id: string): Promise<SupervisedProcess | null> {
    const persisted = await getProcessById(id);
    if (!persisted) return null;

    await this.killProcess(id, 'SIGTERM').catch(() => false);

    return this.startProcess({
      name: persisted.name,
      command: persisted.command,
      cwd: persisted.cwd,
      sessionId: persisted.sessionId,
      restartPolicy: persisted.restartPolicy,
      maxRestarts: persisted.maxRestarts,
      metadata: persisted.metadata ? JSON.parse(persisted.metadata) : undefined,
    });
  }

  getProcessByPid(pid: number): SupervisedProcess | undefined {
    return Array.from(this.processes.values()).find((p) => p.pid === pid);
  }

  async getProcessesBySession(sessionId: string): Promise<PersistedProcess[]> {
    return await getProcessesBySession(sessionId);
  }

  private async readStream(reader: any, id: string, type: 'stdout' | 'stderr'): Promise<void> {
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
      serverLog.debug({ err: err instanceof Error ? err.message : String(err), id, type }, 'Process output stream read ended');
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
      });
    }
  }

  private monitorExit(proc: SupervisedProcess): void {
    if (!proc.proc) return;
    proc.proc.exited
      .then((code: any) => this.handleProcessExit(proc, code))
      .catch((err: any) => this.handleProcessExit(proc, null, err.message));
  }

  private async handleProcessExit(
    proc: SupervisedProcess,
    code: number | null,
    error?: string,
  ): Promise<void> {
    const wasKilled = proc.status === 'killed';
    const isCrash = !wasKilled && code !== 0 && code !== null;
    const status: PersistedProcess['status'] = wasKilled
      ? 'killed'
      : isCrash
        ? 'crashed'
        : 'exited';
    proc.status = status;
    proc.exitCode = code ?? undefined;
    proc.endedAt = Date.now();
    await updateProcessStatus(proc.id, status, {
      exitCode: code ?? undefined,
      signal: proc.signal,
      endedAt: proc.endedAt,
    });
    await logProcessEvent(proc.id, 'process_exited', { code, error });
    this.cleanupTimers(proc);
    const willRestart = !wasKilled && this.shouldRestart(proc, isCrash);
    if (willRestart) this.scheduleRestart(proc);
    else this.processes.delete(proc.id);
    this.emitLifecycle({
      type: 'exited',
      id: proc.id,
      name: proc.name,
      command: proc.command,
      sessionId: proc.sessionId,
      pid: proc.pid,
      exitCode: code ?? undefined,
      status,
      willRestart,
      logsTail: [proc.stdout, proc.stderr].filter(Boolean).join('\n').slice(-2000) || undefined,
    });
  }

  private shouldRestart(proc: any, isCrash: boolean): boolean {
    if (proc.restartPolicy === 'never') return false;
    return proc.restartCount < proc.maxRestarts && (proc.restartPolicy === 'always' || isCrash);
  }

  private scheduleRestart(proc: any): void {
    // Check if we've hit the max restart cap — if so, emit a gave_up event
    // instead of scheduling another restart.
    if (proc.restartCount >= proc.maxRestarts) {
      this.emitLifecycle({
        type: 'exited',
        id: proc.id,
        name: proc.name,
        command: proc.command,
        sessionId: proc.sessionId,
        pid: proc.pid,
        status: 'gave_up',
        willRestart: false,
      });
      this.processes.delete(proc.id);
      return;
    }

    // Exponential backoff: 5s, 10s, 20s, 40s, 60s (capped at 60s).
    // Formula: delay = min(restartDelayMs * 2^restartCount, 60000)
    const delay = Math.min(
      this.config.restartDelayMs * Math.pow(2, proc.restartCount),
      60_000,
    );

    proc.restartTimer = setTimeout(async () => {
      await incrementRestartCount(proc.id);
      await this.startProcess(proc);
    }, delay);
  }

  private startHealthChecks(id: string): void {
    const proc = this.processes.get(id);
    if (!proc) return;
    proc.healthCheckTimer = setInterval(
      () => this.checkHealth(id),
      this.config.healthCheckIntervalMs,
    );
  }

  private async checkHealth(id: string): Promise<void> {
    const proc = this.processes.get(id);
    if (!proc || proc.status !== 'running') return;
    try {
      process.kill(proc.pid, 0);
      await updateHealthCheck(id, true);
    } catch (err: unknown) {
      serverLog.debug({ err: err instanceof Error ? err.message : String(err), id }, 'Health check failed — process may have exited');
      await updateHealthCheck(id, false, 'Process not found');
      await this.handleProcessExit(proc, null, 'Process missing');
    }
  }

  private cleanupTimers(proc: any): void {
    if (proc.healthCheckTimer) clearInterval(proc.healthCheckTimer);
    if (proc.restartTimer) clearTimeout(proc.restartTimer);
  }

  private async cleanupOrphans(): Promise<void> {
    const activeFromDb = await getActiveProcesses();
    const protectedPids = protectedProcessPids();
    for (const proc of activeFromDb) {
      try {
        process.kill(proc.pid, 0);
        if (!shouldKillRecoveredProcess(proc, observeProcess(proc.pid), protectedPids)) {
          serverLog.warn(
            { processId: proc.id, pid: proc.pid },
            'Refusing to kill unverified recovered PID; marking stale record orphaned',
          );
          await updateProcessStatus(proc.id, 'orphaned', { endedAt: Date.now() });
          continue;
        }
        process.kill(proc.pid, 'SIGKILL');
        await updateProcessStatus(proc.id, 'orphaned', { endedAt: Date.now() });
      } catch (err: unknown) {
        serverLog.debug({ err: err instanceof Error ? err.message : String(err), pid: proc.pid }, 'Orphan process cleanup — process already exited');
        await updateProcessStatus(proc.id, 'exited', { endedAt: Date.now() });
      }
    }
  }

  private async recoverActiveProcesses(): Promise<void> {
    const activeFromDb = await getActiveProcesses();
    for (const proc of activeFromDb)
      await updateProcessStatus(proc.id, 'exited', { endedAt: Date.now() });
  }
}

export const processSupervisor = ProcessSupervisor.getInstance();
