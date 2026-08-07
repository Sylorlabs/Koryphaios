/**
 * Frontend logging utility.
 *
 * In development: writes to the corresponding console method.
 * In production: POSTs to `/api/debug/log-error` with `{ level, message, context }`
 * (the backend endpoint is already implemented), rate-limited to max 10 posts
 * per 10 seconds, and also writes to the console.
 *
 * Usage:
 *   feLog.warn('WorkerCard', 'Failed to stop agent', err);
 *   feLog.error('ApiFetch', 'Request failed', err);
 *   feLog.info('Theme', 'Applied preset');
 *   feLog.debug('Shortcuts', 'Loaded from localStorage');
 */

import { apiUrl } from '$lib/utils/api-url';

type LogLevel = 'warn' | 'error' | 'info' | 'debug';

const isDev = import.meta.env.DEV === true;

// Rate limiting: max 10 posts per 10 seconds in production.
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 10_000;
const postTimestamps: number[] = [];

function underRateLimit(): boolean {
  const now = Date.now();
  // Drop timestamps older than the window.
  while (postTimestamps.length > 0 && now - postTimestamps[0] >= RATE_LIMIT_WINDOW_MS) {
    postTimestamps.shift();
  }
  if (postTimestamps.length >= RATE_LIMIT_MAX) return false;
  postTimestamps.push(now);
  return true;
}

function postToBackend(level: LogLevel, context: string, message: string): void {
  if (!underRateLimit()) return;
  try {
    void fetch(apiUrl('/api/debug/log-error'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level, message, context }),
    }).catch((err) => {
      // Never let the logger itself throw — fall back to console.
      console.error('[feLog] Failed to POST log to backend:', err);
    });
  } catch (err) {
    console.error('[feLog] Failed to POST log to backend:', err);
  }
}

function formatMessage(context: string, message: string): string {
  return `[${context}] ${message}`;
}

function log(level: LogLevel, context: string, message: string, ...rest: unknown[]): void {
  const formatted = formatMessage(context, message);
  switch (level) {
    case 'warn':
      console.warn(formatted, ...rest);
      break;
    case 'error':
      console.error(formatted, ...rest);
      break;
    case 'info':
      console.info(formatted, ...rest);
      break;
    case 'debug':
      console.debug(formatted, ...rest);
      break;
  }
  if (!isDev) {
    postToBackend(level, context, message);
  }
}

export const feLog = {
  warn(context: string, message: string, ...rest: unknown[]): void {
    log('warn', context, message, ...rest);
  },
  error(context: string, message: string, ...rest: unknown[]): void {
    log('error', context, message, ...rest);
  },
  info(context: string, message: string, ...rest: unknown[]): void {
    log('info', context, message, ...rest);
  },
  debug(context: string, message: string, ...rest: unknown[]): void {
    log('debug', context, message, ...rest);
  },
};
