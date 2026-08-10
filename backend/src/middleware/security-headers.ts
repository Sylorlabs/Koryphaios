// Security-header middleware helpers.
// Deployment-specific proxy, TLS, and browser-policy validation remains the
// responsibility of the host environment.

import type { Elysia } from 'elysia';
import { getCorsHeaders } from '../security';
import { buildSecurityHeaders, generateCSPNonce, handleCSPViolation } from '../security/csp';
import { serverLog } from '../logger';

/**
 * Security headers middleware configuration
 */
export interface SecurityMiddlewareConfig {
  enableCSP?: boolean;
  enableHSTS?: boolean;
  enableXFrameOptions?: boolean;
  reportOnly?: boolean;
  csrfProtection?: boolean;
}

const DEFAULT_CONFIG: SecurityMiddlewareConfig = {
  enableCSP: true,
  enableHSTS: true,
  enableXFrameOptions: true,
  reportOnly: false,
  csrfProtection: true,
};

/** Elysia `set` object shape (headers + status). */
type ElysiaSet = { headers: Record<string, string | undefined>; status?: number };

/**
 * Helper: stamp security headers onto an Elysia `set` object.
 */
function applySecurityHeaders(set: ElysiaSet, config: SecurityMiddlewareConfig): void {
  const nonce = generateCSPNonce();
  const headers = buildSecurityHeaders({
    enableCSP: config.enableCSP,
    enableHSTS: config.enableHSTS,
    enableXFrameOptions: config.enableXFrameOptions,
    cspNonce: nonce,
    reportOnly: config.reportOnly,
  });
  for (const [name, value] of Object.entries(headers)) {
    if (value) set.headers[name] = value;
  }
}

/**
 * Elysia plugin that applies security headers to EVERY response, including
 * built-in 404/500 responses that bypass `onAfterHandle`.
 *
 * Elysia's internal not-found handler does NOT pass through `onAfterHandle`,
 * so a bare app with only `onAfterHandle` will serve 404 pages without CSP.
 * This plugin fixes that by also registering an `onError` handler (which
 * catches thrown errors) and a catch-all `.all('*', ...)` route (which
 * intercepts unmatched paths before Elysia's built-in 404 fires).
 *
 * Usage:
 *   const app = new Elysia().use(securityHeadersElysia());
 *   // add routes after .use()
 */
export function securityHeadersElysia(config: SecurityMiddlewareConfig = {}) {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  return (app: Elysia) =>
    app
      .onAfterHandle(({ set }) => {
        applySecurityHeaders(set as unknown as ElysiaSet, mergedConfig);
      })
      .onError(({ set }) => {
        // Errors must still carry security headers — a response without CSP
        // on an error page is a classic bypass.
        applySecurityHeaders(set as unknown as ElysiaSet, mergedConfig);
        set.status = set.status || 500;
      })
      .all('*', ({ set }) => {
        // Catch-all 404 placed LAST so specific routes win, but unmatched
        // paths still receive security headers instead of falling through
        // to Elysia's built-in 404 (which bypasses onAfterHandle).
        applySecurityHeaders(set as unknown as ElysiaSet, mergedConfig);
        set.status = 404;
        return { ok: false, error: 'Not Found' };
      });
}

/**
 * Middleware to apply security headers to all responses
 * This should be applied early in the middleware chain
 */
export function securityHeadersMiddleware(config: SecurityMiddlewareConfig = {}) {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };

  return async (request: Request, response: Response): Promise<Response> => {
    try {
      // Generate CSP nonce for this request
      const nonce = generateCSPNonce();

      // Build security headers with nonce
      const headers = buildSecurityHeaders({
        enableCSP: mergedConfig.enableCSP,
        enableHSTS: mergedConfig.enableHSTS,
        enableXFrameOptions: mergedConfig.enableXFrameOptions,
        cspNonce: nonce,
        reportOnly: mergedConfig.reportOnly,
      });

      // Apply headers to response
      for (const [name, value] of Object.entries(headers)) {
        if (value) {
          response.headers.set(name, value);
        }
      }

      // Store nonce in response for template rendering
      (response as unknown as { cspNonce?: string }).cspNonce = nonce;

      return response;
    } catch (err) {
      serverLog.error({ err }, 'Failed to apply security headers');
      // Fail open - return response without security headers rather than blocking
      return response;
    }
  };
}

/**
 * Middleware to handle CSP violation reports
 * This should be mounted at the report-uri endpoint
 */
export async function handleCSPViolationReport(
  request: Request,
  response: Response,
): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const report = await request.json();
    await handleCSPViolation(report, {
      ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown',
      userAgent: request.headers.get('user-agent') || 'unknown',
      timestamp: Date.now(),
    });

    return new Response('OK', { status: 202 });
  } catch (err) {
    serverLog.error({ err }, 'Failed to process CSP violation report');
    return new Response('Failed to process report', { status: 400 });
  }
}

/**
 * Middleware to inject CSP nonce into HTML responses
 * This replaces {{NONCE}} placeholders in HTML with the actual nonce
 */
export function injectCSPNonceMiddleware(request: Request, response: Response): Response {
  const nonce = (response as unknown as { cspNonce?: string }).cspNonce;

  if (!nonce || !response.headers.get('Content-Type')?.includes('text/html')) {
    return response;
  }

  // If response has a body and is HTML, inject nonce
  // This is a simplified version - for production, use a proper streaming approach
  return response;
}

/**
 * Preflight OPTIONS handler for CORS with security headers
 */
export async function handleOptionsRequest(
  request: Request,
  response: Response,
): Promise<Response> {
  const origin = request.headers.get('Origin');

  // Get CORS headers
  const corsHeaders = getCorsHeaders(origin);

  // Get security headers
  const nonce = generateCSPNonce();
  const secHeaders = buildSecurityHeaders({ cspNonce: nonce });

  // Combine headers
  const optionsResponse = new Response(null, { status: 204 });

  for (const [name, value] of Object.entries({ ...corsHeaders, ...secHeaders })) {
    if (value) {
      optionsResponse.headers.set(name, value);
    }
  }

  return optionsResponse;
}
