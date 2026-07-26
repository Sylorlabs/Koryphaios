/**
 * File system watcher for monitoring code changes
 */

import { watch, FSWatcher } from 'chokidar';
import { EventEmitter } from 'events';

import type { WorkspaceEvent } from '@/types/index.js';
import { debounce } from './helpers.js';

export interface FileWatcherOptions {
  ignored?: string[];
  persistent?: boolean;
  ignoreInitial?: boolean;
  followSymlinks?: boolean;
  dot?: boolean;
  cwd?: string;
  ignorePermissionErrors?: boolean;
  disableGlobbing?: boolean;
  usePolling?: boolean;
  interval?: number;
  binaryInterval?: number;
  alwaysStat?: boolean;
  depth?: number;
  awaitWriteFinish?:
    | boolean
    | {
        stabilityThreshold?: number;
        pollInterval?: number;
      };
}

export class FileWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private watchedPaths: Set<string> = new Set();
  private options: FileWatcherOptions;
  private debouncedEmit: (event: WorkspaceEvent) => void;
  private isWatcherReady = false;
  private readyPromise: Promise<void>;
  private readyResolve: (() => void) | null = null;

  constructor(options: FileWatcherOptions = {}) {
    super();
    this.options = {
      ignored: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
      persistent: true,
      ignoreInitial: true,
      followSymlinks: false,
      dot: false,
      usePolling: false,
      ignorePermissionErrors: true,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 100,
      },
      ...options,
    };

    this.readyPromise = new Promise(resolve => {
      this.readyResolve = resolve;
    });

    // Debounce events to avoid spam
    this.debouncedEmit = debounce((event: WorkspaceEvent) => {
      this.emit('change', event);
    }, 100);
  }

  private createReadyPromise(): void {
    this.readyPromise = new Promise(resolve => {
      this.readyResolve = resolve;
    });
    this.isWatcherReady = false;
  }

  async waitForReady(): Promise<void> {
    await this.readyPromise;
  }

  isWatchingReady(): boolean {
    return this.isWatcherReady;
  }

  watch(paths: string | string[]): void {
    const pathsArray = Array.isArray(paths) ? paths : [paths];

    try {
      if (this.watcher) {
        // Add new paths to existing watcher
        this.watcher.add(pathsArray);
      } else {
        // Create new watcher
        this.watcher = watch(pathsArray, this.options);
        this.setupEventHandlers();
      }

      pathsArray.forEach(path => this.watchedPaths.add(path));
    } catch (error) {
      // Gracefully handle watcher creation errors
      console.warn('Failed to create file watcher:', error);
      // Don't throw, just log the error
    }
  }

  unwatch(paths?: string | string[]): void {
    if (!this.watcher) return;

    if (paths) {
      const pathsArray = Array.isArray(paths) ? paths : [paths];
      this.watcher.unwatch(pathsArray);
      pathsArray.forEach(path => this.watchedPaths.delete(path));
    } else {
      // Unwatch all paths
      this.watcher.close();
      this.watcher = null;
      this.watchedPaths.clear();
    }
  }

  async close(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
      this.watchedPaths.clear();
      this.createReadyPromise();
    }
  }

  getWatchedPaths(): string[] {
    return Array.from(this.watchedPaths);
  }

  isWatching(): boolean {
    return this.watcher !== null;
  }

  private setupEventHandlers(): void {
    if (!this.watcher) return;

    if (this.isWatcherReady && this.readyResolve) {
      return;
    }

    this.watcher.once('ready', () => {
      this.isWatcherReady = true;
      if (this.readyResolve) {
        this.readyResolve();
        this.readyResolve = null;
      }
    });

    this.watcher.on('add', (path: string) => {
      this.emitWorkspaceEvent('workspace:file-changed', path, 'added');
    });

    this.watcher.on('change', (path: string) => {
      this.emitWorkspaceEvent('workspace:file-changed', path, 'modified');
    });

    this.watcher.on('unlink', (path: string) => {
      this.emitWorkspaceEvent('workspace:file-changed', path, 'deleted');
    });

    this.watcher.on('addDir', (path: string) => {
      this.emitWorkspaceEvent('workspace:directory-changed', path, 'added');
    });

    this.watcher.on('unlinkDir', (path: string) => {
      this.emitWorkspaceEvent('workspace:directory-changed', path, 'deleted');
    });

    this.watcher.on('error', (error: Error) => {
      const fsError = error as NodeJS.ErrnoException;
      if (fsError.code === 'EACCES' || fsError.code === 'EPERM') {
        console.warn('Ignoring file watcher permission error', {
          code: fsError.code,
          path: fsError.path,
        });
        return;
      }

      this.emit('error', error);
    });

    this.watcher.on('ready', () => {
      if (!this.isWatcherReady) {
        this.isWatcherReady = true;
        if (this.readyResolve) {
          this.readyResolve();
          this.readyResolve = null;
        }
      }
      this.emit('ready');
    });
  }

  private emitWorkspaceEvent(
    type: 'workspace:file-changed' | 'workspace:directory-changed',
    path: string,
    action: 'added' | 'modified' | 'deleted'
  ): void {
    const event: WorkspaceEvent = {
      type,
      timestamp: new Date(),
      path,
      action,
    };

    this.debouncedEmit(event);
  }

  // Static method to create a watcher with common presets
  static createForWorkspace(
    workspaceRoot: string,
    options: Partial<FileWatcherOptions> = {}
  ): FileWatcher {
    const watcher = new FileWatcher({
      cwd: workspaceRoot,
      ignored: [
        '**/node_modules/**',
        '**/.git/**',
        '**/dist/**',
        '**/build/**',
        '**/.next/**',
        '**/.nuxt/**',
        '**/coverage/**',
        '**/.nyc_output/**',
        '**/*.log',
        '**/.DS_Store',
        '**/Thumbs.db',
      ],
      ...options,
    });

    return watcher;
  }

  static createForSourceFiles(
    workspaceRoot: string,
    options: Partial<FileWatcherOptions> = {}
  ): FileWatcher {
    const watcher = new FileWatcher({
      cwd: workspaceRoot,
      ignored: [
        '**/node_modules/**',
        '**/.git/**',
        '**/dist/**',
        '**/build/**',
        '**/*.min.js',
        '**/*.map',
        '**/*.d.ts',
      ],
      ...options,
    });

    // Watch common source directories
    watcher.watch([
      'src/**/*',
      'lib/**/*',
      'app/**/*',
      'pages/**/*',
      'components/**/*',
      'utils/**/*',
      'hooks/**/*',
      'services/**/*',
      '*.ts',
      '*.tsx',
      '*.js',
      '*.jsx',
      '*.py',
      '*.go',
      '*.rs',
      '*.json',
      '*.yaml',
      '*.yml',
    ]);

    return watcher;
  }

  static createForConfigFiles(
    workspaceRoot: string,
    options: Partial<FileWatcherOptions> = {}
  ): FileWatcher {
    const watcher = new FileWatcher({
      dot: true,
      cwd: workspaceRoot,
      ...options,
    });

    // Watch configuration files
    watcher.watch([
      'package.json',
      'tsconfig.json',
      'jsconfig.json',
      '.eslintrc',
      '.eslintrc.*',
      '.eslintrc.js',
      '.eslintrc.json',
      '.eslintrc.yaml',
      '.eslintrc.yml',
      '.eslintrc.cjs',
      '.eslintrc.mjs',
      '.prettierrc.*',
      'vite.config.*',
      'webpack.config.*',
      'next.config.*',
      'nuxt.config.*',
      'jest.config.*',
      'vitest.config.*',
      'tailwind.config.*',
      'postcss.config.*',
      '.env*',
      'Dockerfile',
      'docker-compose.*',
      'requirements.txt',
      'Pipfile',
      'pyproject.toml',
      'go.mod',
      'go.sum',
      'Cargo.toml',
      'Cargo.lock',
    ]);

    return watcher;
  }
}
