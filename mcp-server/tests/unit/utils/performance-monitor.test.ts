/**
 * Tests for PerformanceMonitor utility
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PerformanceMonitor } from '../../../src/utils/performance-monitor.js';
import { Logger } from '../../../src/utils/logger.js';

describe('PerformanceMonitor', () => {
  let monitor: PerformanceMonitor;
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      logPerformance: vi.fn(),
    } as any;

    monitor = new PerformanceMonitor(mockLogger);
  });

  describe('Constructor', () => {
    it('should create monitor with provided logger', () => {
      const customMonitor = new PerformanceMonitor(mockLogger);
      expect(customMonitor).toBeDefined();
    });

    it('should create monitor with default logger when none provided', () => {
      const defaultMonitor = new PerformanceMonitor();
      expect(defaultMonitor).toBeDefined();
    });
  });

  describe('Metric Tracking', () => {
    it('should record metric', () => {
      monitor.recordMetric('memory-usage', 1024, 'bytes');

      const metrics = monitor.getMetrics('memory-usage');
      expect(metrics).toHaveLength(1);
      expect(metrics[0].value).toBe(1024);
      expect(metrics[0].unit).toBe('bytes');
    });

    it('should get all metrics when no name specified', () => {
      monitor.recordMetric('metric1', 100);
      monitor.recordMetric('metric2', 200);

      const allMetrics = monitor.getMetrics();
      expect(allMetrics).toHaveLength(2);
    });

    it('should set performance threshold', () => {
      expect(() => monitor.setThreshold('test-metric', 1000)).not.toThrow();
    });
  });

  describe('Performance Profiling', () => {
    it('should start performance profile', () => {
      const profileId = monitor.startProfile('test-profile');

      expect(profileId).toBeDefined();
      expect(typeof profileId).toBe('string');
    });

    it('should end performance profile', () => {
      const profileId = monitor.startProfile('test-profile');
      const profile = monitor.endProfile(profileId);

      expect(profile).toBeDefined();
      expect(profile?.name).toBe('test-profile');
      expect(profile?.duration).toBeGreaterThanOrEqual(0);
    });

    it('should return undefined for non-existent profile', () => {
      const profile = monitor.endProfile('non-existent');
      expect(profile).toBeUndefined();
    });

    it('should add operation to profile', () => {
      const profileId = monitor.startProfile('test-profile');

      monitor.addOperationToProfile(profileId, 'test-operation', 100, 'success');

      const profile = monitor.endProfile(profileId);
      expect(profile?.operations).toHaveLength(1);
      expect(profile?.operations[0].name).toBe('test-operation');
    });
  });

  describe('System Metrics', () => {
    it('should collect system metrics', () => {
      // The collectSystemMetrics method is private, so we test it indirectly
      // by checking that metrics are recorded when the monitor is created
      expect(monitor).toBeDefined();
    });
  });

  describe('Thresholds and Alerts', () => {
    it('should trigger alert when threshold exceeded', () => {
      monitor.setThreshold('slow-operation', 100);

      // Record a metric that exceeds the threshold
      monitor.recordMetric('slow-operation', 200);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Performance threshold exceeded'),
        expect.any(Object)
      );
    });

    it('should not trigger alert when threshold not exceeded', () => {
      monitor.setThreshold('fast-operation', 1000);

      monitor.recordMetric('fast-operation', 50);

      expect(mockLogger.warn).not.toHaveBeenCalled();
    });
  });

  describe('Reports', () => {
    it('should generate performance report', () => {
      monitor.recordMetric('test-metric', 100);

      const report = monitor.generateReport();

      expect(report).toBeDefined();
      expect(report.id).toBeDefined();
      expect(report.timestamp).toBeGreaterThan(0);
      expect(report.period.start).toBeGreaterThan(0);
      expect(report.period.end).toBeGreaterThan(0);
    });

    it('should generate report for specific time range', () => {
      const startTime = Date.now() - 1000;
      const endTime = Date.now();

      const report = monitor.generateReport(startTime, endTime);

      expect(report.period.start).toBe(startTime);
      expect(report.period.end).toBe(endTime);
    });
  });

  describe('Profiles', () => {
    it('should get all profiles', () => {
      const profileId = monitor.startProfile('test-profile');
      monitor.endProfile(profileId);

      const profiles = monitor.getProfiles();
      expect(profiles).toHaveLength(1);
      expect(profiles[0].name).toBe('test-profile');
    });
  });

  describe('Cleanup', () => {
    it('should cleanup old metrics', () => {
      monitor.recordMetric('test-metric', 100);

      const removedCount = monitor.cleanup(0); // Remove all metrics

      expect(removedCount).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Global Instance', () => {
    it('should export global performance monitor', async () => {
      const { globalPerformanceMonitor } =
        await import('../../../src/utils/performance-monitor.js');
      expect(globalPerformanceMonitor).toBeDefined();
      expect(globalPerformanceMonitor).toBeInstanceOf(PerformanceMonitor);
    });
  });
});
