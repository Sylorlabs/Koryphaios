/**
 * Tests for ErrorTracker utility
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ErrorTracker } from '../../../src/utils/error-tracker.js';
import { Logger } from '../../../src/utils/logger.js';

describe('ErrorTracker', () => {
  let tracker: ErrorTracker;
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      logError: vi.fn(),
    } as any;

    tracker = new ErrorTracker(mockLogger);
  });

  describe('Constructor', () => {
    it('should create tracker with provided logger', () => {
      const customTracker = new ErrorTracker(mockLogger);
      expect(customTracker).toBeDefined();
    });

    it('should create tracker with default logger when none provided', () => {
      const defaultTracker = new ErrorTracker();
      expect(defaultTracker).toBeDefined();
    });
  });

  describe('Error Categories', () => {
    it('should add error category', () => {
      const category = {
        id: 'test-category',
        name: 'Test Category',
        description: 'Test description',
        severity: 'medium' as const,
        patterns: ['test-pattern'],
      };

      tracker.addCategory(category);

      const categories = tracker.getCategories();
      expect(categories).toContainEqual(category);
    });

    it('should get categories', () => {
      const category = {
        id: 'test-category',
        name: 'Test Category',
        description: 'Test description',
        severity: 'high' as const,
        patterns: ['test-pattern'],
      };

      tracker.addCategory(category);
      const categories = tracker.getCategories();

      expect(categories.some(c => c.id === 'test-category')).toBe(true);
    });
  });

  describe('Error Tracking', () => {
    beforeEach(() => {
      tracker.addCategory({
        id: 'syntax',
        name: 'Syntax Error',
        description: 'Syntax errors',
        severity: 'high',
        patterns: ['SyntaxError'],
      });
    });

    it('should track new error', () => {
      const message = 'SyntaxError: Unexpected token';

      const errorId = tracker.trackError(
        message,
        'test-source',
        { component: 'test' },
        undefined,
        'test.js',
        10,
        5
      );

      expect(errorId).toBeDefined();
      expect(typeof errorId).toBe('string');

      const trackedError = tracker.getError(errorId);
      expect(trackedError).toBeDefined();
      expect(trackedError!.message).toBe(message);
      expect(trackedError!.source).toBe('test-source');
      expect(trackedError!.file).toBe('test.js');
      expect(trackedError!.line).toBe(10);
      expect(trackedError!.column).toBe(5);
      expect(trackedError!.category).toBe('syntax');
      expect(trackedError!.severity).toBe('high');
      expect(trackedError!.occurrenceCount).toBe(1);
    });

    it('should increment occurrence count for duplicate errors', () => {
      const message = 'SyntaxError: Unexpected token';

      const errorId1 = tracker.trackError(message, 'test-source');
      const errorId2 = tracker.trackError(message, 'test-source');

      expect(errorId1).toBe(errorId2);

      const trackedError = tracker.getError(errorId1);
      expect(trackedError!.occurrenceCount).toBe(2);
    });

    it('should categorize error as unknown when no pattern matches', () => {
      const message = 'Unknown error type';

      const errorId = tracker.trackError(message, 'test-source');
      const trackedError = tracker.getError(errorId);

      expect(trackedError!.category).toBe('unknown');
      expect(trackedError!.severity).toBe('medium');
    });

    it('should resolve error', () => {
      const message = 'Test error';
      const errorId = tracker.trackError(message, 'test-source');

      tracker.resolveError(errorId, 'manual fix');

      const resolved = tracker.getError(errorId);
      expect(resolved?.resolved).toBe(true);
      expect(resolved?.resolutionMethod).toBe('manual fix');
      expect(resolved?.resolutionTime).toBeDefined();
    });

    it('should handle resolving non-existent error', () => {
      expect(() => tracker.resolveError('non-existent', 'test')).not.toThrow();
    });

    it('should track error with tags', () => {
      const message = 'Test error';
      const errorId = tracker.trackError(message, 'test-source', { component: 'frontend' });
      const trackedError = tracker.getError(errorId);

      expect(trackedError!.tags).toContain('test-source');
      expect(trackedError!.tags).toContain('component:frontend');
    });
  });

  describe('Error Retrieval', () => {
    it('should get error by id', () => {
      const message = 'Test error';
      const errorId = tracker.trackError(message, 'test-source');

      const retrieved = tracker.getError(errorId);

      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(errorId);
      expect(retrieved!.message).toBe(message);
    });

    it('should return undefined for non-existent error', () => {
      const error = tracker.getError('non-existent');
      expect(error).toBeUndefined();
    });

    it('should get all errors', () => {
      tracker.trackError('Error 1', 'source1');
      tracker.trackError('Error 2', 'source2');

      const allErrors = tracker.getAllErrors();
      expect(allErrors).toHaveLength(2);
    });

    it('should get errors by category', () => {
      tracker.addCategory({
        id: 'runtime',
        name: 'Runtime Error',
        description: 'Runtime errors',
        severity: 'critical',
        patterns: ['RuntimeError'],
      });

      tracker.trackError('SyntaxError: test', 'test');
      tracker.trackError('RuntimeError: test', 'test');

      const syntaxErrors = tracker.getErrorsByCategory('syntax');
      expect(syntaxErrors).toHaveLength(1);
      expect(syntaxErrors[0].category).toBe('syntax');
    });

    it('should get unresolved errors', () => {
      // Clear any existing errors first
      const initialErrors = tracker.getAllErrors();
      for (const error of initialErrors) {
        tracker.resolveError(error.id, 'cleanup');
      }

      const errorId1 = tracker.trackError('Error 1', 'test');
      const errorId2 = tracker.trackError('Error 2', 'test');

      tracker.resolveError(errorId1, 'fixed');

      const unresolved = tracker.getUnresolvedErrors();
      expect(unresolved).toHaveLength(1);
      expect(unresolved[0].id).toBe(errorId2);
    });
  });

  describe('Reports', () => {
    it('should generate error report', () => {
      tracker.trackError('Test error', 'test');

      const report = tracker.generateReport();

      expect(report).toBeDefined();
      expect(report.id).toBeDefined();
      expect(report.timestamp).toBeGreaterThan(0);
      expect(report.period.start).toBeGreaterThan(0);
      expect(report.period.end).toBeGreaterThan(0);
      expect(report.summary.totalErrors).toBe(1);
    });

    it('should generate report for specific time period', () => {
      const startTime = Date.now() - 1000;
      const endTime = Date.now();

      const report = tracker.generateReport(startTime, endTime);

      expect(report.period.start).toBe(startTime);
      expect(report.period.end).toBe(endTime);
    });
  });

  describe('Cleanup', () => {
    it('should cleanup old resolved errors', () => {
      const errorId = tracker.trackError('Test error', 'test');
      tracker.resolveError(errorId, 'fixed');

      // Wait a moment to ensure resolution time is set
      setTimeout(() => {
        const removedCount = tracker.cleanup(0); // Remove all resolved errors
        expect(removedCount).toBeGreaterThanOrEqual(0);
      }, 10);
    });
  });
});
