/**
 * Auto-Test System - Run tests automatically after AI changes
 *
 * - Detects test framework
 * - Runs tests after changes
 * - Auto-retry on failure with context
 */

import { spawn } from 'bun';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { koryLog } from '../logger';

export type TestFramework = 'jest' | 'vitest' | 'pytest' | 'cargo' | 'go' | 'bun' | 'unknown';

export interface TestResult {
  success: boolean;
  framework: TestFramework;
  totalTests: number;
  passed: number;
  failed: number;
  durationMs: number;
  output: string;
  failures: Array<{
    testName: string;
    error: string;
    file?: string;
    line?: number;
  }>;
}

export interface AutoTestConfig {
  enabled: boolean;
  autoFix: boolean;
  maxRetries: number;
  frameworks: TestFramework[];
  watchMode: boolean;
  testPattern?: string;
  coverage: boolean;
}

export const DEFAULT_AUTO_TEST_CONFIG: AutoTestConfig = {
  enabled: true,
  autoFix: true,
  maxRetries: 2,
  frameworks: [],
  watchMode: false,
  coverage: false,
};

export class AutoTestRunner {
  private config: AutoTestConfig;
  private detectedFramework: TestFramework = 'unknown';
  private retryCount = 0;
  private testHistory: TestResult[] = [];

  constructor(
    private workingDirectory: string,
    config?: Partial<AutoTestConfig>,
  ) {
    this.config = { ...DEFAULT_AUTO_TEST_CONFIG, ...config };
  }

  /**
   * Detect test framework from project files.
   */
  async detectFramework(): Promise<TestFramework> {
    if (this.detectedFramework !== 'unknown') {
      return this.detectedFramework;
    }

    const checks: Array<{ framework: TestFramework; files: string[] }> = [
      { framework: 'vitest', files: ['vitest.config.ts', 'vitest.config.js'] },
      { framework: 'jest', files: ['jest.config.js', 'jest.config.ts'] },
      { framework: 'pytest', files: ['pytest.ini', 'setup.py', 'pyproject.toml'] },
      { framework: 'cargo', files: ['Cargo.toml'] },
      { framework: 'go', files: ['go.mod'] },
      { framework: 'bun', files: ['bun.lockb'] },
    ];

    for (const { framework, files } of checks) {
      if (files.some((f) => existsSync(join(this.workingDirectory, f)))) {
        this.detectedFramework = framework;
        koryLog.info({ framework }, 'Test framework detected');
        return framework;
      }
    }

    // Check package.json for test scripts
    const packageJsonPath = join(this.workingDirectory, 'package.json');
    if (existsSync(packageJsonPath)) {
      const pkg = await import(packageJsonPath);
      const testScript = pkg.scripts?.test || '';

      if (testScript.includes('vitest')) {
        this.detectedFramework = 'vitest';
      } else if (testScript.includes('jest')) {
        this.detectedFramework = 'jest';
      } else if (testScript.includes('bun')) {
        this.detectedFramework = 'bun';
      }
    }

    return this.detectedFramework;
  }

  /**
   * Run tests for the detected framework.
   */
  async runTests(): Promise<TestResult> {
    const framework = await this.detectFramework();

    if (framework === 'unknown') {
      return {
        success: false,
        framework: 'unknown',
        totalTests: 0,
        passed: 0,
        failed: 0,
        durationMs: 0,
        output: 'No test framework detected',
        failures: [],
      };
    }

    const startTime = Date.now();

    try {
      const result = await this.runFrameworkTests(framework);
      result.durationMs = Date.now() - startTime;
      this.testHistory.push(result);
      return result;
    } catch (err) {
      const errorResult: TestResult = {
        success: false,
        framework,
        totalTests: 0,
        passed: 0,
        failed: 0,
        durationMs: Date.now() - startTime,
        output: String(err),
        failures: [
          {
            testName: 'Test runner error',
            error: String(err),
          },
        ],
      };
      this.testHistory.push(errorResult);
      return errorResult;
    }
  }

  private async runFrameworkTests(framework: TestFramework): Promise<TestResult> {
    switch (framework) {
      case 'vitest':
        return this.runCommand('npx', ['vitest', 'run', '--reporter=json', '--no-color']);
      case 'jest':
        return this.runCommand('npx', ['jest', '--json', '--no-color']);
      case 'pytest':
        return this.runCommand('python', ['-m', 'pytest', '-v', '--tb=short']);
      case 'cargo':
        return this.runCommand('cargo', ['test', '--', '--nocapture']);
      case 'go':
        return this.runCommand('go', ['test', '-v', './...']);
      case 'bun':
        return this.runCommand('bun', ['test']);
      default:
        throw new Error(`Unknown framework: ${framework}`);
    }
  }

  private async runCommand(cmd: string, args: string[]): Promise<TestResult> {
    const proc = spawn({
      cmd: [cmd, ...args],
      cwd: this.workingDirectory,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    const output = stdout + stderr;

    // Parse results based on framework
    return this.parseTestResults(this.detectedFramework, output, exitCode === 0);
  }

  private parseTestResults(framework: TestFramework, output: string, success: boolean): TestResult {
    const result: TestResult = {
      success,
      framework,
      totalTests: 0,
      passed: 0,
      failed: 0,
      durationMs: 0,
      output,
      failures: [],
    };

    switch (framework) {
      case 'vitest':
      case 'jest':
        try {
          const json = JSON.parse(output);
          result.totalTests = json.numTotalTests || json.numTests || 0;
          result.passed = json.numPassedTests || 0;
          result.failed = json.numFailedTests || 0;

          if (json.testResults) {
            for (const suite of json.testResults) {
              for (const test of suite.assertionResults || []) {
                if (test.status === 'failed') {
                  result.failures.push({
                    testName: test.title || test.fullName || 'Unknown test',
                    error: test.failureMessages?.join('\n') || 'Test failed',
                    file: suite.name,
                  });
                }
              }
            }
          }
        } catch {
          // Fallback to regex parsing
          const match = output.match(/(\d+)\s+passing/);
          if (match) result.passed = parseInt(match[1]);
          const failMatch = output.match(/(\d+)\s+failing/);
          if (failMatch) result.failed = parseInt(failMatch[1]);
          result.totalTests = result.passed + result.failed;
        }
        break;

      case 'pytest':
        // Parse pytest output
        const passedMatch = output.match(/(\d+) passed/);
        const failedMatch = output.match(/(\d+) failed/);
        const errorMatch = output.match(/(\d+) error/);

        result.passed = passedMatch ? parseInt(passedMatch[1]) : 0;
        result.failed =
          (failedMatch ? parseInt(failedMatch[1]) : 0) + (errorMatch ? parseInt(errorMatch[1]) : 0);
        result.totalTests = result.passed + result.failed;

        // Parse failures
        const failureRegex = /FAILED\s+([^:]+)::([^\s]+)[\s\S]*?Error: ([^\n]+)/g;
        let match;
        while ((match = failureRegex.exec(output)) !== null) {
          result.failures.push({
            file: match[1],
            testName: match[2],
            error: match[3],
          });
        }
        break;

      case 'cargo':
        // Parse cargo test output
        const testMatch = output.match(/test result: (ok|FAILED)\. (\d+) passed; (\d+) failed/);
        if (testMatch) {
          result.success = testMatch[1] === 'ok';
          result.passed = parseInt(testMatch[2]);
          result.failed = parseInt(testMatch[3]);
          result.totalTests = result.passed + result.failed;
        }
        break;

      case 'bun':
        // Parse bun test output
        const bunMatch = output.match(/(\d+) pass/);
        const bunFail = output.match(/(\d+) fail/);
        result.passed = bunMatch ? parseInt(bunMatch[1]) : 0;
        result.failed = bunFail ? parseInt(bunFail[1]) : 0;
        result.totalTests = result.passed + result.failed;
        break;
    }

    return result;
  }

  /**
   * Run tests after changes, with auto-retry on failure.
   */
  async runWithRetry(
    onRetry?: (attempt: number, failures: string) => Promise<boolean>,
  ): Promise<TestResult> {
    this.retryCount = 0;

    let result = await this.runTests();

    while (!result.success && this.retryCount < this.config.maxRetries) {
      this.retryCount++;
      koryLog.info({ attempt: this.retryCount }, 'Tests failed, attempting fix');

      if (onRetry) {
        const failures = result.failures.map((f) => `${f.testName}: ${f.error}`).join('\n');
        const shouldContinue = await onRetry(this.retryCount, failures);

        if (!shouldContinue) {
          koryLog.info('Auto-fix cancelled by user');
          break;
        }

        // Re-run tests
        result = await this.runTests();
      } else {
        break;
      }
    }

    return result;
  }

  /**
   * Get context for AI to fix test failures.
   */
  getFailureContext(): string {
    const lastResult = this.testHistory[this.testHistory.length - 1];
    if (!lastResult || lastResult.success) {
      return 'All tests passing.';
    }

    const parts = [
      `Test failures (${lastResult.failed} failed, ${lastResult.passed} passed):`,
      '',
      ...lastResult.failures.map((f, i) => `${i + 1}. ${f.testName}\n   ${f.error.slice(0, 200)}`),
    ];

    return parts.join('\n');
  }

  /**
   * Check if specific file has tests.
   */
  hasTestsForFile(filePath: string): boolean {
    const testFile = filePath.replace(/\.(ts|js|py|rs|go)$/, '.test.$1');
    const specFile = filePath.replace(/\.(ts|js)$/, '.spec.$1');

    return (
      existsSync(join(this.workingDirectory, testFile)) ||
      existsSync(join(this.workingDirectory, specFile))
    );
  }

  /**
   * Suggest which tests to run based on changed files.
   */
  suggestTests(changedFiles: string[]): string[] {
    const tests: string[] = [];

    for (const file of changedFiles) {
      // Check for corresponding test file
      const base = file.replace(/\.(ts|js|py|rs|go)$/, '');
      const testVariants = [
        `${base}.test.ts`,
        `${base}.test.js`,
        `${base}.spec.ts`,
        `${base}.spec.js`,
        `${base}_test.py`,
        `test_${base}.py`,
      ];

      for (const variant of testVariants) {
        if (existsSync(join(this.workingDirectory, variant))) {
          tests.push(variant);
        }
      }
    }

    return [...new Set(tests)];
  }

  /**
   * Get test history.
   */
  getHistory(): TestResult[] {
    return [...this.testHistory];
  }

  /**
   * Get retry count.
   */
  getRetryCount(): number {
    return this.retryCount;
  }
}
