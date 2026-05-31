/**
 * Unified File Watcher for Real-time Error Detection
 * Provides centralized, optimized file watching for all detectors
 */

import { EventEmitter } from 'events';
import { watch, type FSWatcher } from 'chokidar';
import { extname, basename, relative, resolve } from 'path';
import { promises as fs } from 'fs';

import { Logger } from '@/utils/logger.js';
import { debounce } from '@/utils/helpers.js';

export interface FileChangeEvent {
  type: 'file-changed' | 'file-added' | 'file-deleted' | 'config-changed';
  path: string;
  relativePath: string;
  extension: string;
  language: string | null;
  category: FileCategory;
  timestamp: Date;
  size?: number;
}

export type FileCategory =
  | 'source'
  | 'test'
  | 'config'
  | 'build'
  | 'documentation'
  | 'asset'
  | 'other';

export interface UnifiedFileWatcherConfig {
  workspaceRoot: string;
  debounceMs: number;
  batchingEnabled: boolean;
  batchTimeoutMs: number;
  maxBatchSize: number;
  performanceMonitoring: boolean;
  watchPatterns: {
    source: string[];
    test: string[];
    config: string[];
    build: string[];
  };
  ignorePatterns: string[];
  languageExtensions: Record<string, string[]>;
}

export interface FileWatchingStats {
  totalEvents: number;
  eventsPerSecond: number;
  batchedEvents: number;
  watchedFiles: number;
  memoryUsage: number;
  lastEventTime: Date | null;
}

export class UnifiedFileWatcher extends EventEmitter {
  private config: UnifiedFileWatcherConfig;
  private logger: Logger;
  private watcher: FSWatcher | null = null;
  private isRunning = false;

  private eventBatch: FileChangeEvent[] = [];
  private batchTimer: NodeJS.Timeout | null = null;
  private debouncedEmit: (event: FileChangeEvent) => void;

  // Performance monitoring
  private stats: FileWatchingStats = {
    totalEvents: 0,
    eventsPerSecond: 0,
    batchedEvents: 0,
    watchedFiles: 0,
    memoryUsage: 0,
    lastEventTime: null,
  };
  private eventTimes: number[] = [];

  constructor(config: UnifiedFileWatcherConfig) {
    super();
    this.config = config;
    this.logger = new Logger('info', { logFile: undefined });

    this.debouncedEmit = debounce((event: FileChangeEvent) => {
      this.emitFileEvent(event);
    }, this.config.debounceMs);
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.logger.info('Starting unified file watcher', {
      workspaceRoot: this.config.workspaceRoot,
      debounceMs: this.config.debounceMs,
      batchingEnabled: this.config.batchingEnabled,
    });

    try {
      await this.initializeWatcher();
      await this.waitForReady();
      this.setupPerformanceMonitoring();

      this.emit('watcher-started');
      this.logger.info('Unified file watcher started successfully');
    } catch (error) {
      this.isRunning = false;
      this.emit('watcher-error', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    this.logger.info('Stopping unified file watcher');

    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }

    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    // Emit any remaining batched events
    if (this.eventBatch.length > 0) {
      this.emitBatchedEvents();
    }

    this.emit('watcher-stopped');
    this.logger.info('Unified file watcher stopped');
  }

  private async initializeWatcher(): Promise<void> {
    this.watcher = watch(this.config.workspaceRoot, {
      ignored: this.config.ignorePatterns,
      persistent: true,
      ignoreInitial: true,
      followSymlinks: false,
      usePolling: false,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 100,
      },
    });

    this.setupWatcherEvents();
  }

  private async waitForReady(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const watcher = this.watcher;
      if (!watcher) {
        resolve();
        return;
      }
      const handleReady = () => {
        watcher.off('error', handleError);
        resolve();
      };
      const handleError = (error: Error) => {
        watcher.off('ready', handleReady);
        reject(error);
      };

      watcher.once('ready', handleReady);
      watcher.once('error', handleError);
    });
  }

  private setupWatcherEvents(): void {
    if (!this.watcher) return;

    this.watcher.on('add', (path: string) => {
      this.handleFileEvent('file-added', path);
    });

    this.watcher.on('change', (path: string) => {
      this.handleFileEvent('file-changed', path);
    });

    this.watcher.on('unlink', (path: string) => {
      this.handleFileEvent('file-deleted', path);
    });

    this.watcher.on('error', (error: Error) => {
      this.logger.error('File watcher error', error);
      this.emit('watcher-error', error);
    });

    this.watcher.on('ready', () => {
      this.updateWatchedFilesCount();
      this.emit('watcher-ready');
    });
  }

  private async handleFileEvent(type: FileChangeEvent['type'], filePath: string): Promise<void> {
    try {
      const resolvedPath = this.resolveAbsolutePath(filePath);
      const relativePath = relative(this.config.workspaceRoot, resolvedPath);
      const extension = extname(resolvedPath);
      const language = this.detectLanguage(extension);
      const category = this.categorizeFile(resolvedPath, extension);

      // Get file size for performance monitoring
      let size: number | undefined;
      if (type !== 'file-deleted') {
        try {
          const stats = await fs.stat(resolvedPath);
          size = stats.size;
        } catch {
          // File might have been deleted between events
        }
      }

      const event: FileChangeEvent = {
        type,
        path: resolvedPath,
        relativePath,
        extension,
        language,
        category,
        timestamp: new Date(),
        ...(size !== undefined && { size }),
      };

      this.updateStats(event);

      // Handle config file changes immediately
      if (category === 'config') {
        event.type = 'config-changed';
        this.emitFileEvent(event);
        return;
      }

      // Use debouncing for regular files
      if (this.config.batchingEnabled) {
        this.addToBatch(event);
      } else {
        this.debouncedEmit(event);
      }
    } catch (error) {
      this.logger.warn('Error handling file event', { filePath, error });
    }
  }

  private resolveAbsolutePath(filePath: string): string {
    return filePath.startsWith(this.config.workspaceRoot)
      ? filePath
      : resolve(this.config.workspaceRoot, filePath);
  }

  private detectLanguage(extension: string): string | null {
    for (const [language, extensions] of Object.entries(this.config.languageExtensions)) {
      if (extensions.includes(extension)) {
        return language;
      }
    }
    return null;
  }

  private categorizeFile(filePath: string, extension: string): FileCategory {
    const fileName = basename(filePath);
    const lowerPath = filePath.toLowerCase();
    const normalizedPath = lowerPath.replace(/\\/g, '/');
    const pathSegments = normalizedPath.split('/');

    // Config files
    if (
      fileName.includes('config') ||
      fileName.includes('tsconfig') ||
      fileName.includes('package.json') ||
      fileName.includes('.eslintrc') ||
      fileName.includes('.prettierrc') ||
      fileName.startsWith('.env')
    ) {
      return 'config';
    }

    // Test files
    if (
      pathSegments.includes('__tests__') ||
      fileName.includes('.test.') ||
      fileName.includes('.spec.')
    ) {
      return 'test';
    }

    // Build files
    if (
      lowerPath.includes('build') ||
      lowerPath.includes('dist') ||
      fileName.includes('webpack') ||
      fileName.includes('vite') ||
      fileName.includes('rollup')
    ) {
      return 'build';
    }

    // Documentation
    if (['.md', '.txt', '.rst'].includes(extension)) {
      return 'documentation';
    }

    // Source files
    if (
      ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.c', '.cpp'].includes(extension)
    ) {
      return 'source';
    }

    // Assets
    if (
      ['.css', '.scss', '.sass', '.less', '.png', '.jpg', '.jpeg', '.gif', '.svg'].includes(
        extension
      )
    ) {
      return 'asset';
    }

    return 'other';
  }

  private addToBatch(event: FileChangeEvent): void {
    this.emitFileEvent(event);
    this.eventBatch.push(event);

    // Emit batch if it reaches max size
    if (this.eventBatch.length >= this.config.maxBatchSize) {
      this.emitBatchedEvents();
      return;
    }

    // Set timer for batch timeout
    if (!this.batchTimer) {
      this.batchTimer = setTimeout(() => {
        this.emitBatchedEvents();
      }, this.config.batchTimeoutMs);
    }
  }

  private emitBatchedEvents(): void {
    if (this.eventBatch.length === 0) {
      return;
    }

    const batch = [...this.eventBatch];
    this.eventBatch = [];

    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    this.stats.batchedEvents += batch.length;
    this.emit('file-batch-changed', batch);
    for (const event of batch) {
      this.emitFileEvent(event);
    }

    this.logger.debug(`Emitted batch of ${batch.length} file events`);
  }

  private emitFileEvent(event: FileChangeEvent): void {
    this.emit(event.type, event);
    this.emit('file-changed', event);

    // Emit category-specific events
    this.emit(`${event.category}-file-changed`, event);

    // Emit language-specific events
    if (event.language) {
      this.emit(`${event.language}-file-changed`, event);
    }
  }

  private updateStats(event: FileChangeEvent): void {
    this.stats.totalEvents++;
    this.stats.lastEventTime = event.timestamp;

    // Track events per second
    const now = Date.now();
    this.eventTimes.push(now);

    // Keep only events from the last second
    this.eventTimes = this.eventTimes.filter(time => now - time < 1000);
    this.stats.eventsPerSecond = this.eventTimes.length;
  }

  private async updateWatchedFilesCount(): Promise<void> {
    if (this.watcher) {
      const watched = this.watcher.getWatched();
      this.stats.watchedFiles = Object.values(watched).reduce(
        (total, files) => total + files.length,
        0
      );
    }
  }

  private setupPerformanceMonitoring(): void {
    if (!this.config.performanceMonitoring) {
      return;
    }

    this.stats.memoryUsage = process.memoryUsage().heapUsed;
    this.emit('performance-stats', { ...this.stats });

    setInterval(() => {
      this.stats.memoryUsage = process.memoryUsage().heapUsed;
      this.emit('performance-stats', { ...this.stats });
    }, 1000);
  }

  // Public API
  getStats(): FileWatchingStats {
    return { ...this.stats };
  }

  isWatcherRunning(): boolean {
    return this.isRunning;
  }

  getWatchedPaths(): string[] {
    if (!this.watcher) return [];

    const watched = this.watcher.getWatched();
    return Object.keys(watched);
  }

  // Static factory methods
  static createDefault(workspaceRoot: string): UnifiedFileWatcher {
    return new UnifiedFileWatcher({
      workspaceRoot,
      debounceMs: 300,
      batchingEnabled: true,
      batchTimeoutMs: 1000,
      maxBatchSize: 10,
      performanceMonitoring: true,
      watchPatterns: {
        source: [
          'src/**/*.{ts,tsx,js,jsx,py,go,rs,java,c,cpp}',
          'lib/**/*.{ts,tsx,js,jsx,py,go,rs,java,c,cpp}',
          'app/**/*.{ts,tsx,js,jsx,py,go,rs,java,c,cpp}',
          'components/**/*.{ts,tsx,js,jsx}',
          'utils/**/*.{ts,tsx,js,jsx}',
          'hooks/**/*.{ts,tsx,js,jsx}',
          'services/**/*.{ts,tsx,js,jsx}',
        ],
        test: [
          '**/*.{test,spec}.{ts,tsx,js,jsx,py,go,rs}',
          'tests/**/*.{ts,tsx,js,jsx,py,go,rs}',
          '__tests__/**/*.{ts,tsx,js,jsx,py,go,rs}',
        ],
        config: [
          'package.json',
          'tsconfig*.json',
          'jsconfig.json',
          '.eslintrc*',
          '.prettierrc*',
          'vite.config.*',
          'webpack.config.*',
          'next.config.*',
          'jest.config.*',
          'vitest.config.*',
          '.env*',
        ],
        build: ['dist/**/*', 'build/**/*', '.next/**/*', '.nuxt/**/*'],
      },
      ignorePatterns: [
        '**/node_modules/**',
        '**/.git/**',
        '**/dist/**',
        '**/build/**',
        '**/.next/**',
        '**/.nuxt/**',
        '**/coverage/**',
        '**/*.min.js',
        '**/*.map',
        '**/.DS_Store',
        '**/Thumbs.db',
      ],
      languageExtensions: {
        typescript: ['.ts', '.tsx'],
        javascript: ['.js', '.jsx'],
        python: ['.py'],
        go: ['.go'],
        rust: ['.rs'],
        java: ['.java'],
        c: ['.c'],
        cpp: ['.cpp', '.cxx', '.cc'],
        csharp: ['.cs'],
        php: ['.php'],
        ruby: ['.rb'],
      },
    });
  }
}
