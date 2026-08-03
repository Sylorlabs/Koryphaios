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
  listProjectMemoryDocuments,
  createProjectMemoryDocument,
  readProjectMemoryDocument,
  writeProjectMemoryDocument,
} from '../../memory/unified-memory';
import { getRequestProjectRoot } from '../../runtime/request-project';

export const memoryRoutes = new Elysia({ prefix: '/api/memory' })
  .get('/documents', async ({ request }) => {
    return { ok: true, data: listProjectMemoryDocuments(getRequestProjectRoot(request)) };
  })
  .post('/documents', async ({ request, body, set }) => {
    try { return { ok: true, data: createProjectMemoryDocument(getRequestProjectRoot(request), body.name, body.kind) }; }
    catch (err) { set.status = 400; return { ok: false, error: err instanceof Error ? err.message : 'Failed to create document' }; }
  }, { body: t.Object({ name: t.String(), kind: t.Union([t.Literal('memory'), t.Literal('rules')]) }) })
  .get('/documents/:kind/:name', async ({ request, params, set }) => {
    try {
      return { ok: true, data: readProjectMemoryDocument(getRequestProjectRoot(request), params.name, params.kind) };
    } catch (err) {
      set.status = 404;
      return { ok: false, error: err instanceof Error ? err.message : 'Failed to read document' };
    }
  }, { params: t.Object({ kind: t.Union([t.Literal('memory'), t.Literal('rules')]), name: t.String() }) })
  .put('/documents/:kind/:name', async ({ request, params, body, set }) => {
    try {
      return { ok: true, data: writeProjectMemoryDocument(getRequestProjectRoot(request), params.name, params.kind, body.content) };
    } catch (err) {
      set.status = 400;
      return { ok: false, error: err instanceof Error ? err.message : 'Failed to write document' };
    }
  }, {
    params: t.Object({ kind: t.Union([t.Literal('memory'), t.Literal('rules')]), name: t.String() }),
    body: t.Object({ content: t.String() }),
  })
  // Universal Memory
  .get('/universal', async () => {
    return { ok: true, data: readUniversalMemory() };
  })
  .put(
    '/universal',
    async ({ body, set }) => {
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
  .post('/universal/init', async () => {
    return { ok: true, data: initializeUniversalMemory() };
  })

  // Project Memory
  .get('/project', async ({ request }) => {
    return { ok: true, data: readProjectMemory(getRequestProjectRoot(request)) };
  })
  .put(
    '/project',
    async ({ request, body, set }) => {
      try {
        const memory = writeProjectMemory(getRequestProjectRoot(request), body.content);
        return { ok: true, data: memory };
      } catch (err: any) {
        set.status = 500;
        return { ok: false, error: err.message ?? 'Failed to write project memory' };
      }
    },
    { body: t.Object({ content: t.String() }) },
  )
  .post('/project/init', async ({ request }) => {
    return { ok: true, data: initializeProjectMemory(getRequestProjectRoot(request)) };
  })

  // Session Memory
  .get('/sessions/:id', async ({ request, params: { id }, set }) => {
    const validatedId = validateSessionId(id);
    if (!validatedId) {
      set.status = 400;
      return { ok: false, error: 'Invalid session ID' };
    }
    return { ok: true, data: readSessionMemory(getRequestProjectRoot(request), validatedId) };
  })
  .put(
    '/sessions/:id',
    async ({ request, params: { id }, body, set }) => {
      const validatedId = validateSessionId(id);
      if (!validatedId) {
        set.status = 400;
        return { ok: false, error: 'Invalid session ID' };
      }
      try {
        const memory = writeSessionMemory(getRequestProjectRoot(request), validatedId, body.content);
        return { ok: true, data: memory };
      } catch (err: any) {
        set.status = 500;
        return { ok: false, error: err.message ?? 'Failed to write session memory' };
      }
    },
    { body: t.Object({ content: t.String() }) },
  )
  .post('/sessions/:id/init', async ({ request, params: { id }, set }) => {
    const validatedId = validateSessionId(id);
    if (!validatedId) {
      set.status = 400;
      return { ok: false, error: 'Invalid session ID' };
    }
    return { ok: true, data: initializeSessionMemory(getRequestProjectRoot(request), validatedId) };
  })
  .delete('/sessions/:id', async ({ request, params: { id }, set }) => {
    const validatedId = validateSessionId(id);
    if (!validatedId) {
      set.status = 400;
      return { ok: false, error: 'Invalid session ID' };
    }
    const success = deleteSessionMemory(getRequestProjectRoot(request), validatedId);
    if (!success) set.status = 500;
    return { ok: success };
  })

  // Rules
  .get('/rules', async ({ request }) => {
    return { ok: true, data: readRules(getRequestProjectRoot(request)) };
  })
  .put(
    '/rules',
    async ({ request, body, set }) => {
      try {
        const rules = writeRules(getRequestProjectRoot(request), body.content);
        return { ok: true, data: rules };
      } catch (err: any) {
        set.status = 500;
        return { ok: false, error: err.message ?? 'Failed to write rules' };
      }
    },
    { body: t.Object({ content: t.String() }) },
  )
  .post('/rules/init', async ({ request }) => {
    return { ok: true, data: initializeRules(getRequestProjectRoot(request)) };
  })

  // Settings
  .get('/settings', async ({ request }) => {
    return { ok: true, data: loadMemorySettings(getRequestProjectRoot(request)) };
  })
  .put('/settings', async ({ request, body, set }) => {
    try {
      const root = getRequestProjectRoot(request);
      const currentSettings = loadMemorySettings(root);
      const newSettings = { ...currentSettings, ...(body as any) };
      saveMemorySettings(root, newSettings as any);
      return { ok: true, data: newSettings };
    } catch (err: any) {
      set.status = 500;
      return { ok: false, error: err.message ?? 'Failed to save settings' };
    }
  })
  .post('/settings/reset', async ({ request }) => {
    saveMemorySettings(getRequestProjectRoot(request), DEFAULT_MEMORY_SETTINGS);
    return { ok: true, data: DEFAULT_MEMORY_SETTINGS };
  })

  // Context & Stats
  .get(
    '/context',
    async ({ request, query }) => {
      const context = assembleMemoryContext(getRequestProjectRoot(request), query.sessionId ?? null);
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
    async ({ request, query }) => {
      return { ok: true, data: getMemoryStats(getRequestProjectRoot(request), query.sessionId ?? undefined) };
    },
    {
      query: t.Object({
        sessionId: t.Optional(t.String()),
      }),
    },
  );
