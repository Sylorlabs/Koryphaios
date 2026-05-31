/**
 * Process Monitor Detector
 * Detects hanging processes, resource leaks, and process-related issues
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { platform } from 'os';

import {
  BaseErrorDetector,
  type ErrorDetectorOptions,
  type ErrorDetectorCapabilities,
} from './base-detector.js';
import type { DetectedError, ErrorSource } from '@/types/index.js';
import { ErrorCategory, ErrorSeverity } from '@/types/errors.js';
import { Logger } from '@/utils/logger.js';

const execAsync = promisify(exec);

export interface ProcessMonitorConfig {
  workspaceRoot: string;
  monitorInterval: number;
  hangingProcessThreshold: number; // seconds
  memoryThreshold: number; // MB
  cpuThreshold: number; // percentage
  processPatterns: string[];
  excludePatterns: string[];
  killHangingProcesses: boolean;
  maxProcessAge: number; // seconds
  enableResourceMonitoring: boolean;
}

export interface SystemProcessInfo {
  pid: number;
  name: string;
  command: string;
  startTime: Date;
  cpuUsage: number;
  memoryUsage: number;
  status: 'running' | 'sleeping' | 'zombie' | 'stopped' | 'unknown';
  parentPid?: number;
  children: number[];
}

export interface ProcessAlert {
  type: 'hanging' | 'memory-leak' | 'cpu-spike' | 'zombie' | 'resource-exhaustion';
  process: SystemProcessInfo;
  threshold: number;
  currentValue: number;
  duration: number;
  severity: ErrorSeverity;
}

export class ProcessMonitorDetector extends BaseErrorDetector {
  private config: ProcessMonitorConfig;
  private logger: Logger;
  private monitoringTimer: NodeJS.Timeout | null = null;
  private trackedProcesses: Map<number, SystemProcessInfo> = new Map();
  private processAlerts: Map<number, ProcessAlert[]> = new Map();
  private isMonitoring = false;

  constructor(options: ErrorDetectorOptions, config?: Partial<ProcessMonitorConfig>) {
    super(options);
    this.logger = new Logger('info', { logFile: undefined });

    this.config = {
      workspaceRoot: process.cwd(),
      monitorInterval: 5000,
      hangingProcessThreshold: 300, // 5 minutes
      memoryThreshold: 1024, // 1GB
      cpuThreshold: 90,
      processPatterns: [
        'node',
        'npm',
        'yarn',
        'pnpm',
        'tsc',
        'webpack',
        'vite',
        'rollup',
        'cargo',
        'rustc',
        'go',
        'java',
        'mvn',
        'gradle',
        'python',
        'pip',
      ],
      excludePatterns: ['grep', 'ps', 'top', 'htop'],
      killHangingProcesses: false,
      maxProcessAge: 3600, // 1 hour
      enableResourceMonitoring: true,
      ...config,
    };
  }

  getSource(): ErrorSource {
    return {
      type: 'runtime',
      tool: 'process-monitor-detector',
      version: '1.0.0',
      configuration: {
        monitorInterval: this.config.monitorInterval,
        hangingThreshold: this.config.hangingProcessThreshold,
        memoryThreshold: this.config.memoryThreshold,
        cpuThreshold: this.config.cpuThreshold,
      },
    };
  }

  getCapabilities(): ErrorDetectorCapabilities {
    return {
      supportsRealTime: true,
      supportsPolling: true,
      supportsFileWatching: false,
      supportedLanguages: ['*'],
      supportedFrameworks: ['*'],
    };
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.logger.info('Starting process monitor detector');

    try {
      if (this.options.realTime) {
        await this.startRealTimeMonitoring();
      } else if (this.options.polling) {
        this.startPolling();
      }

      this.emit('detector-started');
      this.logger.info('Process monitor detector started successfully');
    } catch (error) {
      this.isRunning = false;
      this.emit('detector-error', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    this.isMonitoring = false;
    this.logger.info('Stopping process monitor detector');

    if (this.monitoringTimer) {
      clearTimeout(this.monitoringTimer);
      this.monitoringTimer = null;
    }

    this.trackedProcesses.clear();
    this.processAlerts.clear();

    this.emit('detector-stopped');
    this.logger.info('Process monitor detector stopped');
  }

  async detectErrors(target?: string): Promise<DetectedError[]> {
    if (!this.isRunning) {
      await this.start();
    }

    const errors: DetectedError[] = [];

    try {
      if (target) {
        // Monitor specific process
        const targetErrors = await this.monitorSpecificProcess(target);
        errors.push(...targetErrors);
      } else {
        // Monitor all relevant processes
        const monitoringErrors = await this.performProcessMonitoring();
        errors.push(...monitoringErrors);
      }

      // Add buffered errors
      const bufferedErrors = this.getBufferedErrors();
      errors.push(...bufferedErrors);
    } catch (error) {
      this.logger.error('Error during process monitoring', error);
      this.emit('detector-error', error);
    }

    return errors;
  }

  private async startRealTimeMonitoring(): Promise<void> {
    this.isMonitoring = true;
    await this.scheduleMonitoring();
  }

  private startPolling(): void {
    const pollInterval = this.options.polling?.interval || 30000;

    this.monitoringTimer = setTimeout(async () => {
      if (this.isRunning) {
        await this.performProcessMonitoring();
        this.startPolling(); // Schedule next poll
      }
    }, pollInterval);
  }

  private async scheduleMonitoring(): Promise<void> {
    if (!this.isMonitoring) return;

    try {
      await this.performProcessMonitoring();
    } catch (error) {
      this.logger.error('Process monitoring cycle failed', error);
      this.emit('detector-error', error);
    }

    // Schedule next monitoring cycle
    this.monitoringTimer = setTimeout(() => {
      this.scheduleMonitoring();
    }, this.config.monitorInterval);
  }

  private async performProcessMonitoring(): Promise<DetectedError[]> {
    const errors: DetectedError[] = [];

    try {
      // Get current process list
      const processes = await this.getProcessList();

      // Update tracked processes
      this.updateTrackedProcesses(processes);

      // Check for hanging processes
      const hangingProcesses = this.detectHangingProcesses();
      for (const process of hangingProcesses) {
        const error = this.createHangingProcessError(process);
        errors.push(error);
        this.addToBuffer(error);
      }

      // Check for resource issues
      if (this.config.enableResourceMonitoring) {
        const resourceIssues = this.detectResourceIssues();
        for (const issue of resourceIssues) {
          const error = this.createResourceIssueError(issue);
          errors.push(error);
          this.addToBuffer(error);
        }
      }

      // Check for zombie processes
      const zombieProcesses = this.detectZombieProcesses();
      for (const process of zombieProcesses) {
        const error = this.createZombieProcessError(process);
        errors.push(error);
        this.addToBuffer(error);
      }
    } catch (error) {
      this.logger.error('Process monitoring failed', error);
    }

    return errors;
  }

  private async getProcessList(): Promise<SystemProcessInfo[]> {
    const processes: SystemProcessInfo[] = [];

    try {
      let command: string;
      let args: string[];

      if (platform() === 'win32') {
        // Windows
        command = 'wmic';
        args = [
          'process',
          'get',
          'ProcessId,Name,CommandLine,CreationDate,PageFileUsage,WorkingSetSize',
          '/format:csv',
        ];
      } else {
        // Unix-like systems
        command = 'ps';
        args = ['-eo', 'pid,ppid,comm,cmd,etime,pcpu,pmem,stat'];
      }

      const { stdout } = await execAsync(`${command} ${args.join(' ')}`);
      const lines = stdout.trim().split('\n');

      for (const line of lines.slice(1)) {
        // Skip header
        const process = this.parseProcessLine(line);
        if (process && this.shouldMonitorProcess(process)) {
          processes.push(process);
        }
      }
    } catch (error) {
      this.logger.error('Failed to get process list', error);
    }

    return processes;
  }

  private parseProcessLine(line: string): SystemProcessInfo | null {
    try {
      const parts = line.trim().split(/\s+/);

      if (platform() === 'win32') {
        // Windows format parsing
        return this.parseWindowsProcessLine(parts);
      } else {
        // Unix format parsing
        return this.parseUnixProcessLine(parts);
      }
    } catch (error) {
      return null;
    }
  }

  private parseUnixProcessLine(parts: string[]): SystemProcessInfo | null {
    if (parts.length < 8) return null;

    const pid = parseInt(parts[0] || '0');
    const parentPid = parseInt(parts[1] || '0');
    const name = parts[2] || 'unknown';
    const command = parts.slice(3, -4).join(' ');
    const etime = parts[parts.length - 4] || '0';
    const cpuUsage = parseFloat(parts[parts.length - 3] || '0');
    const memoryUsage = parseFloat(parts[parts.length - 2] || '0');
    const stat = parts[parts.length - 1];

    // Calculate start time from etime
    const startTime = this.calculateStartTimeFromEtime(etime);

    // Parse status
    let status: SystemProcessInfo['status'] = 'unknown';
    if (stat && stat.includes('R')) status = 'running';
    else if (stat && stat.includes('S')) status = 'sleeping';
    else if (stat && stat.includes('Z')) status = 'zombie';
    else if (stat && stat.includes('T')) status = 'stopped';

    const processInfo: SystemProcessInfo = {
      pid,
      name,
      command,
      startTime,
      cpuUsage,
      memoryUsage: (memoryUsage * 1024) / 100, // Convert from percentage to MB (rough estimate)
      status,
      children: [],
    };

    if (parentPid !== pid) {
      processInfo.parentPid = parentPid;
    }

    return processInfo;
  }

  private parseWindowsProcessLine(_parts: string[]): SystemProcessInfo | null {
    // Windows parsing implementation would go here
    // For now, return null as it's more complex
    return null;
  }

  private calculateStartTimeFromEtime(etime: string): Date {
    // Parse etime format (e.g., "01:23:45" or "1-02:34:56")
    const now = new Date();
    let totalSeconds = 0;

    let timeString = etime;
    if (etime.includes('-')) {
      const [days, time] = etime.split('-');
      if (days && time) {
        totalSeconds += parseInt(days) * 24 * 60 * 60;
        timeString = time;
      }
    }

    const timeParts = timeString
      .split(':')
      .map(p => parseInt(p))
      .filter(n => !isNaN(n));
    if (timeParts.length === 3) {
      totalSeconds += (timeParts[0] || 0) * 3600 + (timeParts[1] || 0) * 60 + (timeParts[2] || 0);
    } else if (timeParts.length === 2) {
      totalSeconds += (timeParts[0] || 0) * 60 + (timeParts[1] || 0);
    }

    return new Date(now.getTime() - totalSeconds * 1000);
  }

  private shouldMonitorProcess(process: SystemProcessInfo): boolean {
    // Check if process matches monitoring patterns
    const matchesPattern = this.config.processPatterns.some(
      pattern =>
        process.name.toLowerCase().includes(pattern.toLowerCase()) ||
        process.command.toLowerCase().includes(pattern.toLowerCase())
    );

    // Check if process should be excluded
    const isExcluded = this.config.excludePatterns.some(
      pattern =>
        process.name.toLowerCase().includes(pattern.toLowerCase()) ||
        process.command.toLowerCase().includes(pattern.toLowerCase())
    );

    return matchesPattern && !isExcluded;
  }

  private updateTrackedProcesses(currentProcesses: SystemProcessInfo[]): void {
    // Update existing processes and add new ones
    for (const process of currentProcesses) {
      this.trackedProcesses.set(process.pid, process);
    }

    // Remove processes that are no longer running
    const currentPids = new Set(currentProcesses.map(p => p.pid));
    for (const [pid] of this.trackedProcesses) {
      if (!currentPids.has(pid)) {
        this.trackedProcesses.delete(pid);
        this.processAlerts.delete(pid);
      }
    }
  }

  private detectHangingProcesses(): SystemProcessInfo[] {
    const hangingProcesses: SystemProcessInfo[] = [];
    const now = new Date();

    for (const process of this.trackedProcesses.values()) {
      const ageInSeconds = (now.getTime() - process.startTime.getTime()) / 1000;

      if (ageInSeconds > this.config.hangingProcessThreshold) {
        // Check if process is actually hanging (low CPU, long runtime)
        if (process.cpuUsage < 1 && ageInSeconds > this.config.maxProcessAge) {
          hangingProcesses.push(process);
        }
      }
    }

    return hangingProcesses;
  }

  private detectResourceIssues(): ProcessAlert[] {
    const alerts: ProcessAlert[] = [];

    for (const process of this.trackedProcesses.values()) {
      // Check memory usage
      if (process.memoryUsage > this.config.memoryThreshold) {
        alerts.push({
          type: 'memory-leak',
          process,
          threshold: this.config.memoryThreshold,
          currentValue: process.memoryUsage,
          duration: (new Date().getTime() - process.startTime.getTime()) / 1000,
          severity:
            process.memoryUsage > this.config.memoryThreshold * 2
              ? ErrorSeverity.CRITICAL
              : ErrorSeverity.HIGH,
        });
      }

      // Check CPU usage
      if (process.cpuUsage > this.config.cpuThreshold) {
        alerts.push({
          type: 'cpu-spike',
          process,
          threshold: this.config.cpuThreshold,
          currentValue: process.cpuUsage,
          duration: (new Date().getTime() - process.startTime.getTime()) / 1000,
          severity: process.cpuUsage > 95 ? ErrorSeverity.CRITICAL : ErrorSeverity.HIGH,
        });
      }
    }

    return alerts;
  }

  private detectZombieProcesses(): SystemProcessInfo[] {
    return Array.from(this.trackedProcesses.values()).filter(
      process => process.status === 'zombie'
    );
  }

  private createHangingProcessError(process: SystemProcessInfo): DetectedError {
    const ageInSeconds = (new Date().getTime() - process.startTime.getTime()) / 1000;

    return {
      id: `hanging-process-${process.pid}-${Date.now()}`,
      message: `Process ${process.name} (PID: ${process.pid}) appears to be hanging for ${Math.round(ageInSeconds)} seconds`,
      type: 'HangingProcess',
      category: ErrorCategory.PERFORMANCE,
      severity:
        ageInSeconds > this.config.maxProcessAge ? ErrorSeverity.CRITICAL : ErrorSeverity.HIGH,
      stackTrace: [],
      context: {
        timestamp: new Date(),
        environment: 'system',
        metadata: {
          pid: process.pid,
          name: process.name,
          command: process.command,
          startTime: process.startTime,
          ageInSeconds: Math.round(ageInSeconds),
          cpuUsage: process.cpuUsage,
          memoryUsage: process.memoryUsage,
          status: process.status,
        },
      },
      source: this.getSource(),
      patterns: ['hanging-process'],
      confidence: 0.8,
    };
  }

  private createResourceIssueError(alert: ProcessAlert): DetectedError {
    return {
      id: `resource-issue-${alert.process.pid}-${alert.type}-${Date.now()}`,
      message: `Process ${alert.process.name} (PID: ${alert.process.pid}) ${alert.type}: ${alert.currentValue} exceeds threshold ${alert.threshold}`,
      type: 'ResourceIssue',
      category: ErrorCategory.PERFORMANCE,
      severity: alert.severity,
      stackTrace: [],
      context: {
        timestamp: new Date(),
        environment: 'system',
        metadata: {
          pid: alert.process.pid,
          name: alert.process.name,
          command: alert.process.command,
          alertType: alert.type,
          threshold: alert.threshold,
          currentValue: alert.currentValue,
          duration: alert.duration,
          startTime: alert.process.startTime,
        },
      },
      source: this.getSource(),
      patterns: [alert.type],
      confidence: 0.9,
    };
  }

  private createZombieProcessError(process: SystemProcessInfo): DetectedError {
    return {
      id: `zombie-process-${process.pid}-${Date.now()}`,
      message: `Zombie process detected: ${process.name} (PID: ${process.pid})`,
      type: 'ZombieProcess',
      category: ErrorCategory.RUNTIME,
      severity: ErrorSeverity.MEDIUM,
      stackTrace: [],
      context: {
        timestamp: new Date(),
        environment: 'system',
        metadata: {
          pid: process.pid,
          name: process.name,
          command: process.command,
          parentPid: process.parentPid,
          startTime: process.startTime,
        },
      },
      source: this.getSource(),
      patterns: ['zombie-process'],
      confidence: 1.0,
    };
  }

  private async monitorSpecificProcess(target: string): Promise<DetectedError[]> {
    const errors: DetectedError[] = [];

    try {
      // Target could be PID or process name
      const pid = parseInt(target);
      let targetProcess: SystemProcessInfo | undefined;

      if (!isNaN(pid)) {
        // Monitor by PID
        targetProcess = this.trackedProcesses.get(pid);
      } else {
        // Monitor by name
        targetProcess = Array.from(this.trackedProcesses.values()).find(p =>
          p.name.toLowerCase().includes(target.toLowerCase())
        );
      }

      if (targetProcess) {
        // Check if this specific process has issues
        const ageInSeconds = (new Date().getTime() - targetProcess.startTime.getTime()) / 1000;

        if (ageInSeconds > this.config.hangingProcessThreshold && targetProcess.cpuUsage < 1) {
          const error = this.createHangingProcessError(targetProcess);
          errors.push(error);
        }

        if (targetProcess.memoryUsage > this.config.memoryThreshold) {
          const alert: ProcessAlert = {
            type: 'memory-leak',
            process: targetProcess,
            threshold: this.config.memoryThreshold,
            currentValue: targetProcess.memoryUsage,
            duration: ageInSeconds,
            severity: ErrorSeverity.HIGH,
          };
          const error = this.createResourceIssueError(alert);
          errors.push(error);
        }
      }
    } catch (error) {
      this.logger.error('Failed to monitor specific process', error);
    }

    return errors;
  }

  // Public API
  getTrackedProcesses(): SystemProcessInfo[] {
    return Array.from(this.trackedProcesses.values());
  }

  getProcessAlerts(): Map<number, ProcessAlert[]> {
    return new Map(this.processAlerts);
  }

  async killProcess(pid: number, signal: string = 'SIGTERM'): Promise<boolean> {
    try {
      process.kill(pid, signal as NodeJS.Signals);
      this.logger.info(`Killed process ${pid} with signal ${signal}`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to kill process ${pid}`, error);
      return false;
    }
  }

  updateConfig(newConfig: Partial<ProcessMonitorConfig>): void {
    this.config = { ...this.config, ...newConfig };
    this.emit('config-updated', this.config);
  }
}
