/**
 * Prometheus Metrics
 * 
 * Exposes metrics for monitoring:
 * - HTTP request duration and count
 * - Rate limiting events
 * - Authentication attempts
 * - Credential operations
 * - API key usage
 */

import { serverLog } from '../logger';

// Metric types
interface Counter {
  name: string;
  help: string;
  labels: string[];
  values: Map<string, number>;
}

interface Gauge {
  name: string;
  help: string;
  labels: string[];
  values: Map<string, number>;
}

interface Histogram {
  name: string;
  help: string;
  labels: string[];
  buckets: number[];
  values: Map<string, number[]>;
}

class MetricsRegistry {
  private counters: Map<string, Counter> = new Map();
  private gauges: Map<string, Gauge> = new Map();
  private histograms: Map<string, Histogram> = new Map();
  private startTime: number = Date.now();

  constructor() {
    this.registerDefaultMetrics();
  }

  private registerDefaultMetrics() {
    // HTTP metrics
    this.registerCounter('http_requests_total', 'Total HTTP requests', ['method', 'route', 'status']);
    this.registerHistogram('http_request_duration_seconds', 'HTTP request duration', ['method', 'route'], [0.01, 0.05, 0.1, 0.5, 1, 2, 5]);
    
    // Auth metrics
    this.registerCounter('auth_attempts_total', 'Authentication attempts', ['method', 'result']);
    this.registerCounter('api_key_validations_total', 'API key validations', ['result']);
    
    // Rate limiting metrics
    this.registerCounter('rate_limit_hits_total', 'Rate limit hits', ['tier', 'algorithm']);
    this.registerCounter('rate_limit_allowed_total', 'Requests allowed by rate limiter', ['tier']);
    
    // Credential metrics
    this.registerCounter('credential_operations_total', 'Credential operations', ['operation', 'result']);
    this.registerGauge('credentials_stored', 'Total credentials stored', ['provider']);
    
    // Audit metrics
    this.registerCounter('audit_events_total', 'Audit events logged', ['action', 'resource_type']);
  }

  // Counter methods
  registerCounter(name: string, help: string, labels: string[] = []) {
    this.counters.set(name, { name, help, labels, values: new Map() });
  }

  incCounter(name: string, labels: Record<string, string> = {}, value: number = 1) {
    const counter = this.counters.get(name);
    if (!counter) {
      serverLog.warn({ name }, 'Counter not found');
      return;
    }

    const labelKey = this.formatLabels(labels, counter.labels);
    const current = counter.values.get(labelKey) || 0;
    counter.values.set(labelKey, current + value);
  }

  // Gauge methods
  registerGauge(name: string, help: string, labels: string[] = []) {
    this.gauges.set(name, { name, help, labels, values: new Map() });
  }

  setGauge(name: string, labels: Record<string, string> = {}, value: number) {
    const gauge = this.gauges.get(name);
    if (!gauge) {
      serverLog.warn({ name }, 'Gauge not found');
      return;
    }

    const labelKey = this.formatLabels(labels, gauge.labels);
    gauge.values.set(labelKey, value);
  }

  incGauge(name: string, labels: Record<string, string> = {}, value: number = 1) {
    const gauge = this.gauges.get(name);
    if (!gauge) {
      serverLog.warn({ name }, 'Gauge not found');
      return;
    }

    const labelKey = this.formatLabels(labels, gauge.labels);
    const current = gauge.values.get(labelKey) || 0;
    gauge.values.set(labelKey, current + value);
  }

  decGauge(name: string, labels: Record<string, string> = {}, value: number = 1) {
    this.incGauge(name, labels, -value);
  }

  // Histogram methods
  registerHistogram(name: string, help: string, labels: string[] = [], buckets: number[] = [0.1, 0.5, 1, 2, 5]) {
    this.histograms.set(name, { name, help, labels, buckets, values: new Map() });
  }

  observeHistogram(name: string, labels: Record<string, string> = {}, value: number) {
    const histogram = this.histograms.get(name);
    if (!histogram) {
      serverLog.warn({ name }, 'Histogram not found');
      return;
    }

    const labelKey = this.formatLabels(labels, histogram.labels);
    const values = histogram.values.get(labelKey) || [];
    values.push(value);
    histogram.values.set(labelKey, values);
  }

  // Format labels for storage key
  private formatLabels(labels: Record<string, string>, expectedLabels: string[]): string {
    const parts = expectedLabels.map(label => `${label}="${labels[label] || ''}"`);
    return parts.join(',');
  }

  // Generate Prometheus exposition format
  generateMetrics(): string {
    const lines: string[] = [];
    
    // Process info
    lines.push(`# HELP process_uptime_seconds Process uptime in seconds`);
    lines.push(`# TYPE process_uptime_seconds gauge`);
    lines.push(`process_uptime_seconds ${(Date.now() - this.startTime) / 1000}`);
    lines.push('');

    // Counters
    for (const counter of this.counters.values()) {
      lines.push(`# HELP ${counter.name} ${counter.help}`);
      lines.push(`# TYPE ${counter.name} counter`);
      
      if (counter.values.size === 0) {
        lines.push(`${counter.name} 0`);
      } else {
        for (const [labels, value] of counter.values) {
          if (labels) {
            lines.push(`${counter.name}{${labels}} ${value}`);
          } else {
            lines.push(`${counter.name} ${value}`);
          }
        }
      }
      lines.push('');
    }

    // Gauges
    for (const gauge of this.gauges.values()) {
      lines.push(`# HELP ${gauge.name} ${gauge.help}`);
      lines.push(`# TYPE ${gauge.name} gauge`);
      
      if (gauge.values.size === 0) {
        lines.push(`${gauge.name} 0`);
      } else {
        for (const [labels, value] of gauge.values) {
          if (labels) {
            lines.push(`${gauge.name}{${labels}} ${value}`);
          } else {
            lines.push(`${gauge.name} ${value}`);
          }
        }
      }
      lines.push('');
    }

    // Histograms
    for (const histogram of this.histograms.values()) {
      lines.push(`# HELP ${histogram.name} ${histogram.help}`);
      lines.push(`# TYPE ${histogram.name} histogram`);
      
      for (const [labelKey, values] of histogram.values) {
        const labelPrefix = labelKey ? `{${labelKey}}` : '';
        
        // Calculate buckets
        for (const bucket of histogram.buckets) {
          const count = values.filter(v => v <= bucket).length;
          lines.push(`${histogram.name}_bucket{le="${bucket}"${labelKey ? ',' + labelKey : ''}} ${count}`);
        }
        
        // +Inf bucket
        lines.push(`${histogram.name}_bucket{le="+Inf"${labelKey ? ',' + labelKey : ''}} ${values.length}`);
        
        // Sum
        const sum = values.reduce((a, b) => a + b, 0);
        lines.push(`${histogram.name}_sum${labelPrefix} ${sum}`);
        
        // Count
        lines.push(`${histogram.name}_count${labelPrefix} ${values.length}`);
      }
      
      if (histogram.values.size === 0) {
        for (const bucket of histogram.buckets) {
          lines.push(`${histogram.name}_bucket{le="${bucket}"} 0`);
        }
        lines.push(`${histogram.name}_bucket{le="+Inf"} 0`);
        lines.push(`${histogram.name}_sum 0`);
        lines.push(`${histogram.name}_count 0`);
      }
      
      lines.push('');
    }

    return lines.join('\n');
  }

  // HTTP handler for metrics endpoint
  handleMetrics(): Response {
    const metrics = this.generateMetrics();
    return new Response(metrics, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; version=0.0.4',
      },
    });
  }
}

// Singleton instance
let registry: MetricsRegistry | null = null;

export function getMetricsRegistry(): MetricsRegistry {
  if (!registry) {
    registry = new MetricsRegistry();
  }
  return registry;
}

// Convenience exports
export function incCounter(name: string, labels?: Record<string, string>, value?: number) {
  getMetricsRegistry().incCounter(name, labels, value);
}

export function setGauge(name: string, labels?: Record<string, string>, value: number = 0) {
  getMetricsRegistry().setGauge(name, labels, value);
}

export function incGauge(name: string, labels?: Record<string, string>, value?: number) {
  getMetricsRegistry().incGauge(name, labels, value);
}

export function observeHistogram(name: string, labels?: Record<string, string>, value: number = 0) {
  getMetricsRegistry().observeHistogram(name, labels, value);
}

// Middleware for HTTP metrics
export function httpMetricsMiddleware() {
  const registry = getMetricsRegistry();
  
  return async (req: Request, next: () => Promise<Response>): Promise<Response> => {
    const start = Date.now();
    const url = new URL(req.url);
    const method = req.method;
    const route = url.pathname;
    
    try {
      const response = await next();
      const duration = (Date.now() - start) / 1000;
      const status = response.status.toString();
      
      // Record metrics
      registry.incCounter('http_requests_total', { method, route, status });
      registry.observeHistogram('http_request_duration_seconds', { method, route }, duration);
      
      return response;
    } catch (error) {
      const duration = (Date.now() - start) / 1000;
      registry.incCounter('http_requests_total', { method, route, status: '500' });
      registry.observeHistogram('http_request_duration_seconds', { method, route }, duration);
      throw error;
    }
  };
}

// Auth metrics helpers
export function recordAuthAttempt(method: string, success: boolean) {
  const result = success ? 'success' : 'failure';
  incCounter('auth_attempts_total', { method, result }, 1);
}

export function recordApiKeyValidation(success: boolean) {
  const result = success ? 'success' : 'failure';
  incCounter('api_key_validations_total', { result });
}

// Rate limit metrics helpers
export function recordRateLimitHit(tier: string, algorithm: string) {
  incCounter('rate_limit_hits_total', { tier, algorithm });
}

export function recordRateLimitAllowed(tier: string) {
  incCounter('rate_limit_allowed_total', { tier });
}

// Credential metrics helpers
export function recordCredentialOperation(operation: string, success: boolean) {
  const result = success ? 'success' : 'failure';
  incCounter('credential_operations_total', { operation, result });
}

export function updateCredentialsStored(provider: string, count: number) {
  setGauge('credentials_stored', { provider }, count);
}

// Audit metrics helpers
export function recordAuditEvent(action: string, resourceType?: string) {
  incCounter('audit_events_total', { 
    action, 
    resource_type: resourceType || 'unknown' 
  });
}
