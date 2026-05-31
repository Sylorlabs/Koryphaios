/**
 * Process management utilities for running external tools and debuggers
 */

import { spawn, ChildProcess, type SpawnOptions } from 'child_process';
import { EventEmitter } from 'events';

import { generateId } from './helpers.js';

export interface ProcessInfo {
  id: string;
  command: string;
  args: string[];
  pid: number | undefined;
  status: 'starting' | 'running' | 'stopped' | 'error';
  startTime: Date;
  endTime: Date | undefined;
  exitCode: number | undefined;
  signal: string | undefined;
}

export interface ProcessOptions extends SpawnOptions {
  timeout?: number;
  killSignal?: NodeJS.Signals;
  maxBuffer?: number;
}

export class ProcessManager extends EventEmitter {
  private processes: Map<string, ChildProcess> = new Map();
  private processInfo: Map<string, ProcessInfo> = new Map();

  spawn(
    command: string,
    args: string[] = [],
    options: ProcessOptions = {}
  ): Promise<{ id: string; process: ChildProcess }> {
    return new Promise((resolve, reject) => {
      const id = generateId('proc');
      const startTime = new Date();

      const processInfo: ProcessInfo = {
        id,
        command,
        args,
        pid: undefined,
        status: 'starting',
        startTime,
        endTime: undefined,
        exitCode: undefined,
        signal: undefined,
      };

      this.processInfo.set(id, processInfo);

      const spawnOptions: SpawnOptions = {
        stdio: ['pipe', 'pipe', 'pipe'],
        ...options,
      };

      try {
        const childProcess = spawn(command, args, spawnOptions);

        this.processes.set(id, childProcess);
        processInfo.pid = childProcess.pid;
        processInfo.status = 'running';

        // Set up event handlers
        childProcess.on('spawn', () => {
          this.emit('process:started', { id, pid: childProcess.pid });
          resolve({ id, process: childProcess });
        });

        childProcess.on('error', error => {
          processInfo.status = 'error';
          processInfo.endTime = new Date();
          this.emit('process:error', { id, error });
          reject(error);
        });

        childProcess.on('exit', (code, signal) => {
          processInfo.status = 'stopped';
          processInfo.endTime = new Date();
          processInfo.exitCode = code || undefined;
          processInfo.signal = signal || undefined;

          this.processes.delete(id);
          this.emit('process:exited', { id, code, signal });
        });

        // Handle timeout
        if (options.timeout) {
          setTimeout(() => {
            if (this.processes.has(id)) {
              this.kill(id, options.killSignal || 'SIGTERM');
            }
          }, options.timeout);
        }
      } catch (error) {
        processInfo.status = 'error';
        processInfo.endTime = new Date();
        reject(error);
      }
    });
  }

  async exec(
    command: string,
    args: string[] = [],
    options: ProcessOptions = {}
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const { process } = await this.spawn(command, args, options);

    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';

      if (process.stdout) {
        process.stdout.on('data', data => {
          stdout += data.toString();
        });
      }

      if (process.stderr) {
        process.stderr.on('data', data => {
          stderr += data.toString();
        });
      }

      process.on('exit', code => {
        resolve({
          stdout,
          stderr,
          exitCode: code ?? -1,
        });
      });

      process.on('error', error => {
        reject(error);
      });
    });
  }

  kill(id: string, signal: NodeJS.Signals = 'SIGTERM'): boolean {
    const process = this.processes.get(id);
    if (!process) {
      return false;
    }

    try {
      process.kill(signal);
      return true;
    } catch (error) {
      this.emit('process:error', { id, error });
      return false;
    }
  }

  killAll(signal: NodeJS.Signals = 'SIGTERM'): void {
    for (const [id] of this.processes) {
      this.kill(id, signal);
    }
  }

  getProcess(id: string): ChildProcess | undefined {
    return this.processes.get(id);
  }

  getProcessInfo(id: string): ProcessInfo | undefined {
    return this.processInfo.get(id);
  }

  listProcesses(): ProcessInfo[] {
    return Array.from(this.processInfo.values());
  }

  getRunningProcesses(): ProcessInfo[] {
    return this.listProcesses().filter(info => info.status === 'running');
  }

  isProcessRunning(id: string): boolean {
    const info = this.processInfo.get(id);
    return info?.status === 'running' || false;
  }

  // Utility methods for common operations
  async runLinter(
    linter: string,
    files: string[],
    options: ProcessOptions = {}
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const args = [...files];
    return this.exec(linter, args, options);
  }

  async runTypeChecker(
    checker: string,
    configPath?: string,
    options: ProcessOptions = {}
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const args = configPath ? ['--project', configPath] : [];
    return this.exec(checker, args, options);
  }

  async runTests(
    testRunner: string,
    testFiles?: string[],
    options: ProcessOptions = {}
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const args = testFiles ? [...testFiles] : [];
    return this.exec(testRunner, args, options);
  }

  async runBuild(
    buildTool: string,
    buildScript?: string,
    options: ProcessOptions = {}
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const args = buildScript ? [buildScript] : [];
    return this.exec(buildTool, args, options);
  }

  // Debug session management
  async startDebugSession(
    debuggerPath: string,
    target: string,
    debugArgs: string[] = [],
    options: ProcessOptions = {}
  ): Promise<{ id: string; process: ChildProcess }> {
    const args = [...debugArgs, target];
    return this.spawn(debuggerPath, args, {
      ...options,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  async attachDebugger(
    debuggerPath: string,
    pid: number,
    options: ProcessOptions = {}
  ): Promise<{ id: string; process: ChildProcess }> {
    const args = ['--attach', pid.toString()];
    return this.spawn(debuggerPath, args, options);
  }

  // Performance profiling
  async startProfiler(
    profiler: string,
    target: string,
    duration?: number,
    options: ProcessOptions = {}
  ): Promise<{ id: string; process: ChildProcess }> {
    const args = [target];
    if (duration) {
      args.push('--duration', duration.toString());
    }

    const finalOptions: ProcessOptions = {
      ...options,
    };

    if (duration) {
      finalOptions.timeout = duration + 5000; // Add 5s buffer
    }

    return this.spawn(profiler, args, finalOptions);
  }

  // Memory analysis
  async analyzeMemory(
    analyzer: string,
    target: string,
    options: ProcessOptions = {}
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const args = [target];
    return this.exec(analyzer, args, options);
  }

  // Cleanup
  cleanup(): void {
    this.killAll('SIGTERM');

    // Force kill after timeout
    setTimeout(() => {
      this.killAll('SIGKILL');
    }, 5000);

    this.processes.clear();
    this.processInfo.clear();
  }
}
