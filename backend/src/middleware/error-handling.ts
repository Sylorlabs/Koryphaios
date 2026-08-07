// Global error-handling middleware for Elysia.
//
// This is the SINGLE chokepoint for all unhandled errors in the API. Route
// handlers are expected to throw KoryphaiosError subclasses (from
// errors/types.ts) for operational errors. Unknown errors (bugs) are
// normalized via normalizeError and logged with full context.
//
// The prior codebase had no global error middleware — each route handled
// errors inconsistently or not at all, and many errors were swallowed by
// bare catch {} blocks. This middleware ensures:
//   1. Every error is logged with method, path, correlationId, and stack.
//   2. HTTP status codes come from the error taxonomy, not generic 500s.
//   3. The response body is always structured: { ok, error, code, correlationId }.
//   4. Operational errors (4xx) are logged at warn; bugs (5xx) at error.

import Elysia from 'elysia';
import { serverLog } from '../logger';
import {
  KoryphaiosError,
  normalizeError,
  getErrorStatusCode,
  getErrorCode,
} from '../errors/types';
import { generateCorrelationId } from '../errors';

/**
 * The error handler function used by both the plugin form and the direct
 * registration form. Exported so tests and other apps can attach it directly
 * to an Elysia instance via `.onError(errorHandler)`.
 */
// Elysia's onError context shape — using a loose type so the handler can be
// registered both via .onError(errorHandler) and via the plugin form.
/* eslint-disable @typescript-eslint/no-explicit-any */
export function errorHandler({ error, request, set }: any) {
  const method = request.method;
  const url = new URL(request.url);
  const path = url.pathname;
  const correlationId = generateCorrelationId();

  const normalized = normalizeError(error);
  const statusCode = getErrorStatusCode(normalized);
  const code = getErrorCode(normalized);

  // Operational errors (4xx) are expected user mistakes — warn level.
  // Bugs (5xx) are unexpected — error level with full stack.
  const logContext = {
    method,
    path,
    code,
    statusCode,
    correlationId,
    error: {
      name: normalized.name,
      message: normalized.message,
      stack: normalized.stack,
      details: normalized.details,
    },
  };

  if (statusCode >= 500) {
    serverLog.error(logContext, 'Unhandled server error');
  } else {
    serverLog.warn(logContext, 'Operational error');
  }

  set.status = statusCode;
  set.headers['x-correlation-id'] = correlationId;

  // Don't leak internal error details to clients for 5xx errors.
  const message = statusCode >= 500 ? 'Internal server error' : normalized.message;

  return {
    ok: false,
    error: message,
    code,
    correlationId,
  };
}

export const errorHandlingMiddleware = new Elysia({
  name: 'error-handling',
})
  .onError(errorHandler);
