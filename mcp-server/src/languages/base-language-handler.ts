/**
 * Base language handler implementation
 */

import { EventEmitter } from 'events';
import type {
  LanguageHandler,
  DetectionOptions,
  LanguageError,
  StackFrame,
  LanguageDebugCapabilities,
  LanguageDebugConfig,
  LanguageDebugSession,
  PerformanceAnalysis,
} from '../types/languages.js';
import { SupportedLanguage } from '../types/languages.js';
import { Logger } from '../utils/logger.js';

export abstract class BaseLanguageHandler extends EventEmitter implements LanguageHandler {
  protected logger: Logger;
  protected isInitialized = false;

  constructor(
    public readonly language: SupportedLanguage,
    protected options: Record<string, unknown> = {},
    logger?: Logger
  ) {
    super();
    this.logger =
      logger ||
      new Logger('debug', {
        logFile: undefined,
        enableConsole: false, // Default to disabled to avoid MCP protocol interference
      });
  }

  /**
   * Initialize the language handler
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      await this.doInitialize();
      this.isInitialized = true;
      this.logger.info(`Language handler initialized for ${this.language}`);
      this.emit('initialized');
    } catch (error) {
      this.logger.error(`Failed to initialize language handler for ${this.language}`, error);
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Cleanup resources
   */
  async dispose(): Promise<void> {
    if (!this.isInitialized) {
      return;
    }

    try {
      await this.doDispose();
      this.isInitialized = false;
      this.logger.info(`Language handler disposed for ${this.language}`);
      this.emit('disposed');
    } catch (error) {
      this.logger.error(`Failed to dispose language handler for ${this.language}`, error);
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Check if the language tools are available
   */
  async isAvailable(): Promise<boolean> {
    try {
      return await this.checkAvailability();
    } catch (error) {
      this.logger.debug(`Language tools not available for ${this.language}`, error);
      return false;
    }
  }

  /**
   * Get language-specific file extensions
   */
  abstract getFileExtensions(): string[];

  /**
   * Get language-specific configuration files
   */
  abstract getConfigFiles(): string[];

  /**
   * Detect errors in source code
   */
  abstract detectErrors(source: string, options?: DetectionOptions): Promise<LanguageError[]>;

  /**
   * Parse stack trace specific to this language
   */
  abstract parseStackTrace(stackTrace: string): StackFrame[];

  /**
   * Get debugging capabilities for this language
   */
  abstract getDebugCapabilities(): LanguageDebugCapabilities;

  /**
   * Create a debug session for this language
   */
  abstract createDebugSession(config: LanguageDebugConfig): Promise<LanguageDebugSession>;

  /**
   * Analyze performance of source code
   */
  abstract analyzePerformance(source: string): Promise<PerformanceAnalysis>;

  /**
   * Language-specific initialization
   */
  protected abstract doInitialize(): Promise<void>;

  /**
   * Language-specific disposal
   */
  protected abstract doDispose(): Promise<void>;

  /**
   * Check if language tools are available
   */
  protected abstract checkAvailability(): Promise<boolean>;

  /**
   * Validate source code syntax
   */
  protected abstract validateSyntax(source: string): Promise<LanguageError[]>;

  /**
   * Get language-specific error patterns
   */
  protected abstract getErrorPatterns(): RegExp[];

  /**
   * Parse error message to extract structured information
   */
  protected parseErrorMessage(message: string, file: string): Partial<LanguageError> {
    const patterns = this.getErrorPatterns();

    for (const pattern of patterns) {
      const match = message.match(pattern);
      if (match) {
        return this.extractErrorInfo(match, file);
      }
    }

    // Fallback to basic parsing
    return {
      message: message.trim(),
      severity: 'error' as const,
      location: {
        file,
        line: 1,
        column: 1,
      },
      source: this.language,
    };
  }

  /**
   * Extract error information from regex match
   */
  protected extractErrorInfo(match: RegExpMatchArray, file: string): Partial<LanguageError> {
    // Default implementation - should be overridden by specific handlers
    return {
      message: match[0] || 'Unknown error',
      severity: 'error' as const,
      location: {
        file,
        line: parseInt(match[1] || '1') || 1,
        column: parseInt(match[2] || '1') || 1,
      },
      source: this.language,
    };
  }

  /**
   * Normalize file path for the current platform
   */
  protected normalizePath(filePath: string): string {
    return filePath.replace(/\\/g, '/');
  }

  /**
   * Check if a file is supported by this language handler
   */
  isFileSupported(filePath: string): boolean {
    const extensions = this.getFileExtensions();
    return extensions.some(ext => filePath.endsWith(ext));
  }

  /**
   * Get language-specific severity mapping
   */
  protected mapSeverity(originalSeverity: string): 'error' | 'warning' | 'info' | 'hint' {
    const severity = originalSeverity.toLowerCase();

    if (severity.includes('error') || severity.includes('fatal')) {
      return 'error';
    }
    if (severity.includes('warn')) {
      return 'warning';
    }
    if (severity.includes('info') || severity.includes('note')) {
      return 'info';
    }

    return 'hint';
  }

  /**
   * Create a standardized error object
   */
  protected createError(
    message: string,
    file: string,
    line: number,
    column: number,
    severity: 'error' | 'warning' | 'info' | 'hint' = 'error',
    code?: string | number
  ): LanguageError {
    const error: LanguageError = {
      message: message.trim(),
      severity,
      location: {
        file: this.normalizePath(file),
        line: Math.max(1, line),
        column: Math.max(1, column),
      },
      source: this.language,
      relatedInformation: [],
    };

    if (code !== undefined) {
      error.code = code;
    }

    return error;
  }
}
