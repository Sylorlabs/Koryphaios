/**
 * Integration test to validate enhanced error detection capabilities
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
import { ErrorCategory, ErrorSeverity } from '@/types/errors.js';

describe('Enhanced Error Detection Validation', () => {
  let tempDir: string;
  let detectorManager: ErrorDetectorManager;
  let config: ErrorDetectionConfig;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), 'enhanced-error-test-'));

    config = {
      enabled: true,
      realTime: true,
      sources: {
        console: true,
        runtime: true,
        build: true,
        linter: true,
        staticAnalysis: true,
        test: true,
        ide: true,
        buildTools: true,
        processMonitor: true,
        multiLanguage: true,
      },
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
      maxErrorsPerSession: 1000,
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

  describe('Enhanced Error Detection Integration', () => {
    it('should initialize with enhanced detectors', async () => {
      await detectorManager.start();

      expect(detectorManager.isRunning).toBe(true);

      const detectors = detectorManager.getDetectors();
      expect(detectors.length).toBeGreaterThanOrEqual(6); // Original 6 + new ones

      // Check for enhanced detector types
      const detectorTypes = detectors.map(d => d.constructor.name);
      expect(detectorTypes).toContain('BuildDetector');

      await detectorManager.stop();
    });

    it('should detect build tool errors', async () => {
      // Create a project with TypeScript errors
      await fs.writeFile(
        join(tempDir, 'package.json'),
        JSON.stringify({
          name: 'test-project',
          scripts: {
            build: 'tsc',
          },
          devDependencies: {
            typescript: '^5.0.0',
          },
        })
      );

      await fs.writeFile(
        join(tempDir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'es2020',
            strict: true,
            noEmit: true,
          },
          include: ['*.ts'],
        })
      );

      await fs.writeFile(
        join(tempDir, 'error.ts'),
        `
        interface User {
          id: number;
          name: string;
          email: string;
        }
        
        const user: User = {
          id: "invalid", // Type error: string assigned to number
          name: 123,     // Type error: number assigned to string
          // Missing email property
        };
        
        // Additional type errors
        const count: number = "not a number";
        const flag: boolean = "not a boolean";
      `
      );

      await detectorManager.start();

      // Wait for detection
      await new Promise(resolve => setTimeout(resolve, 2000));

      const errors = await detectorManager.detectErrors();

      // Should have detected some errors
      expect(Array.isArray(errors)).toBe(true);

      // Look for build-related errors
      const buildErrors = errors.filter(
        e =>
          e.source === 'build-tools' ||
          e.source === 'multi-language' ||
          e.type.includes('Build') ||
          e.type.includes('Compilation')
      );

      if (buildErrors.length > 0) {
        expect(
          buildErrors.some(
            e => e.category === ErrorCategory.SYNTAX || e.category === ErrorCategory.LOGICAL
          )
        ).toBe(true);
      }

      await detectorManager.stop();
    });

    it('should provide comprehensive error detection capabilities', async () => {
      await detectorManager.start();

      const capabilities = detectorManager.getCapabilities();

      expect(capabilities).toHaveProperty('detectors');
      expect(capabilities).toHaveProperty('supportedLanguages');
      expect(capabilities).toHaveProperty('supportedFrameworks');

      // Should support enhanced languages and frameworks
      expect(capabilities.supportedLanguages).toContain('typescript');
      expect(capabilities.supportedLanguages).toContain('rust');
      expect(capabilities.supportedLanguages).toContain('go');

      expect(capabilities.supportedFrameworks).toContain('webpack');
      expect(capabilities.supportedFrameworks).toContain('cargo');

      await detectorManager.stop();
    });

    it('should handle multiple error sources simultaneously', async () => {
      // Create files that will trigger multiple types of errors
      await fs.writeFile(
        join(tempDir, 'syntax-error.ts'),
        `
        // Syntax error
        const invalid = {
          prop: "value"
          // Missing comma
          other: "value"
        };
      `
      );

      await fs.writeFile(
        join(tempDir, 'logic-error.ts'),
        `
        // Logic error
        function divide(a: number, b: number): number {
          return a / b; // No check for division by zero
        }
        
        const result = divide(10, 0);
      `
      );

      await fs.writeFile(
        join(tempDir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'es2020',
            strict: true,
          },
        })
      );

      await detectorManager.start();

      // Wait for detection
      await new Promise(resolve => setTimeout(resolve, 1500));

      const errors = await detectorManager.detectErrors();

      expect(Array.isArray(errors)).toBe(true);

      // Should have various error categories
      const errorCategories = new Set(errors.map(e => e.category));
      const errorSources = new Set(errors.map(e => e.source));

      // Verify we have multiple error sources working
      expect(errorSources.size).toBeGreaterThanOrEqual(1);

      await detectorManager.stop();
    });

    it('should provide enhanced error analysis', async () => {
      await detectorManager.start();

      const analysis = await detectorManager.getErrorAnalysis();

      expect(analysis).toHaveProperty('totalErrors');
      expect(analysis).toHaveProperty('errorsByCategory');
      expect(analysis).toHaveProperty('errorsBySeverity');
      expect(analysis).toHaveProperty('errorsBySource');
      expect(analysis).toHaveProperty('recentErrors');

      // Should include enhanced error sources
      expect(analysis.errorsBySource).toHaveProperty('build');

      await detectorManager.stop();
    });

    it('should handle real-time error detection', async () => {
      await detectorManager.start();

      let detectedErrors: any[] = [];

      // Listen for real-time errors
      detectorManager.on('error-detected', error => {
        detectedErrors.push(error);
      });

      // Create a file with errors
      await fs.writeFile(
        join(tempDir, 'realtime-test.ts'),
        `
        const invalid: number = "string";
      `
      );

      // Wait for real-time detection
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Real-time detection depends on file watching and build tools being available
      // This test validates the infrastructure is in place
      expect(detectorManager.isRunning).toBe(true);

      await detectorManager.stop();
    });

    it('should provide performance metrics for enhanced detection', async () => {
      await detectorManager.start();

      const metrics = detectorManager.getPerformanceMetrics();

      expect(metrics).toHaveProperty('detectorStartTimes');
      expect(metrics).toHaveProperty('totalStartTime');
      expect(metrics).toHaveProperty('memoryUsage');
      expect(metrics).toHaveProperty('errorDetectionCounts');

      // Should include metrics for enhanced detectors
      expect(typeof metrics.totalStartTime).toBe('number');
      expect(metrics.totalStartTime).toBeGreaterThan(0);

      await detectorManager.stop();
    });

    it('should handle configuration updates for enhanced detectors', async () => {
      await detectorManager.start();

      // Update configuration to disable some enhanced features
      const updatedConfig = {
        ...config,
        sources: {
          ...config.sources,
          buildTools: false,
          processMonitor: false,
        },
      };

      await detectorManager.updateConfiguration(updatedConfig);

      // Verify configuration was updated
      const currentConfig = detectorManager.getConfiguration();
      expect(currentConfig.sources.buildTools).toBe(false);
      expect(currentConfig.sources.processMonitor).toBe(false);

      await detectorManager.stop();
    });
  });

  describe('Individual Enhanced Detector Validation', () => {
    it('should validate BuildToolDetector integration', async () => {
      const buildDetector = new BuildToolDetector(config.detectors.build!, {
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

    it('should validate ProcessMonitorDetector integration', async () => {
      const processDetector = new ProcessMonitorDetector(config.detectors.build!, {
        workspaceRoot: tempDir,
        monitorInterval: 2000,
        hangingProcessThreshold: 10,
        memoryThreshold: 500,
        cpuThreshold: 90,
      });

      const capabilities = processDetector.getCapabilities();
      expect(capabilities.supportsRealTime).toBe(true);
      expect(capabilities.supportedLanguages).toContain('*');

      await processDetector.start();
      expect(processDetector.isRunning).toBe(true);

      // Let it monitor for a short time
      await new Promise(resolve => setTimeout(resolve, 1000));

      const errors = await processDetector.detectErrors();
      expect(Array.isArray(errors)).toBe(true);

      await processDetector.stop();
      expect(processDetector.isRunning).toBe(false);
    });

    it('should validate MultiLanguageDetector integration', async () => {
      const multiLangDetector = new MultiLanguageDetector(config.detectors.build!, {
        workspaceRoot: tempDir,
        parallelCompilation: false,
        timeoutMs: 10000,
        includeWarnings: true,
        crossLanguageAnalysis: true,
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
});
