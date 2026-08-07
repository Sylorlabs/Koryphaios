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
} from '../../memory/unified-memory';
import { getRequestProjectRoot } from '../../runtime/request-project';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';
import { AuthenticationError, ValidationError, InternalError } from '../../errors/types';
import type { MemorySettings } from '../../memory/unified-memory';

export const memoryRoutes = new Elysia({ prefix: '/api/memory' })
  .get('/documents', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) throw new AuthenticationError('Unauthorized');
    return { ok: true, data: listProjectMemoryDocuments(getRequestProjectRoot(request)) };
  })
  .post('/documents', async ({ request, body, set }) => {
    if (!requireLocalRouteAuth(request, set)) throw new AuthenticationError('Unauthorized');
    return { ok: true, data: createProjectMemoryDocument(getRequestProjectRoot(request), body.name, body.kind) };
  }, { body: t.Object({ name: t.String(), kind: t.Union([t.Literal('memory'), t.Literal('rules')]) }) })
  // Universal Memory
  .get('/universal', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) throw new AuthenticationError('Unauthorized');
    return { ok: true, data: readUniversalMemory() };
  })
  .put(
    '/universal',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) throw new AuthenticationError('Unauthorized');
      const memory = writeUniversalMemory(body.content);
      return { ok: true, data: memory };
    },
    { body: t.Object({ content: t.String() }) },
  )
  .post('/universal/init', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) throw new AuthenticationError('Unauthorized');
    return { ok: true, data: initializeUniversalMemory() };
  })

  // Project Memory
  .get('/project', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) throw new AuthenticationError('Unauthorized');
    return { ok: true, data: readProjectMemory(getRequestProjectRoot(request)) };
  })
  .put(
    '/project',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) throw new AuthenticationError('Unauthorized');
      const memory = writeProjectMemory(getRequestProjectRoot(request), body.content);
      return { ok: true, data: memory };
    },
    { body: t.Object({ content: t.String() }) },
  )
  .post('/project/init', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) throw new AuthenticationError('Unauthorized');
    return { ok: true, data: initializeProjectMemory(getRequestProjectRoot(request)) };
  })

  // Session Memory
  .get('/sessions/:id', async ({ request, params: { id }, set }) => {
    if (!requireLocalRouteAuth(request, set)) throw new AuthenticationError('Unauthorized');
    const validatedId = validateSessionId(id);
    if (!validatedId) throw new ValidationError('Invalid session ID');
    return { ok: true, data: readSessionMemory(getRequestProjectRoot(request), validatedId) };
  })
  .put(
    '/sessions/:id',
    async ({ request, params: { id }, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) throw new AuthenticationError('Unauthorized');
      const validatedId = validateSessionId(id);
      if (!validatedId) throw new ValidationError('Invalid session ID');
      const memory = writeSessionMemory(getRequestProjectRoot(request), validatedId, body.content);
      return { ok: true, data: memory };
    },
    { body: t.Object({ content: t.String() }) },
  )
  .post('/sessions/:id/init', async ({ request, params: { id }, set }) => {
    if (!requireLocalRouteAuth(request, set)) throw new AuthenticationError('Unauthorized');
    const validatedId = validateSessionId(id);
    if (!validatedId) throw new ValidationError('Invalid session ID');
    return { ok: true, data: initializeSessionMemory(getRequestProjectRoot(request), validatedId) };
  })
  .delete('/sessions/:id', async ({ request, params: { id }, set }) => {
    if (!requireLocalRouteAuth(request, set)) throw new AuthenticationError('Unauthorized');
    const validatedId = validateSessionId(id);
    if (!validatedId) throw new ValidationError('Invalid session ID');
    const success = deleteSessionMemory(getRequestProjectRoot(request), validatedId);
    if (!success) throw new InternalError('Failed to delete session memory');
    return { ok: true };
  })

  // Rules
  .get('/rules', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) throw new AuthenticationError('Unauthorized');
    return { ok: true, data: readRules(getRequestProjectRoot(request)) };
  })
  .put(
    '/rules',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) throw new AuthenticationError('Unauthorized');
      const rules = writeRules(getRequestProjectRoot(request), body.content);
      return { ok: true, data: rules };
    },
    { body: t.Object({ content: t.String() }) },
  )
  .post('/rules/init', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) throw new AuthenticationError('Unauthorized');
    return { ok: true, data: initializeRules(getRequestProjectRoot(request)) };
  })

  // Settings
  .get('/settings', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) throw new AuthenticationError('Unauthorized');
    return { ok: true, data: loadMemorySettings(getRequestProjectRoot(request)) };
  })
  .put('/settings', async ({ request, body, set }) => {
    if (!requireLocalRouteAuth(request, set)) throw new AuthenticationError('Unauthorized');
    const root = getRequestProjectRoot(request);
    const currentSettings = loadMemorySettings(root);
    // Body is a partial overlay of MemorySettings; no schema validator is
    // applied on this route, so cast to the expected partial shape.
    const newSettings: MemorySettings = { ...currentSettings, ...(body as Partial<MemorySettings>) };
    saveMemorySettings(root, newSettings);
    return { ok: true, data: newSettings };
  })
  .post('/settings/reset', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) throw new AuthenticationError('Unauthorized');
    saveMemorySettings(getRequestProjectRoot(request), DEFAULT_MEMORY_SETTINGS);
    return { ok: true, data: DEFAULT_MEMORY_SETTINGS };
  })

  // Context & Stats
  .get(
    '/context',
    async ({ request, query, set }) => {
      if (!requireLocalRouteAuth(request, set)) throw new AuthenticationError('Unauthorized');
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
    async ({ request, query, set }) => {
      if (!requireLocalRouteAuth(request, set)) throw new AuthenticationError('Unauthorized');
      return { ok: true, data: getMemoryStats(getRequestProjectRoot(request), query.sessionId ?? undefined) };
    },
    {
      query: t.Object({
        sessionId: t.Optional(t.String()),
      }),
    },
  );
