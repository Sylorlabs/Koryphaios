/**
 * Integration tests for proactive monitoring functionality
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { ErrorDetectorManager } from '@/detectors/error-detector-manager.js';
import { ProactiveMonitoringCoordinator } from '@/monitoring/proactive-monitoring-coordinator.js';
import { UnifiedFileWatcher } from '@/monitoring/unified-file-watcher.js';
import type { ErrorDetectionConfig } from '@/types/index.js';
import type { ProactiveMonitoringConfig } from '@/monitoring/proactive-monitoring-coordinator.js';

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

      // Wait for file watching to trigger
      await new Promise(resolve => setTimeout(resolve, 500));

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

      // Wait for file watching to process all files
      await new Promise(resolve => setTimeout(resolve, 1000));

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

      // Wait for compilation status to update
      await new Promise(resolve => setTimeout(resolve, 300));

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
      await new Promise(resolve => setTimeout(resolve, 300));

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

      // Wait for change detection
      await new Promise(resolve => setTimeout(resolve, 300));

      await coordinator.stop();

      // Should have detected the config file change
      expect(configFileChanged).toHaveBeenCalled();
    });

    it('should detect package.json changes', async () => {
      const dependencyChangeDetected = vi.fn();

      const coordinator = new ProactiveMonitoringCoordinator(detectorManager, proactiveConfig);
      coordinator.on('dependency-change-detected', dependencyChangeDetected);

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

      // Wait for file watching to detect the change
      await new Promise(resolve => setTimeout(resolve, 300));

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

      // Wait for change detection
      await new Promise(resolve => setTimeout(resolve, 300));

      await coordinator.stop();

      // Should have detected the dependency change
      expect(dependencyChangeDetected).toHaveBeenCalled();
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

      // Wait for all files to be processed
      await new Promise(resolve => setTimeout(resolve, 2000));

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

      // Wait for file watching to process
      await new Promise(resolve => setTimeout(resolve, 800));

      // Should have received performance stats
      expect(fileWatchingStats).toHaveBeenCalled();
    });

    it('should handle batched file changes efficiently', async () => {
      const fileBatchProcessed = vi.fn();

      const coordinator = new ProactiveMonitoringCoordinator(detectorManager, proactiveConfig);
      coordinator.on('file-batch-processed', fileBatchProcessed);

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

      // Wait for batch processing
      await new Promise(resolve => setTimeout(resolve, 1500));

      await coordinator.stop();

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

      await coordinator.start();

      // Create different types of files
      await fs.writeFile(join(tempDir, 'source.ts'), 'export const value = 42;');
      await fs.writeFile(join(tempDir, 'test.spec.ts'), 'describe("test", () => {});');
      await fs.writeFile(join(tempDir, 'tsconfig.json'), '{"compilerOptions": {}}');

      // Wait for categorization
      await new Promise(resolve => setTimeout(resolve, 600));

      await coordinator.stop();

      // Should have categorized files correctly
      expect(sourceFileChanged).toHaveBeenCalled();
      expect(testFileChanged).toHaveBeenCalled();
      expect(configFileChanged).toHaveBeenCalled();
    });

    it('should provide file watching statistics', async () => {
      const coordinator = new ProactiveMonitoringCoordinator(detectorManager, proactiveConfig);
      await coordinator.start();

      // Check initial stats
      const stats = coordinator.getFileWatchingStats();
      expect(stats).toBeDefined();
      expect(stats?.totalEvents).toBe(0);
      expect(stats?.watchedFiles).toBeGreaterThanOrEqual(0);

      // Create a file to generate events
      await fs.writeFile(join(tempDir, 'stats-test.ts'), 'const x = 1;');

      // Wait for event processing
      await new Promise(resolve => setTimeout(resolve, 300));

      const updatedStats = coordinator.getFileWatchingStats();
      expect(updatedStats?.totalEvents).toBeGreaterThan(0);

      await coordinator.stop();
    });

    it('should handle language-specific file changes', async () => {
      const typescriptFileChanged = vi.fn();
      const javascriptFileChanged = vi.fn();

      const coordinator = new ProactiveMonitoringCoordinator(detectorManager, proactiveConfig);
      coordinator.on('typescript-file-changed', typescriptFileChanged);
      coordinator.on('javascript-file-changed', javascriptFileChanged);

      await coordinator.start();

      // Create language-specific files
      await fs.writeFile(join(tempDir, 'typescript-file.ts'), 'const x: number = 42;');
      await fs.writeFile(join(tempDir, 'javascript-file.js'), 'const y = 42;');

      // Wait for language detection
      await new Promise(resolve => setTimeout(resolve, 400));

      await coordinator.stop();

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

      await coordinator.start();

      // Create and modify specific config files
      await fs.writeFile(
        join(tempDir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { target: 'es2020' },
        })
      );

      await fs.writeFile(
        join(tempDir, 'package.json'),
        JSON.stringify({
          name: 'test',
          dependencies: { lodash: '^4.0.0' },
        })
      );

      await fs.writeFile(
        join(tempDir, '.eslintrc.json'),
        JSON.stringify({
          extends: ['@typescript-eslint/recommended'],
        })
      );

      // Wait for config detection
      await new Promise(resolve => setTimeout(resolve, 500));

      await coordinator.stop();

      // Should have detected specific config changes
      expect(tsconfigChanged).toHaveBeenCalled();
      expect(packageJsonChanged).toHaveBeenCalled();
      expect(eslintConfigChanged).toHaveBeenCalled();
    });
  });
});
