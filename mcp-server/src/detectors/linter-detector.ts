/**
 * Linter error detector for capturing errors from linting tools
 */

import { spawn, type ChildProcess } from 'child_process';
import { watch, type FSWatcher } from 'fs';
import { resolve } from 'path';
import type { DetectedError, ErrorSource, ErrorContext, ErrorStackFrame } from '@/types/index.js';
import {
  BaseErrorDetector,
  type ErrorDetectorOptions,
  type ErrorDetectorCapabilities,
} from './base-detector.js';

interface LinterConfig {
  projectRoot: string;
  eslintConfigPath?: string;
  linterCommand: 'eslint' | 'tslint' | 'pylint' | 'flake8';
  extensions: string[];
  watchMode: boolean;
  pollInterval: number;
}

interface LinterError {
  file: string;
  line: number;
  column: number;
  rule: string;
  message: string;
  severity: 'error' | 'warning';
}

export class LinterErrorDetector extends BaseErrorDetector {
  private config: LinterConfig;
  private linterProcess?: ChildProcess | undefined;
  private fileWatcher?: FSWatcher | undefined;
  private pollingTimer?: NodeJS.Timeout | undefined;
  private lastLintTime = 0;

  constructor(options: ErrorDetectorOptions, config?: Partial<LinterConfig>) {
    super(options);

    this.config = {
      projectRoot: process.cwd(),
      eslintConfigPath: '.eslintrc.js',
      linterCommand: 'eslint',
      extensions: ['.js', '.jsx', '.ts', '.tsx'],
      watchMode: false,
      pollInterval: 5000,
      ...config,
    };
  }

  getSource(): ErrorSource {
    return {
      type: 'linter',
      tool: 'linter-detector',
      version: '1.0.0',
    };
  }

  getCapabilities(): ErrorDetectorCapabilities {
    return {
      supportsRealTime: true,
      supportsPolling: true,
      supportsFileWatching: true,
      supportedLanguages: ['javascript', 'typescript', 'python', 'go', 'rust'],
      supportedFrameworks: ['eslint', 'tslint', 'pylint', 'flake8', 'golint', 'clippy'],
    };
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;

    try {
      // Verify linter is available
      await this.verifyLinterAvailable();

      // Start file watching if enabled
      if (this.options.realTime) {
        await this.startFileWatching();
      }

      // Start polling if enabled
      if (this.options.polling) {
        this.startPolling();
      }

      // Run initial lint check
      await this.runLintCheck();

      this.emit('detector-started');
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

    // Stop linter process
    if (this.linterProcess) {
      this.linterProcess.kill();
      this.linterProcess = undefined;
    }

    // Stop file watcher
    if (this.fileWatcher) {
      this.fileWatcher.close();
      this.fileWatcher = undefined;
    }

    // Stop polling
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = undefined;
    }

    this.emit('detector-stopped');
  }

  async detectErrors(target?: string): Promise<DetectedError[]> {
    if (!this.isRunning) {
      await this.start();
    }

    // If target is specified, lint specific file/directory
    if (target) {
      return await this.lintSpecificTarget(target);
    }

    // Otherwise run full lint check
    await this.runLintCheck();
    return this.getBufferedErrors();
  }

  private async verifyLinterAvailable(): Promise<void> {
    return new Promise((resolve, reject) => {
      const linter = spawn('npx', [this.config.linterCommand, '--version'], { stdio: 'pipe' });

      linter.on('close', code => {
        if (code === 0) {
          resolve();
        } else {
          reject(
            new Error(
              `${this.config.linterCommand} not found. Please install it globally or locally.`
            )
          );
        }
      });

      linter.on('error', () => {
        reject(
          new Error(
            `${this.config.linterCommand} not found. Please install it globally or locally.`
          )
        );
      });
    });
  }

  private async startFileWatching(): Promise<void> {
    try {
      // Watch for changes in source files
      this.fileWatcher = watch(
        this.config.projectRoot,
        { recursive: true },
        (_eventType, filename) => {
          if (filename && this.shouldLintFile(filename)) {
            // Debounce file changes
            const now = Date.now();
            if (now - this.lastLintTime > 1000) {
              this.lastLintTime = now;
              setTimeout(() => this.runLintCheck(), 500);
            }
          }
        }
      );
    } catch (error) {
      throw new Error(`Failed to start file watching: ${error}`);
    }
  }

  private shouldLintFile(filename: string): boolean {
    return this.config.extensions.some(ext => filename.endsWith(ext));
  }

  private startPolling(): void {
    if (this.options.polling?.interval) {
      this.pollingTimer = setInterval(() => {
        this.runLintCheck().catch(error => {
          this.emit('detector-error', error);
        });
      }, this.options.polling.interval);
    }
  }

  private async runLintCheck(): Promise<void> {
    try {
      const errors = await this.runESLintCheck();

      // Clear previous lint errors and add new ones
      this.clearBuffer();

      for (const error of errors) {
        const detectedError = this.convertLinterErrorToDetectedError(error);
        this.addToBuffer(detectedError);
      }
    } catch (error) {
      this.emit('detector-error', error);
    }
  }

  private async runESLintCheck(): Promise<LinterError[]> {
    return new Promise((resolve, reject) => {
      const args = [
        '--format',
        'json',
        '--ext',
        this.config.extensions.join(','),
        this.config.projectRoot,
      ];

      const eslint = spawn('npx', [this.config.linterCommand, ...args], {
        cwd: this.config.projectRoot,
        stdio: 'pipe',
      });

      let stdout = '';
      let stderr = '';

      eslint.stdout?.on('data', data => {
        stdout += data.toString();
      });

      eslint.stderr?.on('data', data => {
        stderr += data.toString();
      });

      eslint.on('close', _code => {
        try {
          // ESLint returns non-zero exit code when there are errors
          const errors = this.parseESLintOutput(stdout);
          resolve(errors);
        } catch (parseError) {
          reject(new Error(`Failed to parse ESLint output: ${parseError}`));
        }
      });

      eslint.on('error', error => {
        reject(new Error(`Failed to run ESLint: ${error.message}`));
      });
    });
  }

  private parseESLintOutput(output: string): LinterError[] {
    const errors: LinterError[] = [];

    try {
      const results = JSON.parse(output);

      for (const result of results) {
        const filePath = result.filePath;

        for (const message of result.messages) {
          errors.push({
            file: filePath,
            line: message.line || 1,
            column: message.column || 1,
            rule: message.ruleId || 'unknown',
            message: message.message,
            severity: message.severity === 2 ? 'error' : 'warning',
          });
        }
      }
    } catch (parseError) {
      // If JSON parsing fails, try to parse as text output
      const lines = output.split('\n');
      for (const line of lines) {
        const error = this.parseESLintTextLine(line);
        if (error) {
          errors.push(error);
        }
      }
    }

    return errors;
  }

  private parseESLintTextLine(line: string): LinterError | null {
    // ESLint text format: file:line:column: message [rule/code]
    const textRegex = /^(.+?):(\d+):(\d+):\s+(error|warning)\s+(.+?)\s+(\S+)$/;
    const match = line.match(textRegex);

    if (match) {
      const [, file, line, column, severity, message, rule] = match;
      return {
        file: resolve(this.config.projectRoot, file || ''),
        line: parseInt(line || '1', 10),
        column: parseInt(column || '1', 10),
        rule: rule || 'unknown',
        message: (message || '').trim(),
        severity: (severity as 'error' | 'warning') || 'error',
      };
    }

    return null;
  }

  private convertLinterErrorToDetectedError(lintError: LinterError): DetectedError {
    const stackTrace: ErrorStackFrame[] = [
      {
        location: {
          file: lintError.file,
          line: lintError.line,
          column: lintError.column,
          function: undefined,
        },
        source: `${lintError.file}:${lintError.line}:${lintError.column}`,
      },
    ];

    const baseError = this.createBaseError(
      `${lintError.rule}: ${lintError.message}`,
      'LintError',
      stackTrace
    );

    const context: ErrorContext = {
      timestamp: new Date(),
      environment: 'linter',
      metadata: {
        tool: this.config.linterCommand,
        rule: lintError.rule,
        severity: lintError.severity,
        file: lintError.file,
        line: lintError.line,
        column: lintError.column,
      },
    };

    return {
      id: this.generateErrorId(),
      ...baseError,
      context,
      source: this.getSource(),
    };
  }

  private async lintSpecificTarget(target: string): Promise<DetectedError[]> {
    const errors: DetectedError[] = [];

    try {
      // If target is a specific file, lint it
      if (this.shouldLintFile(target)) {
        const lintErrors = await this.lintFile(target);
        for (const lintError of lintErrors) {
          errors.push(this.convertLinterErrorToDetectedError(lintError));
        }
      }
      // If target is a directory, lint all files in it
      else {
        await this.runLintCheck();
        return this.getBufferedErrors();
      }
    } catch (error) {
      this.emit('detector-error', error);
    }

    return errors;
  }

  private async lintFile(filePath: string): Promise<LinterError[]> {
    return new Promise((resolve, reject) => {
      const args = ['--format', 'json', filePath];

      const eslint = spawn('npx', [this.config.linterCommand, ...args], {
        cwd: this.config.projectRoot,
        stdio: 'pipe',
      });

      let stdout = '';
      let stderr = '';

      eslint.stdout?.on('data', data => {
        stdout += data.toString();
      });

      eslint.stderr?.on('data', data => {
        stderr += data.toString();
      });

      eslint.on('close', () => {
        try {
          const errors = this.parseESLintOutput(stdout);
          resolve(errors);
        } catch (parseError) {
          reject(new Error(`Failed to parse ESLint output: ${parseError}`));
        }
      });

      eslint.on('error', error => {
        reject(new Error(`Failed to lint file: ${error.message}`));
      });
    });
  }
}

// Alias for backward compatibility
export { LinterErrorDetector as LinterDetector };
