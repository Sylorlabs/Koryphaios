// Runtime Application Self-Protection (RASP)
// Detects and prevents attacks in real-time through behavioral analysis

import { serverLog } from '../logger';
import EventEmitter from 'events';

export interface SecurityEvent {
  readonly type: 'anomaly' | 'intrusion' | 'policy_violation' | 'rate_limit';
  readonly severity: 'low' | 'medium' | 'high' | 'critical';
  readonly category: string;
  readonly description: string;
  readonly context: Record<string, unknown>;
  readonly timestamp: number;
}

export interface RASPConfig {
  readonly enabled: boolean;
  readonly autoBlock: boolean;
  readonly alertThreshold: 'low' | 'medium' | 'high';
  readonly maxEventsPerSecond: number;
  readonly anomalyWindowMs: number;
}

const DEFAULT_CONFIG: RASPConfig = {
  enabled: true,
  autoBlock: true,
  alertThreshold: 'medium',
  maxEventsPerSecond: 100,
  anomalyWindowMs: 60000, // 1 minute window
};

/**
 * Anomaly detector using statistical analysis
 */
class AnomalyDetector {
  private baselines = new Map<string, number[]>();
  private readonly windowSize: number;

  constructor(windowSize = 100) {
    this.windowSize = windowSize;
  }

  /**
   * Add observation and check if anomalous
   */
  observe(metric: string, value: number): { isAnomaly: boolean; zScore: number } {
    let values = this.baselines.get(metric);
    if (!values) {
      values = [];
      this.baselines.set(metric, values);
    }

    // Add value
    values.push(value);
    if (values.length > this.windowSize) {
      values.shift();
    }

    // Need minimum samples
    if (values.length < 10) {
      return { isAnomaly: false, zScore: 0 };
    }

    // Calculate mean and standard deviation
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
    const stdDev = Math.sqrt(variance);

    // Calculate z-score
    const zScore = stdDev === 0 ? 0 : Math.abs((value - mean) / stdDev);

    // Anomaly if z-score > 3 (99.7% confidence)
    return { isAnomaly: zScore > 3, zScore };
  }

  /**
   * Get baseline stats for a metric
   */
  getStats(metric: string): { mean: number; stdDev: number; count: number } | null {
    const values = this.baselines.get(metric);
    if (!values || values.length === 0) return null;

    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;

    return {
      mean,
      stdDev: Math.sqrt(variance),
      count: values.length,
    };
  }
}

/**
 * File access monitor for detecting suspicious patterns
 */
class FileAccessMonitor {
  private accessLog: Array<{ path: string; operation: string; timestamp: number }> = [];
  private readonly windowMs: number;

  constructor(windowMs = 60000) {
    this.windowMs = windowMs;
  }

  recordAccess(path: string, operation: 'read' | 'write' | 'delete' | 'execute'): void {
    this.accessLog.push({ path, operation, timestamp: Date.now() });
    this.cleanup();
  }

  /**
   * Detect suspicious file access patterns
   */
  detectAnomalies(): Array<{
    type: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    details: string;
  }> {
    const anomalies: Array<{
      type: string;
      severity: 'low' | 'medium' | 'high' | 'critical';
      details: string;
    }> = [];
    const now = Date.now();
    const recent = this.accessLog.filter((a) => now - a.timestamp < this.windowMs);

    // Check for rapid file access (possible scanning)
    if (recent.length > 1000) {
      anomalies.push({
        type: 'rapid_file_access',
        severity: 'high',
        details: `${recent.length} file operations in ${this.windowMs}ms`,
      });
    }

    // Check for system file access
    const systemFiles = recent.filter(
      (a) =>
        a.path.includes('/etc/') ||
        a.path.includes('/sys/') ||
        a.path.includes('/proc/') ||
        a.path.includes('.ssh/') ||
        a.path.includes('.gnupg/'),
    );

    if (systemFiles.length > 5) {
      anomalies.push({
        type: 'system_file_access',
        severity: 'critical',
        details: `Accessed ${systemFiles.length} system files: ${systemFiles
          .map((f) => f.path)
          .slice(0, 3)
          .join(', ')}...`,
      });
    }

    // Check for deletion patterns (possible ransomware)
    const deletions = recent.filter((a) => a.operation === 'delete');
    if (deletions.length > 50) {
      anomalies.push({
        type: 'mass_deletion',
        severity: 'critical',
        details: `${deletions.length} files deleted in ${this.windowMs}ms`,
      });
    }

    return anomalies;
  }

  private cleanup(): void {
    const cutoff = Date.now() - this.windowMs;
    this.accessLog = this.accessLog.filter((a) => a.timestamp > cutoff);
  }
}

/**
 * Network monitor for detecting suspicious connections
 */
class NetworkMonitor {
  private connections = new Map<string, number>();
  private blockedHosts = new Set<string>([
    '169.254.169.254', // AWS metadata
    'metadata.google.internal',
    'metadata.google',
  ]);

  recordConnection(host: string, port: number): { allowed: boolean; reason?: string } {
    // Check blocked hosts
    if (this.blockedHosts.has(host)) {
      return { allowed: false, reason: 'Blocked host (SSRF protection)' };
    }

    // Track connection frequency
    const key = `${host}:${port}`;
    const count = this.connections.get(key) || 0;
    this.connections.set(key, count + 1);

    // Detect connection flooding
    if (count > 100) {
      return { allowed: false, reason: 'Connection rate limit exceeded' };
    }

    return { allowed: true };
  }
}

/**
 * Main RASP engine
 */
export class RASPEngine extends EventEmitter {
  private config: RASPConfig;
  private anomalyDetector: AnomalyDetector;
  private fileMonitor: FileAccessMonitor;
  private networkMonitor: NetworkMonitor;
  private eventHistory: SecurityEvent[] = [];
  private blockedSessions = new Set<string>();
  private lockdownMode = false;
  private checkInterval?: NodeJS.Timeout;

  constructor(config: Partial<RASPConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.anomalyDetector = new AnomalyDetector();
    this.fileMonitor = new FileAccessMonitor(this.config.anomalyWindowMs);
    this.networkMonitor = new NetworkMonitor();

    if (this.config.enabled) {
      this.startMonitoring();
    }
  }

  /**
   * Start periodic monitoring
   */
  private startMonitoring(): void {
    this.checkInterval = setInterval(() => {
      this.runChecks();
    }, 5000); // Check every 5 seconds
  }

  /**
   * Run security checks
   */
  private runChecks(): void {
    if (this.lockdownMode) return;

    // Check file access patterns
    const fileAnomalies = this.fileMonitor.detectAnomalies();
    for (const anomaly of fileAnomalies) {
      this.emitEvent({
        type: 'anomaly',
        severity: anomaly.severity,
        category: 'file_access',
        description: anomaly.details,
        context: { anomalyType: anomaly.type },
        timestamp: Date.now(),
      });
    }

    // Check event rate
    const recentEvents = this.getRecentEvents(1000);
    if (recentEvents.length > this.config.maxEventsPerSecond) {
      this.emitEvent({
        type: 'rate_limit',
        severity: 'high',
        category: 'event_rate',
        description: `Event rate exceeded: ${recentEvents.length} events/sec`,
        context: { rate: recentEvents.length },
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Emit security event
   */
  private emitEvent(event: SecurityEvent): void {
    this.eventHistory.push(event);
    this.emit('security-event', event);

    // Log based on severity
    const logMethod =
      event.severity === 'critical' ? 'error' : event.severity === 'high' ? 'warn' : 'info';
    serverLog[logMethod](
      {
        type: event.type,
        severity: event.severity,
        category: event.category,
        description: event.description,
      },
      'RASP Security Event',
    );

    // Auto-block if enabled and severity meets threshold
    if (this.config.autoBlock && this.shouldBlock(event)) {
      this.triggerLockdown(event);
    }
  }

  /**
   * Determine if event should trigger blocking
   */
  private shouldBlock(event: SecurityEvent): boolean {
    const thresholds = { low: 1, medium: 2, high: 3, critical: 4 };
    const eventLevel = thresholds[event.severity];
    const thresholdLevel = thresholds[this.config.alertThreshold];

    return eventLevel >= thresholdLevel;
  }

  /**
   * Trigger lockdown mode
   */
  private triggerLockdown(cause: SecurityEvent): void {
    if (this.lockdownMode) return;

    this.lockdownMode = true;
    serverLog.fatal(
      {
        cause: cause.description,
        severity: cause.severity,
      },
      'RASP LOCKDOWN TRIGGERED',
    );

    this.emit('lockdown', cause);

    // Notify all listeners to halt operations
    this.emit('security-halt', {
      reason: 'Automatic lockdown due to security event',
      event: cause,
    });
  }

  /**
   * Check if operation is allowed
   */
  isOperationAllowed(sessionId?: string): { allowed: boolean; reason?: string } {
    if (this.lockdownMode) {
      return { allowed: false, reason: 'System in lockdown mode' };
    }

    if (sessionId && this.blockedSessions.has(sessionId)) {
      return { allowed: false, reason: 'Session blocked due to security violation' };
    }

    return { allowed: true };
  }

  /**
   * Record file access for analysis
   */
  recordFileAccess(
    path: string,
    operation: 'read' | 'write' | 'delete' | 'execute',
    sessionId?: string,
  ): void {
    if (!this.config.enabled) return;

    this.fileMonitor.recordAccess(path, operation);

    // Check for immediate violations
    if (path.includes('/etc/passwd') || path.includes('/etc/shadow')) {
      this.emitEvent({
        type: 'policy_violation',
        severity: 'critical',
        category: 'file_access',
        description: `Attempted access to sensitive system file: ${path}`,
        context: { path, operation, sessionId },
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Record network connection attempt
   */
  recordConnection(
    host: string,
    port: number,
    sessionId?: string,
  ): { allowed: boolean; reason?: string } {
    if (!this.config.enabled) return { allowed: true };

    const result = this.networkMonitor.recordConnection(host, port);

    if (!result.allowed) {
      this.emitEvent({
        type: 'policy_violation',
        severity: 'high',
        category: 'network',
        description: `Blocked connection to ${host}:${port}: ${result.reason}`,
        context: { host, port, sessionId },
        timestamp: Date.now(),
      });
    }

    return result;
  }

  /**
   * Record tool execution
   */
  recordToolExecution(toolName: string, args: unknown, sessionId?: string): void {
    if (!this.config.enabled) return;

    // Detect dangerous tool combinations
    const dangerousPatterns = [
      { tool: 'bash', pattern: /rm\s+-rf\s*\//, desc: 'Attempted root deletion' },
      { tool: 'bash', pattern: /curl.*\|\s*bash/, desc: 'Pipe from curl to bash' },
      { tool: 'write_file', pattern: /\/etc\//, desc: 'Write to system directory' },
    ];

    for (const pattern of dangerousPatterns) {
      if (toolName === pattern.tool) {
        const argsStr = JSON.stringify(args);
        if (pattern.pattern.test(argsStr)) {
          this.emitEvent({
            type: 'policy_violation',
            severity: 'critical',
            category: 'tool_execution',
            description: `Dangerous pattern detected: ${pattern.desc}`,
            context: { tool: toolName, sessionId },
            timestamp: Date.now(),
          });
        }
      }
    }
  }

  /**
   * Block a session
   */
  blockSession(sessionId: string, reason: string): void {
    this.blockedSessions.add(sessionId);
    this.emitEvent({
      type: 'policy_violation',
      severity: 'high',
      category: 'session',
      description: `Session blocked: ${reason}`,
      context: { sessionId, reason },
      timestamp: Date.now(),
    });
  }

  /**
   * Get recent events
   */
  getRecentEvents(windowMs: number): SecurityEvent[] {
    const cutoff = Date.now() - windowMs;
    return this.eventHistory.filter((e) => e.timestamp > cutoff);
  }

  /**
   * Get security status
   */
  getStatus(): {
    enabled: boolean;
    lockdownMode: boolean;
    blockedSessions: number;
    recentEvents: number;
    anomalies: ReturnType<FileAccessMonitor['detectAnomalies']>;
  } {
    return {
      enabled: this.config.enabled,
      lockdownMode: this.lockdownMode,
      blockedSessions: this.blockedSessions.size,
      recentEvents: this.getRecentEvents(60000).length,
      anomalies: this.fileMonitor.detectAnomalies(),
    };
  }

  /**
   * Disable lockdown (manual override)
   */
  disableLockdown(adminToken: string): boolean {
    // In real implementation, verify admin token
    this.lockdownMode = false;
    serverLog.warn('Lockdown manually disabled');
    this.emit('lockdown-disabled');
    return true;
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }
  }
}

// Export singleton instance
export const raspEngine = new RASPEngine();
