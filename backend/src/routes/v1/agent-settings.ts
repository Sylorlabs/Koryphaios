import { Elysia, t } from 'elysia';
import { getRequestProjectRoot } from '../../runtime/request-project';
import { getContext } from '../../context';
import {
  loadAgentSettings,
  saveAgentSettings,
  resetAgentSettings,
  initializePreferences,
  readPreferences,
  writePreferences,
  assembleAgentContext,
  criticReview,
  getAgentSettingsStats,
  enforceRules,
  DEFAULT_AGENT_SETTINGS,
} from '../../agent-settings';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';

export const agentSettingsRoutes = new Elysia({ prefix: '/api/agent' })
  .get(
    '/threads/:sessionId',
    async ({ request, params: { sessionId }, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const { sessions, kory } = getContext();
      const session = await sessions.get(sessionId);
      if (!session) {
        set.status = 404;
        return { ok: false, error: 'Session not found' };
      }
      return { ok: true, data: kory.getAgentThreadsForSession(sessionId) };
    },
  )
  .get(
    '/:agentId/thread',
    async ({ request, params: { agentId }, query, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const sessionId = String(query.sessionId ?? '');
      if (!sessionId) {
        set.status = 400;
        return { ok: false, error: 'sessionId is required' };
      }
      const { sessions, kory } = getContext();
      const session = await sessions.get(sessionId);
      if (!session) {
        set.status = 404;
        return { ok: false, error: 'Session not found' };
      }
      return { ok: true, data: kory.getAgentThreadEntries(sessionId, agentId) };
    },
    {
      query: t.Object({
        sessionId: t.String(),
      }),
    },
  )
  .post(
    '/:agentId/message',
    async ({ request, params: { agentId }, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const { sessions, kory } = getContext();
      const session = await sessions.get(body.sessionId);
      if (!session) {
        set.status = 404;
        return { ok: false, error: 'Session not found' };
      }
      try {
        await kory.sendMessageToAgent(body.sessionId, agentId, body.content);
        return { ok: true, data: { status: 'processing' } };
      } catch (err: any) {
        const message = err?.message ?? 'Failed to message agent';
        set.status = message.includes('already working') ? 409 : 400;
        return { ok: false, error: message };
      }
    },
    {
      body: t.Object({
        sessionId: t.String(),
        content: t.String(),
      }),
    },
  )
  .post('/:agentId/cancel', async ({ request, params: { agentId }, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const { kory } = getContext();
    kory.cancelWorker(agentId);
    return { ok: true, message: 'Agent cancelled' };
  })
  .get('/settings', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const settings = loadAgentSettings(getRequestProjectRoot(request));
    return {
      ok: true,
      data: settings,
      message: 'Rules are always enforced. Critic enforces based on enforcement level.',
    };
  })
  .put('/settings', async ({ request, body, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    try {
      const root = getRequestProjectRoot(request);
      const currentSettings = loadAgentSettings(root);
      const newSettings = { ...currentSettings, ...(body as any) };
      saveAgentSettings(root, newSettings as any);
      return {
        ok: true,
        data: newSettings,
        message: 'Agent settings updated. Rules remain enforced.',
      };
    } catch (err: any) {
      set.status = 500;
      return { ok: false, error: err.message ?? 'Failed to save agent settings' };
    }
  })
  .post('/settings/reset', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const settings = resetAgentSettings(getRequestProjectRoot(request));
    return {
      ok: true,
      data: settings,
      message: 'Agent settings reset to defaults. Rules still enforced.',
    };
  })
  .get('/preferences', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const prefs = readPreferences(getRequestProjectRoot(request));
    return { ok: true, data: prefs };
  })
  .put(
    '/preferences',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      try {
        writePreferences(getRequestProjectRoot(request), body.content);
        return { ok: true, message: 'Preferences updated. Critic will enforce new rules.' };
      } catch (err: any) {
        set.status = 500;
        return { ok: false, error: err.message ?? 'Failed to save preferences' };
      }
    },
    {
      body: t.Object({
        content: t.String(),
      }),
    },
  )
  .post('/preferences/init', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const prefs = initializePreferences(getRequestProjectRoot(request));
    return {
      ok: true,
      data: prefs,
      message: 'Preferences initialized with comprehensive template.',
    };
  })
  .get('/context', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const root = getRequestProjectRoot(request);
    const settings = loadAgentSettings(root);
    const context = assembleAgentContext(root, settings);
    return { ok: true, data: context };
  })
  .post(
    '/enforce',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      try {
        const root = getRequestProjectRoot(request);
        const settings = loadAgentSettings(root);
        const preferences = readPreferences(root).content;
        const result = enforceRules(
          body.code,
          body.filePath,
          preferences,
          settings.ruleEnforcementLevel,
        );
        return { ok: true, data: result };
      } catch (err: any) {
        set.status = 500;
        return { ok: false, error: err.message ?? 'Failed to enforce rules' };
      }
    },
    {
      body: t.Object({
        code: t.String(),
        filePath: t.String(),
      }),
    },
  )
  .post(
    '/critic-review',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      try {
        const root = getRequestProjectRoot(request);
        const settings = loadAgentSettings(root);
        const preferences = readPreferences(root).content;
        let rules = '';
        try {
          rules = readFileSync(join(root, '.koryphaios/rules/rules.md'), 'utf-8');
        } catch {}

        const result = criticReview({
          code: body.code,
          filePath: body.filePath,
          changeDescription: body.changeDescription || 'Code change',
          settings,
          preferences,
          rules,
        });

        return { ok: true, data: result };
      } catch (err: any) {
        set.status = 500;
        return { ok: false, error: err.message ?? 'Critic review failed' };
      }
    },
    {
      body: t.Object({
        code: t.String(),
        filePath: t.String(),
        changeDescription: t.Optional(t.String()),
      }),
    },
  )
  .get('/stats', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const stats = getAgentSettingsStats(getRequestProjectRoot(request));
    return { ok: true, data: stats };
  })
  .get('/defaults', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    return {
      ok: true,
      data: DEFAULT_AGENT_SETTINGS,
      message: 'Default agent settings. Rules always enforced.',
    };
  });
