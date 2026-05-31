/**
 * Base error detector interface and abstract class
 */

import { EventEmitter } from 'events';

import type { DetectedError, ErrorSource, ErrorFilter } from '@/types/index.js';
import { ErrorCategory, ErrorSeverity } from '@/types/errors.js';

export interface ErrorDetectorOptions {
  enabled: boolean;
  includeWarnings: boolean;
  filters: ErrorFilter;
  polling?: {
    interval: number;
    maxRetries: number;
  };
  bufferSize: number;
  realTime: boolean;
}

export interface ErrorDetectorCapabilities {
  supportsRealTime: boolean;
  supportsPolling: boolean;
  supportsFileWatching: boolean;
  supportedLanguages: string[];
  supportedFrameworks: string[];
}

export abstract class BaseErrorDetector extends EventEmitter {
  protected options: ErrorDetectorOptions;
  protected isRunning = false;
  protected errorBuffer: DetectedError[] = [];
  protected detectionCount = 0;

  constructor(options: ErrorDetectorOptions) {
    super();
    this.options = options;
  }

  abstract getSource(): ErrorSource;
  abstract getCapabilities(): ErrorDetectorCapabilities;
  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract detectErrors(target?: string): Promise<DetectedError[]>;

  isDetectorRunning(): boolean {
    return this.isRunning;
  }

  getDetectionCount(): number {
    return this.detectionCount;
  }

  getBufferedErrors(): DetectedError[] {
    return [...this.errorBuffer];
  }

  clearBuffer(): void {
    this.errorBuffer = [];
  }

  updateOptions(newOptions: Partial<ErrorDetectorOptions>): void {
    this.options = { ...this.options, ...newOptions };
    this.emit('options-updated', this.options);
  }

  protected addToBuffer(error: DetectedError): void {
    // Apply filters
    if (!this.shouldIncludeError(error)) {
      return;
    }

    // Add to buffer
    this.errorBuffer.push(error);
    this.detectionCount++;

    // Maintain buffer size
    if (this.errorBuffer.length > this.options.bufferSize) {
      this.errorBuffer.shift();
    }

    // Emit event
    this.emit('error-detected', error);
  }

  protected shouldIncludeError(error: DetectedError): boolean {
    const { filters } = this.options;

    // Check severity filter
    if (filters.severities && filters.severities.length > 0) {
      if (!filters.severities.includes(error.severity)) {
        return false;
      }
    }

    // Check category filter
    if (filters.categories && filters.categories.length > 0) {
      if (!filters.categories.includes(error.category)) {
        return false;
      }
    }

    // Check file exclusions
    if (filters.excludeFiles && filters.excludeFiles.length > 0) {
      const errorFile = error.stackTrace[0]?.location.file;
      if (errorFile && this.matchesPatterns(errorFile, filters.excludeFiles)) {
        return false;
      }
    }

    // Check pattern exclusions
    if (filters.excludePatterns && filters.excludePatterns.length > 0) {
      if (this.matchesPatterns(error.message, filters.excludePatterns)) {
        return false;
      }
    }

    return true;
  }

  protected matchesPatterns(text: string, patterns: string[]): boolean {
    return patterns.some(pattern => {
      if (pattern.includes('*') || pattern.includes('?')) {
        // Convert glob pattern to regex
        const regexPattern = pattern.replace(/\*/g, '.*').replace(/\?/g, '.');
        return new RegExp(`^${regexPattern}$`).test(text);
      }
      return text.includes(pattern);
    });
  }

  protected generateErrorId(): string {
    return `error-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  protected categorizeError(message: string, type: string): ErrorCategory {
    const lowerMessage = message.toLowerCase();
    const lowerType = type.toLowerCase();

    // Syntax errors
    if (lowerType.includes('syntax') || lowerMessage.includes('syntax')) {
      return ErrorCategory.SYNTAX;
    }

    // Memory errors
    if (
      lowerMessage.includes('memory') ||
      lowerMessage.includes('heap') ||
      lowerMessage.includes('stack overflow')
    ) {
      return ErrorCategory.MEMORY;
    }

    // Network errors
    if (
      lowerMessage.includes('network') ||
      lowerMessage.includes('connection') ||
      lowerMessage.includes('timeout') ||
      lowerMessage.includes('fetch')
    ) {
      return ErrorCategory.NETWORK;
    }

    // Security errors
    if (
      lowerMessage.includes('security') ||
      lowerMessage.includes('permission') ||
      lowerMessage.includes('unauthorized') ||
      lowerMessage.includes('cors')
    ) {
      return ErrorCategory.SECURITY;
    }

    // Performance errors
    if (
      lowerMessage.includes('performance') ||
      lowerMessage.includes('slow') ||
      lowerMessage.includes('timeout')
    ) {
      return ErrorCategory.PERFORMANCE;
    }

    // Configuration errors
    if (
      lowerMessage.includes('config') ||
      lowerMessage.includes('environment') ||
      lowerMessage.includes('missing') ||
      lowerMessage.includes('not found')
    ) {
      return ErrorCategory.CONFIGURATION;
    }

    // Default to runtime
    return ErrorCategory.RUNTIME;
  }

  protected determineSeverity(error: DetectedError): ErrorSeverity {
    const message = error.message.toLowerCase();
    const category = error.category;

    // Critical errors
    if (
      message.includes('fatal') ||
      message.includes('critical') ||
      message.includes('segmentation fault') ||
      message.includes('panic')
    ) {
      return ErrorSeverity.CRITICAL;
    }

    // High severity
    if (
      category === ErrorCategory.SECURITY ||
      category === ErrorCategory.MEMORY ||
      message.includes('error') ||
      message.includes('exception')
    ) {
      return ErrorSeverity.HIGH;
    }

    // Medium severity
    if (
      category === ErrorCategory.PERFORMANCE ||
      category === ErrorCategory.NETWORK ||
      message.includes('warning') ||
      message.includes('deprecated')
    ) {
      return ErrorSeverity.MEDIUM;
    }

    // Low severity (info, debug, etc.)
    return ErrorSeverity.LOW;
  }

  protected createBaseError(
    message: string,
    type: string,
    stackTrace: any[] = []
  ): Omit<DetectedError, 'id' | 'context' | 'source'> {
    const category = this.categorizeError(message, type);

    const baseError = {
      message,
      type,
      category,
      severity: ErrorSeverity.MEDIUM, // Will be determined later
      stackTrace,
      patterns: [],
      confidence: 1.0,
    };

    // Determine severity based on the complete error
    const severity = this.determineSeverity({
      ...baseError,
      id: 'temp',
      context: { timestamp: new Date(), environment: 'temp' },
      source: { type: 'console', tool: 'temp', version: '1.0.0' },
    } as DetectedError);

    return {
      ...baseError,
      severity,
    };
  }
}

// Alias for backward compatibility
export { BaseErrorDetector as BaseDetector };
