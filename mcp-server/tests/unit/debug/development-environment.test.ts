/**
 * Tests for DevelopmentEnvironment
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DevelopmentEnvironment } from '../../../src/debug/development-environment.js';
import { SupportedLanguage } from '../../../src/types/languages.js';

// Mock all dependencies
vi.mock('../../../src/debug/debug-session-manager.js', () => ({
  DebugSessionManager: vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    createSession: vi.fn().mockResolvedValue('test-session-id'),
    cleanupInactiveSessions: vi.fn().mockResolvedValue(undefined),
    getStatistics: vi.fn().mockReturnValue({
      totalSessions: 0,
      sessionsByStatus: { starting: 0, running: 0, paused: 0, stopped: 0, error: 0 },
      sessionsByLanguage: {},
      totalBreakpoints: 0,
      averageBreakpointsPerSession: 0,
    }),
    dispose: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    emit: vi.fn(),
  })),
}));

vi.mock('../../../src/debug/performance-monitor.js', () => ({
  PerformanceMonitor: vi.fn().mockImplementation(() => ({
    startMonitoring: vi.fn(),
    stopMonitoring: vi.fn(),
    startProfile: vi.fn().mockReturnValue('profile-id'),
    endProfile: vi.fn(),
    recordCounter: vi.fn(),
    cleanup: vi.fn(),
    getStatistics: vi.fn().mockReturnValue({
      profiles: { total: 0, active: 0 },
      system: { memory: { heapUsed: 1024 * 1024 }, cpu: { usage: 10 } },
      metrics: [],
    }),
    dispose: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    emit: vi.fn(),
  })),
}));

vi.mock('../../../src/languages/language-handler-manager.js', () => ({
  LanguageHandlerManager: vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    getStatistics: vi.fn().mockReturnValue({
      totalHandlers: 2,
      availableLanguages: ['typescript', 'javascript'],
      supportedExtensions: new Map(),
      configFiles: new Map(),
    }),
    detectErrors: vi.fn().mockResolvedValue([]),
    analyzePerformance: vi.fn().mockResolvedValue({ complexity: 5 }),
    dispose: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    emit: vi.fn(),
  })),
}));

vi.mock('../../../src/detectors/error-detector-manager.js', () => ({
  ErrorDetectorManager: vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    detectErrors: vi.fn().mockResolvedValue({ errors: [] }),
    dispose: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    emit: vi.fn(),
  })),
}));

describe('DevelopmentEnvironment', () => {
  let devEnvironment: DevelopmentEnvironment;

  beforeEach(() => {
    devEnvironment = new DevelopmentEnvironment({
      enablePerformanceMonitoring: true,
      enableDebugSessions: true,
      enableErrorDetection: true,
      logLevel: 'debug',
    });
  });

  afterEach(async () => {
    if (devEnvironment) {
      await devEnvironment.dispose();
    }
    vi.clearAllMocks();
  });

  describe('start', () => {
    it('should start the development environment successfully', async () => {
      await devEnvironment.start();

      const status = devEnvironment.getStatus();
      expect(status.isRunning).toBe(true);
      expect(status.startTime).toBeInstanceOf(Date);
      expect(status.components.debugSessions).toBe(true);
      expect(status.components.performanceMonitor).toBe(true);
      expect(status.components.errorDetection).toBe(true);
    });

    it('should not start if already running', async () => {
      await devEnvironment.start();

      // Should not throw or cause issues
      await devEnvironment.start();

      const status = devEnvironment.getStatus();
      expect(status.isRunning).toBe(true);
    });

    it('should emit started event', async () => {
      const startedSpy = vi.fn();
      devEnvironment.on('started', startedSpy);

      await devEnvironment.start();

      expect(startedSpy).toHaveBeenCalled();
    });
  });

  describe('stop', () => {
    it('should stop the development environment successfully', async () => {
      await devEnvironment.start();
      await devEnvironment.stop();

      const status = devEnvironment.getStatus();
      expect(status.isRunning).toBe(false);
    });

    it('should not stop if not running', async () => {
      // Should not throw or cause issues
      await devEnvironment.stop();

      const status = devEnvironment.getStatus();
      expect(status.isRunning).toBe(false);
    });

    it('should emit stopped event', async () => {
      const stoppedSpy = vi.fn();
      devEnvironment.on('stopped', stoppedSpy);

      await devEnvironment.start();
      await devEnvironment.stop();

      expect(stoppedSpy).toHaveBeenCalled();
    });
  });

  describe('createDebugSession', () => {
    it('should create a debug session successfully', async () => {
      await devEnvironment.start();

      const config = {
        type: 'launch' as const,
        program: 'test.js',
      };

      // Mock the debug session manager
      const mockSessionId = 'test-session-id';
      const debugSessionManager = devEnvironment.getDebugSessionManager();
      vi.spyOn(debugSessionManager, 'createSession').mockResolvedValue(mockSessionId);

      const sessionId = await devEnvironment.createDebugSession(
        SupportedLanguage.JAVASCRIPT,
        config
      );

      expect(sessionId).toBe(mockSessionId);
      expect(debugSessionManager.createSession).toHaveBeenCalledWith(
        SupportedLanguage.JAVASCRIPT,
        config
      );
    });

    it('should throw error when debug sessions are disabled', async () => {
      const disabledEnv = new DevelopmentEnvironment({
        enableDebugSessions: false,
      });

      await disabledEnv.start();

      const config = { type: 'launch' as const, program: 'test.js' };

      await expect(
        disabledEnv.createDebugSession(SupportedLanguage.JAVASCRIPT, config)
      ).rejects.toThrow('Debug sessions are disabled');

      await disabledEnv.dispose();
    });

    it('should emit debugSessionCreated event', async () => {
      await devEnvironment.start();

      const sessionCreatedSpy = vi.fn();
      devEnvironment.on('debugSessionCreated', sessionCreatedSpy);

      const config = { type: 'launch' as const, program: 'test.js' };
      const mockSessionId = 'test-session-id';

      const debugSessionManager = devEnvironment.getDebugSessionManager();
      vi.spyOn(debugSessionManager, 'createSession').mockResolvedValue(mockSessionId);

      await devEnvironment.createDebugSession(SupportedLanguage.JAVASCRIPT, config);

      expect(sessionCreatedSpy).toHaveBeenCalledWith(mockSessionId, SupportedLanguage.JAVASCRIPT);
    });
  });

  describe('detectErrors', () => {
    it('should detect errors using language manager', async () => {
      await devEnvironment.start();

      const source = 'const x = ;';
      const mockErrors = [
        {
          message: 'Unexpected token',
          severity: 'error' as const,
          location: { file: 'test.js', line: 1, column: 10 },
          source: 'javascript',
        },
      ];

      const languageManager = devEnvironment.getLanguageManager();
      vi.spyOn(languageManager, 'detectErrors').mockResolvedValue(mockErrors);

      const errors = await devEnvironment.detectErrors(
        source,
        SupportedLanguage.JAVASCRIPT,
        'test.js'
      );

      expect(errors).toEqual(mockErrors);
      expect(languageManager.detectErrors).toHaveBeenCalledWith(
        source,
        SupportedLanguage.JAVASCRIPT,
        { filePath: 'test.js', enableLinting: true }
      );
    });

    it('should detect errors using error detector manager when no language specified', async () => {
      await devEnvironment.start();

      const source = 'const x = ;';
      const mockResult = [
        {
          message: 'Syntax error',
          severity: 'error' as const,
          location: { file: 'test.js', line: 1, column: 10 },
        },
      ];

      const errorDetectorManager = devEnvironment.getErrorDetectorManager();
      vi.spyOn(errorDetectorManager, 'detectErrors').mockResolvedValue(mockResult);

      const errors = await devEnvironment.detectErrors(source, undefined, 'test.js');

      expect(errors).toEqual(mockResult);
      expect(errorDetectorManager.detectErrors).toHaveBeenCalledWith({ source });
    });

    it('should throw error when error detection is disabled', async () => {
      const disabledEnv = new DevelopmentEnvironment({
        enableErrorDetection: false,
      });

      await disabledEnv.start();

      await expect(
        disabledEnv.detectErrors('const x = ;', SupportedLanguage.JAVASCRIPT)
      ).rejects.toThrow('Error detection is disabled');

      await disabledEnv.dispose();
    });

    it('should emit errorsDetected event', async () => {
      await devEnvironment.start();

      const errorsDetectedSpy = vi.fn();
      devEnvironment.on('errorsDetected', errorsDetectedSpy);

      const source = 'const x = ;';
      const mockErrors = [
        {
          message: 'Error',
          severity: 'error' as const,
          location: { file: 'test.js', line: 1, column: 1 },
        },
      ];

      const languageManager = devEnvironment.getLanguageManager();
      vi.spyOn(languageManager, 'detectErrors').mockResolvedValue(mockErrors);

      await devEnvironment.detectErrors(source, SupportedLanguage.JAVASCRIPT, 'test.js');

      expect(errorsDetectedSpy).toHaveBeenCalledWith(
        mockErrors,
        SupportedLanguage.JAVASCRIPT,
        'test.js'
      );
    });
  });

  describe('analyzePerformance', () => {
    it('should analyze performance successfully', async () => {
      await devEnvironment.start();

      const source = 'function test() { return 42; }';
      const mockAnalysis = {
        complexity: 1,
        suggestions: ['Use arrow function'],
        metrics: { linesOfCode: 1, cyclomaticComplexity: 1 },
      };

      const languageManager = devEnvironment.getLanguageManager();
      vi.spyOn(languageManager, 'analyzePerformance').mockResolvedValue(mockAnalysis);

      const analysis = await devEnvironment.analyzePerformance(
        source,
        SupportedLanguage.JAVASCRIPT
      );

      expect(analysis).toEqual(mockAnalysis);
      expect(languageManager.analyzePerformance).toHaveBeenCalledWith(
        source,
        SupportedLanguage.JAVASCRIPT
      );
    });

    it('should emit performanceAnalyzed event', async () => {
      await devEnvironment.start();

      const performanceAnalyzedSpy = vi.fn();
      devEnvironment.on('performanceAnalyzed', performanceAnalyzedSpy);

      const source = 'function test() { return 42; }';
      const mockAnalysis = {
        complexity: 1,
        suggestions: [],
        metrics: { linesOfCode: 1, cyclomaticComplexity: 1 },
      };

      const languageManager = devEnvironment.getLanguageManager();
      vi.spyOn(languageManager, 'analyzePerformance').mockResolvedValue(mockAnalysis);

      await devEnvironment.analyzePerformance(source, SupportedLanguage.JAVASCRIPT);

      expect(performanceAnalyzedSpy).toHaveBeenCalledWith(
        mockAnalysis,
        SupportedLanguage.JAVASCRIPT
      );
    });
  });

  describe('getStatus', () => {
    it('should return correct status when running', async () => {
      await devEnvironment.start();

      const status = devEnvironment.getStatus();

      expect(status).toMatchObject({
        isRunning: true,
        startTime: expect.any(Date),
        uptime: expect.any(Number),
        components: {
          debugSessions: true,
          performanceMonitor: true,
          errorDetection: true,
          languageHandlers: expect.any(Boolean),
        },
        statistics: {
          activeSessions: expect.any(Number),
          totalErrors: expect.any(Number),
          performanceProfiles: expect.any(Number),
          memoryUsage: expect.any(Number),
          cpuUsage: expect.any(Number),
        },
      });
    });

    it('should return correct status when not running', () => {
      const status = devEnvironment.getStatus();

      expect(status.isRunning).toBe(false);
      expect(status.uptime).toBe(0);
    });
  });

  describe('updateConfig', () => {
    it('should update configuration', () => {
      const newConfig = {
        enablePerformanceMonitoring: false,
        logLevel: 'info' as const,
      };

      devEnvironment.updateConfig(newConfig);

      const config = devEnvironment.getConfig();
      expect(config.enablePerformanceMonitoring).toBe(false);
      expect(config.logLevel).toBe('info');
    });

    it('should emit configUpdated event', () => {
      const configUpdatedSpy = vi.fn();
      devEnvironment.on('configUpdated', configUpdatedSpy);

      const newConfig = { enablePerformanceMonitoring: false };
      devEnvironment.updateConfig(newConfig);

      expect(configUpdatedSpy).toHaveBeenCalledWith(expect.objectContaining(newConfig));
    });
  });

  describe('cleanup', () => {
    it('should cleanup successfully', async () => {
      await devEnvironment.start();

      const performanceMonitor = devEnvironment.getPerformanceMonitor();
      const debugSessionManager = devEnvironment.getDebugSessionManager();

      const perfCleanupSpy = vi.spyOn(performanceMonitor, 'cleanup');
      const debugCleanupSpy = vi.spyOn(debugSessionManager, 'cleanupInactiveSessions');

      await devEnvironment.cleanup();

      expect(perfCleanupSpy).toHaveBeenCalled();
      expect(debugCleanupSpy).toHaveBeenCalled();
    });

    it('should emit cleanupCompleted event', async () => {
      await devEnvironment.start();

      const cleanupCompletedSpy = vi.fn();
      devEnvironment.on('cleanupCompleted', cleanupCompletedSpy);

      await devEnvironment.cleanup();

      expect(cleanupCompletedSpy).toHaveBeenCalled();
    });
  });

  describe('getStatistics', () => {
    it('should return comprehensive statistics', async () => {
      await devEnvironment.start();

      const stats = devEnvironment.getStatistics();

      expect(stats).toHaveProperty('environment');
      expect(stats).toHaveProperty('debugSessions');
      expect(stats).toHaveProperty('performance');
      expect(stats).toHaveProperty('languageHandlers');
    });
  });

  describe('dispose', () => {
    it('should dispose all resources', async () => {
      await devEnvironment.start();

      await devEnvironment.dispose();

      const status = devEnvironment.getStatus();
      expect(status.isRunning).toBe(false);
    });

    it('should dispose even when not started', async () => {
      // Should not throw
      await devEnvironment.dispose();
    });
  });
});
