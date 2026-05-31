/**
 * Comprehensive performance metrics and monitoring system
 */

import { Logger } from './logger.js';

export interface PerformanceMetric {
  id: string;
  name: string;
  value: number;
  unit: string;
  timestamp: number;
  category: string;
  tags: Record<string, string>;
  threshold?: number | undefined;
  status: 'normal' | 'warning' | 'critical';
}

export interface PerformanceProfile {
  id: string;
  name: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  metrics: PerformanceMetric[];
  operations: Array<{
    name: string;
    startTime: number;
    endTime: number;
    duration: number;
    status: 'success' | 'error';
  }>;
  memoryUsage: {
    start: NodeJS.MemoryUsage;
    end?: NodeJS.MemoryUsage;
    peak?: NodeJS.MemoryUsage;
  };
  cpuUsage: {
    start: NodeJS.CpuUsage;
    end?: NodeJS.CpuUsage;
  };
}

export interface PerformanceReport {
  id: string;
  timestamp: number;
  period: {
    start: number;
    end: number;
  };
  summary: {
    totalMetrics: number;
    averageResponseTime: number;
    peakMemoryUsage: number;
    totalCpuTime: number;
    errorRate: number;
    throughput: number;
  };
  trends: Array<{
    timestamp: number;
    responseTime: number;
    memoryUsage: number;
    cpuUsage: number;
    errorCount: number;
  }>;
  alerts: Array<{
    metric: string;
    value: number;
    threshold: number;
    severity: 'warning' | 'critical';
    timestamp: number;
  }>;
  recommendations: string[];
}

export class PerformanceMonitor {
  private metrics: Map<string, PerformanceMetric[]> = new Map();
  private profiles: Map<string, PerformanceProfile> = new Map();
  private activeProfiles: Map<string, PerformanceProfile> = new Map();
  private logger: Logger;
  private metricCounter = 0;
  private profileCounter = 0;
  private thresholds: Map<string, number> = new Map();

  constructor(logger?: Logger) {
    this.logger = logger || new Logger('info', { logFile: undefined });
    this.initializeDefaultThresholds();
    this.startSystemMonitoring();
  }

  private initializeDefaultThresholds(): void {
    this.thresholds.set('response_time', 1000); // 1 second
    this.thresholds.set('memory_usage', 512 * 1024 * 1024); // 512MB
    this.thresholds.set('cpu_usage', 80); // 80%
    this.thresholds.set('error_rate', 5); // 5%
    this.thresholds.set('throughput', 100); // 100 requests/minute

    this.logger.info('Performance monitor initialized with default thresholds', {
      thresholds: Object.fromEntries(this.thresholds),
    });
  }

  private startSystemMonitoring(): void {
    // Monitor system metrics every 30 seconds
    setInterval(() => {
      this.collectSystemMetrics();
    }, 30000);

    this.logger.debug('System monitoring started');
  }

  private collectSystemMetrics(): void {
    const memUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();

    // Memory metrics
    this.recordMetric('memory_rss', memUsage.rss, 'bytes', 'system', {
      type: 'memory',
      component: 'rss',
    });

    this.recordMetric('memory_heap_used', memUsage.heapUsed, 'bytes', 'system', {
      type: 'memory',
      component: 'heap_used',
    });

    this.recordMetric('memory_heap_total', memUsage.heapTotal, 'bytes', 'system', {
      type: 'memory',
      component: 'heap_total',
    });

    // CPU metrics
    this.recordMetric('cpu_user', cpuUsage.user, 'microseconds', 'system', {
      type: 'cpu',
      component: 'user',
    });

    this.recordMetric('cpu_system', cpuUsage.system, 'microseconds', 'system', {
      type: 'cpu',
      component: 'system',
    });

    // Process metrics
    this.recordMetric('uptime', process.uptime(), 'seconds', 'system', {
      type: 'process',
      component: 'uptime',
    });
  }

  // Metric recording
  recordMetric(
    name: string,
    value: number,
    unit: string,
    category: string,
    tags: Record<string, string> = {}
  ): string {
    const metricId = `metric_${++this.metricCounter}_${Date.now()}`;
    const timestamp = Date.now();
    const threshold = this.thresholds.get(name);

    let status: 'normal' | 'warning' | 'critical' = 'normal';
    if (threshold) {
      if (value > threshold * 1.5) {
        status = 'critical';
      } else if (value > threshold) {
        status = 'warning';
      }
    }

    const metric: PerformanceMetric = {
      id: metricId,
      name,
      value,
      unit,
      timestamp,
      category,
      tags,
      threshold,
      status,
    };

    if (!this.metrics.has(name)) {
      this.metrics.set(name, []);
    }
    this.metrics.get(name)!.push(metric);

    // Log performance metric
    this.logger.logPerformance(name, value, { unit, category, tags, status });

    // Check for alerts
    if (status !== 'normal') {
      this.logger.warn(`Performance threshold exceeded: ${name}`, {
        value,
        threshold,
        status,
        unit,
        category,
      });
    }

    return metricId;
  }

  // Performance profiling
  startProfile(name: string, tags: Record<string, string> = {}): string {
    const profileId = `profile_${++this.profileCounter}_${Date.now()}`;
    const startTime = Date.now();

    const profile: PerformanceProfile = {
      id: profileId,
      name,
      startTime,
      metrics: [],
      operations: [],
      memoryUsage: {
        start: process.memoryUsage(),
      },
      cpuUsage: {
        start: process.cpuUsage(),
      },
    };

    this.activeProfiles.set(profileId, profile);

    this.logger.debug(`Performance profile started: ${name}`, {
      profileId,
      tags,
    });

    return profileId;
  }

  endProfile(profileId: string): PerformanceProfile | undefined {
    const profile = this.activeProfiles.get(profileId);
    if (!profile) {
      this.logger.warn(`Profile ${profileId} not found`);
      return undefined;
    }

    const endTime = Date.now();
    profile.endTime = endTime;
    profile.duration = endTime - profile.startTime;
    profile.memoryUsage.end = process.memoryUsage();
    profile.cpuUsage.end = process.cpuUsage(profile.cpuUsage.start);

    this.activeProfiles.delete(profileId);
    this.profiles.set(profileId, profile);

    this.logger.info(`Performance profile completed: ${profile.name}`, {
      profileId,
      duration: profile.duration,
      memoryDelta: profile.memoryUsage.end.heapUsed - profile.memoryUsage.start.heapUsed,
      cpuTime: profile.cpuUsage.end.user + profile.cpuUsage.end.system,
    });

    return profile;
  }

  addOperationToProfile(
    profileId: string,
    operationName: string,
    duration: number,
    status: 'success' | 'error'
  ): void {
    const profile = this.activeProfiles.get(profileId);
    if (!profile) {
      return;
    }

    const endTime = Date.now();
    profile.operations.push({
      name: operationName,
      startTime: endTime - duration,
      endTime,
      duration,
      status,
    });
  }

  // Measurement utilities
  measureAsync<T>(
    name: string,
    fn: () => Promise<T>,
    tags: Record<string, string> = {}
  ): Promise<T> {
    const startTime = Date.now();
    const profileId = this.startProfile(name, tags);

    return fn()
      .then(result => {
        const duration = Date.now() - startTime;
        this.recordMetric(`${name}_duration`, duration, 'milliseconds', 'operation', tags);
        this.addOperationToProfile(profileId, name, duration, 'success');
        this.endProfile(profileId);
        return result;
      })
      .catch(error => {
        const duration = Date.now() - startTime;
        this.recordMetric(`${name}_duration`, duration, 'milliseconds', 'operation', {
          ...tags,
          status: 'error',
        });
        this.addOperationToProfile(profileId, name, duration, 'error');
        this.endProfile(profileId);
        throw error;
      });
  }

  measureSync<T>(name: string, fn: () => T, tags: Record<string, string> = {}): T {
    const startTime = Date.now();
    const profileId = this.startProfile(name, tags);

    try {
      const result = fn();
      const duration = Date.now() - startTime;
      this.recordMetric(`${name}_duration`, duration, 'milliseconds', 'operation', tags);
      this.addOperationToProfile(profileId, name, duration, 'success');
      this.endProfile(profileId);
      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      this.recordMetric(`${name}_duration`, duration, 'milliseconds', 'operation', {
        ...tags,
        status: 'error',
      });
      this.addOperationToProfile(profileId, name, duration, 'error');
      this.endProfile(profileId);
      throw error;
    }
  }

  // Reporting
  generateReport(startTime?: number, endTime?: number): PerformanceReport {
    const now = Date.now();
    const start = startTime || now - 24 * 60 * 60 * 1000; // Last 24 hours
    const end = endTime || now;

    const relevantMetrics = this.getMetricsInRange(start, end);
    const summary = this.calculateSummary(relevantMetrics);
    const trends = this.calculateTrends(relevantMetrics, start, end);
    const alerts = this.getAlerts(relevantMetrics);
    const recommendations = this.generateRecommendations(summary, alerts);

    const report: PerformanceReport = {
      id: `perf_report_${Date.now()}`,
      timestamp: now,
      period: { start, end },
      summary,
      trends,
      alerts,
      recommendations,
    };

    this.logger.info('Performance report generated', {
      reportId: report.id,
      period: `${new Date(start).toISOString()} - ${new Date(end).toISOString()}`,
      totalMetrics: summary.totalMetrics,
      averageResponseTime: summary.averageResponseTime,
    });

    return report;
  }

  private getMetricsInRange(start: number, end: number): PerformanceMetric[] {
    const metrics: PerformanceMetric[] = [];

    for (const metricList of this.metrics.values()) {
      for (const metric of metricList) {
        if (metric.timestamp >= start && metric.timestamp <= end) {
          metrics.push(metric);
        }
      }
    }

    return metrics;
  }

  private calculateSummary(metrics: PerformanceMetric[]) {
    const responseTimeMetrics = metrics.filter(m => m.name.includes('duration'));
    const memoryMetrics = metrics.filter(m => m.name.includes('memory'));
    const errorMetrics = metrics.filter(m => m.tags['status'] === 'error');

    return {
      totalMetrics: metrics.length,
      averageResponseTime:
        responseTimeMetrics.length > 0
          ? responseTimeMetrics.reduce((sum, m) => sum + m.value, 0) / responseTimeMetrics.length
          : 0,
      peakMemoryUsage: memoryMetrics.length > 0 ? Math.max(...memoryMetrics.map(m => m.value)) : 0,
      totalCpuTime: metrics
        .filter(m => m.name.includes('cpu'))
        .reduce((sum, m) => sum + m.value, 0),
      errorRate: metrics.length > 0 ? (errorMetrics.length / metrics.length) * 100 : 0,
      throughput: responseTimeMetrics.length, // Simple throughput calculation
    };
  }

  private calculateTrends(metrics: PerformanceMetric[], start: number, end: number) {
    const bucketSize = 60 * 60 * 1000; // 1 hour buckets
    const buckets = new Map<
      number,
      {
        responseTime: number[];
        memoryUsage: number[];
        cpuUsage: number[];
        errorCount: number;
      }
    >();

    // Initialize buckets
    for (let time = start; time <= end; time += bucketSize) {
      buckets.set(time, {
        responseTime: [],
        memoryUsage: [],
        cpuUsage: [],
        errorCount: 0,
      });
    }

    // Fill buckets with metrics
    for (const metric of metrics) {
      const bucket = Math.floor(metric.timestamp / bucketSize) * bucketSize;
      const data = buckets.get(bucket);
      if (data) {
        if (metric.name.includes('duration')) {
          data.responseTime.push(metric.value);
        }
        if (metric.name.includes('memory')) {
          data.memoryUsage.push(metric.value);
        }
        if (metric.name.includes('cpu')) {
          data.cpuUsage.push(metric.value);
        }
        if (metric.tags['status'] === 'error') {
          data.errorCount++;
        }
      }
    }

    // Calculate averages
    return Array.from(buckets.entries()).map(([timestamp, data]) => ({
      timestamp,
      responseTime:
        data.responseTime.length > 0
          ? data.responseTime.reduce((sum, val) => sum + val, 0) / data.responseTime.length
          : 0,
      memoryUsage:
        data.memoryUsage.length > 0
          ? data.memoryUsage.reduce((sum, val) => sum + val, 0) / data.memoryUsage.length
          : 0,
      cpuUsage:
        data.cpuUsage.length > 0
          ? data.cpuUsage.reduce((sum, val) => sum + val, 0) / data.cpuUsage.length
          : 0,
      errorCount: data.errorCount,
    }));
  }

  private getAlerts(metrics: PerformanceMetric[]) {
    return metrics
      .filter(m => m.status !== 'normal')
      .map(m => ({
        metric: m.name,
        value: m.value,
        threshold: m.threshold || 0,
        severity: m.status as 'warning' | 'critical',
        timestamp: m.timestamp,
      }))
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 20); // Last 20 alerts
  }

  private generateRecommendations(summary: any, alerts: any[]): string[] {
    const recommendations: string[] = [];

    if (summary.averageResponseTime > 1000) {
      recommendations.push('Consider optimizing slow operations to improve response times.');
    }

    if (summary.peakMemoryUsage > 512 * 1024 * 1024) {
      recommendations.push(
        'Monitor memory usage and consider implementing memory optimization strategies.'
      );
    }

    if (summary.errorRate > 5) {
      recommendations.push(
        'High error rate detected. Review error logs and implement error handling improvements.'
      );
    }

    if (alerts.filter(a => a.severity === 'critical').length > 0) {
      recommendations.push('Critical performance issues detected. Immediate attention required.');
    }

    if (recommendations.length === 0) {
      recommendations.push('System performance is within acceptable parameters.');
    }

    return recommendations;
  }

  // Utility methods
  getMetrics(name?: string): PerformanceMetric[] {
    if (name) {
      return this.metrics.get(name) || [];
    }

    const allMetrics: PerformanceMetric[] = [];
    for (const metricList of this.metrics.values()) {
      allMetrics.push(...metricList);
    }
    return allMetrics;
  }

  getProfiles(): PerformanceProfile[] {
    return Array.from(this.profiles.values());
  }

  setThreshold(metricName: string, threshold: number): void {
    this.thresholds.set(metricName, threshold);
    this.logger.info(`Performance threshold updated: ${metricName}`, { threshold });
  }

  cleanup(olderThan: number = 24 * 60 * 60 * 1000): number {
    // 24 hours default
    const cutoff = Date.now() - olderThan;
    let removedCount = 0;

    for (const [name, metricList] of this.metrics) {
      const filteredMetrics = metricList.filter(m => m.timestamp >= cutoff);
      removedCount += metricList.length - filteredMetrics.length;
      this.metrics.set(name, filteredMetrics);
    }

    this.logger.info('Performance monitor cleanup completed', {
      removedMetrics: removedCount,
      remainingMetrics: this.getMetrics().length,
    });

    return removedCount;
  }
}

// Global instance for convenience
export const globalPerformanceMonitor = new PerformanceMonitor();
