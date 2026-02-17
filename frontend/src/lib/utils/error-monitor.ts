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
  
  const errors = [...errorBuffer];
  errorBuffer = [];
  
  try {
    await fetch(ERROR_LOG_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ errors }),
    });
  } catch (err) {
    // Don't log monitoring errors to avoid infinite loop
    console.warn('Failed to send error logs', err);
  }
}

function scheduleFlush() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(flushErrors, 1000); // Batch errors every 1s
}

function logError(error: ErrorLog) {
  errorBuffer.push(error);
  
  // Also log to console for immediate visibility
  console.error('[ERROR MONITOR]', error.message, error);
  
  scheduleFlush();
}

export function initErrorMonitoring() {
  if (typeof window === 'undefined') return;
  
  // Capture console errors
  const originalError = console.error;
  console.error = (...args: any[]) => {
    const message = args.map(a => {
      if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack}`;
      if (typeof a === 'object') return JSON.stringify(a);
      return String(a);
    }).join(' ');
    
    logError({
      timestamp: Date.now(),
      type: 'error',
      message,
      userAgent: navigator.userAgent,
    });
    
    originalError.apply(console, args);
  };
  
  // Capture console warnings
  const originalWarn = console.warn;
  console.warn = (...args: any[]) => {
    const message = args.map(a => String(a)).join(' ');
    
    logError({
      timestamp: Date.now(),
      type: 'warn',
      message,
      userAgent: navigator.userAgent,
    });
    
    originalWarn.apply(console, args);
  };
  
  // Capture window errors
  window.addEventListener('error', (event) => {
    logError({
      timestamp: Date.now(),
      type: 'error',
      message: event.message,
      stack: event.error?.stack,
      url: event.filename,
      line: event.lineno,
      column: event.colno,
      userAgent: navigator.userAgent,
    });
  });
  
  // Capture unhandled promise rejections
  window.addEventListener('unhandledrejection', (event) => {
    logError({
      timestamp: Date.now(),
      type: 'unhandledrejection',
      message: `Unhandled Promise Rejection: ${event.reason}`,
      stack: event.reason?.stack,
      userAgent: navigator.userAgent,
    });
  });
  
  console.log('[ERROR MONITOR] Initialized - all console errors will be logged');
}
