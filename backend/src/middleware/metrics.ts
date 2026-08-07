// Elysia metrics middleware plugin.
//
// Wraps the MetricsRegistry from metrics/index.ts in Elysia's lifecycle hooks:
//   - onRequest: record start time
//   - onAfterHandle: record success (response status + duration)
//   - onError: record failure (500 + duration)
//
// The prior codebase defined httpMetricsMiddleware() as a generic
// (req, next) => Response function that was never imported or used. This
// plugin is the proper Elysia integration — it's wired into the server's
// middleware chain so every request is counted.
//
// The /metrics endpoint is served directly by the server (not this plugin)
// because it needs auth gating that's co-located with the rest of the
// server's auth logic.

import Elysia from 'elysia';
import { getMetricsRegistry } from '../metrics';

const registry = getMetricsRegistry();

// Per-request start times, keyed by a unique request ID.
// Elysia doesn't provide a per-request store by default, so we use a Map
// keyed by the Request object identity (weakly). This is cleaned up in both
// the success and error paths.
const requestStartTimes = new WeakMap<Request, number>();

export const metricsMiddleware = new Elysia({
  name: 'metrics',
})
  .onRequest(({ request }) => {
    requestStartTimes.set(request, Date.now());
  })
  .onAfterHandle(({ request, set }) => {
    const start = requestStartTimes.get(request);
    if (start === undefined) return;
    const duration = (Date.now() - start) / 1000;
    const url = new URL(request.url);
    const method = request.method;
    const route = url.pathname;
    const status = String(set.status ?? 200);

    registry.incCounter('http_requests_total', { method, route, status });
    registry.observeHistogram('http_request_duration_seconds', { method, route }, duration);

    requestStartTimes.delete(request);
  })
  .onError(({ request, set }) => {
    const start = requestStartTimes.get(request);
    if (start === undefined) return;
    const duration = (Date.now() - start) / 1000;
    const url = new URL(request.url);
    const method = request.method;
    const route = url.pathname;
    const status = String(set.status ?? 500);

    registry.incCounter('http_requests_total', { method, route, status });
    registry.observeHistogram('http_request_duration_seconds', { method, route }, duration);

    requestStartTimes.delete(request);
  });
