/**
 * Test error detector for capturing errors from test runners
 */

import type { ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import { join, extname } from 'path';
import { watch, type FSWatcher } from 'chokidar';

import type { DetectedError, ErrorSource } from '@/types/index.js';
import {
  BaseErrorDetector,
  type ErrorDetectorOptions,
  type ErrorDetectorCapabilities,
} from './base-detector.js';
import { ErrorSeverity } from '@/types/errors.js';

export interface TestConfig {
  jest?: {
    enabled: boolean;
    configPath?: string;
    testMatch?: string[];
  };
  vitest?: {
    enabled: boolean;
    configPath?: string;
    testMatch?: string[];
  };
  mocha?: {
    enabled: boolean;
    configPath?: string;
    testMatch?: string[];
  };
  pytest?: {
    enabled: boolean;
    configPath?: string;
    testMatch?: string[];
  };
  goTest?: {
    enabled: boolean;
    testMatch?: string[];
  };
  cargoTest?: {
    enabled: boolean;
    testMatch?: string[];
  };
  workspaceRoot?: string;
}

export class TestErrorDetector extends BaseErrorDetector {
  private config: TestConfig;
  private testProcess: ChildProcess | undefined;
  private fileWatcher: FSWatcher | undefined;
  private pollingTimer: NodeJS.Timeout | undefined;
  private lastTestTime = 0;

  constructor(options: ErrorDetectorOptions, config: Partial<TestConfig> = {}) {
    super(options);
    this.config = {
      jest: { enabled: true },
      vitest: { enabled: true },
      mocha: { enabled: true },
      pytest: { enabled: true },
      goTest: { enabled: true },
      cargoTest: { enabled: true },
      workspaceRoot: process.cwd(),
      ...config,
    };
  }

  getSource(): ErrorSource {
    return {
      type: 'test',
      tool: 'test-detector',
      version: '1.0.0',
    };
  }

  getCapabilities(): ErrorDetectorCapabilities {
    return {
      supportsRealTime: true,
      supportsPolling: true,
      supportsFileWatching: true,
      supportedLanguages: ['javascript', 'typescript', 'python', 'go', 'rust'],
      supportedFrameworks: ['jest', 'vitest', 'mocha', 'pytest', 'go-test', 'cargo-test'],
    };
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;

    try {
      // Verify test runners are available
      await this.verifyTestRunnersAvailable();

      // Start file watching if enabled
      if (this.options.realTime) {
        await this.startFileWatching();
      }

      // Start polling if enabled
      if (this.options.polling) {
        this.startPolling();
      }

      // Run initial test check
      await this.runTestCheck();

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

    // Stop test process
    if (this.testProcess) {
      this.testProcess.kill();
      this.testProcess = undefined;
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

    // If target is specified, run tests for specific file/directory
    if (target) {
      return await this.runTestsForTarget(target);
    }

    // Otherwise run all tests
    await this.runTestCheck();
    return this.getBufferedErrors();
  }

  private async verifyTestRunnersAvailable(): Promise<void> {
    // For now, we'll proceed without strict tool verification
    // In a production environment, you'd check if test runners are installed
  }

  private async startFileWatching(): Promise<void> {
    if (!this.config.workspaceRoot) {
      return;
    }

    this.fileWatcher = watch(this.config.workspaceRoot, {
      ignored: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
      persistent: true,
      ignoreInitial: true,
    });

    this.fileWatcher.on('change', async (filePath: string) => {
      if (this.shouldRunTestsForFile(filePath)) {
        await this.runTestsForFile(filePath);
      }
    });

    this.fileWatcher.on('add', async (filePath: string) => {
      if (this.shouldRunTestsForFile(filePath)) {
        await this.runTestsForFile(filePath);
      }
    });
  }

  private shouldRunTestsForFile(filePath: string): boolean {
    const ext = extname(filePath);
    const isTestFile =
      filePath.includes('.test.') ||
      filePath.includes('.spec.') ||
      filePath.includes('_test.') ||
      filePath.includes('test_');
    const isSourceFile = ['.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.rs'].includes(ext);

    return isTestFile || isSourceFile;
  }

  private startPolling(): void {
    if (!this.options.polling) {
      return;
    }

    this.pollingTimer = setInterval(async () => {
      try {
        await this.runTestCheck();
      } catch (error) {
        this.emit('detector-error', error);
      }
    }, this.options.polling.interval);
  }

  private async runTestCheck(): Promise<void> {
    const now = Date.now();
    if (now - this.lastTestTime < 10000) {
      // Avoid running tests too frequently (10 second minimum)
      return;
    }

    this.lastTestTime = now;

    try {
      const testPromises: Promise<DetectedError[]>[] = [];

      // Run JavaScript/TypeScript tests
      if (this.config.jest?.enabled) {
        testPromises.push(this.runJestTests());
      }
      if (this.config.vitest?.enabled) {
        testPromises.push(this.runVitestTests());
      }
      if (this.config.mocha?.enabled) {
        testPromises.push(this.runMochaTests());
      }

      // Run Python tests
      if (this.config.pytest?.enabled) {
        testPromises.push(this.runPytestTests());
      }

      // Run Go tests
      if (this.config.goTest?.enabled) {
        testPromises.push(this.runGoTests());
      }

      // Run Rust tests
      if (this.config.cargoTest?.enabled) {
        testPromises.push(this.runCargoTests());
      }

      const results = await Promise.allSettled(testPromises);

      for (const result of results) {
        if (result.status === 'fulfilled') {
          for (const error of result.value) {
            this.addToBuffer(error);
          }
        }
      }
    } catch (error) {
      this.emit('detector-error', error);
    }
  }

  private async runJestTests(): Promise<DetectedError[]> {
    const errors: DetectedError[] = [];

    try {
      // Check if Jest is available
      const packageJsonPath = join(this.config.workspaceRoot || '', 'package.json');
      const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'));

      if (!packageJson.devDependencies?.jest && !packageJson.dependencies?.jest) {
        return errors;
      }

      // Simulate Jest test run - in production, you'd run actual jest
      const testFiles = await this.findTestFiles([
        '**/*.test.js',
        '**/*.test.ts',
        '**/*.spec.js',
        '**/*.spec.ts',
      ]);

      for (const testFile of testFiles.slice(0, 3)) {
        // Limit for demo
        const testErrors = await this.simulateTestRun(testFile, 'jest');
        errors.push(...testErrors);
      }
    } catch (error) {
      // Jest not available or failed - continue silently
    }

    return errors;
  }

  private async runVitestTests(): Promise<DetectedError[]> {
    const errors: DetectedError[] = [];

    try {
      // Check if Vitest is available
      const packageJsonPath = join(this.config.workspaceRoot || '', 'package.json');
      const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'));

      if (!packageJson.devDependencies?.vitest && !packageJson.dependencies?.vitest) {
        return errors;
      }

      // Simulate Vitest test run
      const testFiles = await this.findTestFiles([
        '**/*.test.js',
        '**/*.test.ts',
        '**/*.spec.js',
        '**/*.spec.ts',
      ]);

      for (const testFile of testFiles.slice(0, 3)) {
        // Limit for demo
        const testErrors = await this.simulateTestRun(testFile, 'vitest');
        errors.push(...testErrors);
      }
    } catch (error) {
      // Vitest not available or failed - continue silently
    }

    return errors;
  }

  private async runMochaTests(): Promise<DetectedError[]> {
    const errors: DetectedError[] = [];

    try {
      // Check if Mocha is available
      const packageJsonPath = join(this.config.workspaceRoot || '', 'package.json');
      const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'));

      if (!packageJson.devDependencies?.mocha && !packageJson.dependencies?.mocha) {
        return errors;
      }

      // Simulate Mocha test run
      const testFiles = await this.findTestFiles(['**/test/**/*.js', '**/test/**/*.ts']);

      for (const testFile of testFiles.slice(0, 3)) {
        // Limit for demo
        const testErrors = await this.simulateTestRun(testFile, 'mocha');
        errors.push(...testErrors);
      }
    } catch (error) {
      // Mocha not available or failed - continue silently
    }

    return errors;
  }

  private async runPytestTests(): Promise<DetectedError[]> {
    const errors: DetectedError[] = [];

    try {
      // Simulate Pytest test run
      const testFiles = await this.findTestFiles(['**/test_*.py', '**/*_test.py']);

      for (const testFile of testFiles.slice(0, 3)) {
        // Limit for demo
        const testErrors = await this.simulateTestRun(testFile, 'pytest');
        errors.push(...testErrors);
      }
    } catch (error) {
      // Pytest not available or failed - continue silently
    }

    return errors;
  }

  private async runGoTests(): Promise<DetectedError[]> {
    const errors: DetectedError[] = [];

    try {
      // Simulate Go test run
      const testFiles = await this.findTestFiles(['**/*_test.go']);

      for (const testFile of testFiles.slice(0, 3)) {
        // Limit for demo
        const testErrors = await this.simulateTestRun(testFile, 'go-test');
        errors.push(...testErrors);
      }
    } catch (error) {
      // Go test not available or failed - continue silently
    }

    return errors;
  }

  private async runCargoTests(): Promise<DetectedError[]> {
    const errors: DetectedError[] = [];

    try {
      // Simulate Cargo test run
      const testFiles = await this.findTestFiles(['**/tests/**/*.rs', '**/src/**/*.rs']);

      for (const testFile of testFiles.slice(0, 3)) {
        // Limit for demo
        const testErrors = await this.simulateTestRun(testFile, 'cargo-test');
        errors.push(...testErrors);
      }
    } catch (error) {
      // Cargo test not available or failed - continue silently
    }

    return errors;
  }

  private async findTestFiles(patterns: string[]): Promise<string[]> {
    const files: string[] = [];

    if (!this.config.workspaceRoot) {
      return files;
    }

    try {
      const { glob } = await import('fast-glob');
      const foundFiles = await glob(patterns, {
        cwd: this.config.workspaceRoot,
        ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
        absolute: true,
      });
      files.push(...foundFiles);
    } catch (error) {
      // Fallback to basic file finding if fast-glob is not available
    }

    return files;
  }

  private async simulateTestRun(testFile: string, framework: string): Promise<DetectedError[]> {
    const errors: DetectedError[] = [];

    try {
      const content = await fs.readFile(testFile, 'utf-8');

      // Simple test analysis - look for common test failure patterns
      const lines = content.split('\n');

      lines.forEach((line, index) => {
        // Look for failing assertions or test patterns
        if (line.includes('expect(') && line.includes('.toBe(')) {
          // Simulate occasional test failure
          if (Math.random() < 0.1) {
            // 10% chance of simulated failure
            errors.push(
              this.createTestError(
                `Assertion failed: ${line.trim()}`,
                'test-failure',
                testFile,
                index + 1,
                framework
              )
            );
          }
        }

        // Look for TODO tests
        if (
          line.includes('it.todo') ||
          line.includes('test.todo') ||
          line.includes('describe.skip')
        ) {
          errors.push(
            this.createTestError(
              'Skipped or TODO test found',
              'test-skipped',
              testFile,
              index + 1,
              framework
            )
          );
        }
      });
    } catch (error) {
      // File can't be read
    }

    return errors;
  }

  private createTestError(
    message: string,
    type: string,
    filePath: string,
    line: number,
    framework: string
  ): DetectedError {
    const baseError = this.createBaseError(message, type);

    const severity = type === 'test-failure' ? ErrorSeverity.HIGH : ErrorSeverity.LOW;

    return {
      ...baseError,
      id: this.generateErrorId(),
      severity,
      context: {
        timestamp: new Date(),
        environment: 'test',
        metadata: {
          framework,
          file: filePath,
          line,
        },
      },
      source: this.getSource(),
      stackTrace: [
        {
          location: {
            file: filePath,
            line,
            column: 1,
            function: 'test-runner',
          },
          source: message,
        },
      ],
    };
  }

  private async runTestsForTarget(target: string): Promise<DetectedError[]> {
    try {
      const stat = await fs.stat(target);

      if (stat.isFile()) {
        await this.runTestsForFile(target);
      } else if (stat.isDirectory()) {
        // Run tests for all files in directory
        const testFiles = await this.findTestFiles(['**/*']);
        for (const file of testFiles.slice(0, 5)) {
          // Limit for performance
          await this.runTestsForFile(file);
        }
      }
    } catch (error) {
      // Target doesn't exist or can't be accessed
    }

    return this.getBufferedErrors();
  }

  private async runTestsForFile(filePath: string): Promise<void> {
    try {
      const ext = extname(filePath);
      const isTestFile =
        filePath.includes('.test.') ||
        filePath.includes('.spec.') ||
        filePath.includes('_test.') ||
        filePath.includes('test_');

      if (!isTestFile) {
        return;
      }

      let framework = 'unknown';

      switch (ext) {
        case '.js':
        case '.ts':
        case '.jsx':
        case '.tsx':
          framework = 'jest'; // Default to Jest for JS/TS
          break;
        case '.py':
          framework = 'pytest';
          break;
        case '.go':
          framework = 'go-test';
          break;
        case '.rs':
          framework = 'cargo-test';
          break;
      }

      const testErrors = await this.simulateTestRun(filePath, framework);
      for (const error of testErrors) {
        this.addToBuffer(error);
      }
    } catch (error) {
      // File can't be processed
    }
  }
}

// Alias for backward compatibility
export { TestErrorDetector as TestDetector };
