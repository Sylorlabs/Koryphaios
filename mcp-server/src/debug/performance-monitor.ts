/**
 * Performance monitoring and profiling system
 */

import { EventEmitter } from 'events';
import { Logger } from '../utils/logger.js';

export interface PerformanceMetric {
  name: string;
  value: number;
  unit: 'ms' | 'bytes' | 'count' | 'percent';
  timestamp: Date;
  tags?: Record<string, string> | undefined;
}

export interface PerformanceProfile {
  id: string;
  name: string;
  startTime: Date;
  endTime?: Date;
  duration?: number;
  metrics: PerformanceMetric[];
  children: PerformanceProfile[];
  parent?: string | undefined;
}

export interface MemoryUsage {
  heapUsed: number;
  heapTotal: number;
  external: number;
  rss: number;
  timestamp: Date;
}

export interface CPUUsage {
  user: number;
  system: number;
  percent: number;
  timestamp: Date;
}

export class PerformanceMonitor extends EventEmitter {
  private profiles = new Map<string, PerformanceProfile>();
  private activeProfiles = new Map<string, PerformanceProfile>();
  private metrics: PerformanceMetric[] = [];
  private memoryHistory: MemoryUsage[] = [];
  private cpuHistory: CPUUsage[] = [];
  private logger: Logger;
  private monitoringInterval: NodeJS.Timeout | undefined;
  private profileCounter = 0;

  constructor() {
    super();
    this.logger = new Logger('debug', {
      logFile: undefined,
      enableConsole: true,
    });
  }

  /**
   * Start monitoring system performance
   */
  startMonitoring(intervalMs: number = 5000): void {
    if (this.monitoringInterval) {
      this.stopMonitoring();
    }

    this.logger.info('Starting performance monitoring', { intervalMs });

    this.monitoringInterval = setInterval(() => {
      this.collectSystemMetrics();
    }, intervalMs);

    // Initial collection
    this.collectSystemMetrics();
  }

  /**
   * Stop monitoring system performance
   */
  stopMonitoring(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = undefined;
      this.logger.info('Stopped performance monitoring');
    }
  }

  /**
   * Start a performance profile
   */
  startProfile(name: string, parentId?: string): string {
    const profileId = `profile-${++this.profileCounter}`;
    const now = new Date();

    const profile: PerformanceProfile = {
      id: profileId,
      name,
      startTime: now,
      metrics: [],
      children: [],
      parent: parentId || undefined,
    };

    this.profiles.set(profileId, profile);
    this.activeProfiles.set(profileId, profile);

    // Add to parent if specified
    if (parentId) {
      const parent = this.profiles.get(parentId);
      if (parent) {
        parent.children.push(profile);
      }
    }

    this.logger.debug('Started performance profile', { profileId, name, parentId });
    this.emit('profileStarted', profile);

    return profileId;
  }

  /**
   * End a performance profile
   */
  endProfile(profileId: string): PerformanceProfile | undefined {
    const profile = this.activeProfiles.get(profileId);
    if (!profile) {
      this.logger.warn('Attempted to end non-existent profile', { profileId });
      return undefined;
    }

    const now = new Date();
    profile.endTime = now;
    profile.duration = now.getTime() - profile.startTime.getTime();

    this.activeProfiles.delete(profileId);

    this.logger.debug('Ended performance profile', {
      profileId,
      name: profile.name,
      duration: profile.duration,
    });

    this.emit('profileEnded', profile);
    return profile;
  }

  /**
   * Add a metric to a profile
   */
  addMetric(
    profileId: string,
    name: string,
    value: number,
    unit: 'ms' | 'bytes' | 'count' | 'percent',
    tags?: Record<string, string>
  ): void {
    const profile = this.profiles.get(profileId);
    if (!profile) {
      this.logger.warn('Attempted to add metric to non-existent profile', { profileId, name });
      return;
    }

    const metric: PerformanceMetric = {
      name,
      value,
      unit,
      timestamp: new Date(),
      tags: tags || undefined,
    };

    profile.metrics.push(metric);
    this.metrics.push(metric);

    this.emit('metricAdded', profileId, metric);
  }

  /**
   * Record a timing metric
   */
  recordTiming(name: string, duration: number, tags?: Record<string, string>): void {
    const metric: PerformanceMetric = {
      name,
      value: duration,
      unit: 'ms',
      timestamp: new Date(),
      tags: tags || undefined,
    };

    this.metrics.push(metric);
    this.emit('metricRecorded', metric);
  }

  /**
   * Record a counter metric
   */
  recordCounter(name: string, count: number, tags?: Record<string, string>): void {
    const metric: PerformanceMetric = {
      name,
      value: count,
      unit: 'count',
      timestamp: new Date(),
      tags: tags || undefined,
    };

    this.metrics.push(metric);
    this.emit('metricRecorded', metric);
  }

  /**
   * Record a memory usage metric
   */
  recordMemoryUsage(name: string, bytes: number, tags?: Record<string, string>): void {
    const metric: PerformanceMetric = {
      name,
      value: bytes,
      unit: 'bytes',
      timestamp: new Date(),
      tags: tags || undefined,
    };

    this.metrics.push(metric);
    this.emit('metricRecorded', metric);
  }

  /**
   * Measure execution time of a function
   */
  async measureAsync<T>(
    name: string,
    fn: () => Promise<T>,
    tags?: Record<string, string>
  ): Promise<T> {
    const startTime = Date.now();

    try {
      const result = await fn();
      const duration = Date.now() - startTime;
      this.recordTiming(name, duration, { ...tags, status: 'success' });
      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      this.recordTiming(name, duration, { ...tags, status: 'error' });
      throw error;
    }
  }

  /**
   * Measure execution time of a synchronous function
   */
  measureSync<T>(name: string, fn: () => T, tags?: Record<string, string>): T {
    const startTime = Date.now();

    try {
      const result = fn();
      const duration = Date.now() - startTime;
      this.recordTiming(name, duration, { ...tags, status: 'success' });
      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      this.recordTiming(name, duration, { ...tags, status: 'error' });
      throw error;
    }
  }

  /**
   * Get a profile by ID
   */
  getProfile(profileId: string): PerformanceProfile | undefined {
    return this.profiles.get(profileId);
  }

  /**
   * Get all profiles
   */
  getAllProfiles(): PerformanceProfile[] {
    return Array.from(this.profiles.values());
  }

  /**
   * Get active profiles
   */
  getActiveProfiles(): PerformanceProfile[] {
    return Array.from(this.activeProfiles.values());
  }

  /**
   * Get metrics within a time range
   */
  getMetrics(startTime?: Date, endTime?: Date, name?: string): PerformanceMetric[] {
    let filtered = this.metrics;

    if (startTime) {
      filtered = filtered.filter(m => m.timestamp >= startTime);
    }

    if (endTime) {
      filtered = filtered.filter(m => m.timestamp <= endTime);
    }

    if (name) {
      filtered = filtered.filter(m => m.name === name);
    }

    return filtered;
  }

  /**
   * Get memory usage history
   */
  getMemoryHistory(limit?: number): MemoryUsage[] {
    if (limit) {
      return this.memoryHistory.slice(-limit);
    }
    return [...this.memoryHistory];
  }

  /**
   * Get CPU usage history
   */
  getCPUHistory(limit?: number): CPUUsage[] {
    if (limit) {
      return this.cpuHistory.slice(-limit);
    }
    return [...this.cpuHistory];
  }

  /**
   * Get performance statistics
   */
  getStatistics() {
    const now = new Date();
    const last5Minutes = new Date(now.getTime() - 5 * 60 * 1000);
    const recentMetrics = this.getMetrics(last5Minutes);

    const timingMetrics = recentMetrics.filter(m => m.unit === 'ms');
    const memoryMetrics = recentMetrics.filter(m => m.unit === 'bytes');
    const counterMetrics = recentMetrics.filter(m => m.unit === 'count');

    const avgTiming =
      timingMetrics.length > 0
        ? timingMetrics.reduce((sum, m) => sum + m.value, 0) / timingMetrics.length
        : 0;

    const avgMemory =
      memoryMetrics.length > 0
        ? memoryMetrics.reduce((sum, m) => sum + m.value, 0) / memoryMetrics.length
        : 0;

    const totalCounts = counterMetrics.reduce((sum, m) => sum + m.value, 0);

    const currentMemory = this.memoryHistory[this.memoryHistory.length - 1];
    const currentCPU = this.cpuHistory[this.cpuHistory.length - 1];

    return {
      profiles: {
        total: this.profiles.size,
        active: this.activeProfiles.size,
        completed: this.profiles.size - this.activeProfiles.size,
      },
      metrics: {
        total: this.metrics.length,
        recent: recentMetrics.length,
        averageTiming: avgTiming,
        averageMemoryUsage: avgMemory,
        totalCounts,
      },
      system: {
        memory: currentMemory,
        cpu: currentCPU,
      },
      history: {
        memoryPoints: this.memoryHistory.length,
        cpuPoints: this.cpuHistory.length,
      },
    };
  }

  /**
   * Clear old metrics and history
   */
  cleanup(maxAge: number = 24 * 60 * 60 * 1000): void {
    const cutoff = new Date(Date.now() - maxAge);

    // Clean up metrics
    this.metrics = this.metrics.filter(m => m.timestamp > cutoff);

    // Clean up memory history
    this.memoryHistory = this.memoryHistory.filter(m => m.timestamp > cutoff);

    // Clean up CPU history
    this.cpuHistory = this.cpuHistory.filter(c => c.timestamp > cutoff);

    // Clean up completed profiles
    for (const [id, profile] of this.profiles) {
      if (profile.endTime && profile.endTime < cutoff) {
        this.profiles.delete(id);
      }
    }

    this.logger.debug('Performance monitor cleanup completed', {
      metricsCount: this.metrics.length,
      memoryHistoryCount: this.memoryHistory.length,
      cpuHistoryCount: this.cpuHistory.length,
      profilesCount: this.profiles.size,
    });
  }

  /**
   * Collect system metrics
   */
  private collectSystemMetrics(): void {
    try {
      // Memory usage
      const memUsage = process.memoryUsage();
      const memoryUsage: MemoryUsage = {
        heapUsed: memUsage.heapUsed,
        heapTotal: memUsage.heapTotal,
        external: memUsage.external,
        rss: memUsage.rss,
        timestamp: new Date(),
      };

      this.memoryHistory.push(memoryUsage);

      // CPU usage
      const cpuUsage = process.cpuUsage();
      const cpuPercent = (cpuUsage.user + cpuUsage.system) / 1000000; // Convert to seconds

      const cpu: CPUUsage = {
        user: cpuUsage.user,
        system: cpuUsage.system,
        percent: cpuPercent,
        timestamp: new Date(),
      };

      this.cpuHistory.push(cpu);

      // Emit events
      this.emit('systemMetrics', { memory: memoryUsage, cpu });

      // Keep history size manageable
      if (this.memoryHistory.length > 1000) {
        this.memoryHistory = this.memoryHistory.slice(-500);
      }

      if (this.cpuHistory.length > 1000) {
        this.cpuHistory = this.cpuHistory.slice(-500);
      }
    } catch (error) {
      this.logger.error('Failed to collect system metrics', error);
    }
  }

  /**
   * Dispose and cleanup
   */
  dispose(): void {
    this.stopMonitoring();

    // End all active profiles
    for (const profileId of this.activeProfiles.keys()) {
      this.endProfile(profileId);
    }

    this.profiles.clear();
    this.activeProfiles.clear();
    this.metrics.length = 0;
    this.memoryHistory.length = 0;
    this.cpuHistory.length = 0;
    this.removeAllListeners();

    this.logger.info('Performance monitor disposed');
  }
}
