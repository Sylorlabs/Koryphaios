/**
 * Enhanced error tracking and reporting system
 */

import { Logger } from './logger.js';

export interface ErrorCategory {
  id: string;
  name: string;
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  patterns: string[];
}

export interface TrackedError {
  id: string;
  timestamp: number;
  message: string;
  stack?: string | undefined;
  category: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  source: string;
  file?: string | undefined;
  line?: number | undefined;
  column?: number | undefined;
  context: Record<string, unknown>;
  resolved: boolean;
  resolutionTime?: number | undefined;
  resolutionMethod?: string | undefined;
  occurrenceCount: number;
  firstOccurrence: number;
  lastOccurrence: number;
  relatedErrors: string[];
  tags: string[];
}

export interface ErrorReport {
  id: string;
  timestamp: number;
  period: {
    start: number;
    end: number;
  };
  summary: {
    totalErrors: number;
    resolvedErrors: number;
    unresolvedErrors: number;
    criticalErrors: number;
    highSeverityErrors: number;
    mediumSeverityErrors: number;
    lowSeverityErrors: number;
  };
  categories: Array<{
    category: string;
    count: number;
    percentage: number;
  }>;
  trends: Array<{
    timestamp: number;
    errorCount: number;
    resolvedCount: number;
  }>;
  topErrors: TrackedError[];
  recommendations: string[];
}

export class ErrorTracker {
  private errors: Map<string, TrackedError> = new Map();
  private categories: Map<string, ErrorCategory> = new Map();
  private logger: Logger;
  private errorCounter = 0;

  constructor(logger?: Logger) {
    this.logger = logger || new Logger('info', { logFile: undefined });
    this.initializeDefaultCategories();
  }

  private initializeDefaultCategories(): void {
    const defaultCategories: ErrorCategory[] = [
      {
        id: 'syntax',
        name: 'Syntax Errors',
        description: 'Code syntax and parsing errors',
        severity: 'high',
        patterns: ['SyntaxError', 'Unexpected token', 'Parse error'],
      },
      {
        id: 'type',
        name: 'Type Errors',
        description: 'Type-related errors and mismatches',
        severity: 'medium',
        patterns: ['TypeError', 'Type.*not assignable', 'Property.*does not exist'],
      },
      {
        id: 'reference',
        name: 'Reference Errors',
        description: 'Undefined variables and references',
        severity: 'high',
        patterns: ['ReferenceError', 'is not defined', 'Cannot read property'],
      },
      {
        id: 'runtime',
        name: 'Runtime Errors',
        description: 'Runtime execution errors',
        severity: 'critical',
        patterns: [
          'RuntimeError',
          'Cannot read properties of null',
          'Cannot read properties of undefined',
        ],
      },
      {
        id: 'network',
        name: 'Network Errors',
        description: 'Network and connectivity issues',
        severity: 'medium',
        patterns: ['NetworkError', 'fetch failed', 'ECONNREFUSED', 'timeout'],
      },
      {
        id: 'security',
        name: 'Security Errors',
        description: 'Security-related issues and vulnerabilities',
        severity: 'critical',
        patterns: ['SecurityError', 'CORS', 'CSP violation', 'XSS'],
      },
      {
        id: 'performance',
        name: 'Performance Issues',
        description: 'Performance-related problems',
        severity: 'medium',
        patterns: ['Memory leak', 'Performance warning', 'Slow query', 'timeout'],
      },
      {
        id: 'dependency',
        name: 'Dependency Errors',
        description: 'Module and dependency issues',
        severity: 'high',
        patterns: ['Module not found', 'Cannot resolve', 'Dependency error'],
      },
    ];

    for (const category of defaultCategories) {
      this.categories.set(category.id, category);
    }

    this.logger.info('Error tracker initialized with default categories', {
      categoriesCount: defaultCategories.length,
      categories: defaultCategories.map(c => c.id),
    });
  }

  // Error tracking
  trackError(
    message: string,
    source: string,
    context: Record<string, unknown> = {},
    stack?: string,
    file?: string,
    line?: number,
    column?: number
  ): string {
    const errorId = `err_${++this.errorCounter}_${Date.now()}`;
    const timestamp = Date.now();
    const category = this.categorizeError(message, stack);
    const severity = this.categories.get(category)?.severity || 'medium';

    // Check for existing similar error
    const existingError = this.findSimilarError(message, source, file, line);

    if (existingError) {
      // Update existing error
      existingError.occurrenceCount++;
      existingError.lastOccurrence = timestamp;
      existingError.context = { ...existingError.context, ...context };

      this.logger.debug('Updated existing error occurrence', {
        errorId: existingError.id,
        occurrenceCount: existingError.occurrenceCount,
        message: message.substring(0, 100),
      });

      return existingError.id;
    }

    // Create new tracked error
    const trackedError: TrackedError = {
      id: errorId,
      timestamp,
      message,
      stack,
      category,
      severity,
      source,
      file,
      line,
      column,
      context,
      resolved: false,
      occurrenceCount: 1,
      firstOccurrence: timestamp,
      lastOccurrence: timestamp,
      relatedErrors: [],
      tags: this.generateTags(message, source, context),
    };

    this.errors.set(errorId, trackedError);

    this.logger.error('Error tracked', {
      errorId,
      category,
      severity,
      source,
      message: message.substring(0, 100),
      file,
      line,
      tags: trackedError.tags,
    });

    // Find and link related errors
    this.linkRelatedErrors(errorId);

    return errorId;
  }

  private categorizeError(message: string, stack?: string): string {
    const text = `${message} ${stack || ''}`.toLowerCase();

    for (const [categoryId, category] of this.categories) {
      for (const pattern of category.patterns) {
        const regex = new RegExp(pattern.toLowerCase(), 'i');
        if (regex.test(text)) {
          return categoryId;
        }
      }
    }

    return 'unknown';
  }

  private findSimilarError(
    message: string,
    source: string,
    file?: string,
    line?: number
  ): TrackedError | undefined {
    for (const error of this.errors.values()) {
      if (
        error.message === message &&
        error.source === source &&
        error.file === file &&
        error.line === line &&
        !error.resolved
      ) {
        return error;
      }
    }
    return undefined;
  }

  private generateTags(
    message: string,
    source: string,
    context: Record<string, unknown>
  ): string[] {
    const tags: string[] = [source];

    // Add language tags
    if (message.includes('TypeScript') || context['language'] === 'typescript') {
      tags.push('typescript');
    }
    if (message.includes('JavaScript') || context['language'] === 'javascript') {
      tags.push('javascript');
    }
    if (message.includes('Python') || context['language'] === 'python') {
      tags.push('python');
    }

    // Add severity tags
    if (message.toLowerCase().includes('critical') || message.toLowerCase().includes('fatal')) {
      tags.push('critical');
    }
    if (message.toLowerCase().includes('warning')) {
      tags.push('warning');
    }

    // Add context tags
    if (context['component']) {
      tags.push(`component:${context['component']}`);
    }
    if (context['module']) {
      tags.push(`module:${context['module']}`);
    }

    return tags;
  }

  private linkRelatedErrors(errorId: string): void {
    const currentError = this.errors.get(errorId);
    if (!currentError) return;

    for (const [otherId, otherError] of this.errors) {
      if (otherId === errorId) continue;

      // Link errors with similar messages or same file
      if (
        currentError.message.includes(otherError.message.substring(0, 50)) ||
        otherError.message.includes(currentError.message.substring(0, 50)) ||
        (currentError.file && currentError.file === otherError.file)
      ) {
        if (!currentError.relatedErrors.includes(otherId)) {
          currentError.relatedErrors.push(otherId);
        }
        if (!otherError.relatedErrors.includes(errorId)) {
          otherError.relatedErrors.push(errorId);
        }
      }
    }
  }

  // Error resolution
  resolveError(errorId: string, method: string): boolean {
    const error = this.errors.get(errorId);
    if (!error) {
      this.logger.warn(`Error ${errorId} not found for resolution`);
      return false;
    }

    error.resolved = true;
    error.resolutionTime = Date.now();
    error.resolutionMethod = method;

    this.logger.info('Error resolved', {
      errorId,
      method,
      resolutionTime: error.resolutionTime - error.firstOccurrence,
      occurrenceCount: error.occurrenceCount,
    });

    return true;
  }

  // Reporting
  generateReport(startTime?: number, endTime?: number): ErrorReport {
    const now = Date.now();
    const start = startTime || now - 24 * 60 * 60 * 1000; // Last 24 hours
    const end = endTime || now;

    const relevantErrors = Array.from(this.errors.values()).filter(
      error => error.timestamp >= start && error.timestamp <= end
    );

    const summary = this.calculateSummary(relevantErrors);
    const categories = this.calculateCategoryBreakdown(relevantErrors);
    const trends = this.calculateTrends(relevantErrors, start, end);
    const topErrors = this.getTopErrors(relevantErrors);
    const recommendations = this.generateRecommendations(relevantErrors);

    const report: ErrorReport = {
      id: `report_${Date.now()}`,
      timestamp: now,
      period: { start, end },
      summary,
      categories,
      trends,
      topErrors,
      recommendations,
    };

    this.logger.info('Error report generated', {
      reportId: report.id,
      period: `${new Date(start).toISOString()} - ${new Date(end).toISOString()}`,
      totalErrors: summary.totalErrors,
      unresolvedErrors: summary.unresolvedErrors,
    });

    return report;
  }

  private calculateSummary(errors: TrackedError[]) {
    return {
      totalErrors: errors.length,
      resolvedErrors: errors.filter(e => e.resolved).length,
      unresolvedErrors: errors.filter(e => !e.resolved).length,
      criticalErrors: errors.filter(e => e.severity === 'critical').length,
      highSeverityErrors: errors.filter(e => e.severity === 'high').length,
      mediumSeverityErrors: errors.filter(e => e.severity === 'medium').length,
      lowSeverityErrors: errors.filter(e => e.severity === 'low').length,
    };
  }

  private calculateCategoryBreakdown(errors: TrackedError[]) {
    const categoryCount = new Map<string, number>();

    for (const error of errors) {
      categoryCount.set(error.category, (categoryCount.get(error.category) || 0) + 1);
    }

    return Array.from(categoryCount.entries())
      .map(([category, count]) => ({
        category,
        count,
        percentage: errors.length > 0 ? (count / errors.length) * 100 : 0,
      }))
      .sort((a, b) => b.count - a.count);
  }

  private calculateTrends(errors: TrackedError[], start: number, end: number) {
    const hourlyBuckets = new Map<number, { errorCount: number; resolvedCount: number }>();
    const bucketSize = 60 * 60 * 1000; // 1 hour

    for (let time = start; time <= end; time += bucketSize) {
      hourlyBuckets.set(time, { errorCount: 0, resolvedCount: 0 });
    }

    for (const error of errors) {
      const bucket = Math.floor(error.timestamp / bucketSize) * bucketSize;
      const data = hourlyBuckets.get(bucket);
      if (data) {
        data.errorCount++;
        if (error.resolved) {
          data.resolvedCount++;
        }
      }
    }

    return Array.from(hourlyBuckets.entries()).map(([timestamp, data]) => ({
      timestamp,
      ...data,
    }));
  }

  private getTopErrors(errors: TrackedError[]): TrackedError[] {
    return errors
      .filter(e => !e.resolved)
      .sort((a, b) => {
        // Sort by severity first, then by occurrence count
        const severityOrder = { critical: 4, high: 3, medium: 2, low: 1 };
        const severityDiff = severityOrder[b.severity] - severityOrder[a.severity];
        if (severityDiff !== 0) return severityDiff;
        return b.occurrenceCount - a.occurrenceCount;
      })
      .slice(0, 10);
  }

  private generateRecommendations(errors: TrackedError[]): string[] {
    const recommendations: string[] = [];
    const unresolvedErrors = errors.filter(e => !e.resolved);

    if (unresolvedErrors.length === 0) {
      recommendations.push('Great job! No unresolved errors in this period.');
      return recommendations;
    }

    // Critical errors recommendation
    const criticalErrors = unresolvedErrors.filter(e => e.severity === 'critical');
    if (criticalErrors.length > 0) {
      recommendations.push(
        `Address ${criticalErrors.length} critical errors immediately to prevent system instability.`
      );
    }

    // Frequent errors recommendation
    const frequentErrors = unresolvedErrors.filter(e => e.occurrenceCount > 5);
    if (frequentErrors.length > 0) {
      recommendations.push(
        `Focus on ${frequentErrors.length} frequently occurring errors to reduce overall error volume.`
      );
    }

    // Category-specific recommendations
    const categoryBreakdown = this.calculateCategoryBreakdown(unresolvedErrors);
    const topCategory = categoryBreakdown[0];
    if (topCategory && topCategory.count > 0) {
      const category = this.categories.get(topCategory.category);
      if (category) {
        recommendations.push(
          `${topCategory.category} errors account for ${topCategory.percentage.toFixed(1)}% of issues. Consider reviewing ${category.description.toLowerCase()}.`
        );
      }
    }

    return recommendations;
  }

  // Utility methods
  getError(errorId: string): TrackedError | undefined {
    return this.errors.get(errorId);
  }

  getAllErrors(): TrackedError[] {
    return Array.from(this.errors.values());
  }

  getUnresolvedErrors(): TrackedError[] {
    return Array.from(this.errors.values()).filter(e => !e.resolved);
  }

  getErrorsByCategory(category: string): TrackedError[] {
    return Array.from(this.errors.values()).filter(e => e.category === category);
  }

  addCategory(category: ErrorCategory): void {
    this.categories.set(category.id, category);
    this.logger.info('Error category added', { categoryId: category.id, name: category.name });
  }

  getCategories(): ErrorCategory[] {
    return Array.from(this.categories.values());
  }

  cleanup(olderThan: number = 30 * 24 * 60 * 60 * 1000): number {
    // 30 days default
    const cutoff = Date.now() - olderThan;
    let removedCount = 0;

    for (const [errorId, error] of this.errors) {
      if (error.resolved && error.resolutionTime && error.resolutionTime < cutoff) {
        this.errors.delete(errorId);
        removedCount++;
      }
    }

    this.logger.info('Error tracker cleanup completed', {
      removedCount,
      remainingErrors: this.errors.size,
    });

    return removedCount;
  }
}

// Global instance for convenience
export const globalErrorTracker = new ErrorTracker();
