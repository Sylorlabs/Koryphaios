/**
 * Process Supervisor
 */

import { nanoid } from 'nanoid';
import { serverLog } from '../logger';
import { wsManager } from '../ws/ws-manager';
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

const DEFAULT_CONFIG: SupervisorConfig = {
  maxRestarts: 3,
  restartDelayMs: 5000,
  healthCheckIntervalMs: 30000,
  maxConsecutiveFailures: 3,
  orphanCheckOnStartup: true,
  logRetentionDays: 7,
};

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
    const proc = Bun.spawn(['bash', '-c', options.command], {
      cwd: options.cwd,
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
    this.readStream(proc.stdout.getReader(), id, 'stdout');
    this.readStream(proc.stderr.getReader(), id, 'stderr');
    this.monitorExit(supervised);
    this.startHealthChecks(id);
    return supervised;
  }

  async killProcess(id: string, signal: string = 'SIGTERM'): Promise<boolean> {
    const proc = this.processes.get(id);
    if (!proc) return false;
    try {
      await logProcessEvent(id, 'kill_requested', { signal });
      proc.signal = signal;
      if (proc.proc) proc.proc.kill(signal as any);
      else process.kill(proc.pid, signal as any);
      proc.status = 'killed';
      proc.endedAt = Date.now();
      await updateProcessStatus(id, 'killed', { signal, endedAt: proc.endedAt });
      this.cleanupTimers(proc);
      this.processes.delete(id);
      return true;
    } catch {
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
    } catch {}
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
    const status: PersistedProcess['status'] = wasKilled ? 'killed' : isCrash ? 'crashed' : 'exited';
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
    if (!wasKilled && this.shouldRestart(proc, isCrash)) this.scheduleRestart(proc);
    else this.processes.delete(proc.id);
  }

  private shouldRestart(proc: any, isCrash: boolean): boolean {
    if (proc.restartPolicy === 'never') return false;
    return proc.restartCount < proc.maxRestarts && (proc.restartPolicy === 'always' || isCrash);
  }

  private scheduleRestart(proc: any): void {
    setTimeout(async () => {
      await incrementRestartCount(proc.id);
      await this.startProcess(proc);
    }, 5000);
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
    } catch {
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
    for (const proc of activeFromDb) {
      try {
        process.kill(proc.pid, 0);
        process.kill(proc.pid, 'SIGKILL');
        await updateProcessStatus(proc.id, 'orphaned', { endedAt: Date.now() });
      } catch {
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
