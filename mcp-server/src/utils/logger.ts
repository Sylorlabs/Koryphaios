/**
 * Logging utility with structured logging support
 */

import { writeFile, appendFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { existsSync } from 'fs';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  data?: unknown;
  source: string | undefined;
  sessionId?: string;
}

export class Logger {
  private level: LogLevel;
  private logFile: string | undefined;
  private enableConsole: boolean;
  private enableFile: boolean;

  constructor(
    level: LogLevel = 'info',
    options: {
      logFile: string | undefined;
      enableConsole?: boolean;
      enableFile?: boolean;
    } = { logFile: undefined }
  ) {
    this.level = level;
    this.logFile = options.logFile;
    this.enableConsole = options.enableConsole ?? true;
    this.enableFile = options.enableFile ?? false;

    if (this.enableFile && this.logFile) {
      this.ensureLogDirectory().catch(error => {
        console.error('Failed to create log directory:', error);
        this.enableFile = false; // Disable file logging if directory creation fails
      });
    }
  }

  debug(message: string, data?: unknown, source?: string): void {
    this.log('debug', message, data, source);
  }

  info(message: string, data?: unknown, source?: string): void {
    this.log('info', message, data, source);
  }

  warn(message: string, data?: unknown, source?: string): void {
    this.log('warn', message, data, source);
  }

  error(message: string, data?: unknown, source?: string): void {
    this.log('error', message, data, source);
  }

  private log(level: LogLevel, message: string, data?: unknown, source?: string): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      data,
      source,
    };

    if (this.enableConsole) {
      this.logToConsole(entry);
    }

    if (this.enableFile && this.logFile) {
      this.logToFile(entry).catch(error => {
        console.error('Failed to write to log file:', error);
      });
    }
  }

  private shouldLog(level: LogLevel): boolean {
    const levels: Record<LogLevel, number> = {
      debug: 0,
      info: 1,
      warn: 2,
      error: 3,
    };

    return levels[level] >= levels[this.level];
  }

  private logToConsole(entry: LogEntry): void {
    const timestamp = entry.timestamp;
    const level = entry.level.toUpperCase().padEnd(5);
    const source = entry.source ? `[${entry.source}]` : '';
    const message = entry.message;
    const data = entry.data ? ` ${JSON.stringify(entry.data)}` : '';

    const logMessage = `${timestamp} ${level} ${source} ${message}${data}`;

    // For MCP servers using stdio transport, all logging must go to stderr
    // to avoid interfering with the MCP protocol on stdout
    switch (entry.level) {
      case 'debug':
        process.stderr.write(logMessage + '\n');
        break;
      case 'info':
        process.stderr.write(logMessage + '\n');
        break;
      case 'warn':
        process.stderr.write(logMessage + '\n');
        break;
      case 'error':
        process.stderr.write(logMessage + '\n');
        break;
    }
  }

  private async logToFile(entry: LogEntry): Promise<void> {
    if (!this.logFile) {
      return;
    }

    const logLine = JSON.stringify(entry) + '\n';

    try {
      await appendFile(this.logFile, logLine, 'utf-8');
    } catch (error) {
      // If append fails, try to create the file
      await writeFile(this.logFile, logLine, 'utf-8');
    }
  }

  private async ensureLogDirectory(): Promise<void> {
    if (!this.logFile) {
      return;
    }

    const logDir = dirname(this.logFile);

    if (!existsSync(logDir)) {
      await mkdir(logDir, { recursive: true });
    }
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  setLogFile(logFile: string): void {
    this.logFile = logFile;
    this.enableFile = true;
    this.ensureLogDirectory().catch(error => {
      console.error('Failed to create log directory:', error);
      this.enableFile = false; // Disable file logging if directory creation fails
    });
  }

  enableFileLogging(enable: boolean): void {
    this.enableFile = enable;
  }

  enableConsoleLogging(enable: boolean): void {
    this.enableConsole = enable;
  }

  // Create a child logger with a specific source
  child(source: string): Logger {
    const childLogger = new Logger(this.level, {
      logFile: this.logFile,
      enableConsole: this.enableConsole,
      enableFile: this.enableFile,
    });

    // Override log method to include source
    const originalLog = childLogger.log.bind(childLogger);
    childLogger.log = (level: LogLevel, message: string, data?: unknown, childSource?: string) => {
      originalLog(level, message, data, childSource || source);
    };

    return childLogger;
  }

  // Create structured log entries for specific events
  logError(error: Error, context?: Record<string, unknown>): void {
    this.error('Error occurred', {
      name: error.name,
      message: error.message,
      stack: error.stack,
      context,
    });
  }

  logPerformance(operation: string, duration: number, metadata?: Record<string, unknown>): void {
    this.info('Performance metric', {
      operation,
      duration,
      metadata,
    });
  }

  logDebugSession(sessionId: string, event: string, data?: unknown): void {
    this.debug(
      'Debug session event',
      {
        sessionId,
        event,
        data,
      },
      'debug-session'
    );
  }

  logErrorDetection(errorId: string, details: unknown): void {
    this.info(
      'Error detected',
      {
        errorId,
        details,
      },
      'error-detection'
    );
  }

  logConfigChange(section: string, oldValue: unknown, newValue: unknown): void {
    this.info(
      'Configuration changed',
      {
        section,
        oldValue,
        newValue,
      },
      'config'
    );
  }

  // Enhanced debugging methods
  logMethodEntry(className: string, methodName: string, args?: Record<string, unknown>): void {
    this.debug(
      `Entering ${className}.${methodName}`,
      {
        className,
        methodName,
        args,
        timestamp: Date.now(),
      },
      'method-trace'
    );
  }

  logMethodExit(className: string, methodName: string, result?: unknown, duration?: number): void {
    this.debug(
      `Exiting ${className}.${methodName}`,
      {
        className,
        methodName,
        result: result ? 'returned' : 'void',
        duration,
        timestamp: Date.now(),
      },
      'method-trace'
    );
  }

  logStateChange(
    component: string,
    oldState: unknown,
    newState: unknown,
    context?: Record<string, unknown>
  ): void {
    this.debug(
      'State change',
      {
        component,
        oldState,
        newState,
        context,
        timestamp: Date.now(),
      },
      'state-change'
    );
  }

  logAsyncOperation(
    operation: string,
    phase: 'start' | 'complete' | 'error',
    data?: unknown
  ): void {
    this.debug(
      `Async operation ${phase}: ${operation}`,
      {
        operation,
        phase,
        data,
        timestamp: Date.now(),
      },
      'async-ops'
    );
  }

  logMemoryUsage(component: string, context?: string): void {
    const memUsage = process.memoryUsage();
    this.debug(
      'Memory usage snapshot',
      {
        component,
        context,
        memory: {
          rss: `${Math.round(memUsage.rss / 1024 / 1024)}MB`,
          heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`,
          heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
          external: `${Math.round(memUsage.external / 1024 / 1024)}MB`,
        },
        timestamp: Date.now(),
      },
      'memory-usage'
    );
  }

  logNetworkRequest(method: string, url: string, status?: number, duration?: number): void {
    this.debug(
      'Network request',
      {
        method,
        url,
        status,
        duration,
        timestamp: Date.now(),
      },
      'network'
    );
  }

  logFileOperation(operation: string, path: string, success: boolean, error?: Error): void {
    this.debug(
      `File operation: ${operation}`,
      {
        operation,
        path,
        success,
        error: error
          ? {
              name: error.name,
              message: error.message,
            }
          : undefined,
        timestamp: Date.now(),
      },
      'file-ops'
    );
  }

  logUserAction(action: string, userId?: string, metadata?: Record<string, unknown>): void {
    this.info(
      'User action',
      {
        action,
        userId,
        metadata,
        timestamp: Date.now(),
      },
      'user-action'
    );
  }

  logSecurityEvent(
    event: string,
    severity: 'low' | 'medium' | 'high' | 'critical',
    details?: Record<string, unknown>
  ): void {
    this.warn(
      'Security event',
      {
        event,
        severity,
        details,
        timestamp: Date.now(),
      },
      'security'
    );
  }

  // Context tracking
  createContext(contextId: string, type: string, metadata?: Record<string, unknown>): void {
    this.debug(
      'Context created',
      {
        contextId,
        type,
        metadata,
        timestamp: Date.now(),
      },
      'context'
    );
  }

  updateContext(contextId: string, updates: Record<string, unknown>): void {
    this.debug(
      'Context updated',
      {
        contextId,
        updates,
        timestamp: Date.now(),
      },
      'context'
    );
  }

  destroyContext(contextId: string, reason?: string): void {
    this.debug(
      'Context destroyed',
      {
        contextId,
        reason,
        timestamp: Date.now(),
      },
      'context'
    );
  }
}
