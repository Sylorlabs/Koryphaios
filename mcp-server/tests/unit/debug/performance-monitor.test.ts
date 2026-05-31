/**
 * Tests for PerformanceMonitor
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PerformanceMonitor } from '../../../src/debug/performance-monitor.js';

describe('PerformanceMonitor', () => {
  let performanceMonitor: PerformanceMonitor;

  beforeEach(() => {
    performanceMonitor = new PerformanceMonitor();
    vi.useFakeTimers();
  });

  afterEach(() => {
    performanceMonitor.dispose();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('startProfile', () => {
    it('should start a performance profile', () => {
      const profileId = performanceMonitor.startProfile('test-profile');

      expect(profileId).toMatch(/^profile-\d+$/);

      const profile = performanceMonitor.getProfile(profileId);
      expect(profile).toBeDefined();
      expect(profile?.name).toBe('test-profile');
      expect(profile?.startTime).toBeInstanceOf(Date);
      expect(profile?.endTime).toBeUndefined();
      expect(profile?.duration).toBeUndefined();
    });

    it('should start a nested profile with parent', () => {
      const parentId = performanceMonitor.startProfile('parent-profile');
      const childId = performanceMonitor.startProfile('child-profile', parentId);

      const parentProfile = performanceMonitor.getProfile(parentId);
      const childProfile = performanceMonitor.getProfile(childId);

      expect(childProfile?.parent).toBe(parentId);
      expect(parentProfile?.children).toHaveLength(1);
      expect(parentProfile?.children[0]).toBe(childProfile);
    });
  });

  describe('endProfile', () => {
    it('should end a performance profile', () => {
      const profileId = performanceMonitor.startProfile('test-profile');

      // Advance time
      vi.advanceTimersByTime(100);

      const endedProfile = performanceMonitor.endProfile(profileId);

      expect(endedProfile).toBeDefined();
      expect(endedProfile?.endTime).toBeInstanceOf(Date);
      expect(endedProfile?.duration).toBe(100);

      // Should no longer be in active profiles
      const activeProfiles = performanceMonitor.getActiveProfiles();
      expect(activeProfiles.find(p => p.id === profileId)).toBeUndefined();
    });

    it('should return undefined for non-existent profile', () => {
      const result = performanceMonitor.endProfile('non-existent');
      expect(result).toBeUndefined();
    });
  });

  describe('addMetric', () => {
    it('should add a metric to a profile', () => {
      const profileId = performanceMonitor.startProfile('test-profile');

      performanceMonitor.addMetric(profileId, 'test-metric', 42, 'ms', { tag: 'value' });

      const profile = performanceMonitor.getProfile(profileId);
      expect(profile?.metrics).toHaveLength(1);
      expect(profile?.metrics[0]).toMatchObject({
        name: 'test-metric',
        value: 42,
        unit: 'ms',
        tags: { tag: 'value' },
      });
    });

    it('should not add metric to non-existent profile', () => {
      performanceMonitor.addMetric('non-existent', 'test-metric', 42, 'ms');

      // Should not throw, but metric should not be added anywhere
      const allProfiles = performanceMonitor.getAllProfiles();
      expect(allProfiles).toHaveLength(0);
    });
  });

  describe('recordTiming', () => {
    it('should record a timing metric', () => {
      performanceMonitor.recordTiming('api-call', 150, { endpoint: '/users' });

      const metrics = performanceMonitor.getMetrics();
      expect(metrics).toHaveLength(1);
      expect(metrics[0]).toMatchObject({
        name: 'api-call',
        value: 150,
        unit: 'ms',
        tags: { endpoint: '/users' },
      });
    });
  });

  describe('recordCounter', () => {
    it('should record a counter metric', () => {
      performanceMonitor.recordCounter('requests', 5, { status: '200' });

      const metrics = performanceMonitor.getMetrics();
      expect(metrics).toHaveLength(1);
      expect(metrics[0]).toMatchObject({
        name: 'requests',
        value: 5,
        unit: 'count',
        tags: { status: '200' },
      });
    });
  });

  describe('recordMemoryUsage', () => {
    it('should record a memory usage metric', () => {
      performanceMonitor.recordMemoryUsage('heap-used', 1024 * 1024, { type: 'heap' });

      const metrics = performanceMonitor.getMetrics();
      expect(metrics).toHaveLength(1);
      expect(metrics[0]).toMatchObject({
        name: 'heap-used',
        value: 1024 * 1024,
        unit: 'bytes',
        tags: { type: 'heap' },
      });
    });
  });

  describe('measureAsync', () => {
    it('should measure async function execution time', async () => {
      const asyncFn = vi.fn().mockImplementation(async () => {
        vi.advanceTimersByTime(200);
        return 'result';
      });

      const result = await performanceMonitor.measureAsync('async-operation', asyncFn, {
        type: 'test',
      });

      expect(result).toBe('result');
      expect(asyncFn).toHaveBeenCalled();

      const metrics = performanceMonitor.getMetrics();
      expect(metrics).toHaveLength(1);
      expect(metrics[0]).toMatchObject({
        name: 'async-operation',
        value: 200,
        unit: 'ms',
        tags: { type: 'test', status: 'success' },
      });
    });

    it('should measure async function execution time on error', async () => {
      const asyncFn = vi.fn().mockImplementation(async () => {
        vi.advanceTimersByTime(100);
        throw new Error('Test error');
      });

      await expect(
        performanceMonitor.measureAsync('async-operation', asyncFn, { type: 'test' })
      ).rejects.toThrow('Test error');

      const metrics = performanceMonitor.getMetrics();
      expect(metrics).toHaveLength(1);
      expect(metrics[0]).toMatchObject({
        name: 'async-operation',
        value: 100,
        unit: 'ms',
        tags: { type: 'test', status: 'error' },
      });
    });
  });

  describe('measureSync', () => {
    it('should measure sync function execution time', () => {
      const syncFn = vi.fn().mockImplementation(() => {
        vi.advanceTimersByTime(50);
        return 'result';
      });

      const result = performanceMonitor.measureSync('sync-operation', syncFn, { type: 'test' });

      expect(result).toBe('result');
      expect(syncFn).toHaveBeenCalled();

      const metrics = performanceMonitor.getMetrics();
      expect(metrics).toHaveLength(1);
      expect(metrics[0]).toMatchObject({
        name: 'sync-operation',
        value: 50,
        unit: 'ms',
        tags: { type: 'test', status: 'success' },
      });
    });

    it('should measure sync function execution time on error', () => {
      const syncFn = vi.fn().mockImplementation(() => {
        vi.advanceTimersByTime(25);
        throw new Error('Test error');
      });

      expect(() =>
        performanceMonitor.measureSync('sync-operation', syncFn, { type: 'test' })
      ).toThrow('Test error');

      const metrics = performanceMonitor.getMetrics();
      expect(metrics).toHaveLength(1);
      expect(metrics[0]).toMatchObject({
        name: 'sync-operation',
        value: 25,
        unit: 'ms',
        tags: { type: 'test', status: 'error' },
      });
    });
  });

  describe('getMetrics', () => {
    it('should filter metrics by time range', () => {
      const now = new Date();
      const past = new Date(now.getTime() - 1000);
      const future = new Date(now.getTime() + 1000);

      performanceMonitor.recordTiming('old-metric', 100);
      vi.advanceTimersByTime(500);
      performanceMonitor.recordTiming('new-metric', 200);

      const allMetrics = performanceMonitor.getMetrics();
      expect(allMetrics).toHaveLength(2);

      const recentMetrics = performanceMonitor.getMetrics(past);
      expect(recentMetrics).toHaveLength(2);

      const futureMetrics = performanceMonitor.getMetrics(future);
      expect(futureMetrics).toHaveLength(0);
    });

    it('should filter metrics by name', () => {
      performanceMonitor.recordTiming('api-call', 100);
      performanceMonitor.recordTiming('db-query', 200);
      performanceMonitor.recordTiming('api-call', 150);

      const apiMetrics = performanceMonitor.getMetrics(undefined, undefined, 'api-call');
      expect(apiMetrics).toHaveLength(2);
      expect(apiMetrics.every(m => m.name === 'api-call')).toBe(true);
    });
  });

  describe('startMonitoring', () => {
    it('should start system monitoring', () => {
      const spy = vi.spyOn(performanceMonitor as any, 'collectSystemMetrics');

      performanceMonitor.startMonitoring(1000);

      // Should call immediately
      expect(spy).toHaveBeenCalledTimes(1);

      // Should call again after interval
      vi.advanceTimersByTime(1000);
      expect(spy).toHaveBeenCalledTimes(2);

      spy.mockRestore();
    });

    it('should stop previous monitoring when starting new', () => {
      const spy = vi.spyOn(performanceMonitor, 'stopMonitoring');

      performanceMonitor.startMonitoring(1000);
      performanceMonitor.startMonitoring(2000);

      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });
  });

  describe('stopMonitoring', () => {
    it('should stop system monitoring', () => {
      performanceMonitor.startMonitoring(1000);
      performanceMonitor.stopMonitoring();

      const spy = vi.spyOn(performanceMonitor as any, 'collectSystemMetrics');

      vi.advanceTimersByTime(1000);
      expect(spy).not.toHaveBeenCalled();

      spy.mockRestore();
    });
  });

  describe('getStatistics', () => {
    it('should return performance statistics', () => {
      const profileId = performanceMonitor.startProfile('test-profile');
      performanceMonitor.recordTiming('test-timing', 100);
      performanceMonitor.recordCounter('test-counter', 5);
      performanceMonitor.recordMemoryUsage('test-memory', 1024);

      const stats = performanceMonitor.getStatistics();

      expect(stats).toMatchObject({
        profiles: {
          total: 1,
          active: 1,
          completed: 0,
        },
        metrics: {
          total: 3,
          recent: 3,
        },
      });
    });
  });

  describe('cleanup', () => {
    it('should cleanup old data', () => {
      // Create old data
      performanceMonitor.recordTiming('old-metric', 100);
      const profileId = performanceMonitor.startProfile('old-profile');
      performanceMonitor.endProfile(profileId);

      // Advance time beyond max age
      vi.advanceTimersByTime(25 * 60 * 60 * 1000); // 25 hours

      // Create new data
      performanceMonitor.recordTiming('new-metric', 200);

      performanceMonitor.cleanup(24 * 60 * 60 * 1000); // 24 hours max age

      const metrics = performanceMonitor.getMetrics();
      expect(metrics).toHaveLength(1);
      expect(metrics[0].name).toBe('new-metric');

      const profiles = performanceMonitor.getAllProfiles();
      expect(profiles).toHaveLength(0);
    });
  });

  describe('dispose', () => {
    it('should dispose and cleanup all resources', () => {
      const profileId = performanceMonitor.startProfile('test-profile');
      performanceMonitor.startMonitoring(1000);

      performanceMonitor.dispose();

      expect(performanceMonitor.getActiveProfiles()).toHaveLength(0);
      expect(performanceMonitor.getAllProfiles()).toHaveLength(0);
      expect(performanceMonitor.getMetrics()).toHaveLength(0);
    });
  });
});
