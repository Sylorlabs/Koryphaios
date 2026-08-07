// Error monitoring - logs all console errors for debugging
// This helps track down issues by sending errors to the backend

const ERROR_LOG_ENDPOINT = '/api/debug/log-error';

interface ErrorLog {
  timestamp: number;
  type: 'error' | 'warn' | 'unhandledrejection';
  message: string;
  stack?: string;
  url?: string;
  line?: number;
  column?: number;
  userAgent?: string;
}

let errorBuffer: ErrorLog[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

async function flushErrors() {
  if (errorBuffer.length === 0) return;
  // Demo builds have no backend to receive logs — posting would just 404.
  const { isDemoMode } = await import('$lib/demo-flags');
  if (isDemoMode) {
    errorBuffer = [];
    return;
  }

  const errors = [...errorBuffer];
  errorBuffer = [];

  try {
    await fetch(ERROR_LOG_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ errors }),
    });
  } catch (err) {
    // Don't log monitoring errors to avoid infinite loop — use the original
    // console.warn so we don't re-enter our own wrapper (which would push
    // to errorBuffer, schedule another flush, and feedback-loop).
    if (_originalWarn) _originalWarn.call(console, '[ERROR MONITOR] Failed to send error logs', err);
  }
}

function scheduleFlush() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(flushErrors, 1000); // Batch errors every 1s
}

let _originalError: typeof console.error;
let _originalWarn: typeof console.warn;
let _initialized = false;

// Store the real console methods on globalThis so they survive Vite HMR
// (which re-evaluates the module and resets module-level variables, while
// console.error stays wrapped from the previous instance). Without this,
// a hot-reload would capture the old wrapper as _originalError and create
// infinite recursion: wrapper → _originalError (old wrapper) → _originalError (itself) → …
const _g = globalThis as unknown as {
  __koryOriginalConsoleError?: typeof console.error;
  __koryOriginalConsoleWarn?: typeof console.warn;
};

/** Safely serialize a value for the error log message. Never throws —
 *  falls back to a placeholder on circular references or stringify failures. */
function safeStringify(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'function') return `[Function: ${value.name || 'anonymous'}]`;
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ''}`;
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch (err: unknown) {
      // Circular reference or other stringify failure — don't let this
      // throw out of console.error and trigger a cascading error loop.
      console.debug('safeStringify: JSON.stringify failed:', err instanceof Error ? err.message : String(err));
      try {
        return Object.prototype.toString.call(value);
      } catch (err2: unknown) {
        console.debug('safeStringify: Object.prototype.toString also failed:', err2 instanceof Error ? err2.message : String(err2));
        return '[Unserializable object]';
      }
    }
  }
  return String(value);
}

/** Quick check whether any arg is a string starting with the sentinel prefix.
 *  Used to skip [Koryphaios] messages BEFORE running the (potentially
 *  throwing) serialization map. */
function argsHaveKoryphaiosSentinel(args: unknown[]): boolean {
  for (const a of args) {
    if (typeof a === 'string' && a.includes('[Koryphaios]')) return true;
  }
  return false;
}

function logError(error: ErrorLog) {
  errorBuffer.push(error);
  // Use original console so we don't recurse into our own wrapper
  if (_originalError) _originalError.call(console, '[ERROR MONITOR]', error.message, error);
  scheduleFlush();
}

export function initErrorMonitoring() {
  if (typeof window === 'undefined') return;
  // Guard against double-initialization (e.g. HMR re-mounting the layout).
  // Without this, the second call captures the already-wrapped console.error
  // as _originalError, so _originalError.apply() re-enters the wrapper →
  // infinite recursion → Maximum call stack size exceeded.
  if (_initialized) return;
  _initialized = true;

  // Always capture the REAL console methods — never a previous wrapper.
  // On HMR, module-level _originalError is reset, but globalThis survives.
  _originalError = _g.__koryOriginalConsoleError ?? console.error;
  _originalWarn = _g.__koryOriginalConsoleWarn ?? console.warn;
  _g.__koryOriginalConsoleError = _originalError;
  _g.__koryOriginalConsoleWarn = _originalWarn;

  // Capture console errors — must call _originalError so our own logError doesn't recurse
  console.error = (...args: unknown[]) => {
    // Don't relay the backend-health sentinel's own failures — that creates
    // a feedback loop where each health-check timeout logs an error, which
    // triggers a flush to /api/debug/log-error, which adds more concurrent
    // requests to the same origin, which can cause more health-check timeouts.
    // Check BEFORE serializing so a circular object in a [Koryphaios] call
    // doesn't throw out of safeStringify before we get a chance to skip it.
    const isSentinel = argsHaveKoryphaiosSentinel(args);

    if (!isSentinel) {
      const message = args.map(safeStringify).join(' ');
      errorBuffer.push({
        timestamp: Date.now(),
        type: 'error',
        message,
        userAgent: navigator.userAgent,
      });
      scheduleFlush();
    }
    if (_originalError) _originalError.apply(console, args);
  };

  // Capture console warnings
  console.warn = (...args: unknown[]) => {
    const message = args.map((a) => (typeof a === 'string' ? a : safeStringify(a))).join(' ');
    if (!message.includes('[Koryphaios]') && !message.includes('[ERROR MONITOR]')) {
      errorBuffer.push({
        timestamp: Date.now(),
        type: 'warn',
        message,
        userAgent: navigator.userAgent,
      });
      scheduleFlush();
    }
    if (_originalWarn) _originalWarn.apply(console, args);
  };

  // Capture window errors
  window.addEventListener('error', (event) => {
    errorBuffer.push({
      timestamp: Date.now(),
      type: 'error',
      message: event.message,
      stack: event.error?.stack,
      url: event.filename,
      line: event.lineno,
      column: event.colno,
      userAgent: navigator.userAgent,
    });
    scheduleFlush();
  });

  // Capture unhandled promise rejections
  window.addEventListener('unhandledrejection', (event) => {
    errorBuffer.push({
      timestamp: Date.now(),
      type: 'unhandledrejection',
      message: `Unhandled Promise Rejection: ${event.reason}`,
      stack: event.reason?.stack,
      userAgent: navigator.userAgent,
    });
    scheduleFlush();
  });
}
