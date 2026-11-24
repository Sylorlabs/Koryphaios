import { Elysia } from 'elysia';
import { getUpdateReleaseStatus } from '../../services/update-release-status';

/**
 * Public, read-only release metadata.
 *
 * This intentionally has no local-auth gate: the response contains only the
 * public GitHub release workflow state already visible on github.com, and the
 * updater needs it before the app's auth bootstrap has necessarily completed.
 * It cannot install anything; the signed Tauri manifest remains authoritative.
 */
export const updateRoutes = new Elysia({ prefix: '/api/updates' }).get(
  '/status',
  async ({ query }) => {
    const refresh = typeof query?.refresh === 'string' && query.refresh === '1';
    const status = await getUpdateReleaseStatus({ force: refresh });
    return { ok: true, data: status };
  },
);
