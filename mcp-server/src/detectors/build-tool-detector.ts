/**
 * Build Tool Error Detector
 * Detects failures in various build tools and processes
 */

import { spawn, type ChildProcess } from 'child_process';

import { join, extname } from 'path';
import { watch, type FSWatcher } from 'chokidar';

import {
  BaseErrorDetector,
  type ErrorDetectorOptions,
  type ErrorDetectorCapabilities,
} from './base-detector.js';
import type { DetectedError, ErrorSource } from '@/types/index.js';
import { ErrorCategory, ErrorSeverity } from '@/types/errors.js';
import { Logger } from '@/utils/logger.js';

export interface BuildToolConfig {
  workspaceRoot: string;
  buildTools: BuildToolDefinition[];
  watchConfigFiles: boolean;
  timeoutMs: number;
  retryAttempts: number;
  parallelBuilds: boolean;
  maxConcurrentBuilds: number;
}

export interface BuildToolDefinition {
  name: string;
  command: string;
  args: string[];
  configFiles: string[];
  outputPatterns: string[];
  errorPatterns: RegExp[];
  languages: string[];
  frameworks: string[];
  enabled: boolean;
}

export interface BuildProcess {
  id: string;
  tool: BuildToolDefinition;
  process: ChildProcess;
  startTime: Date;
  status: 'running' | 'completed' | 'failed' | 'timeout' | 'killed';
  output: string[];
  errors: string[];
}

export class BuildToolDetector extends BaseErrorDetector {
  private config: BuildToolConfig;
  private logger: Logger;
  private fileWatcher: FSWatcher | null = null;
  private buildProcesses: Map<string, BuildProcess> = new Map();
  private pollingTimer: NodeJS.Timeout | null = null;

  constructor(options: ErrorDetectorOptions, config?: Partial<BuildToolConfig>) {
    super(options);
    this.logger = new Logger('info', { logFile: undefined });

    this.config = {
      workspaceRoot: process.cwd(),
      watchConfigFiles: true,
      timeoutMs: 30000,
      retryAttempts: 2,
      parallelBuilds: true,
      maxConcurrentBuilds: 3,
      buildTools: this.getDefaultBuildTools(),
      ...config,
    };
  }

  getSource(): ErrorSource {
    return {
      type: 'build',
      tool: 'build-tool-detector',
      version: '1.0.0',
      configuration: {
        enabledTools: this.config.buildTools.filter(t => t.enabled).map(t => t.name),
        parallelBuilds: this.config.parallelBuilds,
        maxConcurrentBuilds: this.config.maxConcurrentBuilds,
      },
    };
  }

  getCapabilities(): ErrorDetectorCapabilities {
    return {
      supportsRealTime: true,
      supportsPolling: true,
      supportsFileWatching: true,
      supportedLanguages: [
        'typescript',
        'javascript',
        'python',
        'go',
        'rust',
        'java',
        'c',
        'cpp',
        'csharp',
      ],
      supportedFrameworks: [
        'webpack',
        'vite',
        'rollup',
        'parcel',
        'esbuild',
        'swc',
        'babel',
        'maven',
        'gradle',
        'cargo',
        'go-build',
        'msbuild',
        'make',
        'cmake',
      ],
    };
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.logger.info('Starting build tool detector');

    try {
      // Start file watching for config files
      if (this.options.realTime && this.config.watchConfigFiles) {
        await this.startConfigFileWatching();
      }

      // Start polling if enabled
      if (this.options.polling) {
        this.startPolling();
      }

      // Detect available build tools
      await this.detectAvailableBuildTools();

      this.emit('detector-started');
      this.logger.info('Build tool detector started successfully');
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
    this.logger.info('Stopping build tool detector');

    // Stop file watching
    if (this.fileWatcher) {
      await this.fileWatcher.close();
      this.fileWatcher = null;
    }

    // Stop polling
    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = null;
    }

    // Kill running build processes
    for (const [, buildProcess] of this.buildProcesses) {
      if (buildProcess.status === 'running') {
        buildProcess.process.kill('SIGTERM');
        buildProcess.status = 'killed';
      }
    }

    this.buildProcesses.clear();
    this.emit('detector-stopped');
    this.logger.info('Build tool detector stopped');
  }

  async detectErrors(target?: string): Promise<DetectedError[]> {
    if (!this.isRunning) {
      await this.start();
    }

    const errors: DetectedError[] = [];

    try {
      if (target) {
        // Check specific target
        const targetErrors = await this.checkSpecificTarget(target);
        errors.push(...targetErrors);
      } else {
        // Run all enabled build tools
        const buildErrors = await this.runAllBuildTools();
        errors.push(...buildErrors);
      }

      // Add buffered errors
      const bufferedErrors = this.getBufferedErrors();
      errors.push(...bufferedErrors);
    } catch (error) {
      this.logger.error('Error during build tool detection', error);
      this.emit('detector-error', error);
    }

    return errors;
  }

  private getDefaultBuildTools(): BuildToolDefinition[] {
    return [
      {
        name: 'TypeScript',
        command: 'tsc',
        args: ['--noEmit'],
        configFiles: ['tsconfig.json', 'tsconfig.build.json'],
        outputPatterns: ['dist/**/*', 'build/**/*'],
        errorPatterns: [
          /error TS\d+:/i,
          /Cannot find module/i,
          /Type .* is not assignable to type/i,
        ],
        languages: ['typescript'],
        frameworks: ['typescript'],
        enabled: true,
      },
      {
        name: 'Webpack',
        command: 'webpack',
        args: ['--mode=development'],
        configFiles: ['webpack.config.js', 'webpack.config.ts'],
        outputPatterns: ['dist/**/*', 'build/**/*'],
        errorPatterns: [/Module not found/i, /Can't resolve/i, /ERROR in/i],
        languages: ['javascript', 'typescript'],
        frameworks: ['webpack'],
        enabled: true,
      },
      {
        name: 'Vite',
        command: 'vite',
        args: ['build'],
        configFiles: ['vite.config.js', 'vite.config.ts'],
        outputPatterns: ['dist/**/*'],
        errorPatterns: [/Build failed/i, /Transform failed/i, /Could not resolve/i],
        languages: ['javascript', 'typescript'],
        frameworks: ['vite'],
        enabled: true,
      },
      {
        name: 'Cargo',
        command: 'cargo',
        args: ['check'],
        configFiles: ['Cargo.toml'],
        outputPatterns: ['target/**/*'],
        errorPatterns: [/error\[E\d+\]/i, /cannot find/i, /mismatched types/i],
        languages: ['rust'],
        frameworks: ['cargo'],
        enabled: true,
      },
      {
        name: 'Go Build',
        command: 'go',
        args: ['build', './...'],
        configFiles: ['go.mod', 'go.sum'],
        outputPatterns: ['bin/**/*'],
        errorPatterns: [/cannot find package/i, /undefined:/i, /syntax error/i],
        languages: ['go'],
        frameworks: ['go'],
        enabled: true,
      },
      {
        name: 'Maven',
        command: 'mvn',
        args: ['compile'],
        configFiles: ['pom.xml'],
        outputPatterns: ['target/**/*'],
        errorPatterns: [/\[ERROR\]/i, /compilation failure/i, /cannot find symbol/i],
        languages: ['java'],
        frameworks: ['maven'],
        enabled: true,
      },
      {
        name: 'Gradle',
        command: 'gradle',
        args: ['build'],
        configFiles: ['build.gradle', 'build.gradle.kts'],
        outputPatterns: ['build/**/*'],
        errorPatterns: [/FAILED/i, /compilation failed/i, /cannot resolve/i],
        languages: ['java', 'kotlin'],
        frameworks: ['gradle'],
        enabled: true,
      },
    ];
  }

  private async startConfigFileWatching(): Promise<void> {
    const configFiles = this.config.buildTools
      .filter(tool => tool.enabled)
      .flatMap(tool => tool.configFiles);

    const watchPatterns = configFiles.map(file => join(this.config.workspaceRoot, file));

    this.fileWatcher = watch(watchPatterns, {
      ignored: ['**/node_modules/**', '**/.git/**'],
      persistent: true,
      ignoreInitial: true,
    });

    this.fileWatcher.on('change', async (filePath: string) => {
      this.logger.info('Build config file changed', { filePath });
      await this.handleConfigFileChange(filePath);
    });

    this.fileWatcher.on('error', (error: Error) => {
      this.logger.error('File watcher error', error);
      this.emit('detector-error', error);
    });
  }

  private async handleConfigFileChange(filePath: string): Promise<void> {
    // Find which build tool this config file belongs to
    const affectedTools = this.config.buildTools.filter(
      tool => tool.enabled && tool.configFiles.some(configFile => filePath.includes(configFile))
    );

    for (const tool of affectedTools) {
      this.logger.info(`Running ${tool.name} due to config change`);
      await this.runBuildTool(tool);
    }
  }

  private async detectAvailableBuildTools(): Promise<void> {
    for (const tool of this.config.buildTools) {
      if (!tool.enabled) continue;

      try {
        // Check if command is available
        const process = spawn(tool.command, ['--version'], {
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 5000,
        });

        await new Promise<void>(resolve => {
          process.on('close', code => {
            if (code === 0) {
              this.logger.debug(`Build tool ${tool.name} is available`);
              resolve();
            } else {
              this.logger.debug(`Build tool ${tool.name} is not available (exit code: ${code})`);
              tool.enabled = false;
              resolve();
            }
          });

          process.on('error', () => {
            this.logger.debug(`Build tool ${tool.name} is not available`);
            tool.enabled = false;
            resolve();
          });
        });
      } catch (error) {
        this.logger.debug(`Build tool ${tool.name} check failed`, error);
        tool.enabled = false;
      }
    }
  }

  private startPolling(): void {
    const pollInterval = this.options.polling?.interval || 30000;

    this.pollingTimer = setTimeout(async () => {
      if (this.isRunning) {
        await this.runAllBuildTools();
        this.startPolling(); // Schedule next poll
      }
    }, pollInterval);
  }

  private async runAllBuildTools(): Promise<DetectedError[]> {
    const errors: DetectedError[] = [];
    const enabledTools = this.config.buildTools.filter(tool => tool.enabled);

    if (this.config.parallelBuilds) {
      // Run builds in parallel with concurrency limit
      const chunks = this.chunkArray(enabledTools, this.config.maxConcurrentBuilds);

      for (const chunk of chunks) {
        const promises = chunk.map(tool => this.runBuildTool(tool));
        const results = await Promise.allSettled(promises);

        for (const result of results) {
          if (result.status === 'fulfilled') {
            errors.push(...result.value);
          }
        }
      }
    } else {
      // Run builds sequentially
      for (const tool of enabledTools) {
        const toolErrors = await this.runBuildTool(tool);
        errors.push(...toolErrors);
      }
    }

    return errors;
  }

  private async runBuildTool(tool: BuildToolDefinition): Promise<DetectedError[]> {
    const buildId = `${tool.name}-${Date.now()}`;
    const errors: DetectedError[] = [];

    try {
      this.logger.info(`Running build tool: ${tool.name}`);

      const process = spawn(tool.command, tool.args, {
        cwd: this.config.workspaceRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: this.config.timeoutMs,
      });

      const buildProcess: BuildProcess = {
        id: buildId,
        tool,
        process,
        startTime: new Date(),
        status: 'running',
        output: [],
        errors: [],
      };

      this.buildProcesses.set(buildId, buildProcess);

      // Collect output and errors
      process.stdout?.on('data', (data: Buffer) => {
        const output = data.toString();
        buildProcess.output.push(output);
        this.checkForErrors(output, tool, errors);
      });

      process.stderr?.on('data', (data: Buffer) => {
        const errorOutput = data.toString();
        buildProcess.errors.push(errorOutput);
        this.checkForErrors(errorOutput, tool, errors);
      });

      // Wait for process completion
      await new Promise<void>(resolve => {
        process.on('close', (code, signal) => {
          if (signal === 'SIGTERM') {
            buildProcess.status = 'killed';
          } else if (code === 0) {
            buildProcess.status = 'completed';
          } else {
            buildProcess.status = 'failed';

            // Create error for build failure
            const buildError = this.createBuildFailureError(tool, code, buildProcess);
            errors.push(buildError);
          }
          resolve();
        });

        process.on('error', error => {
          buildProcess.status = 'failed';
          const processError = this.createProcessError(tool, error);
          errors.push(processError);
          resolve();
        });
      });
    } catch (error) {
      this.logger.error(`Build tool ${tool.name} execution failed`, error);
      const executionError = this.createExecutionError(tool, error);
      errors.push(executionError);
    } finally {
      this.buildProcesses.delete(buildId);
    }

    return errors;
  }

  private checkForErrors(output: string, tool: BuildToolDefinition, errors: DetectedError[]): void {
    for (const pattern of tool.errorPatterns) {
      const matches = output.match(pattern);
      if (matches) {
        const error = this.createPatternMatchError(tool, output, pattern);
        errors.push(error);
        this.addToBuffer(error);
      }
    }
  }

  private createBuildFailureError(
    tool: BuildToolDefinition,
    exitCode: number | null,
    buildProcess: BuildProcess
  ): DetectedError {
    return {
      id: `build-failure-${tool.name}-${Date.now()}`,
      message: `${tool.name} build failed with exit code ${exitCode}`,
      type: 'BuildFailure',
      category: ErrorCategory.CONFIGURATION,
      severity: ErrorSeverity.HIGH,
      stackTrace: [],
      context: {
        timestamp: new Date(),
        environment: 'build',
        metadata: {
          tool: tool.name,
          command: tool.command,
          args: tool.args,
          exitCode,
          duration: Date.now() - buildProcess.startTime.getTime(),
          output: buildProcess.output.join('\n'),
          errors: buildProcess.errors.join('\n'),
        },
      },
      source: this.getSource(),
      patterns: [],
      confidence: 0.9,
    };
  }

  private createPatternMatchError(
    tool: BuildToolDefinition,
    output: string,
    pattern: RegExp
  ): DetectedError {
    return {
      id: `pattern-match-${tool.name}-${Date.now()}`,
      message: `${tool.name} error detected: ${output.trim()}`,
      type: 'BuildPatternMatch',
      category: this.inferCategoryFromPattern(pattern),
      severity: this.inferSeverityFromOutput(output),
      stackTrace: [],
      context: {
        timestamp: new Date(),
        environment: 'build',
        metadata: {
          tool: tool.name,
          pattern: pattern.source,
          matchedOutput: output.trim(),
        },
      },
      source: this.getSource(),
      patterns: [pattern.source],
      confidence: 0.8,
    };
  }

  private createProcessError(tool: BuildToolDefinition, error: Error): DetectedError {
    return {
      id: `process-error-${tool.name}-${Date.now()}`,
      message: `${tool.name} process error: ${error.message}`,
      type: 'ProcessError',
      category: ErrorCategory.RUNTIME,
      severity: ErrorSeverity.HIGH,
      stackTrace: [],
      context: {
        timestamp: new Date(),
        environment: 'build',
        metadata: {
          tool: tool.name,
          error: error.name,
          message: error.message,
        },
      },
      source: this.getSource(),
      patterns: [],
      confidence: 0.9,
    };
  }

  private createExecutionError(tool: BuildToolDefinition, error: unknown): DetectedError {
    const errorMessage = error instanceof Error ? error.message : String(error);

    return {
      id: `execution-error-${tool.name}-${Date.now()}`,
      message: `Failed to execute ${tool.name}: ${errorMessage}`,
      type: 'ExecutionError',
      category: ErrorCategory.CONFIGURATION,
      severity: ErrorSeverity.CRITICAL,
      stackTrace: [],
      context: {
        timestamp: new Date(),
        environment: 'build',
        metadata: {
          tool: tool.name,
          command: tool.command,
          args: tool.args,
          error: errorMessage,
        },
      },
      source: this.getSource(),
      patterns: [],
      confidence: 1.0,
    };
  }

  private async checkSpecificTarget(target: string): Promise<DetectedError[]> {
    const errors: DetectedError[] = [];

    // Find relevant build tools for the target
    const relevantTools = this.config.buildTools.filter(tool => {
      if (!tool.enabled) return false;

      const ext = extname(target);
      return tool.languages.some(lang => {
        switch (lang) {
          case 'typescript':
            return ['.ts', '.tsx'].includes(ext);
          case 'javascript':
            return ['.js', '.jsx'].includes(ext);
          case 'rust':
            return ext === '.rs';
          case 'go':
            return ext === '.go';
          case 'java':
            return ext === '.java';
          default:
            return false;
        }
      });
    });

    for (const tool of relevantTools) {
      const toolErrors = await this.runBuildTool(tool);
      errors.push(...toolErrors);
    }

    return errors;
  }

  private inferCategoryFromPattern(pattern: RegExp): ErrorCategory {
    const patternStr = pattern.source.toLowerCase();

    if (patternStr.includes('syntax') || patternStr.includes('parse')) {
      return ErrorCategory.SYNTAX;
    } else if (patternStr.includes('type') || patternStr.includes('assignable')) {
      return ErrorCategory.LOGICAL;
    } else if (patternStr.includes('module') || patternStr.includes('resolve')) {
      return ErrorCategory.CONFIGURATION;
    } else {
      return ErrorCategory.RUNTIME;
    }
  }

  private inferSeverityFromOutput(output: string): ErrorSeverity {
    const lowerOutput = output.toLowerCase();

    if (lowerOutput.includes('error') || lowerOutput.includes('failed')) {
      return ErrorSeverity.HIGH;
    } else if (lowerOutput.includes('warning')) {
      return ErrorSeverity.MEDIUM;
    } else {
      return ErrorSeverity.LOW;
    }
  }

  private chunkArray<T>(array: T[], chunkSize: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += chunkSize) {
      chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
  }

  // Public API
  getBuildProcesses(): BuildProcess[] {
    return Array.from(this.buildProcesses.values());
  }

  getEnabledBuildTools(): BuildToolDefinition[] {
    return this.config.buildTools.filter(tool => tool.enabled);
  }

  updateBuildToolConfig(toolName: string, updates: Partial<BuildToolDefinition>): void {
    const tool = this.config.buildTools.find(t => t.name === toolName);
    if (tool) {
      Object.assign(tool, updates);
      this.emit('config-updated', { tool: toolName, updates });
    }
  }
}
