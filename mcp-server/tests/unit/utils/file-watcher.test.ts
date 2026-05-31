/**
 * Tests for FileWatcher utility
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { FileWatcher, type FileWatcherOptions } from '../../../src/utils/file-watcher.js';

// Create mock functions outside of vi.mock to avoid hoisting issues
const mockWatcher = {
  add: vi.fn(),
  unwatch: vi.fn(),
  close: vi.fn(),
  on: vi.fn(),
};

vi.mock('chokidar', () => ({
  watch: vi.fn(() => mockWatcher),
}));

// Mock helpers
vi.mock('../../../src/utils/helpers.js', () => ({
  debounce: vi.fn(fn => fn),
}));

// Mock types
vi.mock('../../../src/types/index.js', () => ({
  WorkspaceEvent: {},
}));

describe('FileWatcher', () => {
  let fileWatcher: FileWatcher;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { watch } = vi.mocked(await import('chokidar'));
    watch.mockClear();
    mockWatcher.add.mockClear();
    mockWatcher.unwatch.mockClear();
    mockWatcher.close.mockClear();
    mockWatcher.on.mockClear();
    fileWatcher = new FileWatcher();
  });

  afterEach(() => {
    fileWatcher.close();
  });

  describe('Constructor', () => {
    it('should create FileWatcher with default options', () => {
      const watcher = new FileWatcher();
      expect(watcher).toBeInstanceOf(FileWatcher);
      expect(watcher).toBeInstanceOf(EventEmitter);
    });

    it('should create FileWatcher with custom options', () => {
      const options: FileWatcherOptions = {
        ignored: ['**/test/**'],
        persistent: false,
        usePolling: true,
        interval: 1000,
      };

      const watcher = new FileWatcher(options);
      expect(watcher).toBeInstanceOf(FileWatcher);
    });

    it('should merge custom options with defaults', () => {
      const options: FileWatcherOptions = {
        usePolling: true,
      };

      const watcher = new FileWatcher(options);
      expect(watcher).toBeInstanceOf(FileWatcher);
    });
  });

  describe('watch()', () => {
    it('should watch a single path', async () => {
      const { watch } = vi.mocked(await import('chokidar'));

      fileWatcher.watch('/test/path');

      expect(watch).toHaveBeenCalledWith(['/test/path'], expect.any(Object));
    });

    it('should watch multiple paths', async () => {
      const { watch } = vi.mocked(await import('chokidar'));
      const paths = ['/test/path1', '/test/path2'];

      fileWatcher.watch(paths);

      expect(watch).toHaveBeenCalledWith(paths, expect.any(Object));
    });

    it('should add paths to existing watcher', () => {
      fileWatcher.watch('/test/path1');
      fileWatcher.watch('/test/path2');

      expect(mockWatcher.add).toHaveBeenCalledWith(['/test/path2']);
    });

    it('should track watched paths', () => {
      fileWatcher.watch(['/test/path1', '/test/path2']);

      const watchedPaths = fileWatcher.getWatchedPaths();
      expect(watchedPaths).toContain('/test/path1');
      expect(watchedPaths).toContain('/test/path2');
    });
  });

  describe('unwatch()', () => {
    beforeEach(() => {
      fileWatcher.watch(['/test/path1', '/test/path2']);
    });

    it('should unwatch specific paths', () => {
      fileWatcher.unwatch('/test/path1');

      expect(mockWatcher.unwatch).toHaveBeenCalledWith(['/test/path1']);

      const watchedPaths = fileWatcher.getWatchedPaths();
      expect(watchedPaths).not.toContain('/test/path1');
      expect(watchedPaths).toContain('/test/path2');
    });

    it('should unwatch multiple paths', () => {
      fileWatcher.unwatch(['/test/path1', '/test/path2']);

      expect(mockWatcher.unwatch).toHaveBeenCalledWith(['/test/path1', '/test/path2']);
    });

    it('should unwatch all paths when no argument provided', () => {
      fileWatcher.unwatch();

      expect(mockWatcher.close).toHaveBeenCalled();
      expect(fileWatcher.getWatchedPaths()).toHaveLength(0);
    });

    it('should handle unwatching when no watcher exists', () => {
      const newWatcher = new FileWatcher();
      expect(() => newWatcher.unwatch('/test/path')).not.toThrow();
    });
  });

  describe('close()', () => {
    it('should close the watcher and clear paths', () => {
      fileWatcher.watch('/test/path');
      fileWatcher.close();

      expect(mockWatcher.close).toHaveBeenCalled();
      expect(fileWatcher.getWatchedPaths()).toHaveLength(0);
      expect(fileWatcher.isWatching()).toBe(false);
    });

    it('should handle closing when no watcher exists', () => {
      const newWatcher = new FileWatcher();
      expect(() => newWatcher.close()).not.toThrow();
    });
  });

  describe('getWatchedPaths()', () => {
    it('should return empty array initially', () => {
      expect(fileWatcher.getWatchedPaths()).toEqual([]);
    });

    it('should return watched paths', () => {
      fileWatcher.watch(['/test/path1', '/test/path2']);

      const paths = fileWatcher.getWatchedPaths();
      expect(paths).toContain('/test/path1');
      expect(paths).toContain('/test/path2');
    });
  });

  describe('isWatching()', () => {
    it('should return false initially', () => {
      expect(fileWatcher.isWatching()).toBe(false);
    });

    it('should return true when watching', () => {
      fileWatcher.watch('/test/path');
      expect(fileWatcher.isWatching()).toBe(true);
    });

    it('should return false after closing', () => {
      fileWatcher.watch('/test/path');
      fileWatcher.close();
      expect(fileWatcher.isWatching()).toBe(false);
    });
  });

  describe('Event Handling', () => {
    beforeEach(() => {
      fileWatcher.watch('/test/path');
    });

    it('should set up event handlers', () => {
      expect(mockWatcher.on).toHaveBeenCalledWith('add', expect.any(Function));
      expect(mockWatcher.on).toHaveBeenCalledWith('change', expect.any(Function));
      expect(mockWatcher.on).toHaveBeenCalledWith('unlink', expect.any(Function));
      expect(mockWatcher.on).toHaveBeenCalledWith('addDir', expect.any(Function));
      expect(mockWatcher.on).toHaveBeenCalledWith('unlinkDir', expect.any(Function));
      expect(mockWatcher.on).toHaveBeenCalledWith('error', expect.any(Function));
      expect(mockWatcher.on).toHaveBeenCalledWith('ready', expect.any(Function));
    });

    it('should emit workspace events for file changes', () => {
      const changeHandler = vi.fn();
      fileWatcher.on('change', changeHandler);

      // Simulate file add event
      const addHandler = mockWatcher.on.mock.calls.find(call => call[0] === 'add')[1];
      addHandler('/test/file.js');

      expect(changeHandler).toHaveBeenCalledWith({
        type: 'workspace:file-changed',
        timestamp: expect.any(Date),
        path: '/test/file.js',
        action: 'added',
      });
    });

    it('should emit workspace events for file modifications', () => {
      const changeHandler = vi.fn();
      fileWatcher.on('change', changeHandler);

      // Simulate file change event
      const changeEventHandler = mockWatcher.on.mock.calls.find(call => call[0] === 'change')[1];
      changeEventHandler('/test/file.js');

      expect(changeHandler).toHaveBeenCalledWith({
        type: 'workspace:file-changed',
        timestamp: expect.any(Date),
        path: '/test/file.js',
        action: 'modified',
      });
    });

    it('should emit workspace events for file deletions', () => {
      const changeHandler = vi.fn();
      fileWatcher.on('change', changeHandler);

      // Simulate file unlink event
      const unlinkHandler = mockWatcher.on.mock.calls.find(call => call[0] === 'unlink')[1];
      unlinkHandler('/test/file.js');

      expect(changeHandler).toHaveBeenCalledWith({
        type: 'workspace:file-changed',
        timestamp: expect.any(Date),
        path: '/test/file.js',
        action: 'deleted',
      });
    });

    it('should emit workspace events for directory changes', () => {
      const changeHandler = vi.fn();
      fileWatcher.on('change', changeHandler);

      // Simulate directory add event
      const addDirHandler = mockWatcher.on.mock.calls.find(call => call[0] === 'addDir')[1];
      addDirHandler('/test/newdir');

      expect(changeHandler).toHaveBeenCalledWith({
        type: 'workspace:directory-changed',
        timestamp: expect.any(Date),
        path: '/test/newdir',
        action: 'added',
      });
    });

    it('should forward error events', () => {
      const errorHandler = vi.fn();
      fileWatcher.on('error', errorHandler);

      const error = new Error('Test error');
      const errorEventHandler = mockWatcher.on.mock.calls.find(call => call[0] === 'error')[1];
      errorEventHandler(error);

      expect(errorHandler).toHaveBeenCalledWith(error);
    });

    it('should forward ready events', () => {
      const readyHandler = vi.fn();
      fileWatcher.on('ready', readyHandler);

      const readyEventHandler = mockWatcher.on.mock.calls.find(call => call[0] === 'ready')[1];
      readyEventHandler();

      expect(readyHandler).toHaveBeenCalled();
    });
  });

  describe('Static Factory Methods', () => {
    describe('createForWorkspace()', () => {
      it('should create watcher with workspace-specific options', () => {
        const watcher = FileWatcher.createForWorkspace('/workspace/root');
        expect(watcher).toBeInstanceOf(FileWatcher);
      });

      it('should merge custom options', () => {
        const options = { usePolling: true };
        const watcher = FileWatcher.createForWorkspace('/workspace/root', options);
        expect(watcher).toBeInstanceOf(FileWatcher);
      });
    });

    describe('createForSourceFiles()', () => {
      it('should create watcher for source files', async () => {
        const { watch } = vi.mocked(await import('chokidar'));
        const watcher = FileWatcher.createForSourceFiles('/workspace/root');
        expect(watcher).toBeInstanceOf(FileWatcher);
        expect(watch).toHaveBeenCalled();
      });

      it('should watch common source directories', async () => {
        const { watch } = vi.mocked(await import('chokidar'));
        FileWatcher.createForSourceFiles('/workspace/root');

        const watchCall = watch.mock.calls[0][0];
        expect(watchCall).toContain('src/**/*');
        expect(watchCall).toContain('*.ts');
        expect(watchCall).toContain('*.js');
        expect(watchCall).toContain('*.py');
      });
    });

    describe('createForConfigFiles()', () => {
      it('should create watcher for config files', async () => {
        const { watch } = vi.mocked(await import('chokidar'));
        const watcher = FileWatcher.createForConfigFiles('/workspace/root');
        expect(watcher).toBeInstanceOf(FileWatcher);
        expect(watch).toHaveBeenCalled();
      });

      it('should watch common config files', async () => {
        const { watch } = vi.mocked(await import('chokidar'));
        FileWatcher.createForConfigFiles('/workspace/root');

        const watchCall = watch.mock.calls[0][0];
        expect(watchCall).toContain('package.json');
        expect(watchCall).toContain('tsconfig.json');
        expect(watchCall).toContain('.eslintrc.*');
        expect(watchCall).toContain('Dockerfile');
      });
    });
  });

  describe('Error Handling', () => {
    it('should handle watcher creation errors gracefully', async () => {
      const { watch } = vi.mocked(await import('chokidar'));
      watch.mockImplementationOnce(() => {
        throw new Error('Watcher creation failed');
      });

      expect(() => fileWatcher.watch('/test/path')).not.toThrow();
    });

    it('should handle invalid paths gracefully', () => {
      expect(() => fileWatcher.watch('')).not.toThrow();
      expect(() => fileWatcher.watch([])).not.toThrow();
    });
  });
});
