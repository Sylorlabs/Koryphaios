/**
 * Proactive Monitoring Coordinator
 * Coordinates proactive error detection across all detectors and build processes
 */

import { EventEmitter } from 'events';
import { watch, type FSWatcher as ChokidarFSWatcher } from 'chokidar';
import { promises as fs, watchFile, unwatchFile } from 'fs';
import { type ChildProcess } from 'child_process';
import { join, extname, basename, relative } from 'path';

import type { DetectedError } from '@/types/index.js';
import type { ErrorDetectorManager } from '@/detectors/error-detector-manager.js';
import { FileWatcher } from '@/utils/file-watcher.js';
import type { WorkspaceEvent } from '@/types/index.js';
import {
  UnifiedFileWatcher,
  type FileChangeEvent,
  type FileWatchingStats,
} from '@/monitoring/unified-file-watcher.js';
import { Logger } from '@/utils/logger.js';

export interface ProactiveMonitoringConfig {
  enabled: boolean;
  workspaceRoot: string;
  fileWatching: {
    enabled: boolean;
    debounceMs: number;
    watchPatterns: string[];
    ignorePatterns: string[];
  };
  buildProcessMonitoring: {
    enabled: boolean;
    buildCommands: string[];
    watchConfigFiles: boolean;
    autoRestartBuilds: boolean;
  };
  compilationMonitoring: {
    enabled: boolean;
    languages: string[];
    watchTsConfig: boolean;
    watchPackageJson: boolean;
  };
  realTimeAnalysis: {
    enabled: boolean;
    analysisDelay: number;
    maxConcurrentAnalysis: number;
  };
}

export interface BuildProcessInfo {
  id: string;
  command: string;
  process: ChildProcess;
  startTime: Date;
  status: 'running' | 'completed' | 'failed' | 'killed';
  errors: DetectedError[];
}

export interface CompilationStatus {
  language: string;
  status: 'idle' | 'compiling' | 'success' | 'error';
  lastCompilation: Date;
  errors: DetectedError[];
}

export class ProactiveMonitoringCoordinator extends EventEmitter {
  private config: ProactiveMonitoringConfig;
  private detectorManager: ErrorDetectorManager;
  private logger: Logger;

  private fileWatcher: FileWatcher | null = null;
  private configFileWatcher: FileWatcher | null = null;
  private unifiedFileWatcher: UnifiedFileWatcher | null = null;
  private configWatchers = new Map<string, { close: () => void | Promise<void> }>();
  private buildProcesses: Map<string, BuildProcessInfo> = new Map();
  private compilationStatuses: Map<string, CompilationStatus> = new Map();

  private isRunning = false;
  private analysisQueue: string[] = [];
  private activeAnalysis = 0;

  constructor(detectorManager: ErrorDetectorManager, config: ProactiveMonitoringConfig) {
    super();
    this.detectorManager = detectorManager;
    this.config = config;
    this.logger = new Logger('info', { logFile: undefined });

    this.setupEventHandlers();
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.logger.info('Starting proactive monitoring coordinator');

    try {
      // Start file watching
      if (this.config.fileWatching.enabled) {
        await this.startFileWatching();
      }

      // Start build process monitoring
      if (this.config.buildProcessMonitoring.enabled) {
        await this.startBuildProcessMonitoring();
      }

      // Start compilation monitoring
      if (this.config.compilationMonitoring.enabled) {
        await this.startCompilationMonitoring();
      }

      // Initialize compilation statuses
      this.initializeCompilationStatuses();

      this.emit('coordinator-started');
      this.logger.info('Proactive monitoring coordinator started successfully');
    } catch (error) {
      this.isRunning = false;
      this.emit('coordinator-error', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    this.logger.info('Stopping proactive monitoring coordinator');

    // Stop unified file watcher
    if (this.unifiedFileWatcher) {
      await this.unifiedFileWatcher.stop();
      this.unifiedFileWatcher = null;
    }

    // Stop legacy file watching
    if (this.fileWatcher) {
      await this.fileWatcher.close();
      this.fileWatcher = null;
    }

    if (this.configFileWatcher) {
      await this.configFileWatcher.close();
      this.configFileWatcher = null;
    }

    for (const watcher of this.configWatchers.values()) {
      await watcher.close();
    }
    this.configWatchers.clear();

    // Stop all build processes
    for (const [, buildInfo] of this.buildProcesses) {
      if (buildInfo.status === 'running') {
        buildInfo.process.kill();
        buildInfo.status = 'killed';
      }
    }
    this.buildProcesses.clear();

    // Clear compilation statuses
    this.compilationStatuses.clear();

    this.emit('coordinator-stopped');
    this.logger.info('Proactive monitoring coordinator stopped');
  }

  private setupEventHandlers(): void {
    // Listen to detector manager events
    this.detectorManager.on('error-detected', (error: DetectedError) => {
      this.handleDetectedError(error);
    });

    this.detectorManager.on('detector-error', (event: any) => {
      this.logger.warn('Detector error in proactive monitoring', event);
    });
  }

  private async startFileWatching(): Promise<void> {
    // Use unified file watcher for enhanced real-time monitoring
    this.unifiedFileWatcher = UnifiedFileWatcher.createDefault(this.config.workspaceRoot);

    // Set up event handlers for unified file watcher
    this.unifiedFileWatcher.on('file-changed', (event: FileChangeEvent) => {
      this.handleUnifiedFileChange(event);
    });

    this.unifiedFileWatcher.on('file-batch-changed', (events: FileChangeEvent[]) => {
      this.handleBatchedFileChanges(events);
    });

    this.unifiedFileWatcher.on('config-changed', (event: FileChangeEvent) => {
      this.handleConfigFileChange(event);
    });

    this.unifiedFileWatcher.on('performance-stats', (stats: FileWatchingStats) => {
      this.emit('file-watching-stats', stats);
    });

    this.unifiedFileWatcher.on('watcher-error', (error: Error) => {
      this.logger.error('Unified file watcher error', error);
      this.emit('coordinator-error', error);
    });

    await this.unifiedFileWatcher.start();

    // Keep legacy file watcher for backward compatibility
    this.fileWatcher = FileWatcher.createForSourceFiles(this.config.workspaceRoot, {
      ignored: this.config.fileWatching.ignorePatterns,
    });

    this.fileWatcher.on('change', (event: WorkspaceEvent) => {
      this.handleFileChange(event);
    });
    this.fileWatcher.on('error', (error: Error) => {
      this.logger.warn('Legacy source file watcher error', {
        error: error instanceof Error ? error.message : String(error),
      });
    });

    // Also watch configuration files explicitly for reliable config-event coverage
    this.configFileWatcher = FileWatcher.createForConfigFiles(this.config.workspaceRoot, {
      ignored: this.config.fileWatching.ignorePatterns,
    });

    this.configFileWatcher.on('change', (event: WorkspaceEvent) => {
      this.handleConfigFileEvent(event);
    });
    this.configFileWatcher.on('error', (error: Error) => {
      this.logger.warn('Config file watcher error', {
        error: error instanceof Error ? error.message : String(error),
      });
    });

    await Promise.all([this.fileWatcher.waitForReady(), this.configFileWatcher.waitForReady()]);

    this.logger.info('Enhanced file watching started for proactive monitoring');
  }

  private async startBuildProcessMonitoring(): Promise<void> {
    // Monitor package.json changes for build script updates
    if (this.config.buildProcessMonitoring.watchConfigFiles) {
      await this.watchConfigFilePattern('package.json', 'package.json');
    }

    this.logger.info('Build process monitoring started');
  }

  private async startCompilationMonitoring(): Promise<void> {
    // Watch TypeScript config files
    if (this.config.compilationMonitoring.watchTsConfig) {
      await this.watchConfigFilePattern('tsconfig*.json', 'tsconfig.json');
    }

    if (this.config.compilationMonitoring.watchPackageJson) {
      await this.watchConfigFilePattern('package.json', 'package.json');
    }

    await this.watchEslintConfigFiles();

    this.logger.info('Compilation monitoring started');
  }

  private async watchConfigFilePattern(pattern: string, type: string): Promise<void> {
    if (this.configWatchers.has(pattern)) {
      return;
    }

    const watcherPatterns = this.expandConfigWatchPattern(pattern);
    const watcher = watch(watcherPatterns, {
      cwd: this.config.workspaceRoot,
      persistent: true,
      ignoreInitial: true,
      dot: true,
      ignorePermissionErrors: true,
    });
    this.configWatchers.set(pattern, watcher);

    const emitConfigFileChange = (filePath: string) => {
      const absolutePath = join(this.config.workspaceRoot, filePath);
      this.logger.info(`Configuration file changed: ${type}`, { path: filePath });
      const event: FileChangeEvent = {
        type: 'config-changed',
        path: absolutePath,
        relativePath: filePath,
        extension: extname(filePath),
        language: null,
        category: 'config',
        timestamp: new Date(),
      };
      this.handleConfigFileChange(event);
    };

    watcher.on('add', emitConfigFileChange);
    watcher.on('change', emitConfigFileChange);
    watcher.on('error', error => {
      this.logger.warn(`Failed to watch config pattern ${pattern}`, error);
    });

    await this.waitForChokidarReady(watcher);
  }

  private async watchEslintConfigFiles(): Promise<void> {
    const configFiles = [
      '.eslintrc',
      '.eslintrc.js',
      '.eslintrc.json',
      '.eslintrc.yaml',
      '.eslintrc.yml',
      '.eslintrc.cjs',
      '.eslintrc.mjs',
    ];

    const watcherPromises = configFiles.map(async fileName => {
      const filePath = join(this.config.workspaceRoot, fileName);
      if (this.configWatchers.has(filePath)) {
        return;
      }

      let lastKnownMtime = 0;

      try {
        const existingStat = await fs.stat(filePath);
        lastKnownMtime = existingStat.mtimeMs;
      } catch (error) {
        this.logger.debug(
          `ESLint config file ${fileName} does not exist yet, polling until creation`
        );
      }

      const emitConfigFileChange = (path: string) => {
        const relativePath = relative(this.config.workspaceRoot, path);
        this.logger.info('Configuration file changed: eslint', { path: relativePath });
        const event: FileChangeEvent = {
          type: 'config-changed',
          path,
          relativePath,
          extension: extname(path),
          language: null,
          category: 'config',
          timestamp: new Date(),
        };
        this.handleConfigFileChange(event);
      };

      watchFile(
        filePath,
        {
          persistent: true,
          interval: 300,
        },
        current => {
          if (current.mtimeMs === lastKnownMtime || current.mtimeMs === 0) {
            return;
          }
          lastKnownMtime = current.mtimeMs;
          emitConfigFileChange(filePath);
        }
      );

      this.configWatchers.set(filePath, {
        close: () => {
          unwatchFile(filePath);
        },
      });
    });

    await Promise.all(watcherPromises);
  }

  private async waitForChokidarReady(watcher: ChokidarFSWatcher): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const handleReady = () => {
        watcher.off('ready', handleReady);
        watcher.off('error', handleError);
        resolve();
      };
      const handleError = (error: Error) => {
        watcher.off('ready', handleReady);
        reject(error);
      };

      watcher.once('ready', handleReady);
      watcher.once('error', handleError);
    }).catch(error => {
      this.logger.warn('Failed to wait for config watcher ready', error);
    });
  }

  private expandConfigWatchPattern(pattern: string): string | string[] {
    return pattern;
  }

  private handleFileChange(event: WorkspaceEvent): void {
    const { path: filePath, type } = event;
    if (type !== 'workspace:file-changed') {
      return;
    }

    this.emitLegacySourceEvents(filePath);
  }

  private handleUnifiedFileChange(event: FileChangeEvent): void {
    const { path: filePath, language, category, type } = event;

    this.logger.debug('Unified file change detected', {
      path: event.relativePath,
      language,
      category,
      type,
    });

    // Queue for analysis based on category
    if (category === 'source' || category === 'test') {
      this.queueFileForAnalysis(filePath);
    }

    // Update compilation status for language-specific files
    if (language) {
      this.updateCompilationStatus(language, 'compiling');
    }

    // Emit specific events for different categories
    this.emit(`${category}-file-changed`, event);

    if (language) {
      this.emit(`${language}-file-changed`, event);
    }
  }

  private handleBatchedFileChanges(events: FileChangeEvent[]): void {
    this.logger.debug(`Processing batch of ${events.length} file changes`);

    const sourceFiles = events.filter(e => e.category === 'source' || e.category === 'test');
    const configFiles = events.filter(e => e.category === 'config');

    // Process source files for analysis
    for (const event of sourceFiles) {
      this.queueFileForAnalysis(event.path);
    }

    // Handle config files immediately
    for (const event of configFiles) {
      this.handleConfigFileChange(event);
    }

    // Update compilation statuses
    const languages = new Set(events.map(e => e.language).filter(Boolean));
    for (const language of languages) {
      this.updateCompilationStatus(language as string, 'compiling');
    }

    this.emit('file-batch-processed', {
      totalFiles: events.length,
      sourceFiles: sourceFiles.length,
      configFiles: configFiles.length,
      languages: Array.from(languages),
    });
  }

  private handleConfigFileChange(event: FileChangeEvent): void {
    const { relativePath } = event;

    this.logger.info('Configuration file changed', { path: relativePath });

    // Handle specific config file types
    if (relativePath.includes('tsconfig')) {
      this.triggerBuildDetection();
      this.emit('tsconfig-changed', event);
    } else if (relativePath.includes('package.json')) {
      this.triggerDependencyAnalysis();
      this.emit('package-json-changed', event);
    } else if (relativePath.includes('.eslintrc')) {
      this.triggerLinterDetection();
      this.emit('eslint-config-changed', event);
    }

    this.emit('config-file-changed', event);
  }

  private emitLegacySourceEvents(filePath: string): void {
    const absolutePath = join(this.config.workspaceRoot, filePath);
    const extension = extname(filePath);
    const language = this.inferLanguageFromExtension(extension);
    const category = this.inferCategoryFromPath(filePath);

    const event: FileChangeEvent = {
      type: 'file-changed',
      path: absolutePath,
      relativePath: filePath,
      extension,
      language,
      category,
      timestamp: new Date(),
    };

    if (category === 'config') {
      this.handleConfigFileChange({ ...event, type: 'config-changed' });
      return;
    }

    if (category === 'source' || category === 'test') {
      this.queueFileForAnalysis(event.path);
    }

    this.emit(`${category}-file-changed`, event);
    this.emit('file-changed', event);
    if (language) {
      this.updateCompilationStatus(language, 'compiling');
      this.emit(`${language}-file-changed`, event);
    }
  }

  private handleConfigFileEvent(event: WorkspaceEvent): void {
    const absolutePath = join(this.config.workspaceRoot, event.path);
    const configEvent: FileChangeEvent = {
      type: 'config-changed',
      path: absolutePath,
      relativePath: event.path,
      extension: extname(event.path),
      language: null,
      category: 'config',
      timestamp: new Date(),
    };

    this.handleConfigFileChange(configEvent);
  }

  private inferCategoryFromPath(filePath: string): FileChangeEvent['category'] {
    const fileName = basename(filePath);
    const lowerPath = filePath.toLowerCase();
    const extension = extname(filePath).toLowerCase();

    if (
      fileName.includes('tsconfig') ||
      fileName.includes('package.json') ||
      fileName.includes('.eslintrc') ||
      lowerPath.includes('.prettierrc') ||
      lowerPath.includes('.env')
    ) {
      return 'config';
    }

    if (lowerPath.includes('.test.') || lowerPath.includes('.spec.')) {
      return 'test';
    }

    if (['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.c', '.cpp'].includes(extension)) {
      return 'source';
    }

    return 'other';
  }

  private inferLanguageFromExtension(extension: string): string | null {
    switch (extension) {
      case '.ts':
      case '.tsx':
        return 'typescript';
      case '.js':
      case '.jsx':
        return 'javascript';
      case '.py':
        return 'python';
      case '.go':
        return 'go';
      case '.rs':
        return 'rust';
      case '.java':
        return 'java';
      case '.c':
        return 'c';
      case '.cpp':
        return 'cpp';
      default:
        return null;
    }
  }

  private queueFileForAnalysis(filePath: string): void {
    if (!this.config.realTimeAnalysis.enabled) {
      return;
    }

    // Add to analysis queue if not already queued
    if (!this.analysisQueue.includes(filePath)) {
      this.analysisQueue.push(filePath);
      this.processAnalysisQueue();
    }
  }

  private async processAnalysisQueue(): Promise<void> {
    if (this.activeAnalysis >= this.config.realTimeAnalysis.maxConcurrentAnalysis) {
      return;
    }

    const filePath = this.analysisQueue.shift();
    if (!filePath) {
      return;
    }

    this.activeAnalysis++;

    try {
      // Delay analysis to avoid excessive processing
      await new Promise(resolve => setTimeout(resolve, this.config.realTimeAnalysis.analysisDelay));

      // Trigger analysis for the file
      await this.analyzeFile(filePath);
    } catch (error) {
      this.logger.warn('Error during proactive file analysis', { filePath, error });
    } finally {
      this.activeAnalysis--;

      // Process next item in queue
      if (this.analysisQueue.length > 0) {
        this.processAnalysisQueue();
      }
    }
  }

  private async analyzeFile(filePath: string): Promise<void> {
    try {
      // Trigger static analysis for the file
      const errors = await this.detectorManager.detectErrors({
        source: 'staticAnalysis',
        target: filePath,
      });

      this.emit('proactive-errors-detected', { filePath, errors });
      if (errors.length > 0) {
        this.logger.debug(
          `Proactive analysis found ${errors.length} issues in ${basename(filePath)}`
        );
      }
    } catch (error) {
      this.logger.warn('Failed to analyze file proactively', { filePath, error });
    }
  }

  private initializeCompilationStatuses(): void {
    for (const language of this.config.compilationMonitoring.languages) {
      this.compilationStatuses.set(language, {
        language,
        status: 'idle',
        lastCompilation: new Date(),
        errors: [],
      });
    }
  }

  private updateCompilationStatus(language: string, status: CompilationStatus['status']): void {
    const current = this.compilationStatuses.get(language);
    if (current) {
      current.status = status;
      current.lastCompilation = new Date();
      this.emit('compilation-status-changed', { language, status });
    }
  }

  private handleDetectedError(error: DetectedError): void {
    // Update compilation status based on error source
    if (error.source.type === 'build') {
      const language = this.inferLanguageFromError(error);
      if (language) {
        this.updateCompilationStatus(language, 'error');
      }
    }

    this.emit('proactive-error-detected', error);
  }

  private inferLanguageFromError(error: DetectedError): string | null {
    const message = error.message.toLowerCase();
    if (message.includes('typescript') || message.includes('tsc')) {
      return 'typescript';
    } else if (message.includes('javascript') || message.includes('js')) {
      return 'javascript';
    }
    return null;
  }

  // Public API methods
  getCompilationStatus(language: string): CompilationStatus | null {
    return this.compilationStatuses.get(language) || null;
  }

  getAllCompilationStatuses(): CompilationStatus[] {
    return Array.from(this.compilationStatuses.values());
  }

  getBuildProcesses(): BuildProcessInfo[] {
    return Array.from(this.buildProcesses.values());
  }

  isCoordinatorRunning(): boolean {
    return this.isRunning;
  }

  updateConfig(newConfig: Partial<ProactiveMonitoringConfig>): void {
    this.config = { ...this.config, ...newConfig };
    this.emit('config-updated', this.config);
  }

  // Trigger methods for specific detector types
  private triggerBuildDetection(): void {
    this.logger.debug('Triggering build detection due to config change');
    this.emit('trigger-build-detection');
  }

  private triggerDependencyAnalysis(): void {
    this.logger.debug('Triggering dependency analysis due to package.json change');
    this.emit('dependency-change-detected');
    this.emit('trigger-dependency-analysis');
  }

  private triggerLinterDetection(): void {
    this.logger.debug('Triggering linter detection due to config change');
    this.emit('trigger-linter-detection');
  }

  // Enhanced API methods
  getFileWatchingStats(): FileWatchingStats | null {
    return this.unifiedFileWatcher?.getStats() || null;
  }

  getWatchedPaths(): string[] {
    return this.unifiedFileWatcher?.getWatchedPaths() || [];
  }

  isFileWatchingActive(): boolean {
    return this.unifiedFileWatcher?.isWatcherRunning() || false;
  }
}
