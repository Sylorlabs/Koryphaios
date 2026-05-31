/**
 * Tests for LinterErrorDetector
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LinterErrorDetector } from '../../../src/detectors/linter-detector.js';
import type { ErrorDetectorOptions } from '../../../src/detectors/base-detector.js';

describe('LinterErrorDetector', () => {
  let detector: LinterErrorDetector;
  let options: ErrorDetectorOptions;

  beforeEach(() => {
    options = {
      enabled: true,
      includeWarnings: true,
      filters: {
        categories: [],
        severities: [],
        excludeFiles: [],
        excludePatterns: [],
      },
      polling: {
        interval: 1000,
        maxRetries: 3,
      },
      bufferSize: 100,
      realTime: true,
    };

    detector = new LinterErrorDetector(options, {
      projectRoot: process.cwd(),
      eslintConfigPath: '.eslintrc.js',
      linterCommand: 'eslint',
      extensions: ['.js', '.jsx', '.ts', '.tsx'],
      watchMode: false,
      pollInterval: 5000,
    });
  });

  afterEach(async () => {
    if (detector.isRunning) {
      await detector.stop();
    }
  });

  describe('initialization', () => {
    it('should create detector with default options', () => {
      expect(detector).toBeDefined();
      expect(detector.isRunning).toBe(false);
    });

    it('should have correct capabilities', () => {
      const capabilities = detector.getCapabilities();
      expect(capabilities.supportsRealTime).toBe(true);
      expect(capabilities.supportsPolling).toBe(true);
      expect(capabilities.supportsFileWatching).toBe(true);
      expect(capabilities.supportedLanguages).toContain('javascript');
      expect(capabilities.supportedLanguages).toContain('typescript');
      expect(capabilities.supportedFrameworks).toContain('eslint');
    });

    it('should have correct source type', () => {
      const source = detector.getSource();
      expect(source.type).toBe('linter');
      expect(source.tool).toBe('linter-detector');
    });
  });

  describe('ESLint output parsing', () => {
    it('should parse ESLint JSON output correctly', () => {
      const mockOutput = JSON.stringify([
        {
          filePath: '/project/src/index.js',
          messages: [
            {
              line: 10,
              column: 5,
              ruleId: 'no-unused-vars',
              message: "'foo' is defined but never used.",
              severity: 2,
            },
            {
              line: 15,
              column: 12,
              ruleId: 'prefer-const',
              message: "'bar' is never reassigned. Use 'const' instead of 'let'.",
              severity: 1,
            },
          ],
        },
      ]);

      const parseMethod = (detector as any).parseESLintOutput.bind(detector);
      const errors = parseMethod(mockOutput);

      expect(errors).toHaveLength(2);

      expect(errors[0]).toEqual({
        file: '/project/src/index.js',
        line: 10,
        column: 5,
        rule: 'no-unused-vars',
        message: "'foo' is defined but never used.",
        severity: 'error',
      });

      expect(errors[1]).toEqual({
        file: '/project/src/index.js',
        line: 15,
        column: 12,
        rule: 'prefer-const',
        message: "'bar' is never reassigned. Use 'const' instead of 'let'.",
        severity: 'warning',
      });
    });

    it('should parse ESLint text output correctly', () => {
      const mockOutput = `
/project/src/index.js:10:5: error 'foo' is defined but never used. no-unused-vars
/project/src/utils.js:25:12: warning 'bar' is never reassigned. prefer-const
      `.trim();

      const parseMethod = (detector as any).parseESLintOutput.bind(detector);
      const errors = parseMethod(mockOutput);

      expect(errors).toHaveLength(2);

      expect(errors[0]).toEqual({
        file: expect.stringContaining('src/index.js'),
        line: 10,
        column: 5,
        rule: 'no-unused-vars',
        message: "'foo' is defined but never used.",
        severity: 'error',
      });

      expect(errors[1]).toEqual({
        file: expect.stringContaining('src/utils.js'),
        line: 25,
        column: 12,
        rule: 'prefer-const',
        message: "'bar' is never reassigned.",
        severity: 'warning',
      });
    });

    it('should handle empty ESLint output', () => {
      const parseMethod = (detector as any).parseESLintOutput.bind(detector);
      const errors = parseMethod('[]');
      expect(errors).toHaveLength(0);
    });

    it('should handle malformed ESLint output', () => {
      const mockOutput = 'Some random output that is not JSON';
      const parseMethod = (detector as any).parseESLintOutput.bind(detector);
      const errors = parseMethod(mockOutput);
      expect(errors).toHaveLength(0);
    });
  });

  describe('file filtering', () => {
    it('should correctly identify files to lint', () => {
      const shouldLintMethod = (detector as any).shouldLintFile.bind(detector);

      expect(shouldLintMethod('index.js')).toBe(true);
      expect(shouldLintMethod('component.jsx')).toBe(true);
      expect(shouldLintMethod('utils.ts')).toBe(true);
      expect(shouldLintMethod('types.tsx')).toBe(true);
      expect(shouldLintMethod('README.md')).toBe(false);
      expect(shouldLintMethod('package.json')).toBe(false);
      expect(shouldLintMethod('style.css')).toBe(false);
    });
  });

  describe('error conversion', () => {
    it('should convert linter error to DetectedError correctly', () => {
      const lintError = {
        file: '/project/src/index.js',
        line: 10,
        column: 5,
        rule: 'no-unused-vars',
        message: "'foo' is defined but never used.",
        severity: 'error' as const,
      };

      const convertMethod = (detector as any).convertLinterErrorToDetectedError.bind(detector);
      const detectedError = convertMethod(lintError);

      expect(detectedError.message).toBe("no-unused-vars: 'foo' is defined but never used.");
      expect(detectedError.type).toBe('LintError');
      expect(detectedError.stackTrace).toHaveLength(1);
      expect(detectedError.stackTrace[0].location.file).toBe('/project/src/index.js');
      expect(detectedError.stackTrace[0].location.line).toBe(10);
      expect(detectedError.stackTrace[0].location.column).toBe(5);
      expect(detectedError.context.environment).toBe('linter');
      expect(detectedError.context.metadata.tool).toBe('eslint');
      expect(detectedError.context.metadata.rule).toBe('no-unused-vars');
      expect(detectedError.context.metadata.severity).toBe('error');
      expect(detectedError.source.type).toBe('linter');
    });
  });

  describe('lifecycle', () => {
    it('should start and stop correctly', async () => {
      // Mock the linter verification to avoid requiring eslint
      vi.spyOn(detector as any, 'verifyLinterAvailable').mockResolvedValue(undefined);
      vi.spyOn(detector as any, 'runLintCheck').mockResolvedValue(undefined);

      expect(detector.isRunning).toBe(false);

      await detector.start();
      expect(detector.isRunning).toBe(true);

      await detector.stop();
      expect(detector.isRunning).toBe(false);
    });

    it('should not start twice', async () => {
      vi.spyOn(detector as any, 'verifyLinterAvailable').mockResolvedValue(undefined);
      vi.spyOn(detector as any, 'runLintCheck').mockResolvedValue(undefined);

      await detector.start();
      expect(detector.isRunning).toBe(true);

      // Starting again should not throw
      await detector.start();
      expect(detector.isRunning).toBe(true);
    });

    it('should handle start errors gracefully', async () => {
      vi.spyOn(detector as any, 'verifyLinterAvailable').mockRejectedValue(
        new Error('ESLint not found')
      );

      await expect(detector.start()).rejects.toThrow('ESLint not found');
      expect(detector.isRunning).toBe(false);
    });
  });

  describe('error detection', () => {
    beforeEach(() => {
      // Mock linter verification and lint check
      vi.spyOn(detector as any, 'verifyLinterAvailable').mockResolvedValue(undefined);
      vi.spyOn(detector as any, 'runLintCheck').mockResolvedValue(undefined);
    });

    it('should detect errors when running', async () => {
      await detector.start();

      const errors = await detector.detectErrors();
      expect(Array.isArray(errors)).toBe(true);
    });

    it('should auto-start when detecting errors if not running', async () => {
      expect(detector.isRunning).toBe(false);

      const errors = await detector.detectErrors();
      expect(detector.isRunning).toBe(true);
      expect(Array.isArray(errors)).toBe(true);
    });

    it('should handle specific target detection', async () => {
      const mockLintSpecificTarget = vi
        .spyOn(detector as any, 'lintSpecificTarget')
        .mockResolvedValue([]);

      await detector.detectErrors('src/index.js');
      expect(mockLintSpecificTarget).toHaveBeenCalledWith('src/index.js');
    });
  });

  describe('events', () => {
    it('should emit detector-started event', async () => {
      vi.spyOn(detector as any, 'verifyLinterAvailable').mockResolvedValue(undefined);
      vi.spyOn(detector as any, 'runLintCheck').mockResolvedValue(undefined);

      const startedPromise = new Promise<void>(resolve => {
        detector.once('detector-started', resolve);
      });

      await detector.start();
      await startedPromise;
    });

    it('should emit detector-stopped event', async () => {
      vi.spyOn(detector as any, 'verifyLinterAvailable').mockResolvedValue(undefined);
      vi.spyOn(detector as any, 'runLintCheck').mockResolvedValue(undefined);

      await detector.start();

      const stoppedPromise = new Promise<void>(resolve => {
        detector.once('detector-stopped', resolve);
      });

      await detector.stop();
      await stoppedPromise;
    });

    it('should emit detector-error event on errors', async () => {
      const testError = new Error('Test error');
      vi.spyOn(detector as any, 'verifyLinterAvailable').mockRejectedValue(testError);

      const errorPromise = new Promise<Error>(resolve => {
        detector.once('detector-error', resolve);
      });

      await expect(detector.start()).rejects.toThrow('Test error');
      const emittedError = await errorPromise;
      expect(emittedError).toBe(testError);
    });
  });
});
