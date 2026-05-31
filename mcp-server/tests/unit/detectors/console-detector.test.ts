/**
 * Tests for the console error detector
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { ConsoleErrorDetector } from '@/detectors/console-detector.js';
import type { ErrorDetectorOptions } from '@/detectors/base-detector.js';
import { ErrorCategory, ErrorSeverity } from '@/types/errors.js';

describe('ConsoleErrorDetector', () => {
  let detector: ConsoleErrorDetector;
  let options: ErrorDetectorOptions;

  beforeEach(() => {
    options = {
      enabled: true,
      includeWarnings: true,
      filters: {
        categories: [],
        severities: [],
        excludeFiles: [],
        excludePatterns: [],
      },
      bufferSize: 100,
      realTime: true,
    };

    detector = new ConsoleErrorDetector(options);
  });

  afterEach(async () => {
    if (detector.isDetectorRunning()) {
      await detector.stop();
    }
  });

  describe('initialization', () => {
    it('should create detector with correct source', () => {
      const source = detector.getSource();
      expect(source.type).toBe('console');
      expect(source.tool).toBe('console-detector');
    });

    it('should have correct capabilities', () => {
      const capabilities = detector.getCapabilities();
      expect(capabilities.supportsRealTime).toBe(true);
      expect(capabilities.supportsPolling).toBe(false);
      expect(capabilities.supportedLanguages).toContain('javascript');
      expect(capabilities.supportedLanguages).toContain('typescript');
    });

    it('should not be running initially', () => {
      expect(detector.isDetectorRunning()).toBe(false);
    });
  });

  describe('lifecycle', () => {
    it('should start and stop correctly', async () => {
      expect(detector.isDetectorRunning()).toBe(false);

      await detector.start();
      expect(detector.isDetectorRunning()).toBe(true);

      await detector.stop();
      expect(detector.isDetectorRunning()).toBe(false);
    });

    it('should not start if already running', async () => {
      await detector.start();
      expect(detector.isDetectorRunning()).toBe(true);

      // Should not throw or change state
      await detector.start();
      expect(detector.isDetectorRunning()).toBe(true);
    });

    it('should not stop if not running', async () => {
      expect(detector.isDetectorRunning()).toBe(false);

      // Should not throw
      await detector.stop();
      expect(detector.isDetectorRunning()).toBe(false);
    });
  });

  describe('error detection', () => {
    beforeEach(async () => {
      await detector.start();
    });

    it('should detect console.error calls', () => {
      return new Promise<void>(resolve => {
        detector.on('error-detected', error => {
          expect(error.message).toContain('Test error message');
          expect(error.type).toBe('console.error');
          expect(error.category).toBe(ErrorCategory.RUNTIME);
          expect(error.source.type).toBe('console');
          resolve();
        });

        // Trigger a console error
        console.error('Test error message');
      });
    });

    it('should detect console.warn calls when warnings enabled', () => {
      return new Promise<void>(resolve => {
        detector.on('error-detected', error => {
          expect(error.message).toContain('Test warning message');
          expect(error.type).toBe('console.warn');
          resolve();
        });

        // Trigger a console warning
        console.warn('Test warning message');
      });
    });

    it('should categorize errors correctly', () => {
      return new Promise<void>(resolve => {
        detector.on('error-detected', error => {
          expect(error.category).toBe(ErrorCategory.SYNTAX);
          resolve();
        });

        // Trigger a syntax error
        console.error('SyntaxError: Unexpected token');
      });
    });

    it('should determine severity correctly', () => {
      return new Promise<void>(resolve => {
        detector.on('error-detected', error => {
          expect(error.severity).toBe(ErrorSeverity.CRITICAL);
          resolve();
        });

        // Trigger a critical error
        console.error('Fatal error occurred');
      });
    });

    it('should maintain buffer correctly', async () => {
      // Generate multiple errors
      console.error('Error 1');
      console.error('Error 2');
      console.error('Error 3');

      // Wait a bit for processing
      await new Promise(resolve => setTimeout(resolve, 100));

      const bufferedErrors = detector.getBufferedErrors();
      expect(bufferedErrors.length).toBeGreaterThan(0);
      expect(detector.getDetectionCount()).toBeGreaterThan(0);
    });

    it('should clear buffer when requested', async () => {
      console.error('Test error');

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(detector.getBufferedErrors().length).toBeGreaterThan(0);

      detector.clearBuffer();
      expect(detector.getBufferedErrors().length).toBe(0);
    });
  });

  describe('error filtering', () => {
    it('should filter by severity', async () => {
      const filteredOptions = {
        ...options,
        filters: {
          ...options.filters,
          severities: [ErrorSeverity.HIGH],
        },
      };

      const filteredDetector = new ConsoleErrorDetector(filteredOptions);
      await filteredDetector.start();

      let errorDetected = false;
      filteredDetector.on('error-detected', () => {
        errorDetected = true;
      });

      // This should be filtered out (low severity)
      console.log('Info message');

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(errorDetected).toBe(false);

      await filteredDetector.stop();
    });

    it('should filter by patterns', async () => {
      const filteredOptions = {
        ...options,
        filters: {
          ...options.filters,
          excludePatterns: ['test-pattern'],
        },
      };

      const filteredDetector = new ConsoleErrorDetector(filteredOptions);
      await filteredDetector.start();

      let errorDetected = false;
      filteredDetector.on('error-detected', () => {
        errorDetected = true;
      });

      // This should be filtered out
      console.error('Error with test-pattern in message');

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(errorDetected).toBe(false);

      await filteredDetector.stop();
    });
  });

  describe('stack trace parsing', () => {
    beforeEach(async () => {
      await detector.start();
    });

    it('should parse Node.js stack traces', () => {
      return new Promise<void>(resolve => {
        detector.on('error-detected', error => {
          expect(error.stackTrace.length).toBeGreaterThan(0);
          const frame = error.stackTrace[0];
          expect(frame?.location.file).toBeDefined();
          expect(frame?.location.line).toBeGreaterThan(0);
          resolve();
        });

        // Create an error with stack trace
        const testError = new Error('Test error with stack');
        console.error(testError);
      });
    });
  });
});
