// Usage API — billable image/voice API calls recorded by the api-usage-ledger.
// Read-only: recent entries, lifetime totals, daily buckets, CSV export.

import { Elysia, t } from 'elysia';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';
import {
  apiUsageCsv,
  apiUsageDaily,
  apiUsageTotals,
  listApiUsage,
} from '../../billing/api-usage-ledger';
import { AuthenticationError } from '../../errors/types';

export const usageRoutes = new Elysia({ prefix: '/api/usage' })
  .onBeforeHandle(({ request }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
  })
  .get('/', async ({ request }) => {
    const rawLimit = new URL(request.url).searchParams.get('limit');
    const parsed = rawLimit ? Number(rawLimit) : Number.NaN;
    const limit = Number.isFinite(parsed) ? parsed : 100;
    const [entries, totals] = await Promise.all([listApiUsage(limit), apiUsageTotals()]);
    return { ok: true, data: { entries, totals } };
  })
  .get('/daily', async ({ query }) => ({ ok: true, data: await apiUsageDaily(query.days) }), {
    query: t.Object({ days: t.Optional(t.Numeric()) }),
  })
  .get(
    '/export',
    async () =>
      new Response(await apiUsageCsv(), {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="koryphaios-api-usage-${new Date().toISOString().slice(0, 10)}.csv"`,
        },
      }),
  );
