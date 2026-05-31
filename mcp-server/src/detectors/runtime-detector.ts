/**
 * Runtime error detector for capturing errors during code execution
 */

import { spawn } from 'child_process';

import type { DetectedError, ErrorSource, ErrorContext } from '@/types/index.js';
import {
  BaseErrorDetector,
  type ErrorDetectorOptions,
  type ErrorDetectorCapabilities,
} from './base-detector.js';

export interface RuntimeDetectorConfig {
  watchedProcesses: string[];
  logFiles: string[];
  errorPatterns: RegExp[];
  excludePatterns: RegExp[];
}

export class RuntimeErrorDetector extends BaseErrorDetector {
  private config: RuntimeDetectorConfig;
  private watchedProcesses: Map<string, any> = new Map();
  private logWatchers: Map<string, any> = new Map();
  private pollingInterval: NodeJS.Timeout | null = null;
  private isPolling = false;

  constructor(
    options: ErrorDetectorOptions,
    config: RuntimeDetectorConfig = {
      watchedProcesses: [],
      logFiles: [],
      errorPatterns: [/error/i, /exception/i, /failed/i, /fatal/i, /critical/i],
      excludePatterns: [/debug/i, /info/i, /trace/i],
    }
  ) {
    super(options);
    this.config = config;
  }

  getSource(): ErrorSource {
    return {
      type: 'runtime',
      tool: 'runtime-detector',
      version: '1.0.0',
    };
  }

  getCapabilities(): ErrorDetectorCapabilities {
    return {
      supportsRealTime: true,
      supportsPolling: true,
      supportsFileWatching: true,
      supportedLanguages: ['javascript', 'typescript', 'python', 'go', 'rust'],
      supportedFrameworks: ['node', 'express', 'fastify', 'django', 'flask', 'gin', 'actix'],
    };
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;

    if (this.options.realTime) {
      await this.startRealTimeMonitoring();
    } else if (this.options.polling) {
      this.startPolling();
    }

    this.emit('detector-started');
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    // Stop polling
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }

    // Stop process monitoring
    for (const [, process] of this.watchedProcesses) {
      try {
        process.kill();
      } catch (error) {
        // Process might already be dead
      }
    }
    this.watchedProcesses.clear();

    // Stop log file watching
    for (const [, watcher] of this.logWatchers) {
      try {
        watcher.close();
      } catch (error) {
        // Watcher might already be closed
      }
    }
    this.logWatchers.clear();

    this.emit('detector-stopped');
  }

  async detectErrors(target?: string): Promise<DetectedError[]> {
    const errors: DetectedError[] = [];

    if (target) {
      // Detect errors in specific target (file, process, etc.)
      const targetErrors = await this.detectErrorsInTarget(target);
      errors.push(...targetErrors);
    } else {
      // Return buffered errors
      errors.push(...this.getBufferedErrors());
    }

    return errors;
  }

  private async startRealTimeMonitoring(): Promise<void> {
    // Monitor log files
    for (const logFile of this.config.logFiles) {
      await this.watchLogFile(logFile);
    }

    // Monitor processes
    for (const processName of this.config.watchedProcesses) {
      await this.watchProcess(processName);
    }
  }

  private startPolling(): void {
    if (!this.options.polling) {
      return;
    }

    this.pollingInterval = setInterval(async () => {
      try {
        await this.pollForErrors();
      } catch (error) {
        this.emit('detector-error', error);
      }
    }, this.options.polling.interval);
  }

  private async watchLogFile(logFile: string): Promise<void> {
    try {
      // Use tail -f to watch log file
      const tailProcess = spawn('tail', ['-f', logFile], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      tailProcess.stdout?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n');
        for (const line of lines) {
          if (line.trim()) {
            this.processLogLine(line, logFile);
          }
        }
      });

      tailProcess.stderr?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n');
        for (const line of lines) {
          if (line.trim()) {
            this.processLogLine(line, logFile);
          }
        }
      });

      tailProcess.on('error', error => {
        this.emit('detector-error', error);
      });

      this.logWatchers.set(logFile, tailProcess);
    } catch (error) {
      this.emit('detector-error', error);
    }
  }

  private async watchProcess(processName: string): Promise<void> {
    try {
      // Use ps to find process and monitor its output
      const psProcess = spawn('ps', ['aux'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      psProcess.stdout?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n');
        for (const line of lines) {
          if (line.includes(processName)) {
            // Extract PID and monitor the process
            const parts = line.trim().split(/\s+/);
            const pid = parts[1];
            if (pid && !this.watchedProcesses.has(pid)) {
              this.monitorProcessById(pid);
            }
          }
        }
      });

      psProcess.on('error', error => {
        this.emit('detector-error', error);
      });
    } catch (error) {
      this.emit('detector-error', error);
    }
  }

  private monitorProcessById(pid: string): void {
    try {
      // Monitor process stderr for errors
      const stderrProcess = spawn('strace', ['-p', pid, '-e', 'write'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      stderrProcess.stderr?.on('data', (data: Buffer) => {
        const output = data.toString();
        if (this.containsError(output)) {
          this.processRuntimeError(output, pid);
        }
      });

      stderrProcess.on('error', () => {
        // strace might not be available or permission denied
        // Fall back to other monitoring methods
      });

      this.watchedProcesses.set(pid, stderrProcess);
    } catch (error) {
      this.emit('detector-error', error);
    }
  }

  private async pollForErrors(): Promise<void> {
    if (this.isPolling) {
      return;
    }

    this.isPolling = true;
    try {
      // Poll system logs for errors
      await this.checkSystemLogs();

      // Poll application logs
      for (const logFile of this.config.logFiles) {
        await this.checkLogFile(logFile);
      }
    } finally {
      this.isPolling = false;
    }
  }

  private async checkSystemLogs(): Promise<void> {
    return new Promise((resolve) => {
      try {
        // Check journalctl for recent errors (Linux)
        const journalProcess = spawn('journalctl', ['-n', '100', '--no-pager'], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        journalProcess.stdout?.on('data', (data: Buffer) => {
          const lines = data.toString().split('\n');
          for (const line of lines) {
            if (this.containsError(line)) {
              this.processLogLine(line, 'system-journal');
            }
          }
        });

        journalProcess.on('close', () => {
          resolve();
        });

        journalProcess.on('error', () => {
          // journalctl not available, try other methods
          this.checkAlternativeSystemLogs().then(resolve);
        });
      } catch (error) {
        this.emit('detector-error', error);
        resolve();
      }
    });
  }

  private async checkAlternativeSystemLogs(): Promise<void> {
    // Check common log files
    const commonLogFiles = ['/var/log/syslog', '/var/log/messages', '/var/log/kern.log'];

    for (const logFile of commonLogFiles) {
      try {
        await this.checkLogFile(logFile);
      } catch (error) {
        // Log file might not exist or be accessible
      }
    }
  }

  private async checkLogFile(logFile: string): Promise<void> {
    return new Promise((resolve) => {
      try {
        const tailProcess = spawn('tail', ['-n', '50', logFile], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        tailProcess.stdout?.on('data', (data: Buffer) => {
          const lines = data.toString().split('\n');
          for (const line of lines) {
            if (line.trim() && this.containsError(line)) {
              this.processLogLine(line, logFile);
            }
          }
        });

        tailProcess.on('close', () => {
          resolve();
        });

        tailProcess.on('error', error => {
          this.emit('detector-error', error);
          resolve();
        });
      } catch (error) {
        this.emit('detector-error', error);
        resolve();
      }
    });
  }

  private containsError(text: string): boolean {
    // Check if text matches error patterns
    for (const pattern of this.config.errorPatterns) {
      if (pattern.test(text)) {
        // Make sure it doesn't match exclude patterns
        const isExcluded = this.config.excludePatterns.some(excludePattern =>
          excludePattern.test(text)
        );
        if (!isExcluded) {
          return true;
        }
      }
    }
    return false;
  }

  private processLogLine(line: string, source: string): void {
    try {
      const error = this.parseLogLineToError(line, source);
      if (error) {
        this.addToBuffer(error);
      }
    } catch (error) {
      this.emit('detector-error', error);
    }
  }

  private processRuntimeError(output: string, pid: string): void {
    try {
      const error = this.parseRuntimeErrorToError(output, pid);
      if (error) {
        this.addToBuffer(error);
      }
    } catch (error) {
      this.emit('detector-error', error);
    }
  }

  private parseLogLineToError(line: string, source: string): DetectedError | null {
    // Extract timestamp, level, message from log line
    const timestampMatch = line.match(/(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2})/);
    const timestamp = timestampMatch ? new Date(timestampMatch[1]!) : new Date();

    // Extract error level
    const levelMatch = line.match(/\b(ERROR|FATAL|CRITICAL|EXCEPTION)\b/i);
    const level = levelMatch ? levelMatch[1]!.toUpperCase() : 'ERROR';

    // Extract the actual error message
    let message = line;
    if (timestampMatch) {
      message = line.substring(timestampMatch.index! + timestampMatch[0].length).trim();
    }

    const baseError = this.createBaseError(message, level);

    const context: ErrorContext = {
      timestamp,
      environment: 'runtime',
      metadata: {
        source,
        originalLine: line,
      },
    };

    return {
      id: this.generateErrorId(),
      ...baseError,
      context,
      source: this.getSource(),
    };
  }

  private parseRuntimeErrorToError(output: string, pid: string): DetectedError | null {
    const baseError = this.createBaseError(output, 'RuntimeError');

    const context: ErrorContext = {
      timestamp: new Date(),
      environment: 'runtime',
      metadata: {
        pid,
        source: 'process-monitor',
      },
    };

    return {
      id: this.generateErrorId(),
      ...baseError,
      context,
      source: this.getSource(),
    };
  }

  private async detectErrorsInTarget(target: string): Promise<DetectedError[]> {
    const errors: DetectedError[] = [];

    try {
      // If target is a file, check it for errors
      if (target.endsWith('.log') || target.includes('/log/')) {
        await this.checkLogFile(target);
      }
      // If target is a process name, monitor it
      else {
        await this.watchProcess(target);
      }
    } catch (error) {
      this.emit('detector-error', error);
    }

    return errors;
  }

  updateConfig(newConfig: Partial<RuntimeDetectorConfig>): void {
    this.config = { ...this.config, ...newConfig };
    this.emit('config-updated', this.config);
  }

  getConfig(): RuntimeDetectorConfig {
    return { ...this.config };
  }
}

// Alias for backward compatibility
export { RuntimeErrorDetector as RuntimeDetector };
