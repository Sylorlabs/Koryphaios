/**
 * Development environment manager with comprehensive debugging and logging
 */

import { EventEmitter } from 'events';
import { DebugSessionManager } from './debug-session-manager.js';
import { PerformanceMonitor } from './performance-monitor.js';
import { LanguageHandlerManager } from '../languages/language-handler-manager.js';
import { ErrorDetectorManager } from '../detectors/error-detector-manager.js';
import { Logger } from '../utils/logger.js';
import { SupportedLanguage } from '../types/languages.js';
import type { LanguageDebugConfig } from '../types/languages.js';

export interface DevelopmentEnvironmentConfig {
  enablePerformanceMonitoring?: boolean;
  performanceMonitoringInterval?: number;
  enableDebugSessions?: boolean;
  enableErrorDetection?: boolean;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  logFile?: string;
  maxLogFileSize?: number;
  enableMetrics?: boolean;
  enableProfiling?: boolean;
}

export interface EnvironmentStatus {
  isRunning: boolean;
  startTime: Date;
  uptime: number;
  components: {
    debugSessions: boolean;
    performanceMonitor: boolean;
    errorDetection: boolean;
    languageHandlers: boolean;
  };
  statistics: {
    activeSessions: number;
    totalErrors: number;
    performanceProfiles: number;
    memoryUsage: number;
    cpuUsage: number;
  };
}

export class DevelopmentEnvironment extends EventEmitter {
  private config: DevelopmentEnvironmentConfig;
  private debugSessionManager: DebugSessionManager;
  private performanceMonitor: PerformanceMonitor;
  private languageManager: LanguageHandlerManager;
  private errorDetectorManager: ErrorDetectorManager;
  private logger: Logger;
  private isRunning = false;
  private startTime?: Date;

  constructor(config: DevelopmentEnvironmentConfig = {}) {
    super();

    this.config = {
      enablePerformanceMonitoring: true,
      performanceMonitoringInterval: 5000,
      enableDebugSessions: true,
      enableErrorDetection: true,
      logLevel: 'debug',
      enableMetrics: true,
      enableProfiling: true,
      ...config,
    };

    // Initialize logger
    this.logger = new Logger(this.config.logLevel || 'debug', {
      logFile: this.config.logFile,
      enableConsole: true,
      enableFile: !!this.config.logFile,
    });

    // Initialize components
    this.languageManager = new LanguageHandlerManager({
      enabledLanguages: [
        SupportedLanguage.TYPESCRIPT,
        SupportedLanguage.JAVASCRIPT,
        SupportedLanguage.PYTHON,
        SupportedLanguage.GO,
        SupportedLanguage.RUST,
      ],
      autoDetectLanguages: true,
    });

    this.errorDetectorManager = new ErrorDetectorManager({
      config: {
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
          buildTools: true,
          processMonitor: true,
          multiLanguage: true,
        },
        filters: {
          categories: [],
          severities: [],
          excludeFiles: ['node_modules/**', 'dist/**'],
          excludePatterns: ['*.min.js', '*.map'],
        },
        polling: {
          interval: 1000,
          maxRetries: 3,
        },
        bufferSize: 1000,
        maxErrorsPerSession: 100,
      },
      proactiveMonitoring: {
        enabled: true,
        workspaceRoot: process.cwd(),
        fileWatching: {
          enabled: true,
          debounceMs: 500,
          watchPatterns: ['src/**/*', 'lib/**/*', '*.ts', '*.tsx', '*.js', '*.jsx'],
          ignorePatterns: ['node_modules/**', 'dist/**', 'build/**', '.git/**'],
        },
        buildProcessMonitoring: {
          enabled: true,
          buildCommands: ['tsc', 'webpack', 'vite', 'rollup'],
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
          analysisDelay: 1000,
          maxConcurrentAnalysis: 3,
        },
      },
    });
    this.debugSessionManager = new DebugSessionManager(this.languageManager);
    this.performanceMonitor = new PerformanceMonitor();

    this.setupEventHandlers();
  }

  /**
   * Start the development environment
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Development environment is already running');
      return;
    }

    this.logger.info('Starting development environment', this.config);
    this.startTime = new Date();

    try {
      // Start language handlers
      await this.languageManager.initialize();
      this.logger.info('Language handlers initialized');

      // Start error detection
      if (this.config.enableErrorDetection) {
        // Error detector manager doesn't need initialization
        this.logger.info('Error detection enabled');
      }

      // Start performance monitoring
      if (this.config.enablePerformanceMonitoring) {
        this.performanceMonitor.startMonitoring(this.config.performanceMonitoringInterval);
        this.logger.info('Performance monitoring started');
      }

      this.isRunning = true;
      this.emit('started');
      this.logger.info('Development environment started successfully');
    } catch (error) {
      this.logger.error('Failed to start development environment', error);
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Stop the development environment
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      this.logger.warn('Development environment is not running');
      return;
    }

    this.logger.info('Stopping development environment');

    try {
      // Stop performance monitoring
      this.performanceMonitor.stopMonitoring();

      // Stop debug sessions
      await this.debugSessionManager.dispose();

      // Error detection doesn't need disposal

      // Stop language handlers
      await this.languageManager.dispose();

      this.isRunning = false;
      this.emit('stopped');
      this.logger.info('Development environment stopped successfully');
    } catch (error) {
      this.logger.error('Failed to stop development environment', error);
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Create a debug session
   */
  async createDebugSession(
    language: SupportedLanguage,
    config: LanguageDebugConfig
  ): Promise<string> {
    if (!this.config.enableDebugSessions) {
      throw new Error('Debug sessions are disabled');
    }

    this.logger.info('Creating debug session', { language, config });

    const profileId = this.performanceMonitor.startProfile(`debug-session-${language}`);

    try {
      const sessionId = await this.debugSessionManager.createSession(language, config);

      this.performanceMonitor.endProfile(profileId);
      this.performanceMonitor.recordCounter('debug_sessions_created', 1, { language });

      this.emit('debugSessionCreated', sessionId, language);
      return sessionId;
    } catch (error) {
      this.performanceMonitor.endProfile(profileId);
      this.performanceMonitor.recordCounter('debug_sessions_failed', 1, { language });
      throw error;
    }
  }

  /**
   * Detect errors in source code
   */
  async detectErrors(
    source: string,
    language?: SupportedLanguage,
    filePath?: string
  ): Promise<any[]> {
    if (!this.config.enableErrorDetection) {
      throw new Error('Error detection is disabled');
    }

    const profileId = this.performanceMonitor.startProfile('error-detection');

    try {
      let errors: any[] = [];

      // Use language manager for error detection
      if (language) {
        const options = filePath ? { filePath, enableLinting: true } : { enableLinting: true };
        errors = await this.languageManager.detectErrors(source, language, options);
      } else {
        // Use error detector manager for general detection
        errors = await this.errorDetectorManager.detectErrors({ source });
      }

      this.performanceMonitor.endProfile(profileId);
      this.performanceMonitor.recordCounter('errors_detected', errors.length, {
        language: language || 'unknown',
      });

      this.emit('errorsDetected', errors, language, filePath);
      return errors;
    } catch (error) {
      this.performanceMonitor.endProfile(profileId);
      this.performanceMonitor.recordCounter('error_detection_failed', 1, {
        language: language || 'unknown',
      });
      throw error;
    }
  }

  /**
   * Analyze performance of source code
   */
  async analyzePerformance(source: string, language: SupportedLanguage): Promise<any> {
    const profileId = this.performanceMonitor.startProfile('performance-analysis');

    try {
      const analysis = await this.languageManager.analyzePerformance(source, language);

      this.performanceMonitor.endProfile(profileId);
      this.performanceMonitor.recordCounter('performance_analyses', 1, { language });

      this.emit('performanceAnalyzed', analysis, language);
      return analysis;
    } catch (error) {
      this.performanceMonitor.endProfile(profileId);
      this.performanceMonitor.recordCounter('performance_analysis_failed', 1, { language });
      throw error;
    }
  }

  /**
   * Get environment status
   */
  getStatus(): EnvironmentStatus {
    const now = new Date();
    const uptime = this.startTime ? now.getTime() - this.startTime.getTime() : 0;

    const debugStats = this.debugSessionManager.getStatistics();
    const perfStats = this.performanceMonitor.getStatistics();
    const langStats = this.languageManager.getStatistics();

    return {
      isRunning: this.isRunning,
      startTime: this.startTime || new Date(),
      uptime,
      components: {
        debugSessions: this.config.enableDebugSessions || false,
        performanceMonitor: this.config.enablePerformanceMonitoring || false,
        errorDetection: this.config.enableErrorDetection || false,
        languageHandlers: langStats.totalHandlers > 0,
      },
      statistics: {
        activeSessions: debugStats.totalSessions,
        totalErrors: 0, // Would need to track this
        performanceProfiles: perfStats.profiles.total,
        memoryUsage: perfStats.system.memory?.heapUsed || 0,
        cpuUsage: perfStats.system.cpu?.percent || 0,
      },
    };
  }

  /**
   * Get comprehensive statistics
   */
  getStatistics() {
    return {
      environment: this.getStatus(),
      debugSessions: this.debugSessionManager.getStatistics(),
      performance: this.performanceMonitor.getStatistics(),
      languageHandlers: this.languageManager.getStatistics(),
    };
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<DevelopmentEnvironmentConfig>): void {
    const oldConfig = { ...this.config };
    this.config = { ...this.config, ...newConfig };

    this.logger.info('Development environment configuration updated', {
      oldConfig,
      newConfig: this.config,
    });

    // Apply configuration changes
    if (newConfig.logLevel && newConfig.logLevel !== oldConfig.logLevel) {
      // Would need to update logger level
    }

    if (
      newConfig.performanceMonitoringInterval &&
      newConfig.performanceMonitoringInterval !== oldConfig.performanceMonitoringInterval
    ) {
      if (this.config.enablePerformanceMonitoring) {
        this.performanceMonitor.stopMonitoring();
        this.performanceMonitor.startMonitoring(this.config.performanceMonitoringInterval);
      }
    }

    this.emit('configUpdated', this.config);
  }

  /**
   * Get current configuration
   */
  getConfig(): DevelopmentEnvironmentConfig {
    return { ...this.config };
  }

  /**
   * Cleanup old data and optimize performance
   */
  async cleanup(): Promise<void> {
    this.logger.info('Starting development environment cleanup');

    try {
      // Cleanup performance monitor
      this.performanceMonitor.cleanup();

      // Cleanup inactive debug sessions
      await this.debugSessionManager.cleanupInactiveSessions();

      this.logger.info('Development environment cleanup completed');
      this.emit('cleanupCompleted');
    } catch (error) {
      this.logger.error('Failed to cleanup development environment', error);
      this.emit('error', error);
    }
  }

  /**
   * Get debug session manager
   */
  getDebugSessionManager(): DebugSessionManager {
    return this.debugSessionManager;
  }

  /**
   * Get performance monitor
   */
  getPerformanceMonitor(): PerformanceMonitor {
    return this.performanceMonitor;
  }

  /**
   * Get language manager
   */
  getLanguageManager(): LanguageHandlerManager {
    return this.languageManager;
  }

  /**
   * Get error detector manager
   */
  getErrorDetectorManager(): ErrorDetectorManager {
    return this.errorDetectorManager;
  }

  /**
   * Set up event handlers for all components
   */
  private setupEventHandlers(): void {
    // Debug session events
    this.debugSessionManager.on('sessionCreated', session => {
      this.logger.info('Debug session created', {
        sessionId: session.id,
        language: session.language,
      });
      this.emit('debugSessionCreated', session);
    });

    this.debugSessionManager.on('sessionError', (sessionId, error) => {
      this.logger.error('Debug session error', { sessionId, error });
      this.emit('debugSessionError', sessionId, error);
    });

    // Performance monitor events
    this.performanceMonitor.on('profileEnded', profile => {
      this.logger.debug('Performance profile completed', {
        profileId: profile.id,
        name: profile.name,
        duration: profile.duration,
      });
    });

    this.performanceMonitor.on('systemMetrics', metrics => {
      this.emit('systemMetrics', metrics);
    });

    // Language manager events
    this.languageManager.on('handlerError', (language, error) => {
      this.logger.error('Language handler error', { language, error });
      this.emit('languageHandlerError', language, error);
    });

    this.languageManager.on('errorsDetected', (language, errors) => {
      this.logger.debug('Errors detected by language handler', {
        language,
        errorCount: errors.length,
      });
      this.emit('errorsDetected', errors, language);
    });

    // Error detector events
    this.errorDetectorManager.on('errorsDetected', result => {
      this.logger.debug('Errors detected', { errorCount: result.errors.length });
      this.emit('errorsDetected', result.errors);
    });
  }

  /**
   * Dispose and cleanup all resources
   */
  async dispose(): Promise<void> {
    this.logger.info('Disposing development environment');

    if (this.isRunning) {
      await this.stop();
    }

    // Dispose all components
    this.performanceMonitor.dispose();
    await this.debugSessionManager.dispose();
    await this.languageManager.dispose();

    this.removeAllListeners();
    this.logger.info('Development environment disposed');
  }
}
