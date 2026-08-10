// Structured logger for Koryphaios.
// Replaces all console.log/warn/error with pino in dev, uses simple console in compiled binaries.

import pino from 'pino';
import { join } from 'path';

const MAX_LOG_STRING_LENGTH = 4_000;
const MAX_LOG_TOTAL_STRING_LENGTH = 24_000;
const MAX_LOG_DEPTH = 5;
const MAX_LOG_OBJECT_KEYS = 48;
const MAX_LOG_ARRAY_ITEMS = 32;
const MAX_LOG_NODES = 256;
const MAX_LOG_ENTRIES = 192;
const TRUNCATED = '[TRUNCATED]';
const REDACTED = '[REDACTED]';

const SENSITIVE_LOG_KEYS = new Set([
  'apikey',
  'accesstoken',
  'authtoken',
  'authorization',
  'bearer',
  'clientsecret',
  'cookie',
  'credential',
  'credentials',
  'encryptionkey',
  'jwt',
  'masterkey',
  'passphrase',
  'password',
  'privatekey',
  'refreshtoken',
  'secret',
  'secretid',
  'sessiontoken',
  'token',
]);

interface LogSanitizerState {
  nodes: number;
  remainingEntries: number;
  remainingStringCharacters: number;
  seen: WeakSet<object>;
}

function isSensitiveLogKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (
    SENSITIVE_LOG_KEYS.has(normalized) ||
    normalized.endsWith('apikey') ||
    normalized.endsWith('accesstoken') ||
    normalized.endsWith('authtoken') ||
    normalized.endsWith('clientsecret') ||
    normalized.endsWith('jwt') ||
    normalized.endsWith('privatekey') ||
    normalized.endsWith('refreshtoken') ||
    normalized.endsWith('sessiontoken') ||
    normalized.endsWith('token')
  );
}

/** Redact secret-shaped free-form text without importing the security module,
 * which itself depends on the logger. This is the final persistence boundary:
 * call sites should still avoid passing prompts, command output, or credentials. */
export function redactLogText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:Basic|Digest|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '[REDACTED_AUTH]')
    .replace(/\b(?:sk|rk|pk)-(?:proj-)?[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_KEY]')
    .replace(/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{12,}\b/g, '[REDACTED_KEY]')
    .replace(/\b(?:gsk|hf|npm)_[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_TOKEN]')
    .replace(/\b(?:glpat|pplx|xai)-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_TOKEN]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{16,}\b/g, '[REDACTED_TOKEN]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED_TOKEN]')
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]')
    .replace(/\bAIza[0-9A-Za-z_-]{30,}\b/g, '[REDACTED_GOOGLE_KEY]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_JWT]')
    .replace(
      /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s/@:]+:[^\s/@]+@/gi,
      '[REDACTED_DSN]@',
    )
    .replace(
      /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g,
      '[REDACTED_PRIVATE_KEY]',
    )
    .replace(
      /((?:api[_ -]?key|access[_ -]?token|auth[_ -]?token|refresh[_ -]?token|password|passphrase|secret|authorization|cookie)\s*["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi,
      '$1[REDACTED]',
    )
    .replace(
      /((?:--?)(?:api-key|access-token|auth-token|refresh-token|password|passphrase|secret)\s+)[^\s]+/gi,
      '$1[REDACTED]',
    )
    .replace(
      /([?&](?:api[_-]?key|access[_-]?token|auth[_-]?token|token|key|secret|sig|(?:x-amz-|x-goog-)?signature)=)[^&#\s]+/gi,
      '$1[REDACTED]',
    );
}

function boundedLogString(value: string, state: LogSanitizerState): string {
  if (state.remainingStringCharacters <= 0) return TRUNCATED;
  const redacted = redactLogText(value);
  const allowed = Math.min(MAX_LOG_STRING_LENGTH, state.remainingStringCharacters);
  const bounded =
    redacted.length > allowed ? `${redacted.slice(0, Math.max(0, allowed - 1))}…` : redacted;
  state.remainingStringCharacters -= bounded.length;
  return bounded;
}

function sanitizedKey(key: string, state: LogSanitizerState): string {
  const redacted = redactLogText(key);
  const bounded = redacted.length > 128 ? `${redacted.slice(0, 127)}…` : redacted;
  // Keys count toward the global text budget but should not consume the entire
  // allowance before values are inspected.
  state.remainingStringCharacters = Math.max(
    0,
    state.remainingStringCharacters - Math.min(bounded.length, 128),
  );
  return bounded;
}

function sanitizeError(
  error: Error,
  depth: number,
  state: LogSanitizerState,
): Record<string, unknown> {
  const out = Object.create(null) as Record<string, unknown>;
  out.name = boundedLogString(error.name || 'Error', state);
  out.message = boundedLogString(error.message, state);
  if (error.stack) out.stack = boundedLogString(error.stack, state);
  if ('cause' in error && error.cause !== undefined) {
    out.cause = sanitizeLogValue(error.cause, depth + 1, state, 'cause');
  }

  const descriptors = Object.getOwnPropertyDescriptors(error);
  const extraKeys = Object.keys(descriptors).filter(
    (key) => !['name', 'message', 'stack', 'cause'].includes(key),
  );
  let processedKeys = 0;
  for (const key of extraKeys.slice(0, MAX_LOG_OBJECT_KEYS)) {
    if (state.remainingEntries <= 0) break;
    state.remainingEntries -= 1;
    processedKeys += 1;
    const descriptor = descriptors[key];
    const safeKey = sanitizedKey(key, state);
    out[safeKey] =
      descriptor && 'value' in descriptor
        ? sanitizeLogValue(descriptor.value, depth + 1, state, key)
        : '[Getter]';
  }
  if (extraKeys.length > processedKeys) {
    out._truncatedKeys = extraKeys.length - processedKeys;
  }
  return out;
}

function sanitizeLogValue(
  value: unknown,
  depth: number,
  state: LogSanitizerState,
  key?: string,
): unknown {
  if (key && isSensitiveLogKey(key)) {
    return value === undefined || value === null || value === '' ? value : REDACTED;
  }
  if (value === null || value === undefined || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (typeof value === 'string') return boundedLogString(value, state);
  if (typeof value === 'symbol') return boundedLogString(String(value), state);
  if (typeof value === 'function') {
    return boundedLogString(`[Function${value.name ? ` ${value.name}` : ''}]`, state);
  }
  if (depth >= MAX_LOG_DEPTH) return '[MAX_DEPTH]';
  if (state.nodes >= MAX_LOG_NODES) return TRUNCATED;

  const object = value as object;
  if (state.seen.has(object)) return '[CIRCULAR]';
  state.seen.add(object);
  state.nodes += 1;

  try {
    if (value instanceof Error) return sanitizeError(value, depth, state);
    if (value instanceof Date) return boundedLogString(value.toISOString(), state);
    if (value instanceof URL) return boundedLogString(value.toString(), state);
    if (ArrayBuffer.isView(value)) {
      return {
        type: value.constructor.name,
        byteLength: value.byteLength,
      };
    }
    if (value instanceof ArrayBuffer) {
      return { type: 'ArrayBuffer', byteLength: value.byteLength };
    }
    if (Array.isArray(value)) {
      const itemCount = Math.min(value.length, MAX_LOG_ARRAY_ITEMS, state.remainingEntries);
      state.remainingEntries -= itemCount;
      const items = value
        .slice(0, itemCount)
        .map((item) => sanitizeLogValue(item, depth + 1, state));
      if (value.length > itemCount) {
        items.push(`[${value.length - itemCount} more items]`);
      }
      return items;
    }

    // A null prototype prevents hostile `__proto__`/constructor keys from
    // mutating the sanitized container before JSON serialization.
    const out = Object.create(null) as Record<string, unknown>;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors);
    let processedKeys = 0;
    for (const property of keys.slice(0, MAX_LOG_OBJECT_KEYS)) {
      if (state.remainingEntries <= 0) break;
      state.remainingEntries -= 1;
      processedKeys += 1;
      const descriptor = descriptors[property];
      const safeKey = sanitizedKey(property, state);
      out[safeKey] =
        descriptor && 'value' in descriptor
          ? sanitizeLogValue(descriptor.value, depth + 1, state, property)
          : '[Getter]';
    }
    if (keys.length > processedKeys) {
      out._truncatedKeys = keys.length - processedKeys;
    }
    return out;
  } catch (error) {
    return {
      type: 'UnserializableObject',
      serializationError: boundedLogString(
        error instanceof Error ? error.message : String(error),
        state,
      ),
    };
  }
}

/** Sanitize metadata before it reaches stdout, a rolling file, or a pretty
 * transport. Exported for focused regression tests and logger adapters. */
export function sanitizeLogMetadata(value: unknown): Record<string, unknown> {
  const state: LogSanitizerState = {
    nodes: 0,
    remainingEntries: MAX_LOG_ENTRIES,
    remainingStringCharacters: MAX_LOG_TOTAL_STRING_LENGTH,
    seen: new WeakSet(),
  };
  const sanitized = sanitizeLogValue(value, 0, state);
  if (sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized)) {
    return sanitized as Record<string, unknown>;
  }
  return { value: sanitized };
}

function sanitizeLogMessage(value: string): string {
  return boundedLogString(value, {
    nodes: 0,
    remainingEntries: 0,
    remainingStringCharacters: MAX_LOG_STRING_LENGTH,
    seen: new WeakSet(),
  });
}

const isProduction = process.env.NODE_ENV === 'production';
const logDir = process.env.LOG_DIR ?? '.koryphaios/logs';

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
  const safeModuleName = sanitizeLogMessage(moduleName);
  const formatMessage = (level: string, msg: string, extra?: Record<string, unknown>) => {
    const time = new Date().toISOString().split('T')[1]?.split('.')[0] ?? '';
    const extraStr = extra && Object.keys(extra).length > 0 ? ' ' + JSON.stringify(extra) : '';
    return `[${time}] ${level.padEnd(5)} [${safeModuleName}] ${sanitizeLogMessage(msg)}${extraStr}`;
  };

  const makeLogger = (level: string, consoleFn: (...args: unknown[]) => void) => {
    return (arg1: unknown, arg2?: string) => {
      if (typeof arg1 === 'string') {
        consoleFn(formatMessage(level, arg1));
      } else if (arg2) {
        consoleFn(formatMessage(level, arg2, sanitizeLogMetadata(arg1)));
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

function wrapStructuredLogger(delegate: Logger): Logger {
  const invoke = (level: keyof Omit<Logger, 'child'>) => {
    return (arg1: unknown, arg2?: string) => {
      if (typeof arg1 === 'string') {
        delegate[level](sanitizeLogMessage(arg1));
      } else if (arg2) {
        delegate[level](sanitizeLogMetadata(arg1), sanitizeLogMessage(arg2));
      }
    };
  };
  return {
    trace: invoke('trace'),
    debug: invoke('debug'),
    info: invoke('info'),
    warn: invoke('warn'),
    error: invoke('error'),
    fatal: invoke('fatal'),
    child: (bindings: { module: string }) =>
      wrapStructuredLogger(delegate.child({ module: sanitizeLogMessage(bindings.module) })),
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
    } catch (err: unknown) {
      // Logger module itself — serverLog isn't available yet, use console.
      console.warn(
        'pino-roll transport setup failed, falling back to stdout:',
        sanitizeLogMessage(err instanceof Error ? err.message : String(err)),
      );
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
    } catch (err: unknown) {
      // Logger module itself — serverLog isn't available yet, use console.
      console.warn(
        'pino-pretty transport setup failed, falling back to stdout:',
        sanitizeLogMessage(err instanceof Error ? err.message : String(err)),
      );
    }
  }

  const pinoLogger = pino(loggerOptions);
  const child = pinoLogger.child({ module: sanitizeLogMessage(moduleName) }) as unknown as Logger;
  return wrapStructuredLogger(child);
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
