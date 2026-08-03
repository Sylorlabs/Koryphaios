// Structured logger for Koryphaios.
// Replaces all console.log/warn/error with pino in dev, uses simple console in compiled binaries.

import pino from 'pino';
import { join, resolve } from 'path';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';

const isProduction = process.env.NODE_ENV === 'production';
const logDir = process.env.LOG_DIR ?? '.koryphaios/logs';

// ─── Direct file logging ───────────────────────────────────────────────────
// The launcher pipes backend stdout to data/logs/backend-dev.log, but if the
// launcher dies the pipe breaks and all subsequent logs are lost — exactly the
// scenario that made the 2026-08-03 event-loop hang impossible to debug. This
// direct file stream is owned by the backend process itself, so it survives
// launcher death and always leaves a postmortem.
let directFileLog: WriteStream | null = null;
function openDirectFileLog(): WriteStream | null {
  try {
    // Resolve the log directory relative to the project root (cwd is backend/
    // in dev, or the data dir in packaged mode). Walk up to find koryphaios.json.
    let root = process.cwd();
    for (let i = 0; i < 4; i++) {
      try {
        if (require('node:fs').existsSync(join(root, 'koryphaios.json'))) break;
      } catch { /* ignore */ }
      root = resolve(root, '..');
    }
    const dir = process.env.LOG_DIR
      ? resolve(root, process.env.LOG_DIR)
      : join(root, 'data', 'logs');
    mkdirSync(dir, { recursive: true });
    const stream = createWriteStream(join(dir, 'backend-direct.log'), { flags: 'a' });
    stream.on('error', () => { directFileLog = null; });
    return stream;
  } catch {
    return null;
  }
}
directFileLog = openDirectFileLog();
const DIRECT_LOG_PID = process.pid;

// Detect if we're running as a compiled binary
// Bun compile sets process.execPath to the compiled binary path
const isCompiledBinary =
  typeof process !== 'undefined' &&
  (process.argv[0]?.includes('koryphaios-backend') ||
    process.execPath?.includes('koryphaios-backend') ||
    // Bun compiled binaries run from /$bunfs/root/
    process.argv[1]?.includes('/$bunfs/') ||
    // Check if we're running a standalone executable
    (!process.argv[0]?.includes('bun') && process.argv[0]?.includes('backend')));

// Detect if stdout is a TTY
const isTTY = process.stdout?.isTTY === true;

// Logger interface matching pino's API
interface Logger {
  trace(obj: unknown, msg: string): void;
  trace(msg: string): void;
  debug(obj: unknown, msg: string): void;
  debug(msg: string): void;
  info(obj: unknown, msg: string): void;
  info(msg: string): void;
  warn(obj: unknown, msg: string): void;
  warn(msg: string): void;
  error(obj: unknown, msg: string): void;
  error(msg: string): void;
  fatal(obj: unknown, msg: string): void;
  fatal(msg: string): void;
  child(bindings: { module: string }): Logger;
}

// Simple console-based logger for compiled binaries
function createSimpleLogger(moduleName: string): Logger {
  const formatMessage = (level: string, msg: string, extra?: Record<string, unknown>) => {
    const time = new Date().toISOString().split('T')[1]?.split('.')[0] ?? '';
    const extraStr = extra && Object.keys(extra).length > 0 ? ' ' + JSON.stringify(extra) : '';
    return `[${time}] ${level.padEnd(5)} [${moduleName}] ${msg}${extraStr}`;
  };

  const writeToFile = (line: string) => {
    if (!directFileLog) return;
    try {
      directFileLog.write(`[pid:${DIRECT_LOG_PID}] ${line}\n`);
    } catch {
      // File logging is best-effort; never let it crash the server.
    }
  };

  const makeLogger = (level: string, consoleFn: (...args: unknown[]) => void) => {
    return (arg1: string | Record<string, unknown>, arg2?: string) => {
      const formatted =
        typeof arg1 === 'string'
          ? formatMessage(level, arg1)
          : arg2
            ? formatMessage(level, arg2, arg1)
            : null;
      if (formatted) {
        consoleFn(formatted);
        writeToFile(formatted);
      }
    };
  };

  return {
    trace: makeLogger('TRACE', console.debug),
    debug: makeLogger('DEBUG', console.debug),
    info: makeLogger('INFO', console.info),
    warn: makeLogger('WARN', console.warn),
    error: makeLogger('ERROR', console.error),
    fatal: makeLogger('FATAL', console.error),
    child: (bindings: { module: string }) => createSimpleLogger(bindings.module),
  };
}

// Create pino-based logger for development/production
function createPinoLogger(moduleName: string): Logger {
  const loggerOptions: pino.LoggerOptions = {
    level: process.env.LOG_LEVEL ?? (isProduction ? 'info' : 'debug'),
    base: { service: 'koryphaios' },
  };

  if (isProduction) {
    try {
      loggerOptions.transport = {
        target: 'pino-roll',
        options: {
          file: join(logDir, 'server'),
          frequency: 'daily',
          mkdir: true,
          maxSize: '100M',
          maxFiles: 7,
        },
      };
    } catch {
      // Fallback to stdout
    }
  } else if (isTTY) {
    try {
      loggerOptions.transport = {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss',
          ignore: 'pid,hostname',
        },
      };
    } catch {
      // Fallback to stdout
    }
  }

  const pinoLogger = pino(loggerOptions);
  return pinoLogger.child({ module: moduleName }) as unknown as Logger;
}

// Factory function to create loggers
function createLogger(moduleName: string): Logger {
  // Force simple logger for now until we can properly detect compiled mode
  // The pino transport workers don't work in Bun compiled binaries anyway
  return createSimpleLogger(moduleName);
}

// Export root logger and child loggers
export const log = createLogger('koryphaios');
export const serverLog = createLogger('server');
export const providerLog = createLogger('providers');
export const koryLog = createLogger('kory');
export const toolLog = createLogger('tools');
export const mcpLog = createLogger('mcp');
export const authLog = createLogger('auth');
export const routingLog = createLogger('routing');
