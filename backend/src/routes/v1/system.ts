import { Elysia } from 'elysia';
import { basename } from 'node:path';
import { VERSION, COMPAT } from '../../constants';
import { PROJECT_ROOT } from '../../runtime/paths';
import { resolveBundleHash, isBundleHashEnforced } from '../../config/compat';

const SERVER_STARTED_AT = Date.now();
const BACKEND_SERVICE_ID = 'koryphaios';

/**
 * Unauthenticated system routes: liveness, project identity and the client
 * error sink. Mounted first in the server so they precede the error handler,
 * exactly as they did when they were inline in `server.ts`.
 */
export const systemRoutes = new Elysia()
  .get('/api/health', () => ({
    ok: true,
    data: {
      id: BACKEND_SERVICE_ID,
      version: VERSION,
      uptime: process.uptime(),
      // Lets the desktop supervisor reject a stale process already bound to
      // the configured port instead of mistaking it for the embedded service.
      pid: process.pid,
      // Frontend/backend compatibility contract. The frontend reads this and
      // halts normal operation when its own version/bundle-hash falls outside
      // the range the backend reports. Prevents a stale frontend from running
      // silently against a fresh backend (or vice versa).
      compat: {
        minFrontend: COMPAT.minFrontend,
        currentFrontend: COMPAT.currentFrontend,
        bundleHash: resolveBundleHash(),
        bundleHashEnforced: isBundleHashEnforced(),
        serverStartedAt: SERVER_STARTED_AT,
      },
    },
  }))
  .get('/api/project', () => {
    const projectName = basename(PROJECT_ROOT);
    return { ok: true, data: { projectName } };
  })
  .post('/api/debug/log-error', () => ({ ok: true }));
