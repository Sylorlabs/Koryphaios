/**
 * Error detector manager for coordinating multiple error detectors
 */

import { EventEmitter } from 'events';

import type { DetectedError, ErrorDetectionConfig } from '@/types/index.js';
import { BaseErrorDetector, type ErrorDetectorOptions } from './base-detector.js';
import { ConsoleErrorDetector } from './console-detector.js';
import { RuntimeErrorDetector } from './runtime-detector.js';
import { BuildErrorDetector } from './build-detector.js';
import { LinterErrorDetector } from './linter-detector.js';
import { IDEErrorDetector } from './ide-detector.js';
import { StaticAnalysisDetector } from './static-analysis-detector.js';
import { TestErrorDetector } from './test-detector.js';
import { BuildToolDetector } from './build-tool-detector.js';
import { ProcessMonitorDetector } from './process-monitor-detector.js';
import { MultiLanguageDetector } from './multi-language-detector.js';
import {
  ProactiveMonitoringCoordinator,
  type ProactiveMonitoringConfig,
} from '@/monitoring/proactive-monitoring-coordinator.js';
import { Logger } from '@/utils/logger.js';
import { HeuristicDiagnosticEngine } from '@/diagnostics/heuristic-engine.js';
import type { ErrorAnalysis } from '@/types/diagnostics.js';
import type { FixSuggestion } from '@/types/errors.js';

export interface DetectorManagerOptions {
  config: ErrorDetectionConfig;
  workspaceRoot?: string;
  proactiveMonitoring?: ProactiveMonitoringConfig;
  logger?: Logger;
}

export class ErrorDetectorManager extends EventEmitter {
  private detectors: Map<string, BaseErrorDetector> = new Map();
  private config: ErrorDetectionConfig;
  private workspaceRoot: string;
  private isRunning = false;
  private aggregatedErrors: DetectedError[] = [];
  private logger: Logger;
  private proactiveCoordinator: ProactiveMonitoringCoordinator | null = null;
  private diagnosticEngine: HeuristicDiagnosticEngine;

  constructor(options: DetectorManagerOptions) {
    super();
    this.config = options.config;
    this.workspaceRoot = options.workspaceRoot || process.cwd();
    this.logger =
      options.logger ||
      new Logger('info', {
        logFile: undefined,
        enableConsole: false, // Default to disabled to avoid MCP protocol interference
      });
    
    this.diagnosticEngine = new HeuristicDiagnosticEngine();
    this.initializeDetectors();

    // Initialize proactive monitoring if configured
    if (options.proactiveMonitoring) {
      this.initializeProactiveMonitoring(options.proactiveMonitoring);
    }
  }

  private initializeDetectors(): void {
    const detectorOptions: ErrorDetectorOptions = {
      enabled: this.config.enabled,
      includeWarnings: true, // Will be filtered later
      filters: this.config.filters,
      polling: this.config.polling,
      bufferSize: this.config.bufferSize,
      realTime: this.config.realTime,
    };

    // Initialize console detector
    if (this.config.sources.console) {
      const consoleDetector = new ConsoleErrorDetector(detectorOptions);
      this.registerDetector('console', consoleDetector);
    }

    // Initialize runtime detector
    if (this.config.sources.runtime) {
      const runtimeDetector = new RuntimeErrorDetector(detectorOptions, {
        watchedProcesses: this.config.watchedProcesses || [],
        logFiles: this.config.logFiles || [],
        errorPatterns: [
          /error/i, 
          /exception/i, 
          /failed/i, 
          /fatal/i, 
          /critical/i,
          /panic/i,           // Bun panics
          /unhandled/i,       // Unhandled rejections/exceptions
          /sqlite3/i,         // Database errors
          /tauri/i,           // Tauri bridge errors
          /auth/i,            // Authentication failures
          /permission/i       // Permission denied issues
        ],
        excludePatterns: [/debug/i, /info/i, /trace/i],
      });
      this.registerDetector('runtime', runtimeDetector);
    }

    // Initialize build detector
    if (this.config.sources.build) {
      const buildDetector = new BuildErrorDetector(detectorOptions, {
        projectRoot: this.workspaceRoot
      } as any);
      this.registerDetector('build', buildDetector);
    }

    // Initialize linter detector
    if (this.config.sources.linter) {
      const linterDetector = new LinterErrorDetector(detectorOptions, {
        workspaceRoot: this.workspaceRoot
      } as any);
      this.registerDetector('linter', linterDetector);
    }

    // Initialize IDE detector
    if (this.config.sources.ide) {
      const ideDetector = new IDEErrorDetector(detectorOptions);
      this.registerDetector('ide', ideDetector);
    }

    // Initialize static analysis detector
    if (this.config.sources.staticAnalysis) {
      const staticAnalysisDetector = new StaticAnalysisDetector(detectorOptions, {
        workspaceRoot: this.workspaceRoot
      });
      this.registerDetector('staticAnalysis', staticAnalysisDetector);
    }

    // Initialize test detector
    if (this.config.sources.test) {
      const testDetector = new TestErrorDetector(detectorOptions);
      this.registerDetector('test', testDetector);
    }

    // Initialize build tools detector
    if (this.config.sources.buildTools) {
      const buildToolDetector = new BuildToolDetector(detectorOptions);
      this.registerDetector('buildTools', buildToolDetector);
    }

    // Initialize process monitor detector
    if (this.config.sources.processMonitor) {
      const processMonitorDetector = new ProcessMonitorDetector(detectorOptions);
      this.registerDetector('processMonitor', processMonitorDetector);
    }

    // Initialize multi-language detector
    if (this.config.sources.multiLanguage) {
      const multiLanguageDetector = new MultiLanguageDetector(detectorOptions);
      this.registerDetector('multiLanguage', multiLanguageDetector);
    }
  }

  private registerDetector(name: string, detector: BaseErrorDetector): void {
    this.detectors.set(name, detector);

    // Forward detector events
    detector.on('error-detected', (error: DetectedError) => {
      this.handleDetectedError(name, error);
    });

    detector.on('detector-error', (error: Error) => {
      this.emit('detector-error', { detector: name, error });
    });

    detector.on('detector-started', () => {
      this.emit('detector-started', { detector: name });
    });

    detector.on('detector-stopped', () => {
      this.emit('detector-stopped', { detector: name });
    });
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.debug('Error detector manager already running, skipping start');
      return;
    }

    const startTime = Date.now();
    this.logger.info('Starting error detector manager...', {
      totalDetectors: this.detectors.size,
      enabledDetectors: Array.from(this.detectors.keys()).filter(name =>
        this.isDetectorEnabled(name)
      ),
    });

    this.isRunning = true;

    // Start all enabled detectors
    const startPromises: Promise<void>[] = [];
    const enabledDetectors: string[] = [];

    for (const [name, detector] of this.detectors) {
      if (this.isDetectorEnabled(name)) {
        this.logger.debug(`Starting detector: ${name}`);
        const detectorStartTime = Date.now();

        const startPromise = detector
          .start()
          .then(() => {
            this.logger.logPerformance(`detector-${name}-start`, Date.now() - detectorStartTime);
            this.logger.debug(`Detector ${name} started successfully`);
          })
          .catch(error => {
            this.logger.error(`Failed to start detector ${name}`, {
              detector: name,
              error:
                error instanceof Error
                  ? {
                      name: error.name,
                      message: error.message,
                      stack: error.stack,
                    }
                  : error,
            });
            throw error;
          });

        startPromises.push(startPromise);
        enabledDetectors.push(name);
      } else {
        this.logger.debug(`Detector ${name} is disabled, skipping`);
      }
    }

    await Promise.all(startPromises);

    // Start proactive monitoring coordinator
    if (this.proactiveCoordinator) {
      try {
        await this.proactiveCoordinator.start();
        this.logger.info('Proactive monitoring coordinator started');
      } catch (error) {
        this.logger.warn('Failed to start proactive monitoring coordinator', error);
      }
    }

    const totalStartTime = Date.now() - startTime;
    this.logger.info('Error detector manager started successfully', {
      startedDetectors: enabledDetectors,
      totalStartTime,
      memoryUsage: process.memoryUsage(),
      proactiveMonitoring: this.proactiveCoordinator?.isCoordinatorRunning() || false,
    });

    this.emit('manager-started');
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    // Stop proactive monitoring coordinator first
    if (this.proactiveCoordinator) {
      try {
        await this.proactiveCoordinator.stop();
        this.logger.info('Proactive monitoring coordinator stopped');
      } catch (error) {
        this.logger.warn('Failed to stop proactive monitoring coordinator', error);
      }
    }

    // Stop all detectors
    const stopPromises: Promise<void>[] = [];
    for (const detector of this.detectors.values()) {
      if (detector.isDetectorRunning()) {
        stopPromises.push(detector.stop());
      }
    }

    await Promise.all(stopPromises);
    this.emit('manager-stopped');
  }

  async detectErrors(
    options: {
      source?: string;
      target?: string;
      includeBuffered?: boolean;
      projectRoot?: string;
    } = {}
  ): Promise<DetectedError[]> {
    const { source, target, includeBuffered = true, projectRoot } = options;
    const errors: DetectedError[] = [];

    // Temporarily update project root for build detector if provided
    const buildDetector = this.detectors.get('build') as any;
    const originalProjectRoot = buildDetector?.config?.projectRoot;
    if (projectRoot && buildDetector) {
      buildDetector.config = { ...buildDetector.config, projectRoot };
    }

    // Clear aggregated build/static-analysis errors when doing a targeted project check
    // to avoid stale results from previous runs with different project roots
    if (projectRoot) {
      this.aggregatedErrors = this.aggregatedErrors.filter(
        e => e.source?.type !== 'build' && e.source?.type !== 'static-analysis'
      );
    }

    try {
      if (source) {
        // Detect errors from specific source
        const detector = this.detectors.get(source);
        if (detector) {
          const sourceErrors = await detector.detectErrors(target);
          errors.push(...sourceErrors);
        }
      } else {
        // Detect errors from all sources
        const detectionPromises: Promise<DetectedError[]>[] = [];
        for (const [name, detector] of this.detectors) {
          if (this.isDetectorEnabled(name)) {
            detectionPromises.push(detector.detectErrors(target));
          }
        }

        const results = await Promise.all(detectionPromises);
        for (const result of results) {
          errors.push(...result);
        }
      }
    } finally {
      // Restore original project root
      if (projectRoot && buildDetector && originalProjectRoot) {
        buildDetector.config = { ...buildDetector.config, projectRoot: originalProjectRoot };
      }
    }

    // Include buffered errors if requested
    if (includeBuffered) {
      errors.push(...this.aggregatedErrors);
    }

    // Apply global filters and deduplication
    return this.filterAndDeduplicateErrors(errors);
  }

  private handleDetectedError(detectorName: string, error: DetectedError): void {
    // Add detector source information
    error.source = {
      ...error.source,
      configuration: { detector: detectorName },
    };

    // Apply global filters
    if (this.shouldIncludeError(error)) {
      this.aggregatedErrors.push(error);

      // Maintain buffer size
      if (this.aggregatedErrors.length > this.config.maxErrorsPerSession) {
        this.aggregatedErrors.shift();
      }

      // Emit aggregated error event
      this.emit('error-detected', error);
    }
  }

  private shouldIncludeError(error: DetectedError): boolean {
    const { filters } = this.config;

    // Check severity filter
    if (filters.severities.length > 0) {
      if (!filters.severities.includes(error.severity)) {
        return false;
      }
    }

    // Check category filter
    if (filters.categories.length > 0) {
      if (!filters.categories.includes(error.category)) {
        return false;
      }
    }

    // Check file exclusions
    if (filters.excludeFiles.length > 0) {
      const errorFile = error.stackTrace[0]?.location.file;
      if (errorFile && this.matchesPatterns(errorFile, filters.excludeFiles)) {
        return false;
      }
    }

    // Check pattern exclusions
    if (filters.excludePatterns.length > 0) {
      if (this.matchesPatterns(error.message, filters.excludePatterns)) {
        return false;
      }
    }

    return true;
  }

  private matchesPatterns(text: string, patterns: string[]): boolean {
    return patterns.some(pattern => {
      if (pattern.includes('*') || pattern.includes('?')) {
        // Convert glob pattern to regex
        const regexPattern = pattern.replace(/\*/g, '.*').replace(/\?/g, '.');
        return new RegExp(`^${regexPattern}$`).test(text);
      }
      return text.includes(pattern);
    });
  }

  private filterAndDeduplicateErrors(errors: DetectedError[]): DetectedError[] {
    // Remove duplicates based on message and location
    const seen = new Set<string>();
    const filtered: DetectedError[] = [];

    for (const error of errors) {
      const key = this.generateErrorKey(error);
      if (!seen.has(key)) {
        seen.add(key);
        filtered.push(error);
      }
    }

    // Sort by timestamp (newest first)
    return filtered.sort((a, b) => b.context.timestamp.getTime() - a.context.timestamp.getTime());
  }

  private generateErrorKey(error: DetectedError): string {
    const location = error.stackTrace[0]?.location;
    const locationKey = location
      ? `${location.file}:${location.line}:${location.column}`
      : 'unknown';

    return `${error.message}:${locationKey}:${error.type}`;
  }

  private isDetectorEnabled(detectorName: string): boolean {
    switch (detectorName) {
      case 'console':
        return this.config.sources.console;
      case 'runtime':
        return this.config.sources.runtime;
      case 'build':
        return this.config.sources.build;
      case 'test':
        return this.config.sources.test;
      case 'linter':
        return this.config.sources.linter;
      case 'staticAnalysis':
        return this.config.sources.staticAnalysis;
      default:
        return false;
    }
  }

  getDetector(name: string): BaseErrorDetector | undefined {
    return this.detectors.get(name);
  }

  listDetectors(): Array<{ name: string; enabled: boolean; running: boolean; capabilities: any }> {
    const detectors: Array<{
      name: string;
      enabled: boolean;
      running: boolean;
      capabilities: any;
    }> = [];

    for (const [name, detector] of this.detectors) {
      detectors.push({
        name,
        enabled: this.isDetectorEnabled(name),
        running: detector.isDetectorRunning(),
        capabilities: detector.getCapabilities(),
      });
    }

    return detectors;
  }

  getAggregatedErrors(): DetectedError[] {
    return [...this.aggregatedErrors];
  }

  clearAggregatedErrors(): void {
    this.aggregatedErrors = [];

    // Also clear individual detector buffers
    for (const detector of this.detectors.values()) {
      detector.clearBuffer();
    }
  }

  getDetectionStats(): {
    totalErrors: number;
    errorsByDetector: Record<string, number>;
    errorsByCategory: Record<string, number>;
    errorsBySeverity: Record<string, number>;
  } {
    const stats = {
      totalErrors: this.aggregatedErrors.length,
      errorsByDetector: {} as Record<string, number>,
      errorsByCategory: {} as Record<string, number>,
      errorsBySeverity: {} as Record<string, number>,
    };

    for (const error of this.aggregatedErrors) {
      // Count by detector
      const detectorName = (error.source.configuration?.['detector'] as string) || 'unknown';
      stats.errorsByDetector[detectorName] = (stats.errorsByDetector[detectorName] || 0) + 1;

      // Count by category
      stats.errorsByCategory[error.category] = (stats.errorsByCategory[error.category] || 0) + 1;

      // Count by severity
      stats.errorsBySeverity[error.severity] = (stats.errorsBySeverity[error.severity] || 0) + 1;
    }

    return stats;
  }

  updateConfig(newConfig: Partial<ErrorDetectionConfig>): void {
    this.config = { ...this.config, ...newConfig };

    // Update detector options
    const detectorOptions: ErrorDetectorOptions = {
      enabled: this.config.enabled,
      includeWarnings: true,
      filters: this.config.filters,
      polling: this.config.polling,
      bufferSize: this.config.bufferSize,
      realTime: this.config.realTime,
    };

    // Update all detectors
    for (const detector of this.detectors.values()) {
      detector.updateOptions(detectorOptions);
    }

    this.emit('config-updated', this.config);
  }

  isManagerRunning(): boolean {
    return this.isRunning;
  }

  async analyzeError(errorId: string): Promise<ErrorAnalysis | null> {
    const error = this.aggregatedErrors.find(e => e.id === errorId);
    if (!error) return null;
    return this.diagnosticEngine.analyzeError(error);
  }

  async suggestFixes(errorId: string): Promise<FixSuggestion[]> {
    const error = this.aggregatedErrors.find(e => e.id === errorId);
    if (!error) return [];
    return this.diagnosticEngine.suggestFixes(error);
  }

  private initializeProactiveMonitoring(config: ProactiveMonitoringConfig): void {
    this.proactiveCoordinator = new ProactiveMonitoringCoordinator(this, config);

    // Set up event forwarding
    this.proactiveCoordinator.on('proactive-error-detected', (error: DetectedError) => {
      this.emit('proactive-error-detected', error);
    });

    this.proactiveCoordinator.on(
      'proactive-errors-detected',
      (event: { filePath: string; errors: DetectedError[] }) => {
        this.emit('proactive-errors-detected', event);
      }
    );

    this.proactiveCoordinator.on('compilation-status-changed', (event: any) => {
      this.emit('compilation-status-changed', event);
    });

    this.proactiveCoordinator.on('coordinator-error', (error: any) => {
      this.logger.warn('Proactive monitoring coordinator error', error);
    });
  }

  // Public API for proactive monitoring
  getProactiveMonitoringStatus(): any {
    if (!this.proactiveCoordinator) {
      return { enabled: false };
    }

    return {
      enabled: true,
      running: this.proactiveCoordinator.isCoordinatorRunning(),
      compilationStatuses: this.proactiveCoordinator.getAllCompilationStatuses(),
      buildProcesses: this.proactiveCoordinator.getBuildProcesses(),
    };
  }
}
