import { Elysia, t } from 'elysia';
import { getModeManager } from '../../mode';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';

export const modeRoutes = new Elysia({ prefix: '/api/mode' })
  .get('/', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const modeManager = getModeManager();
    return {
      ok: true,
      data: {
        mode: modeManager.getMode(),
        config: modeManager.getModeConfig(),
        context: modeManager.getModeContext(),
        shouldWarnNoGit: modeManager.shouldWarnNoGitRepo(),
        noGitWarning: modeManager.shouldWarnNoGitRepo()
          ? modeManager.getNoGitRepoWarning()
          : null,
      },
    };
  })
  .put(
    '/',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const modeManager = getModeManager();
      modeManager.setMode(body.mode as 'beginner' | 'advanced');
      return {
        ok: true,
        data: {
          mode: modeManager.getMode(),
          config: modeManager.getModeConfig(),
          message: `Switched to ${body.mode} mode`,
        },
      };
    },
    {
      body: t.Object({
        mode: t.Enum({ beginner: 'beginner', advanced: 'advanced' }),
      }),
    },
  )
  .post('/toggle', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const modeManager = getModeManager();
    const newMode = modeManager.toggleMode();
    return {
      ok: true,
      data: {
        mode: newMode,
        config: modeManager.getModeConfig(),
        message: `Switched to ${newMode} mode`,
      },
    };
  });
