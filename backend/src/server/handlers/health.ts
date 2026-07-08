import { basename } from 'node:path';
import { VERSION } from '../../constants';
import { getReconciliation } from '../../credit-accountant';
import { getMetricsRegistry } from '../../metrics';
import { PROJECT_ROOT } from '../../runtime/paths';
import { serverLog } from '../../logger';
import { json, withCors } from '../http-helpers';
import type { BackendConfig } from '../../runtime/config';

export function handleHealthRoutes(
  pathname: string,
  method: string,
  corsHeaders: Record<string, string>,
  config: BackendConfig,
): Response | undefined {
  // Metrics endpoint (Prometheus)
  if (pathname === '/metrics' && method === 'GET') {
    return withCors(getMetricsRegistry().handleMetrics(), corsHeaders);
  }

  // Health check endpoint with configuration info
  if (pathname === '/api/health' && method === 'GET') {
    return json(
      {
        ok: true,
        data: {
          status: 'healthy',
          version: VERSION,
          pid: process.pid,
          config: {
            port: config.server.port,
            host: config.server.host,
          },
        },
      },
      200,
      corsHeaders,
    );
  }

  // Billing / credits (local estimate vs cloud reality, drift)
  if (pathname === '/api/billing/credits' && method === 'GET') {
    try {
      const data = getReconciliation();
      return json(
        {
          localEstimate: data.localEstimate,
          cloudReality: data.cloudReality,
          driftPercent: data.driftPercent,
          highlightDrift: data.highlightDrift,
        },
        200,
        corsHeaders,
      );
    } catch (err: unknown) {
      serverLog.error({ err }, 'Failed to get billing credits');
      return json({ error: 'Failed to get billing credits' }, 500, corsHeaders);
    }
  }

  // Health check endpoint (minimal for public/lb)
  if (pathname === '/health' && method === 'GET') {
    return json({ ok: true, data: { version: VERSION } }, 200, corsHeaders);
  }

  // Debug: client error log sink (no-op, avoids 404 from error-monitor)
  if (pathname === '/api/debug/log-error' && method === 'POST') {
    return json({ ok: true }, 200, corsHeaders);
  }

  // Project context (folder name the backend is operating in)
  if (pathname === '/api/project' && method === 'GET') {
    const projectName = basename(PROJECT_ROOT);
    return json({ ok: true, data: { projectName } }, 200, corsHeaders);
  }

  return undefined;
}
