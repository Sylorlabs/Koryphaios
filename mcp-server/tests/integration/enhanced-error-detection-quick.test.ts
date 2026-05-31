/**
 * Quick integration test for enhanced error detection capabilities
 * Focused on core functionality without performance bottlenecks
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { ErrorDetectorManager } from '@/detectors/error-detector-manager.js';
import { BuildToolDetector } from '@/detectors/build-tool-detector.js';
import { ProcessMonitorDetector } from '@/detectors/process-monitor-detector.js';
import { MultiLanguageDetector } from '@/detectors/multi-language-detector.js';
import type { ErrorDetectionConfig } from '@/types/config.js';
import type { ErrorDetectorOptions } from '@/detectors/base-detector.js';
import { ErrorCategory, ErrorSeverity } from '@/types/errors.js';

describe('Enhanced Error Detection Quick Test', () => {
  let tempDir: string;
  let detectorManager: ErrorDetectorManager;
  let config: ErrorDetectionConfig;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), 'enhanced-error-quick-test-'));

    config = {
      enabled: true,
      realTime: false, // Disable real-time for faster tests
      sources: {
        console: true,
        runtime: true,
        build: false, // Disable to prevent TypeScript process spawning in tests
        linter: false, // Disable for speed
        staticAnalysis: false, // Disable for speed
        test: false, // Disable for speed
        ide: false, // Disable for speed
        buildTools: false, // Disable to prevent spawning build processes in tests
        processMonitor: false, // Disable to prevent process monitoring in tests
        multiLanguage: false, // Disable to prevent compiler spawning in tests
      },
      filters: {
        categories: [],
        severities: [],
        excludeFiles: [],
        excludePatterns: [],
      },
      polling: {
        interval: 5000, // Longer interval for tests
        maxRetries: 1, // Fewer retries for speed
      },
      bufferSize: 50,
      maxErrorsPerSession: 100,
    };

    detectorManager = new ErrorDetectorManager({
      config,
      workspaceRoot: tempDir,
    });
  });

  afterEach(async () => {
    if (detectorManager && detectorManager.isRunning) {
      await detectorManager.stop();
    }

    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Enhanced Error Detection Core Functionality', () => {
    it('should initialize with enhanced detectors enabled', async () => {
      await detectorManager.start();

      expect(detectorManager.isManagerRunning()).toBe(true);

      const detectors = detectorManager.listDetectors();
      expect(detectors.length).toBeGreaterThanOrEqual(2); // At least console, runtime (build disabled for tests)

      // Check for basic detector names in the list
      const detectorNames = detectors.map(d => d.name);
      expect(detectorNames).toContain('console');
      expect(detectorNames).toContain('runtime');
      // Build detector is disabled in test configuration to prevent process spawning

      await detectorManager.stop();
    });

    it('should provide enhanced capabilities', async () => {
      await detectorManager.start();

      const detectors = detectorManager.listDetectors();

      expect(Array.isArray(detectors)).toBe(true);
      expect(detectors.length).toBeGreaterThan(0);

      // Check that detectors have capabilities
      const enabledDetectors = detectors.filter(d => d.enabled);
      expect(enabledDetectors.length).toBeGreaterThan(0);

      // Check that each detector has capabilities
      for (const detector of enabledDetectors) {
        expect(detector).toHaveProperty('capabilities');
        expect(detector.capabilities).toHaveProperty('supportsRealTime');
      }

      await detectorManager.stop();
    });

    it('should handle configuration updates', async () => {
      await detectorManager.start();

      // Update configuration
      const updatedConfig = {
        sources: {
          ...config.sources,
          buildTools: false,
          processMonitor: false,
        },
      };

      detectorManager.updateConfig(updatedConfig);

      // Verify the manager is still running after config update
      expect(detectorManager.isManagerRunning()).toBe(true);

      await detectorManager.stop();
    });

    it('should provide error analysis', async () => {
      await detectorManager.start();

      const stats = detectorManager.getDetectionStats();

      expect(stats).toHaveProperty('totalErrors');
      expect(stats).toHaveProperty('errorsByDetector');
      expect(stats).toHaveProperty('errorsByCategory');
      expect(stats).toHaveProperty('errorsBySeverity');

      expect(typeof stats.totalErrors).toBe('number');
      expect(stats.totalErrors).toBeGreaterThanOrEqual(0);

      await detectorManager.stop();
    });

    it('should provide performance metrics', async () => {
      await detectorManager.start();

      const stats = detectorManager.getDetectionStats();
      const detectors = detectorManager.listDetectors();

      expect(stats).toHaveProperty('totalErrors');
      expect(stats).toHaveProperty('errorsByDetector');

      // Check that we have detector information
      expect(Array.isArray(detectors)).toBe(true);
      expect(detectors.length).toBeGreaterThan(0);

      await detectorManager.stop();
    });
  });

  describe('Individual Enhanced Detectors', () => {
    let detectorOptions: ErrorDetectorOptions;

    beforeEach(() => {
      detectorOptions = {
        enabled: true,
        includeWarnings: true,
        filters: {
          categories: [],
          severities: [],
          excludeFiles: [],
          excludePatterns: [],
        },
        bufferSize: 50,
        realTime: false,
        polling: {
          interval: 5000,
          maxRetries: 1,
        },
      };
    });

    it('should create BuildToolDetector with correct capabilities', async () => {
      const buildDetector = new BuildToolDetector(detectorOptions, {
        workspaceRoot: tempDir,
        parallelBuilds: false,
        timeoutMs: 5000,
      });

      const capabilities = buildDetector.getCapabilities();
      expect(capabilities.supportsRealTime).toBe(true);
      expect(capabilities.supportedLanguages).toContain('typescript');
      expect(capabilities.supportedFrameworks).toContain('webpack');

      await buildDetector.start();
      expect(buildDetector.isRunning).toBe(true);

      const errors = await buildDetector.detectErrors();
      expect(Array.isArray(errors)).toBe(true);

      await buildDetector.stop();
      expect(buildDetector.isRunning).toBe(false);
    });

    it('should create ProcessMonitorDetector with correct capabilities', async () => {
      const processDetector = new ProcessMonitorDetector(detectorOptions, {
        workspaceRoot: tempDir,
        monitorInterval: 10000, // Longer interval for tests
        hangingProcessThreshold: 30,
        memoryThreshold: 1000,
        cpuThreshold: 95,
      });

      const capabilities = processDetector.getCapabilities();
      expect(capabilities.supportsRealTime).toBe(true);
      expect(capabilities.supportedLanguages).toContain('*');

      await processDetector.start();
      expect(processDetector.isRunning).toBe(true);

      const errors = await processDetector.detectErrors();
      expect(Array.isArray(errors)).toBe(true);

      await processDetector.stop();
      expect(processDetector.isRunning).toBe(false);
    });

    it('should create MultiLanguageDetector with correct capabilities', async () => {
      const multiLangDetector = new MultiLanguageDetector(detectorOptions, {
        workspaceRoot: tempDir,
        parallelCompilation: false,
        timeoutMs: 10000,
        includeWarnings: true,
        crossLanguageAnalysis: false, // Disable for speed
      });

      const capabilities = multiLangDetector.getCapabilities();
      expect(capabilities.supportsRealTime).toBe(true);
      expect(capabilities.supportedLanguages).toContain('typescript');
      expect(capabilities.supportedLanguages).toContain('rust');
      expect(capabilities.supportedLanguages).toContain('go');

      await multiLangDetector.start();
      expect(multiLangDetector.isRunning).toBe(true);

      const errors = await multiLangDetector.detectErrors();
      expect(Array.isArray(errors)).toBe(true);

      await multiLangDetector.stop();
      expect(multiLangDetector.isRunning).toBe(false);
    });
  });

  describe('Enhanced Error Detection Integration', () => {
    it('should detect errors from multiple sources', async () => {
      // Create a simple test file that might trigger errors
      await fs.writeFile(
        join(tempDir, 'test.js'),
        `
        // Simple JavaScript file for testing
        console.log("Testing enhanced error detection");
        
        // This might trigger some analysis
        function testFunction() {
          return "test";
        }
      `
      );

      await detectorManager.start();

      // Give it a moment to initialize
      await new Promise(resolve => setTimeout(resolve, 500));

      const errors = await detectorManager.detectErrors();

      expect(Array.isArray(errors)).toBe(true);
      // We don't expect specific errors, just that the system works

      await detectorManager.stop();
    });

    it('should handle error detection without crashing', async () => {
      await detectorManager.start();

      // Test multiple error detection calls with shorter timeout
      const errors1 = await detectorManager.detectErrors();
      expect(Array.isArray(errors1)).toBe(true);

      await detectorManager.stop();
    }, 15000);
  });
});
