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
  MalformedJsonError,
  ValidationError,
  normalizeError,
  getErrorStatusCode,
  getErrorCode,
} from '../errors/types';
import { generateCorrelationId } from '../errors';

const PUBLIC_CONFLICT_DETAIL_KEYS = new Set([
  'expectedRevision',
  'currentRevision',
  'actualRevision',
  'sourceChanged',
  'sourceDeleted',
]);

/** Conflict recovery needs a small amount of authoritative state, but arbitrary
 * error details can contain paths or submitted content. Only return bounded,
 * primitive fields that are part of the public optimistic-concurrency contract. */
function publicConflictDetails(
  code: string,
  statusCode: number,
  details?: Record<string, unknown>,
): Record<string, string | number | boolean> | undefined {
  if (code !== 'CONFLICT' || statusCode !== 409 || !details) return undefined;
  const safe: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(details)) {
    if (!PUBLIC_CONFLICT_DETAIL_KEYS.has(key)) continue;
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
      safe[key] = value;
    } else if (typeof value === 'string' && value.length <= 128) {
      safe[key] = value;
    }
  }
  return Object.keys(safe).length ? safe : undefined;
}

/**
 * The error handler function used by both the plugin form and the direct
 * registration form. Exported so tests and other apps can attach it directly
 * to an Elysia instance via `.onError(errorHandler)`.
 */
// Elysia's onError context shape — using a loose type so the handler can be
// registered both via .onError(errorHandler) and via the plugin form.
/* eslint-disable @typescript-eslint/no-explicit-any */
export function errorHandler({ code: frameworkCode, error, request, set }: any) {
  const method = request.method;
  const url = new URL(request.url);
  const path = url.pathname;
  const correlationId = generateCorrelationId();

  // Elysia's schema/parser failures are caller errors. Its raw validation
  // message can contain the full schema and submitted value, so return a
  // stable bounded description rather than converting it to an opaque 500 or
  // echoing private request content.
  const normalized =
    frameworkCode === 'VALIDATION' || error?.code === 'VALIDATION'
      ? new ValidationError('Request does not match the required schema')
      : frameworkCode === 'PARSE' || error?.code === 'PARSE'
        ? new MalformedJsonError()
        : normalizeError(error);
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
  const details = publicConflictDetails(code, statusCode, normalized.details);

  return {
    ok: false,
    error: message,
    code,
    correlationId,
    ...(details ? { details } : {}),
  };
}

export const errorHandlingMiddleware = new Elysia({
  name: 'error-handling',
}).onError(errorHandler);
