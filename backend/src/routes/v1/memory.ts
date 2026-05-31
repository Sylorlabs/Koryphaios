import { Elysia, t } from 'elysia';
import { validateSessionId } from '../../security';
import {
  readUniversalMemory,
  writeUniversalMemory,
  readProjectMemory,
  writeProjectMemory,
  readSessionMemory,
  writeSessionMemory,
  deleteSessionMemory,
  readRules,
  writeRules,
  loadMemorySettings,
  saveMemorySettings,
  assembleMemoryContext,
  formatMemoryForContext,
  getMemoryStats,
  initializeUniversalMemory,
  initializeProjectMemory,
  initializeSessionMemory,
  initializeRules,
  DEFAULT_MEMORY_SETTINGS,
} from '../../memory/unified-memory';
import { PROJECT_ROOT } from '../../runtime/paths';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';

export const memoryRoutes = new Elysia({ prefix: '/api/memory' })
  // Universal Memory
  .get('/universal', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    return { ok: true, data: readUniversalMemory() };
  })
  .put(
    '/universal',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      try {
        const memory = writeUniversalMemory(body.content);
        return { ok: true, data: memory };
      } catch (err: any) {
        set.status = 500;
        return { ok: false, error: err.message ?? 'Failed to write universal memory' };
      }
    },
    { body: t.Object({ content: t.String() }) },
  )
  .post('/universal/init', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    return { ok: true, data: initializeUniversalMemory() };
  })

  // Project Memory
  .get('/project', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    return { ok: true, data: readProjectMemory(PROJECT_ROOT) };
  })
  .put(
    '/project',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      try {
        const memory = writeProjectMemory(PROJECT_ROOT, body.content);
        return { ok: true, data: memory };
      } catch (err: any) {
        set.status = 500;
        return { ok: false, error: err.message ?? 'Failed to write project memory' };
      }
    },
    { body: t.Object({ content: t.String() }) },
  )
  .post('/project/init', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    return { ok: true, data: initializeProjectMemory(PROJECT_ROOT) };
  })

  // Session Memory
  .get('/sessions/:id', async ({ request, params: { id }, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const validatedId = validateSessionId(id);
    if (!validatedId) {
      set.status = 400;
      return { ok: false, error: 'Invalid session ID' };
    }
    return { ok: true, data: readSessionMemory(PROJECT_ROOT, validatedId) };
  })
  .put(
    '/sessions/:id',
    async ({ request, params: { id }, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const validatedId = validateSessionId(id);
      if (!validatedId) {
        set.status = 400;
        return { ok: false, error: 'Invalid session ID' };
      }
      try {
        const memory = writeSessionMemory(PROJECT_ROOT, validatedId, body.content);
        return { ok: true, data: memory };
      } catch (err: any) {
        set.status = 500;
        return { ok: false, error: err.message ?? 'Failed to write session memory' };
      }
    },
    { body: t.Object({ content: t.String() }) },
  )
  .post('/sessions/:id/init', async ({ request, params: { id }, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const validatedId = validateSessionId(id);
    if (!validatedId) {
      set.status = 400;
      return { ok: false, error: 'Invalid session ID' };
    }
    return { ok: true, data: initializeSessionMemory(PROJECT_ROOT, validatedId) };
  })
  .delete('/sessions/:id', async ({ request, params: { id }, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const validatedId = validateSessionId(id);
    if (!validatedId) {
      set.status = 400;
      return { ok: false, error: 'Invalid session ID' };
    }
    const success = deleteSessionMemory(PROJECT_ROOT, validatedId);
    if (!success) set.status = 500;
    return { ok: success };
  })

  // Rules
  .get('/rules', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    return { ok: true, data: readRules(PROJECT_ROOT) };
  })
  .put(
    '/rules',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      try {
        const rules = writeRules(PROJECT_ROOT, body.content);
        return { ok: true, data: rules };
      } catch (err: any) {
        set.status = 500;
        return { ok: false, error: err.message ?? 'Failed to write rules' };
      }
    },
    { body: t.Object({ content: t.String() }) },
  )
  .post('/rules/init', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    return { ok: true, data: initializeRules(PROJECT_ROOT) };
  })

  // Settings
  .get('/settings', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    return { ok: true, data: loadMemorySettings(PROJECT_ROOT) };
  })
  .put('/settings', async ({ request, body, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    try {
      const currentSettings = loadMemorySettings(PROJECT_ROOT);
      const newSettings = { ...currentSettings, ...(body as any) };
      saveMemorySettings(PROJECT_ROOT, newSettings as any);
      return { ok: true, data: newSettings };
    } catch (err: any) {
      set.status = 500;
      return { ok: false, error: err.message ?? 'Failed to save settings' };
    }
  })
  .post('/settings/reset', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    saveMemorySettings(PROJECT_ROOT, DEFAULT_MEMORY_SETTINGS);
    return { ok: true, data: DEFAULT_MEMORY_SETTINGS };
  })

  // Context & Stats
  .get(
    '/context',
    async ({ request, query, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const context = assembleMemoryContext(PROJECT_ROOT, query.sessionId ?? null);
      const formatted = formatMemoryForContext(context);
      return {
        ok: true,
        data: {
          context,
          formatted,
          tokenEstimate: Math.ceil(formatted.length / 4),
        },
      };
    },
    {
      query: t.Object({
        sessionId: t.Optional(t.String()),
      }),
    },
  )
  .get(
    '/stats',
    async ({ request, query, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      return { ok: true, data: getMemoryStats(PROJECT_ROOT, query.sessionId ?? undefined) };
    },
    {
      query: t.Object({
        sessionId: t.Optional(t.String()),
      }),
    },
  );
