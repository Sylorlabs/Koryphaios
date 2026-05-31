/**
 * Tests for BuildErrorDetector
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BuildErrorDetector } from '../../../src/detectors/build-detector.js';
import type { ErrorDetectorOptions } from '../../../src/detectors/base-detector.js';

describe('BuildErrorDetector', () => {
  let detector: BuildErrorDetector;
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

    detector = new BuildErrorDetector(options, {
      projectRoot: process.cwd(),
      tsconfigPath: 'tsconfig.json',
      buildCommand: 'tsc',
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
      expect(capabilities.supportedLanguages).toContain('typescript');
      expect(capabilities.supportedFrameworks).toContain('tsc');
    });

    it('should have correct source type', () => {
      const source = detector.getSource();
      expect(source.type).toBe('build');
      expect(source.tool).toBe('build-detector');
    });
  });

  describe('TypeScript error parsing', () => {
    it('should parse TypeScript error output correctly', () => {
      const mockOutput = `
src/index.ts(10,5): error TS2304: Cannot find name 'foo'.
src/utils.ts(25,12): warning TS6133: 'unused' is declared but its value is never read.
      `.trim();

      // Access private method for testing
      const parseMethod = (detector as any).parseTypeScriptOutput.bind(detector);
      const errors = parseMethod(mockOutput);

      expect(errors).toHaveLength(2);

      expect(errors[0]).toEqual({
        file: expect.stringContaining('src/index.ts'),
        line: 10,
        column: 5,
        code: 'TS2304',
        message: "Cannot find name 'foo'.",
        severity: 'error',
      });

      expect(errors[1]).toEqual({
        file: expect.stringContaining('src/utils.ts'),
        line: 25,
        column: 12,
        code: 'TS6133',
        message: "'unused' is declared but its value is never read.",
        severity: 'warning',
      });
    });

    it('should handle empty TypeScript output', () => {
      const parseMethod = (detector as any).parseTypeScriptOutput.bind(detector);
      const errors = parseMethod('');
      expect(errors).toHaveLength(0);
    });

    it('should handle malformed TypeScript output', () => {
      const mockOutput = 'Some random output that does not match the pattern';
      const parseMethod = (detector as any).parseTypeScriptOutput.bind(detector);
      const errors = parseMethod(mockOutput);
      expect(errors).toHaveLength(0);
    });
  });

  describe('error conversion', () => {
    it('should convert TypeScript error to DetectedError correctly', () => {
      const tsError = {
        file: '/project/src/index.ts',
        line: 10,
        column: 5,
        code: 'TS2304',
        message: "Cannot find name 'foo'.",
        severity: 'error' as const,
      };

      const convertMethod = (detector as any).convertTypeScriptErrorToDetectedError.bind(detector);
      const detectedError = convertMethod(tsError);

      expect(detectedError.message).toBe("TS2304: Cannot find name 'foo'.");
      expect(detectedError.type).toBe('TypeScriptError');
      expect(detectedError.stackTrace).toHaveLength(1);
      expect(detectedError.stackTrace[0].location.file).toBe('/project/src/index.ts');
      expect(detectedError.stackTrace[0].location.line).toBe(10);
      expect(detectedError.stackTrace[0].location.column).toBe(5);
      expect(detectedError.context.environment).toBe('build');
      expect(detectedError.context.metadata.tool).toBe('tsc');
      expect(detectedError.context.metadata.code).toBe('TS2304');
      expect(detectedError.context.metadata.severity).toBe('error');
      expect(detectedError.source.type).toBe('build');
    });
  });

  describe('lifecycle', () => {
    it('should start and stop correctly', async () => {
      // Mock the TypeScript verification to avoid requiring tsc
      vi.spyOn(detector as any, 'verifyTypeScriptAvailable').mockResolvedValue(undefined);
      vi.spyOn(detector as any, 'runBuildCheck').mockResolvedValue(undefined);

      expect(detector.isRunning).toBe(false);

      await detector.start();
      expect(detector.isRunning).toBe(true);

      await detector.stop();
      expect(detector.isRunning).toBe(false);
    });

    it('should not start twice', async () => {
      vi.spyOn(detector as any, 'verifyTypeScriptAvailable').mockResolvedValue(undefined);
      vi.spyOn(detector as any, 'runBuildCheck').mockResolvedValue(undefined);

      await detector.start();
      expect(detector.isRunning).toBe(true);

      // Starting again should not throw
      await detector.start();
      expect(detector.isRunning).toBe(true);
    });

    it('should handle start errors gracefully', async () => {
      vi.spyOn(detector as any, 'verifyTypeScriptAvailable').mockRejectedValue(
        new Error('TypeScript not found')
      );

      // BuildErrorDetector should handle TypeScript unavailability gracefully
      await detector.start();
      expect(detector.isRunning).toBe(true);
      expect((detector as any).typeScriptAvailable).toBe(false);
    });
  });

  describe('error detection', () => {
    beforeEach(() => {
      // Mock TypeScript verification and build check
      vi.spyOn(detector as any, 'verifyTypeScriptAvailable').mockResolvedValue(undefined);
      vi.spyOn(detector as any, 'runBuildCheck').mockResolvedValue(undefined);
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
      const mockCheckSpecificTarget = vi
        .spyOn(detector as any, 'checkSpecificTarget')
        .mockResolvedValue([]);

      await detector.detectErrors('src/index.ts');
      expect(mockCheckSpecificTarget).toHaveBeenCalledWith('src/index.ts');
    });
  });

  describe('events', () => {
    it('should emit detector-started event', async () => {
      vi.spyOn(detector as any, 'verifyTypeScriptAvailable').mockResolvedValue(undefined);
      vi.spyOn(detector as any, 'runBuildCheck').mockResolvedValue(undefined);

      const startedPromise = new Promise<void>(resolve => {
        detector.once('detector-started', resolve);
      });

      await detector.start();
      await startedPromise;
    });

    it('should emit detector-stopped event', async () => {
      vi.spyOn(detector as any, 'verifyTypeScriptAvailable').mockResolvedValue(undefined);
      vi.spyOn(detector as any, 'runBuildCheck').mockResolvedValue(undefined);

      await detector.start();

      const stoppedPromise = new Promise<void>(resolve => {
        detector.once('detector-stopped', resolve);
      });

      await detector.stop();
      await stoppedPromise;
    });

    it('should emit detector-error event on errors', async () => {
      // Test that detector handles errors gracefully during operation
      vi.spyOn(detector as any, 'verifyTypeScriptAvailable').mockResolvedValue(undefined);
      vi.spyOn(detector as any, 'runBuildCheck').mockResolvedValue(undefined);

      await detector.start();
      expect(detector.isRunning).toBe(true);

      // Now simulate an error during operation
      const testError = new Error('Build check error');
      const errorPromise = new Promise<Error>(resolve => {
        detector.once('detector-error', resolve);
      });

      // Trigger an error by calling runBuildCheck directly with a mock that throws
      vi.spyOn(detector as any, 'runBuildCheck').mockRejectedValue(testError);

      // Trigger the error by calling detectErrors which will call runBuildCheck
      await detector.detectErrors();

      const emittedError = await errorPromise;
      expect(emittedError).toBe(testError);
    });
  });
});
