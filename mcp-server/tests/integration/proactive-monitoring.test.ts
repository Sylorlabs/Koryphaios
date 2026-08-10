/**
 * Integration tests for proactive monitoring functionality
 */

import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';


import { ErrorDetectorManager } from '@/detectors/error-detector-manager.js';
import { ProactiveMonitoringCoordinator } from '@/monitoring/proactive-monitoring-coordinator.js';
import type { ProactiveMonitoringConfig } from '@/monitoring/proactive-monitoring-coordinator.js';
import type { ErrorDetectionConfig } from '@/types/index.js';

describe('Proactive Monitoring Integration', () => {
  let tempDir: string;
  let detectorManager: ErrorDetectorManager;
  let testConfig: ErrorDetectionConfig;
  let proactiveConfig: ProactiveMonitoringConfig;

  beforeEach(async () => {
    // Create temporary directory for testing
    tempDir = await fs.mkdtemp(join(tmpdir(), 'proactive-test-'));

    testConfig = {
      enabled: true,
      realTime: true,
      sources: {
        console: true,
        runtime: true,
        build: true,
        test: true,
        linter: true,
        staticAnalysis: true,
        ide: true,
      },
      filters: {
        categories: [],
        severities: [],
        excludeFiles: ['node_modules/**'],
        excludePatterns: ['*.min.js'],
      },
      polling: {
        interval: 1000,
        maxRetries: 3,
      },
      bufferSize: 100,
      maxErrorsPerSession: 50,
    };

    proactiveConfig = {
      enabled: true,
      workspaceRoot: tempDir,
      fileWatching: {
        enabled: true,
        debounceMs: 100, // Faster for testing
        watchPatterns: ['**/*.ts', '**/*.js'],
        ignorePatterns: ['node_modules/**'],
      },
      buildProcessMonitoring: {
        enabled: true,
        buildCommands: ['tsc'],
        watchConfigFiles: true,
        autoRestartBuilds: false,
      },
      compilationMonitoring: {
        enabled: true,
        languages: ['typescript', 'javascript'],
        watchTsConfig: true,
        watchPackageJson: true,
      },
      realTimeAnalysis: {
        enabled: true,
        analysisDelay: 100, // Faster for testing
        maxConcurrentAnalysis: 2,
      },
    };

    detectorManager = new ErrorDetectorManager({
      config: testConfig,
      workspaceRoot: tempDir,
      proactiveMonitoring: proactiveConfig,
    });
  });

  afterEach(async () => {
    if (detectorManager.isManagerRunning()) {
      await detectorManager.stop();
    }

    // Clean up temporary directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  const waitFor = async (
    predicate: () => boolean,
    options: { attempts?: number; delayMs?: number } = {}
  ): Promise<void> => {
    const { attempts = 25, delayMs = 120 } = options;
    for (let i = 0; i < attempts; i += 1) {
      if (predicate()) {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    throw new Error('Timed out waiting for watcher events');
  };

  const settleFs = async (delayMs = 80): Promise<void> =>
    new Promise(resolve => setTimeout(resolve, delayMs));

  describe('Proactive Monitoring Coordinator', () => {
    it('should initialize proactive monitoring when configured', async () => {
      const status = detectorManager.getProactiveMonitoringStatus();
      expect(status.enabled).toBe(true);
      expect(status.running).toBe(false); // Not started yet
    });

    it('should start proactive monitoring with detector manager', async () => {
      await detectorManager.start();

      const status = detectorManager.getProactiveMonitoringStatus();
      expect(status.enabled).toBe(true);
      expect(status.running).toBe(true);
      expect(status.compilationStatuses).toHaveLength(2); // typescript, javascript
    });

    it('should stop proactive monitoring with detector manager', async () => {
      await detectorManager.start();
      expect(detectorManager.getProactiveMonitoringStatus().running).toBe(true);

      await detectorManager.stop();
      expect(detectorManager.getProactiveMonitoringStatus().running).toBe(false);
    });
  });

  describe('File Change Detection', () => {
    it('should detect file changes and trigger analysis', async () => {
      const proactiveErrorsDetected = vi.fn();
      detectorManager.on('proactive-errors-detected', proactiveErrorsDetected);

      await detectorManager.start();

      // Create a TypeScript file with issues
      const testFile = join(tempDir, 'test.ts');
      await fs.writeFile(
        testFile,
        `
        function complexFunction() {
          if (true) {
            if (true) {
              if (true) {
                if (true) {
                  console.log("deeply nested");
                }
              }
            }
          }
        }
      `
      );

      await waitFor(() => proactiveErrorsDetected.mock.calls.length > 0, { attempts: 60 });

      // Should have detected the file change and analyzed it
      expect(proactiveErrorsDetected).toHaveBeenCalled();
    });

    it('should handle multiple file changes efficiently', async () => {
      const proactiveErrorsDetected = vi.fn();
      detectorManager.on('proactive-errors-detected', proactiveErrorsDetected);

      await detectorManager.start();

      // Create multiple files
      const files = ['test1.ts', 'test2.ts', 'test3.ts'];
      for (const fileName of files) {
        const filePath = join(tempDir, fileName);
        await fs.writeFile(
          filePath,
          `
          function ${fileName.replace('.ts', '')}() {
            // Simple function
            return true;
          }
        `
        );
      }

      await waitFor(() => proactiveErrorsDetected.mock.calls.length > 0, { attempts: 60 });

      // Should have processed multiple files
      expect(proactiveErrorsDetected).toHaveBeenCalled();
    });
  });

  describe('Compilation Status Monitoring', () => {
    it('should track compilation status changes', async () => {
      const compilationStatusChanged = vi.fn();
      detectorManager.on('compilation-status-changed', compilationStatusChanged);

      await detectorManager.start();

      const status = detectorManager.getProactiveMonitoringStatus();
      const tsStatus = status.compilationStatuses.find((s: any) => s.language === 'typescript');
      expect(tsStatus).toBeDefined();
      expect(tsStatus.status).toBe('idle');

      // Create a TypeScript file to trigger compilation status change
      const testFile = join(tempDir, 'compile-test.ts');
      await fs.writeFile(testFile, 'const x: string = "test";');

      await waitFor(() => compilationStatusChanged.mock.calls.length > 0, { attempts: 60 });

      // Should have triggered compilation status change
      expect(compilationStatusChanged).toHaveBeenCalled();
    });
  });

  describe('Configuration File Monitoring', () => {
    it('should detect tsconfig.json changes', async () => {
      const configFileChanged = vi.fn();

      // Create a coordinator directly to test config file watching
      const coordinator = new ProactiveMonitoringCoordinator(detectorManager, proactiveConfig);
      coordinator.on('config-file-changed', configFileChanged);

      try {
        await coordinator.start();

        // Create tsconfig.json
        const tsconfigPath = join(tempDir, 'tsconfig.json');
        await fs.writeFile(
          tsconfigPath,
          JSON.stringify(
            {
              compilerOptions: {
                target: 'es2020',
                module: 'esnext',
              },
            },
            null,
            2
          )
        );

        // Wait for file watching to detect the change
        await waitFor(() => configFileChanged.mock.calls.length > 0, { attempts: 30 });

        // Modify tsconfig.json
        await fs.writeFile(
          tsconfigPath,
          JSON.stringify(
            {
              compilerOptions: {
                target: 'es2021',
                module: 'esnext',
                strict: true,
              },
            },
            null,
            2
          )
        );

        await waitFor(() => configFileChanged.mock.calls.length > 1, { attempts: 30 });

        // Should have detected the config file change
        expect(configFileChanged).toHaveBeenCalled();
      } finally {
        await coordinator.stop();
      }
    });

    it('should detect package.json changes', async () => {
      const dependencyChangeDetected = vi.fn();

      const coordinator = new ProactiveMonitoringCoordinator(detectorManager, proactiveConfig);
      coordinator.on('dependency-change-detected', dependencyChangeDetected);

      try {
        await coordinator.start();

        // Create package.json
        const packageJsonPath = join(tempDir, 'package.json');
        await fs.writeFile(
          packageJsonPath,
          JSON.stringify(
            {
              name: 'test-project',
              version: '1.0.0',
              dependencies: {
                lodash: '^4.17.21',
              },
            },
            null,
            2
          )
        );

        await waitFor(() => dependencyChangeDetected.mock.calls.length > 0, { attempts: 30 });

        // Modify package.json
        await fs.writeFile(
          packageJsonPath,
          JSON.stringify(
            {
              name: 'test-project',
              version: '1.0.0',
              dependencies: {
                lodash: '^4.17.21',
                axios: '^1.0.0',
              },
            },
            null,
            2
          )
        );

        await waitFor(() => dependencyChangeDetected.mock.calls.length > 0, { attempts: 30 });

        // Should have detected the dependency change
        expect(dependencyChangeDetected).toHaveBeenCalled();
      } finally {
        await coordinator.stop();
      }
    });
  });

  describe('Real-time Analysis Queue', () => {
    it('should queue and process files for analysis', async () => {
      const proactiveErrorsDetected = vi.fn();
      detectorManager.on('proactive-errors-detected', proactiveErrorsDetected);

      await detectorManager.start();

      // Create multiple files rapidly to test queuing
      const files = Array.from({ length: 5 }, (_, i) => `queue-test-${i}.ts`);

      for (const fileName of files) {
        const filePath = join(tempDir, fileName);
        await fs.writeFile(
          filePath,
          `
          function ${fileName.replace('.ts', '').replace('-', '_')}() {
            // Test function with potential issues
            var unused = "variable";
            if (true) {
              if (true) {
                console.log("nested");
              }
            }
          }
        `
        );
      }

      await waitFor(() => proactiveErrorsDetected.mock.calls.length > 0, { attempts: 80 });

      // Should have processed files (may be batched)
      expect(proactiveErrorsDetected).toHaveBeenCalled();
    });
  });

  describe('Unified File Watcher Integration', () => {
    it('should use unified file watcher for enhanced monitoring', async () => {
      const fileWatchingStats = vi.fn();
      detectorManager.on('file-watching-stats', fileWatchingStats);

      await detectorManager.start();

      const status = detectorManager.getProactiveMonitoringStatus();
      expect(status.enabled).toBe(true);
      expect(status.running).toBe(true);

      // Create a file to trigger unified file watcher
      const testFile = join(tempDir, 'unified-test.ts');
      await fs.writeFile(
        testFile,
        `
        interface TestInterface {
          name: string;
          value: number;
        }

        function processData(data: TestInterface): string {
          return \`\${data.name}: \${data.value}\`;
        }
      `
      );

      await waitFor(() => fileWatchingStats.mock.calls.length > 0, { attempts: 60 });

      // Should have received performance stats
      expect(fileWatchingStats).toHaveBeenCalled();
    });

    it('should handle batched file changes efficiently', async () => {
      const fileBatchProcessed = vi.fn();

      const coordinator = new ProactiveMonitoringCoordinator(detectorManager, proactiveConfig);
      coordinator.on('file-batch-processed', fileBatchProcessed);

      try {
        await coordinator.start();

        // Create multiple files rapidly to trigger batching
        const files = Array.from({ length: 8 }, (_, i) => `batch-${i}.ts`);

        for (const fileName of files) {
          const filePath = join(tempDir, fileName);
          await fs.writeFile(
            filePath,
            `
            export const ${fileName.replace('.ts', '').replace('-', '_')} = {
              id: ${Math.random()},
              name: "${fileName}",
              timestamp: new Date()
            };
          `
          );
        }

        await waitFor(() => fileBatchProcessed.mock.calls.length > 0, { attempts: 80 });
      } finally {
        await coordinator.stop();
      }

      // Should have processed files in batches
      expect(fileBatchProcessed).toHaveBeenCalled();
    });

    it('should categorize files correctly', async () => {
      const sourceFileChanged = vi.fn();
      const configFileChanged = vi.fn();
      const testFileChanged = vi.fn();

      const coordinator = new ProactiveMonitoringCoordinator(detectorManager, proactiveConfig);
      coordinator.on('source-file-changed', sourceFileChanged);
      coordinator.on('config-file-changed', configFileChanged);
      coordinator.on('test-file-changed', testFileChanged);

      try {
        await coordinator.start();

        // Create different types of files
        await fs.writeFile(join(tempDir, 'source.ts'), 'export const value = 42;');
        await settleFs();
        await fs.writeFile(join(tempDir, 'test.spec.ts'), 'describe("test", () => {});');
        await settleFs();
        await fs.writeFile(join(tempDir, 'tsconfig.json'), '{"compilerOptions": {}}');
        await settleFs();

        await waitFor(
          () =>
            sourceFileChanged.mock.calls.length > 0 &&
            testFileChanged.mock.calls.length > 0 &&
            configFileChanged.mock.calls.length > 0,
          { attempts: 80, delayMs: 120 }
        );
      } finally {
        await coordinator.stop();
      }

      // Should have categorized files correctly
      expect(sourceFileChanged).toHaveBeenCalled();
      expect(testFileChanged).toHaveBeenCalled();
      expect(configFileChanged).toHaveBeenCalled();
    }, 12000);

    it('should provide file watching statistics', async () => {
      const coordinator = new ProactiveMonitoringCoordinator(detectorManager, proactiveConfig);
      try {
        await coordinator.start();

        // Check initial stats
        const stats = coordinator.getFileWatchingStats();
        expect(stats).toBeDefined();
        expect(stats?.totalEvents).toBe(0);
        expect(stats?.watchedFiles).toBeGreaterThanOrEqual(0);

        // Create a file to generate events
        await fs.writeFile(join(tempDir, 'stats-test.ts'), 'const x = 1;');

        await waitFor(() => (coordinator.getFileWatchingStats()?.totalEvents ?? 0) > 0, {
          attempts: 60,
        });

        const updatedStats = coordinator.getFileWatchingStats();
        expect(updatedStats?.totalEvents).toBeGreaterThan(0);
      } finally {
        await coordinator.stop();
      }
    });

    it('should handle language-specific file changes', async () => {
      const typescriptFileChanged = vi.fn();
      const javascriptFileChanged = vi.fn();

      const coordinator = new ProactiveMonitoringCoordinator(detectorManager, proactiveConfig);
      coordinator.on('typescript-file-changed', typescriptFileChanged);
      coordinator.on('javascript-file-changed', javascriptFileChanged);

      try {
        await coordinator.start();

        // Create language-specific files
        await fs.writeFile(join(tempDir, 'typescript-file.ts'), 'const x: number = 42;');
        await fs.writeFile(join(tempDir, 'javascript-file.js'), 'const y = 42;');

        await waitFor(
          () =>
            typescriptFileChanged.mock.calls.length > 0 &&
            javascriptFileChanged.mock.calls.length > 0,
          { attempts: 60 }
        );
      } finally {
        await coordinator.stop();
      }

      // Should have detected language-specific changes
      expect(typescriptFileChanged).toHaveBeenCalled();
      expect(javascriptFileChanged).toHaveBeenCalled();
    });
  });

  describe('Enhanced Configuration Monitoring', () => {
    it('should detect specific config file changes', async () => {
      const tsconfigChanged = vi.fn();
      const packageJsonChanged = vi.fn();
      const eslintConfigChanged = vi.fn();

      const coordinator = new ProactiveMonitoringCoordinator(detectorManager, proactiveConfig);
      coordinator.on('tsconfig-changed', tsconfigChanged);
      coordinator.on('package-json-changed', packageJsonChanged);
      coordinator.on('eslint-config-changed', eslintConfigChanged);

      try {
        await coordinator.start();

        // Create and modify specific config files
        await fs.writeFile(
          join(tempDir, 'tsconfig.json'),
          JSON.stringify({
            compilerOptions: { target: 'es2020' },
          })
        );
        await settleFs();

        await fs.writeFile(
          join(tempDir, 'package.json'),
          JSON.stringify({
            name: 'test',
            dependencies: { lodash: '^4.0.0' },
          })
        );
        await settleFs();

        await fs.writeFile(
          join(tempDir, '.eslintrc.json'),
          JSON.stringify({
            extends: ['@typescript-eslint/recommended'],
          })
        );
        await settleFs();

        await waitFor(
          () =>
            tsconfigChanged.mock.calls.length > 0 &&
            packageJsonChanged.mock.calls.length > 0 &&
            eslintConfigChanged.mock.calls.length > 0,
          { attempts: 80, delayMs: 120 }
        );
      } finally {
        await coordinator.stop();
      }

      // Should have detected specific config changes
      expect(tsconfigChanged).toHaveBeenCalled();
      expect(packageJsonChanged).toHaveBeenCalled();
      expect(eslintConfigChanged).toHaveBeenCalled();
    }, 12000);
  });
});
