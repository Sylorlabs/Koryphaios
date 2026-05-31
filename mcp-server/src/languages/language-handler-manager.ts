/**
 * Language handler manager implementation
 */

import { EventEmitter } from 'events';
import { TypeScriptHandler } from './typescript-handler.js';
import { JavaScriptHandler } from './javascript-handler.js';
import { PythonHandler } from './python-handler.js';
import { GoHandler } from './go-handler.js';
import { RustHandler } from './rust-handler.js';
import { PHPHandler } from './php-handler.js';
import type { LanguageHandler, DetectionOptions, LanguageError } from '../types/languages.js';
import { SupportedLanguage } from '../types/languages.js';
import { Logger } from '../utils/logger.js';

export interface LanguageHandlerManagerConfig {
  enabledLanguages?: SupportedLanguage[];
  autoDetectLanguages?: boolean;
  defaultOptions?: Record<string, unknown>;
  logger?: Logger;
}

export class LanguageHandlerManager extends EventEmitter {
  private handlers = new Map<SupportedLanguage, LanguageHandler>();
  private logger: Logger;
  private config: LanguageHandlerManagerConfig;

  constructor(config: LanguageHandlerManagerConfig = {}) {
    super();
    this.config = {
      enabledLanguages: [
        SupportedLanguage.TYPESCRIPT,
        SupportedLanguage.JAVASCRIPT,
        SupportedLanguage.PYTHON,
        SupportedLanguage.GO,
        SupportedLanguage.RUST,
        SupportedLanguage.PHP,
      ],
      autoDetectLanguages: true,
      ...config,
    };
    this.logger =
      config.logger ||
      new Logger('debug', {
        logFile: undefined,
        enableConsole: false, // Default to disabled to avoid MCP protocol interference
      });
  }

  /**
   * Initialize all language handlers
   */
  async initialize(): Promise<void> {
    this.logger.info('Initializing language handler manager');

    const enabledLanguages = this.config.enabledLanguages || [];
    const initPromises: Promise<void>[] = [];

    for (const language of enabledLanguages) {
      initPromises.push(this.initializeHandler(language));
    }

    await Promise.allSettled(initPromises);

    this.logger.info(`Language handler manager initialized with ${this.handlers.size} handlers`);
    this.emit('initialized');
  }

  /**
   * Initialize a specific language handler
   */
  private async initializeHandler(language: SupportedLanguage): Promise<void> {
    try {
      const handler = this.createHandler(language);

      // Check if the language tools are available
      if (await handler.isAvailable()) {
        await handler.initialize();
        this.handlers.set(language, handler);

        // Forward events
        handler.on('error', error => {
          this.emit('handlerError', language, error);
        });

        this.logger.info(`Initialized ${language} handler`);
      } else {
        this.logger.warn(`${language} tools not available, skipping handler initialization`);
      }
    } catch (error) {
      this.logger.error(`Failed to initialize ${language} handler`, error);
      this.emit('handlerError', language, error);
    }
  }

  /**
   * Create a language handler instance
   */
  private createHandler(language: SupportedLanguage): LanguageHandler {
    const options = this.config.defaultOptions || {};

    switch (language) {
      case SupportedLanguage.TYPESCRIPT:
        return new TypeScriptHandler(options, this.logger);
      case SupportedLanguage.JAVASCRIPT:
        return new JavaScriptHandler(options, this.logger);
      case SupportedLanguage.PYTHON:
        return new PythonHandler(options, this.logger);
      case SupportedLanguage.GO:
        return new GoHandler(options, this.logger);
      case SupportedLanguage.RUST:
        return new RustHandler(options, this.logger);
      case SupportedLanguage.PHP:
        return new PHPHandler(options, this.logger);
      default:
        throw new Error(`Unsupported language: ${language}`);
    }
  }

  /**
   * Get a language handler by language
   */
  getHandler(language: SupportedLanguage): LanguageHandler | undefined {
    return this.handlers.get(language);
  }

  /**
   * Get all available handlers
   */
  getAvailableHandlers(): Map<SupportedLanguage, LanguageHandler> {
    return new Map(this.handlers);
  }

  /**
   * Detect language from file path
   */
  detectLanguage(filePath: string): SupportedLanguage | undefined {
    if (!this.config.autoDetectLanguages) {
      return undefined;
    }

    for (const [language, handler] of this.handlers) {
      if (handler.isFileSupported(filePath)) {
        return language;
      }
    }

    return undefined;
  }

  /**
   * Detect errors in source code using appropriate language handler
   */
  async detectErrors(
    source: string,
    language?: SupportedLanguage,
    options?: DetectionOptions
  ): Promise<LanguageError[]> {
    // Auto-detect language if not provided
    if (!language && options?.filePath) {
      language = this.detectLanguage(options.filePath);
    }

    if (!language) {
      this.logger.warn('No language specified or detected for error detection');
      return [];
    }

    const handler = this.handlers.get(language);
    if (!handler) {
      this.logger.warn(`No handler available for language: ${language}`);
      return [];
    }

    try {
      const errors = await handler.detectErrors(source, options);
      this.emit('errorsDetected', language, errors);
      return errors;
    } catch (error) {
      this.logger.error(`Error detection failed for ${language}`, error);
      this.emit('detectionError', language, error);
      return [];
    }
  }

  /**
   * Parse stack trace using appropriate language handler
   */
  parseStackTrace(stackTrace: string, language: SupportedLanguage) {
    const handler = this.handlers.get(language);
    if (!handler) {
      this.logger.warn(`No handler available for language: ${language}`);
      return [];
    }

    try {
      return handler.parseStackTrace(stackTrace);
    } catch (error) {
      this.logger.error(`Stack trace parsing failed for ${language}`, error);
      return [];
    }
  }

  /**
   * Get debug capabilities for a language
   */
  getDebugCapabilities(language: SupportedLanguage) {
    const handler = this.handlers.get(language);
    if (!handler) {
      return null;
    }

    return handler.getDebugCapabilities();
  }

  /**
   * Analyze performance of source code
   */
  async analyzePerformance(source: string, language: SupportedLanguage) {
    const handler = this.handlers.get(language);
    if (!handler) {
      this.logger.warn(`No handler available for language: ${language}`);
      return null;
    }

    try {
      return await handler.analyzePerformance(source);
    } catch (error) {
      this.logger.error(`Performance analysis failed for ${language}`, error);
      return null;
    }
  }

  /**
   * Check if a language is supported
   */
  isLanguageSupported(language: SupportedLanguage): boolean {
    return this.handlers.has(language);
  }

  /**
   * Get supported file extensions for all languages
   */
  getSupportedExtensions(): Map<string, SupportedLanguage[]> {
    const extensions = new Map<string, SupportedLanguage[]>();

    for (const [language, handler] of this.handlers) {
      for (const ext of handler.getFileExtensions()) {
        if (!extensions.has(ext)) {
          extensions.set(ext, []);
        }
        extensions.get(ext)!.push(language);
      }
    }

    return extensions;
  }

  /**
   * Get configuration files for all languages
   */
  getConfigFiles(): Map<SupportedLanguage, string[]> {
    const configFiles = new Map<SupportedLanguage, string[]>();

    for (const [language, handler] of this.handlers) {
      configFiles.set(language, handler.getConfigFiles());
    }

    return configFiles;
  }

  /**
   * Reload a specific language handler
   */
  async reloadHandler(language: SupportedLanguage): Promise<void> {
    const existingHandler = this.handlers.get(language);
    if (existingHandler) {
      await existingHandler.dispose();
      this.handlers.delete(language);
    }

    await this.initializeHandler(language);
  }

  /**
   * Dispose all handlers and cleanup resources
   */
  async dispose(): Promise<void> {
    this.logger.info('Disposing language handler manager');

    const disposePromises: Promise<void>[] = [];
    for (const handler of this.handlers.values()) {
      disposePromises.push(handler.dispose());
    }

    await Promise.allSettled(disposePromises);
    this.handlers.clear();

    this.logger.info('Language handler manager disposed');
    this.emit('disposed');
  }

  /**
   * Get statistics about the language handlers
   */
  getStatistics() {
    return {
      totalHandlers: this.handlers.size,
      availableLanguages: Array.from(this.handlers.keys()),
      supportedExtensions: this.getSupportedExtensions(),
      configFiles: this.getConfigFiles(),
    };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<LanguageHandlerManagerConfig>): void {
    this.config = { ...this.config, ...config };
    this.emit('configUpdated', this.config);
  }

  /**
   * Get current configuration
   */
  getConfig(): LanguageHandlerManagerConfig {
    return { ...this.config };
  }
}
