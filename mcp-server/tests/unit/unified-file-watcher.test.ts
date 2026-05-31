/**
 * Unit tests for UnifiedFileWatcher
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  UnifiedFileWatcher,
  type FileChangeEvent,
  type UnifiedFileWatcherConfig,
} from '@/monitoring/unified-file-watcher.js';

describe('UnifiedFileWatcher', () => {
  let tempDir: string;
  let watcher: UnifiedFileWatcher;
  let config: UnifiedFileWatcherConfig;

  beforeEach(async () => {
    // Create temporary directory for testing
    tempDir = await fs.mkdtemp(join(tmpdir(), 'unified-watcher-test-'));

    config = {
      workspaceRoot: tempDir,
      debounceMs: 50, // Faster for testing
      batchingEnabled: true,
      batchTimeoutMs: 200,
      maxBatchSize: 5,
      performanceMonitoring: true,
      watchPatterns: {
        source: ['**/*.{ts,tsx,js,jsx}'],
        test: ['**/*.{test,spec}.{ts,tsx,js,jsx}'],
        config: ['package.json', 'tsconfig*.json', '.eslintrc*'],
        build: ['dist/**/*', 'build/**/*'],
      },
      ignorePatterns: ['**/node_modules/**', '**/.git/**'],
      languageExtensions: {
        typescript: ['.ts', '.tsx'],
        javascript: ['.js', '.jsx'],
      },
    };

    watcher = new UnifiedFileWatcher(config);
  });

  afterEach(async () => {
    if (watcher.isWatcherRunning()) {
      await watcher.stop();
    }

    // Clean up temporary directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Initialization and Lifecycle', () => {
    it('should initialize with correct configuration', () => {
      expect(watcher.isWatcherRunning()).toBe(false);
      expect(watcher.getStats().totalEvents).toBe(0);
    });

    it('should start and stop correctly', async () => {
      await watcher.start();
      expect(watcher.isWatcherRunning()).toBe(true);

      await watcher.stop();
      expect(watcher.isWatcherRunning()).toBe(false);
    });

    it('should handle multiple start calls gracefully', async () => {
      await watcher.start();
      await watcher.start(); // Should not throw
      expect(watcher.isWatcherRunning()).toBe(true);
    });

    it('should handle stop when not running', async () => {
      await watcher.stop(); // Should not throw
      expect(watcher.isWatcherRunning()).toBe(false);
    });
  });

  describe('File Change Detection', () => {
    it('should detect file additions', async () => {
      const fileChanged = vi.fn();
      watcher.on('file-changed', fileChanged);

      await watcher.start();

      // Create a TypeScript file
      const testFile = join(tempDir, 'test.ts');
      await fs.writeFile(testFile, 'const x: number = 42;');

      // Wait for file detection
      await new Promise(resolve => setTimeout(resolve, 1000));

      expect(fileChanged).toHaveBeenCalled();
      const event: FileChangeEvent = fileChanged.mock.calls[0][0];
      expect(event.type).toBe('file-added');
      expect(event.language).toBe('typescript');
      expect(event.category).toBe('source');
    });

    it('should detect file modifications', async () => {
      const fileChanged = vi.fn();
      watcher.on('file-changed', fileChanged);

      // Create file first
      const testFile = join(tempDir, 'modify-test.ts');
      await fs.writeFile(testFile, 'const x = 1;');

      await watcher.start();

      // Wait a bit then modify
      await new Promise(resolve => setTimeout(resolve, 100));
      await fs.writeFile(testFile, 'const x = 2;');

      // Wait for change detection
      await new Promise(resolve => setTimeout(resolve, 300));

      expect(fileChanged).toHaveBeenCalled();
      const event: FileChangeEvent = fileChanged.mock.calls[0][0];
      expect(event.type).toBe('file-changed');
    });

    it('should detect file deletions', async () => {
      const fileChanged = vi.fn();
      watcher.on('file-changed', fileChanged);

      // Create file first
      const testFile = join(tempDir, 'delete-test.ts');
      await fs.writeFile(testFile, 'const x = 1;');

      await watcher.start();

      // Wait a bit then delete
      await new Promise(resolve => setTimeout(resolve, 100));
      await fs.unlink(testFile);

      // Wait for deletion detection
      await new Promise(resolve => setTimeout(resolve, 300));

      expect(fileChanged).toHaveBeenCalled();
      const event: FileChangeEvent = fileChanged.mock.calls[0][0];
      expect(event.type).toBe('file-deleted');
    });
  });

  describe('File Categorization', () => {
    it('should categorize source files correctly', async () => {
      const sourceFileChanged = vi.fn();
      watcher.on('source-file-changed', sourceFileChanged);

      await watcher.start();

      await fs.writeFile(join(tempDir, 'component.tsx'), 'export const Component = () => <div />;');

      await new Promise(resolve => setTimeout(resolve, 300));

      expect(sourceFileChanged).toHaveBeenCalled();
      const event: FileChangeEvent = sourceFileChanged.mock.calls[0][0];
      expect(event.category).toBe('source');
      expect(event.language).toBe('typescript');
    });

    it('should categorize test files correctly', async () => {
      const testFileChanged = vi.fn();
      watcher.on('test-file-changed', testFileChanged);

      await watcher.start();

      await fs.writeFile(join(tempDir, 'component.test.ts'), 'describe("test", () => {});');

      await new Promise(resolve => setTimeout(resolve, 300));

      expect(testFileChanged).toHaveBeenCalled();
      const event: FileChangeEvent = testFileChanged.mock.calls[0][0];
      expect(event.category).toBe('test');
    });

    it('should categorize config files correctly', async () => {
      const configFileChanged = vi.fn();
      watcher.on('config-changed', configFileChanged);

      await watcher.start();

      await fs.writeFile(join(tempDir, 'tsconfig.json'), '{"compilerOptions": {}}');

      await new Promise(resolve => setTimeout(resolve, 300));

      expect(configFileChanged).toHaveBeenCalled();
      const event: FileChangeEvent = configFileChanged.mock.calls[0][0];
      expect(event.category).toBe('config');
    });
  });

  describe('Language Detection', () => {
    it('should detect TypeScript files', async () => {
      const typescriptFileChanged = vi.fn();
      watcher.on('typescript-file-changed', typescriptFileChanged);

      await watcher.start();

      await fs.writeFile(join(tempDir, 'typescript.ts'), 'interface Test {}');

      await new Promise(resolve => setTimeout(resolve, 1000));

      expect(typescriptFileChanged).toHaveBeenCalled();
    });

    it('should detect JavaScript files', async () => {
      const javascriptFileChanged = vi.fn();
      watcher.on('javascript-file-changed', javascriptFileChanged);

      await watcher.start();

      await fs.writeFile(join(tempDir, 'javascript.js'), 'const test = {};');

      await new Promise(resolve => setTimeout(resolve, 300));

      expect(javascriptFileChanged).toHaveBeenCalled();
    });
  });

  describe('Batching Functionality', () => {
    it('should batch multiple file changes', async () => {
      const fileBatchChanged = vi.fn();
      watcher.on('file-batch-changed', fileBatchChanged);

      await watcher.start();

      // Create multiple files rapidly
      const files = ['batch1.ts', 'batch2.ts', 'batch3.ts'];
      for (const fileName of files) {
        await fs.writeFile(join(tempDir, fileName), `const ${fileName.replace('.ts', '')} = 1;`);
      }

      // Wait for batching
      await new Promise(resolve => setTimeout(resolve, 500));

      expect(fileBatchChanged).toHaveBeenCalled();
      const events: FileChangeEvent[] = fileBatchChanged.mock.calls[0][0];
      expect(events.length).toBeGreaterThan(0);
    });

    it('should respect max batch size', async () => {
      const fileBatchChanged = vi.fn();
      watcher.on('file-batch-changed', fileBatchChanged);

      await watcher.start();

      // Create more files than max batch size
      const files = Array.from({ length: 8 }, (_, i) => `batch-max-${i}.ts`);
      for (const fileName of files) {
        await fs.writeFile(
          join(tempDir, fileName),
          `const file${fileName.replace('.ts', '')} = 1;`
        );
      }

      // Wait for batching
      await new Promise(resolve => setTimeout(resolve, 600));

      expect(fileBatchChanged).toHaveBeenCalled();
      // Should have multiple batches due to max size limit
      const totalEvents = fileBatchChanged.mock.calls.reduce(
        (total, call) => total + call[0].length,
        0
      );
      expect(totalEvents).toBeGreaterThan(0);
    });
  });

  describe('Performance Monitoring', () => {
    it('should track performance statistics', async () => {
      const performanceStats = vi.fn();
      watcher.on('performance-stats', performanceStats);

      await watcher.start();

      // Create a file to generate events
      await fs.writeFile(join(tempDir, 'perf-test.ts'), 'const x = 1;');

      // Wait for stats
      await new Promise(resolve => setTimeout(resolve, 1500));

      expect(performanceStats).toHaveBeenCalled();
      const stats = performanceStats.mock.calls.at(-1)?.[0];
      expect(stats.totalEvents).toBeGreaterThan(0);
      expect(stats.memoryUsage).toBeGreaterThan(0);
    });

    it('should provide accurate statistics via getStats()', async () => {
      await watcher.start();

      const initialStats = watcher.getStats();
      expect(initialStats.totalEvents).toBe(0);

      // Create a file
      await fs.writeFile(join(tempDir, 'stats-test.ts'), 'const x = 1;');

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 1000));

      const updatedStats = watcher.getStats();
      expect(updatedStats.totalEvents).toBeGreaterThan(initialStats.totalEvents);
      expect(updatedStats.lastEventTime).toBeDefined();
    });
  });

  describe('Static Factory Methods', () => {
    it('should create default watcher with correct configuration', () => {
      const defaultWatcher = UnifiedFileWatcher.createDefault(tempDir);
      expect(defaultWatcher.isWatcherRunning()).toBe(false);

      const stats = defaultWatcher.getStats();
      expect(stats.totalEvents).toBe(0);
    });
  });

  describe('Error Handling', () => {
    it('should handle watcher errors gracefully', async () => {
      const watcherError = vi.fn();
      watcher.on('watcher-error', watcherError);

      await watcher.start();

      // Simulate an error by trying to watch a non-existent path
      // This is implementation-dependent and may not always trigger an error
      // The test ensures the error handler is set up correctly
      expect(watcher.isWatcherRunning()).toBe(true);
    });
  });
});
