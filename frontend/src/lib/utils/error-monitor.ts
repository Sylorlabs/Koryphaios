// Frontend error monitoring. Diagnostic transport is structural-only: console
// arguments, Error messages/stacks, prompts, tool output, and response bodies
// never cross this persistence boundary.

const ERROR_LOG_ENDPOINT = '/api/debug/log-error';

export const MONITOR_MAX_BATCH_BYTES = 32 * 1024;
export const MONITOR_MAX_ENTRY_BYTES = 2 * 1024;
const MONITOR_MAX_BUFFER_ENTRIES = 32;
const MONITOR_MAX_DEPTH = 3;
const MONITOR_MAX_OBJECT_KEYS = 12;
const MONITOR_MAX_ARRAY_ITEMS = 12;
const MONITOR_MAX_NODES = 64;

interface ErrorLog {
  timestamp: number;
  type: 'error' | 'warn' | 'unhandledrejection';
  message: 'console.error' | 'console.warn' | 'window.error' | 'unhandledrejection';
  details: unknown;
}

interface ShapeState {
  nodes: number;
  seen: WeakSet<object>;
}

let errorBuffer: ErrorLog[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let _originalError: typeof console.error;
let _originalWarn: typeof console.warn;
let _initialized = false;

// Store the real console methods on globalThis so they survive Vite HMR.
const _g = globalThis as unknown as {
  __koryOriginalConsoleError?: typeof console.error;
  __koryOriginalConsoleWarn?: typeof console.warn;
};

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isErrorObject(value: object): value is Error {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
}

function safeErrorType(value: Error): string {
  const builtins: ReadonlyArray<readonly [string, new (...args: never[]) => Error]> = [
    ['EvalError', EvalError],
    ['RangeError', RangeError],
    ['ReferenceError', ReferenceError],
    ['SyntaxError', SyntaxError],
    ['TypeError', TypeError],
    ['URIError', URIError],
  ];
  for (const [name, constructor] of builtins) {
    try {
      if (value instanceof constructor) return name;
    } catch {
      return 'Error';
    }
  }
  return 'Error';
}

function ownStringBytes(value: object, property: string): number {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, property);
    return descriptor && 'value' in descriptor && typeof descriptor.value === 'string'
      ? utf8Bytes(descriptor.value)
      : 0;
  } catch {
    return 0;
  }
}

/** Return a bounded structural description without retaining any string value,
 * object key, Error message/stack, or getter result. */
export function summarizeMonitorValue(
  value: unknown,
  depth = 0,
  state: ShapeState = { nodes: 0, seen: new WeakSet() },
): unknown {
  if (value === null) return { type: 'null' };
  if (typeof value === 'string') return { type: 'string', bytes: utf8Bytes(value) };
  if (typeof value === 'number') {
    return {
      type: 'number',
      finite: Number.isFinite(value),
    };
  }
  if (typeof value === 'boolean') return { type: 'boolean' };
  if (typeof value === 'undefined') return { type: 'undefined' };
  if (typeof value === 'bigint') return { type: 'bigint', digits: value.toString().length };
  if (typeof value === 'symbol') return { type: 'symbol' };
  if (typeof value === 'function') return { type: 'function' };
  if (depth >= MONITOR_MAX_DEPTH) return { type: 'max-depth' };
  if (state.nodes >= MONITOR_MAX_NODES) return { type: 'node-limit' };

  const object = value as object;
  if (state.seen.has(object)) return { type: 'circular' };
  state.seen.add(object);
  state.nodes += 1;

  if (isErrorObject(object)) {
    const error = object;
    let cause: PropertyDescriptor | undefined;
    try {
      cause = Object.getOwnPropertyDescriptor(error, 'cause');
    } catch {
      cause = undefined;
    }
    return {
      type: 'error',
      errorType: safeErrorType(error),
      messageBytes: ownStringBytes(error, 'message'),
      stackBytes: ownStringBytes(error, 'stack'),
      ...(cause && 'value' in cause
        ? { cause: summarizeMonitorValue(cause.value, depth + 1, state) }
        : {}),
    };
  }
  if (ArrayBuffer.isView(value)) {
    return { type: 'binary-view', bytes: value.byteLength };
  }
  if (value instanceof ArrayBuffer) return { type: 'array-buffer', bytes: value.byteLength };
  if (Array.isArray(value)) {
    return {
      type: 'array',
      length: value.length,
      items: value
        .slice(0, MONITOR_MAX_ARRAY_ITEMS)
        .map((item) => summarizeMonitorValue(item, depth + 1, state)),
      truncated: value.length > MONITOR_MAX_ARRAY_ITEMS,
    };
  }

  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const values = Object.values(descriptors)
      .slice(0, MONITOR_MAX_OBJECT_KEYS)
      .map((descriptor) =>
        'value' in descriptor
          ? summarizeMonitorValue(descriptor.value, depth + 1, state)
          : { type: 'accessor' },
      );
    return {
      type: 'object',
      keyCount: Object.keys(descriptors).length,
      values,
      truncated: Object.keys(descriptors).length > MONITOR_MAX_OBJECT_KEYS,
    };
  } catch {
    return { type: 'uninspectable-object' };
  }
}

function boundedEntry(entry: ErrorLog): ErrorLog {
  const serialized = JSON.stringify(entry);
  if (utf8Bytes(serialized) <= MONITOR_MAX_ENTRY_BYTES) return entry;
  return {
    timestamp: entry.timestamp,
    type: entry.type,
    message: entry.message,
    details: { type: 'entry-size-limit', originalBytes: utf8Bytes(serialized) },
  };
}

function enqueue(entry: ErrorLog): void {
  errorBuffer.push(boundedEntry(entry));
  if (errorBuffer.length > MONITOR_MAX_BUFFER_ENTRIES) {
    errorBuffer.splice(0, errorBuffer.length - MONITOR_MAX_BUFFER_ENTRIES);
  }
  scheduleFlush();
}

function boundedBatch(entries: ErrorLog[]): ErrorLog[] {
  const bounded: ErrorLog[] = [];
  for (const entry of entries) {
    const candidate = [...bounded, entry];
    if (utf8Bytes(JSON.stringify({ errors: candidate })) > MONITOR_MAX_BATCH_BYTES) break;
    bounded.push(entry);
  }
  return bounded;
}

async function flushErrors(): Promise<void> {
  if (errorBuffer.length === 0) return;
  const { isDemoMode } = await import('$lib/demo-flags');
  if (isDemoMode) {
    errorBuffer = [];
    return;
  }

  const errors = boundedBatch(errorBuffer);
  errorBuffer = [];
  if (errors.length === 0) return;

  try {
    await fetch(ERROR_LOG_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ errors }),
    });
  } catch {
    // The monitoring path must not recursively log its own transport failure.
    if (_originalWarn) {
      _originalWarn.call(console, '[Koryphaios] Error monitor transport unavailable');
    }
  }
}

function scheduleFlush(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => void flushErrors(), 1_000);
}

function consoleEntry(type: 'error' | 'warn', args: unknown[]): ErrorLog {
  return {
    timestamp: Date.now(),
    type,
    message: type === 'error' ? 'console.error' : 'console.warn',
    details: {
      argumentCount: args.length,
      arguments: args
        .slice(0, MONITOR_MAX_ARRAY_ITEMS)
        .map((argument) => summarizeMonitorValue(argument)),
      truncated: args.length > MONITOR_MAX_ARRAY_ITEMS,
    },
  };
}

function argsHaveKoryphaiosSentinel(args: unknown[]): boolean {
  return args.some((argument) => typeof argument === 'string' && argument.includes('[Koryphaios]'));
}

const onWindowError = (event: ErrorEvent): void => {
  enqueue({
    timestamp: Date.now(),
    type: 'error',
    message: 'window.error',
    details: {
      messageBytes: utf8Bytes(event.message ?? ''),
      stackBytes: utf8Bytes(event.error instanceof Error ? (event.error.stack ?? '') : ''),
      sourceBytes: utf8Bytes(event.filename ?? ''),
      line: event.lineno,
      column: event.colno,
      error: summarizeMonitorValue(event.error),
    },
  });
};

const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
  enqueue({
    timestamp: Date.now(),
    type: 'unhandledrejection',
    message: 'unhandledrejection',
    details: { reason: summarizeMonitorValue(event.reason) },
  });
};

export function initErrorMonitoring(): void {
  if (typeof window === 'undefined' || _initialized) return;
  _initialized = true;

  _originalError = _g.__koryOriginalConsoleError ?? console.error;
  _originalWarn = _g.__koryOriginalConsoleWarn ?? console.warn;
  _g.__koryOriginalConsoleError = _originalError;
  _g.__koryOriginalConsoleWarn = _originalWarn;

  console.error = (...args: unknown[]) => {
    const entry = consoleEntry('error', args);
    if (!argsHaveKoryphaiosSentinel(args)) enqueue(entry);
    _originalError.call(console, '[Koryphaios monitor]', entry.message, entry.details);
  };

  console.warn = (...args: unknown[]) => {
    const entry = consoleEntry('warn', args);
    if (!argsHaveKoryphaiosSentinel(args)) enqueue(entry);
    _originalWarn.call(console, '[Koryphaios monitor]', entry.message, entry.details);
  };

  window.addEventListener('error', onWindowError);
  window.addEventListener('unhandledrejection', onUnhandledRejection);
}

/** Also useful for HMR and tests: restore native console functions and drop
 * any unsent in-memory diagnostics. */
export function disposeErrorMonitoring(): void {
  if (!_initialized) return;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  errorBuffer = [];
  console.error = _originalError;
  console.warn = _originalWarn;
  window.removeEventListener('error', onWindowError);
  window.removeEventListener('unhandledrejection', onUnhandledRejection);
  _initialized = false;
}
