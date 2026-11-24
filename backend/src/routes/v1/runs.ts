import { Elysia } from 'elysia';
import type { SessionRunSnapshot } from '@koryphaios/shared';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';
import { getContext } from '../../context';
import { summarizeActiveWork } from '../../runs/active-work';

export interface ActiveRunSource {
  listActive(): SessionRunSnapshot[];
}

/**
 * Cheap read used by the desktop shell to decide whether Quit needs
 * confirmation. It lives behind the same local bearer auth as every other
 * local route, so a random local process cannot probe agent activity.
 */
export function createRunRoutes(source: () => ActiveRunSource) {
  return new Elysia({ prefix: '/api/runs' }).get('/active-count', ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    return { ok: true, data: summarizeActiveWork(source().listActive()) };
  });
}

export const runRoutes = createRunRoutes(() => getContext().runs);
