import { Elysia, t } from 'elysia';
import { PROJECT_ROOT } from '../../runtime/paths';
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
import { DOMAIN } from '../../constants';
import { resolveModel } from '../../providers';
import { syncAssignmentsToConfig } from '../../runtime/config';

/**
 * Routing categories the user can override a model for. The manager's smart
 * router uses these per-domain assignments (config.assignments) ahead of the
 * built-in DOMAIN.DEFAULT_MODELS, falling back to "auto" when unset.
 */
const ROUTING_CATEGORIES: Array<{ id: keyof typeof DOMAIN.DEFAULT_MODELS; label: string; description: string }> = [
  { id: 'ui', label: 'UI / Frontend', description: 'Svelte, components, styling, design work' },
  { id: 'backend', label: 'Backend', description: 'APIs, services, server logic, data' },
  { id: 'general', label: 'General', description: 'Default for uncategorized tasks' },
  { id: 'test', label: 'Testing', description: 'Writing and fixing tests' },
  { id: 'review', label: 'Review', description: 'Reviewing code and changes' },
  { id: 'critic', label: 'Critic', description: 'The harshest gate — best on a different model than the coder' },
];

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
    const settings = loadAgentSettings(PROJECT_ROOT);
    return {
      ok: true,
      data: settings,
      message: 'Rules are always enforced. Critic enforces based on enforcement level.',
    };
  })
  .put('/settings', async ({ request, body, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    try {
      const currentSettings = loadAgentSettings(PROJECT_ROOT);
      const newSettings = { ...currentSettings, ...(body as any) };
      saveAgentSettings(PROJECT_ROOT, newSettings as any);
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
    const settings = resetAgentSettings(PROJECT_ROOT);
    return {
      ok: true,
      data: settings,
      message: 'Agent settings reset to defaults. Rules still enforced.',
    };
  })
  // Per-category model routing. The smart router uses these overrides ahead of
  // the built-in defaults; unset categories resolve to "auto".
  .get('/assignments', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const { config } = getContext();
    const current = (config.assignments ?? {}) as Record<string, string>;
    const categories = ROUTING_CATEGORIES.map((c) => ({
      id: c.id,
      label: c.label,
      description: c.description,
      defaultModel: DOMAIN.DEFAULT_MODELS[c.id],
      value: current[c.id] ?? '',
    }));
    return { ok: true, data: { categories, assignments: current } };
  })
  .put(
    '/assignments',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      try {
        const incoming = (body.assignments ?? {}) as Record<string, string>;
        const validDomains = new Set(ROUTING_CATEGORIES.map((c) => c.id as string));
        const cleaned: Record<string, string> = {};
        for (const [domain, raw] of Object.entries(incoming)) {
          if (!validDomains.has(domain)) continue;
          const v = (raw ?? '').trim();
          if (!v || v === 'auto') continue; // empty/auto = use smart-router default
          // Accept "provider:model" or a bare model id; validate the model resolves.
          const modelId = v.includes(':') ? v.split(':')[1]! : v;
          if (!resolveModel(modelId)) {
            set.status = 400;
            return { ok: false, error: `Unknown model "${v}" for category "${domain}"` };
          }
          cleaned[domain] = v;
        }
        // Mutate the live config so routing picks it up immediately, then persist.
        const { config } = getContext();
        (config as any).assignments = cleaned;
        syncAssignmentsToConfig(PROJECT_ROOT, cleaned);
        return { ok: true, data: { assignments: cleaned }, message: 'Routing updated.' };
      } catch (err: any) {
        set.status = 500;
        return { ok: false, error: err.message ?? 'Failed to save assignments' };
      }
    },
    {
      body: t.Object({
        assignments: t.Record(t.String(), t.String()),
      }),
    },
  )
  .get('/preferences', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const prefs = readPreferences(PROJECT_ROOT);
    return { ok: true, data: prefs };
  })
  .put(
    '/preferences',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      try {
        writePreferences(PROJECT_ROOT, body.content);
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
    const prefs = initializePreferences(PROJECT_ROOT);
    return {
      ok: true,
      data: prefs,
      message: 'Preferences initialized with comprehensive template.',
    };
  })
  .get('/context', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const settings = loadAgentSettings(PROJECT_ROOT);
    const context = assembleAgentContext(PROJECT_ROOT, settings);
    return { ok: true, data: context };
  })
  .post(
    '/enforce',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      try {
        const settings = loadAgentSettings(PROJECT_ROOT);
        const preferences = readPreferences(PROJECT_ROOT).content;
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
        const settings = loadAgentSettings(PROJECT_ROOT);
        const preferences = readPreferences(PROJECT_ROOT).content;
        let rules = '';
        try {
          rules = readFileSync(join(PROJECT_ROOT, '.koryrules'), 'utf-8');
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
    const stats = getAgentSettingsStats(PROJECT_ROOT);
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
