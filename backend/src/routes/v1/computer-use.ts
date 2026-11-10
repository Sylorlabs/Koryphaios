import { Elysia } from 'elysia';
import { revokeComputerAuthority } from '../../computer-use/authority';
import type { ComputerPlatformAdapter } from '@koryphaios/shared';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';
import { getRequestProjectRoot } from '../../runtime/request-project';
import { loadAgentSettings, saveAgentSettings } from '../../agent-settings';
import { createComputerPlatformAdapter } from '../../computer-use/platform';
import { computerScreenshots } from '../../computer-use/screenshots';
import {
  computerUsePendingCount,
  stopComputerUse,
  withComputerUseLock,
} from '../../computer-use/control';

/** Settings-only human control plane. Discovery is explicit, authenticated and not an agent bypass. */
export function createComputerUseRoutes(
  adapter: ComputerPlatformAdapter = createComputerPlatformAdapter(),
) {
  return new Elysia({ prefix: '/api/v1/computer-use' })
    .get('/screenshots/:id', ({ request, params, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const sessionId = new URL(request.url).searchParams.get('sessionId') ?? '';
      const bytes = computerScreenshots.get(sessionId, params.id);
      if (!bytes) {
        set.status = 404;
        return { ok: false, error: 'Screenshot expired or unavailable' };
      }
      return new Response(Buffer.from(bytes), { headers: {
        'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      } });
    })
    .get('/status', async ({ request, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      try {
        const status = await adapter.status();
        return {
          ok: true,
          data: {
            ...status,
            enabled: loadAgentSettings(getRequestProjectRoot(request)).computerUse.enabled,
            pending: computerUsePendingCount(),
          },
        };
      } catch (error) {
        set.status = 503;
        return {
          ok: false,
          error: error instanceof Error ? error.message : 'Computer status unavailable',
        };
      }
    })
    .get('/apps', async ({ request, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      try {
        const targets = await withComputerUseLock(async (signal) => {
          const status = await adapter.status();
          signal.throwIfAborted();
          if (!status.available || !status.capabilities.includes('discover'))
            throw new Error('Application discovery is unavailable on this host');
          const result = await adapter.execute({ kind: 'discover' }, signal);
          signal.throwIfAborted();
          return result.targets ?? [];
        });
        return { ok: true, data: { targets } };
      } catch (error) {
        set.status = 503;
        return {
          ok: false,
          error: error instanceof Error ? error.message : 'Application discovery failed',
        };
      }
    })
    .post('/stop', ({ request, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      revokeComputerAuthority();
      const cancelled = stopComputerUse('Computer use stopped by the user');
      const root = getRequestProjectRoot(request);
      const settings = loadAgentSettings(root);
      settings.computerUse.enabled = false;
      saveAgentSettings(root, settings);
      return { ok: true, data: { cancelled, enabled: false } };
    });
}
