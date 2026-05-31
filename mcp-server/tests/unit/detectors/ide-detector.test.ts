/**
 * Tests for IDEErrorDetector
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IDEErrorDetector } from '../../../src/detectors/ide-detector.js';
import type { ErrorDetectorOptions } from '../../../src/detectors/base-detector.js';

describe('IDEErrorDetector', () => {
  let detector: IDEErrorDetector;
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

    detector = new IDEErrorDetector(options, {
      enableVSCodeIntegration: true,
      enableLanguageServerIntegration: true,
      pollInterval: 2000,
      watchWorkspace: true,
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
      expect(capabilities.supportsFileWatching).toBe(false); // IDE handles file watching
      expect(capabilities.supportedLanguages).toContain('javascript');
      expect(capabilities.supportedLanguages).toContain('typescript');
      expect(capabilities.supportedLanguages).toContain('python');
      expect(capabilities.supportedFrameworks).toContain('vscode');
      expect(capabilities.supportedFrameworks).toContain('language-server-protocol');
    });

    it('should have correct source type', () => {
      const source = detector.getSource();
      expect(source.type).toBe('ide');
      expect(source.tool).toBe('ide-detector');
    });
  });

  describe('VS Code environment detection', () => {
    it('should detect VS Code environment correctly', () => {
      const originalEnv = process.env.VSCODE_PID;

      // Test with VSCODE_PID environment variable
      process.env.VSCODE_PID = '12345';
      const isVSCodeMethod = (detector as any).isVSCodeEnvironment.bind(detector);
      expect(isVSCodeMethod()).toBe(true);

      // Clean up
      if (originalEnv !== undefined) {
        process.env.VSCODE_PID = originalEnv;
      } else {
        delete process.env.VSCODE_PID;
      }
    });

    it('should detect non-VS Code environment correctly', () => {
      const originalEnv = process.env['VSCODE_PID'];
      const originalTerm = process.env['TERM_PROGRAM'];

      delete process.env['VSCODE_PID'];
      delete process.env['TERM_PROGRAM'];

      // Mock globalThis to not have vscode
      const originalGlobalThis = globalThis;
      const mockGlobalThis = {} as any;
      Object.setPrototypeOf(mockGlobalThis, originalGlobalThis);

      // Temporarily replace globalThis reference
      vi.stubGlobal('globalThis', mockGlobalThis);

      const isVSCodeMethod = (detector as any).isVSCodeEnvironment.bind(detector);
      expect(isVSCodeMethod()).toBe(false);

      // Restore original environment
      if (originalEnv !== undefined) {
        process.env['VSCODE_PID'] = originalEnv;
      }
      if (originalTerm !== undefined) {
        process.env['TERM_PROGRAM'] = originalTerm;
      }

      // Restore globalThis
      vi.unstubAllGlobals();
    });
  });

  describe('diagnostic management', () => {
    it('should update diagnostics correctly', () => {
      const diagnostics = [
        {
          file: '/project/src/index.ts',
          line: 10,
          column: 5,
          code: 'TS2304',
          message: "Cannot find name 'foo'.",
          severity: 'error' as const,
          source: 'typescript',
        },
        {
          file: '/project/src/index.ts',
          line: 15,
          column: 12,
          code: 'TS6133',
          message: "'unused' is declared but its value is never read.",
          severity: 'warning' as const,
          source: 'typescript',
        },
      ];

      detector.updateDiagnostics('/project/src/index.ts', diagnostics);

      const cache = detector.getDiagnosticsCache();
      expect(cache.has('/project/src/index.ts')).toBe(true);
      expect(cache.get('/project/src/index.ts')).toEqual(diagnostics);
    });

    it('should clear diagnostics for a file', () => {
      const diagnostics = [
        {
          file: '/project/src/index.ts',
          line: 10,
          column: 5,
          code: 'TS2304',
          message: "Cannot find name 'foo'.",
          severity: 'error' as const,
          source: 'typescript',
        },
      ];

      detector.updateDiagnostics('/project/src/index.ts', diagnostics);
      expect(detector.getDiagnosticsCache().has('/project/src/index.ts')).toBe(true);

      detector.clearDiagnosticsForFile('/project/src/index.ts');
      expect(detector.getDiagnosticsCache().has('/project/src/index.ts')).toBe(false);
    });

    it('should emit diagnostics-updated event', () => {
      const diagnostics = [
        {
          file: '/project/src/index.ts',
          line: 10,
          column: 5,
          code: 'TS2304',
          message: "Cannot find name 'foo'.",
          severity: 'error' as const,
          source: 'typescript',
        },
      ];

      const eventPromise = new Promise<any>(resolve => {
        detector.once('diagnostics-updated', resolve);
      });

      detector.updateDiagnostics('/project/src/index.ts', diagnostics);

      return eventPromise.then(event => {
        expect(event.filePath).toBe('/project/src/index.ts');
        expect(event.diagnostics).toEqual(diagnostics);
      });
    });
  });

  describe('error conversion', () => {
    it('should convert IDE diagnostic to DetectedError correctly', () => {
      const diagnostic = {
        file: '/project/src/index.ts',
        line: 10,
        column: 5,
        code: 'TS2304',
        message: "Cannot find name 'foo'.",
        severity: 'error' as const,
        source: 'typescript',
      };

      const convertMethod = (detector as any).convertIDEDiagnosticToDetectedError.bind(detector);
      const detectedError = convertMethod(diagnostic);

      expect(detectedError.message).toBe("TS2304: Cannot find name 'foo'.");
      expect(detectedError.type).toBe('IDEDiagnostic');
      expect(detectedError.stackTrace).toHaveLength(1);
      expect(detectedError.stackTrace[0].location.file).toBe('/project/src/index.ts');
      expect(detectedError.stackTrace[0].location.line).toBe(10);
      expect(detectedError.stackTrace[0].location.column).toBe(5);
      expect(detectedError.context.environment).toBe('ide');
      expect(detectedError.context.metadata.tool).toBe('ide');
      expect(detectedError.context.metadata.source).toBe('typescript');
      expect(detectedError.context.metadata.code).toBe('TS2304');
      expect(detectedError.context.metadata.severity).toBe('error');
      expect(detectedError.source.type).toBe('ide');
    });
  });

  describe('lifecycle', () => {
    it('should start and stop correctly', async () => {
      // Mock the IDE integration initialization
      vi.spyOn(detector as any, 'initializeVSCodeIntegration').mockResolvedValue(undefined);
      vi.spyOn(detector as any, 'collectDiagnostics').mockResolvedValue(undefined);

      expect(detector.isRunning).toBe(false);

      await detector.start();
      expect(detector.isRunning).toBe(true);

      await detector.stop();
      expect(detector.isRunning).toBe(false);
    });

    it('should not start twice', async () => {
      vi.spyOn(detector as any, 'initializeVSCodeIntegration').mockResolvedValue(undefined);
      vi.spyOn(detector as any, 'collectDiagnostics').mockResolvedValue(undefined);

      await detector.start();
      expect(detector.isRunning).toBe(true);

      // Starting again should not throw
      await detector.start();
      expect(detector.isRunning).toBe(true);
    });

    it('should handle start errors gracefully', async () => {
      vi.spyOn(detector as any, 'initializeVSCodeIntegration').mockRejectedValue(
        new Error('IDE integration failed')
      );

      await expect(detector.start()).rejects.toThrow('IDE integration failed');
      expect(detector.isRunning).toBe(false);
    });

    it('should clear diagnostics cache on stop', async () => {
      vi.spyOn(detector as any, 'initializeVSCodeIntegration').mockResolvedValue(undefined);
      vi.spyOn(detector as any, 'collectDiagnostics').mockResolvedValue(undefined);

      // Add some diagnostics
      detector.updateDiagnostics('/test/file.ts', [
        {
          file: '/test/file.ts',
          line: 1,
          column: 1,
          code: 'TEST',
          message: 'Test diagnostic',
          severity: 'error' as const,
          source: 'test',
        },
      ]);

      expect(detector.getDiagnosticsCache().size).toBe(1);

      await detector.start();
      await detector.stop();

      expect(detector.getDiagnosticsCache().size).toBe(0);
    });
  });

  describe('error detection', () => {
    beforeEach(() => {
      // Mock IDE integration initialization and diagnostics collection
      vi.spyOn(detector as any, 'initializeVSCodeIntegration').mockResolvedValue(undefined);
      vi.spyOn(detector as any, 'collectDiagnostics').mockResolvedValue(undefined);
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

    it('should handle specific file detection', async () => {
      const mockGetDiagnosticsForFile = vi
        .spyOn(detector as any, 'getDiagnosticsForFile')
        .mockResolvedValue([]);

      await detector.detectErrors('/project/src/index.ts');
      expect(mockGetDiagnosticsForFile).toHaveBeenCalledWith('/project/src/index.ts');
    });

    it('should return diagnostics for specific file', async () => {
      const diagnostics = [
        {
          file: '/project/src/index.ts',
          line: 10,
          column: 5,
          code: 'TS2304',
          message: "Cannot find name 'foo'.",
          severity: 'error' as const,
          source: 'typescript',
        },
      ];

      detector.updateDiagnostics('/project/src/index.ts', diagnostics);

      const errors = await detector.getDiagnosticsForFile('/project/src/index.ts');
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toBe("TS2304: Cannot find name 'foo'.");
    });
  });

  describe('events', () => {
    it('should emit detector-started event', async () => {
      vi.spyOn(detector as any, 'initializeVSCodeIntegration').mockResolvedValue(undefined);
      vi.spyOn(detector as any, 'collectDiagnostics').mockResolvedValue(undefined);

      const startedPromise = new Promise<void>(resolve => {
        detector.once('detector-started', resolve);
      });

      await detector.start();
      await startedPromise;
    });

    it('should emit detector-stopped event', async () => {
      vi.spyOn(detector as any, 'initializeVSCodeIntegration').mockResolvedValue(undefined);
      vi.spyOn(detector as any, 'collectDiagnostics').mockResolvedValue(undefined);

      await detector.start();

      const stoppedPromise = new Promise<void>(resolve => {
        detector.once('detector-stopped', resolve);
      });

      await detector.stop();
      await stoppedPromise;
    });

    it('should emit detector-error event on errors', async () => {
      const testError = new Error('Test error');
      vi.spyOn(detector as any, 'initializeVSCodeIntegration').mockRejectedValue(testError);

      const errorPromise = new Promise<Error>(resolve => {
        detector.once('detector-error', resolve);
      });

      await expect(detector.start()).rejects.toThrow('Test error');
      const emittedError = await errorPromise;
      expect(emittedError).toBe(testError);
    });
  });
});
