// Usage API — billable image/voice API calls recorded by the api-usage-ledger.
// Read-only: recent entries, lifetime totals, daily buckets, CSV export.

import { Elysia } from 'elysia';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';
import {
  apiUsageCsv,
  apiUsageDaily,
  apiUsageTotals,
  listApiUsage,
} from '../../billing/api-usage-ledger';
import { AuthenticationError } from '../../errors/types';

function excludedProviders(request: Request): Set<string> {
  return new Set(
    new URL(request.url).searchParams
      .getAll('excludeProvider')
      .map((provider) => provider.trim().toLowerCase())
      .filter(Boolean),
  );
}

export const usageRoutes = new Elysia({ prefix: '/api/usage' })
  .onBeforeHandle(({ request }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
  })
  .get('/', async ({ request }) => {
    const requestUrl = new URL(request.url);
    const rawLimit = requestUrl.searchParams.get('limit');
    const parsed = rawLimit ? Number(rawLimit) : Number.NaN;
    const limit = Number.isFinite(parsed) ? parsed : 100;
    const excluded = excludedProviders(request);
    const [entries, totals] = await Promise.all([
      listApiUsage(limit, excluded),
      apiUsageTotals(excluded),
    ]);
    return { ok: true, data: { entries, totals } };
  })
  .get('/daily', async ({ request }) => {
    const rawDays = new URL(request.url).searchParams.get('days');
    const parsed = rawDays ? Number(rawDays) : Number.NaN;
    const days = Number.isFinite(parsed) ? parsed : 30;
    return { ok: true, data: await apiUsageDaily(days, excludedProviders(request)) };
  })
  .get(
    '/export',
    async ({ request }) =>
      new Response(await apiUsageCsv(excludedProviders(request)), {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="koryphaios-api-usage-${new Date().toISOString().slice(0, 10)}.csv"`,
        },
      }),
  );
