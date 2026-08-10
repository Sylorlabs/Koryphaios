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
  normalizeMemorySettings,
} from '../../memory/unified-memory';
import { getRequestProjectRoot } from '../../runtime/request-project';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';
import { AuthenticationError, ValidationError, InternalError } from '../../errors/types';
import type { MemorySettings } from '../../memory/unified-memory';

function publicFile<T extends { path: string }>(file: T, logicalPath: string): T {
  return { ...file, path: logicalPath };
}

function publicDocument<T extends { name: string; path: string; kind: 'memory' | 'rules' }>(
  document: T,
): T {
  return publicFile(document, `${document.kind}/${document.name}`);
}

export const memoryRoutes = new Elysia({ prefix: '/api/memory' })
  .get('/documents', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) throw new AuthenticationError('Unauthorized');
    return {
      ok: true,
      data: listProjectMemoryDocuments(getRequestProjectRoot(request)).map(publicDocument),
    };
  })
  .post(
    '/documents',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) throw new AuthenticationError('Unauthorized');
      return {
        ok: true,
        data: publicDocument(
          createProjectMemoryDocument(getRequestProjectRoot(request), body.name, body.kind),
        ),
      };
    },
    {
      body: t.Object({
        name: t.String(),
        kind: t.Union([t.Literal('memory'), t.Literal('rules')]),
      }),
    },
  )
  .get('/documents/:kind/:name', async ({ request, params, set }) => {
    if (!requireLocalRouteAuth(request, set)) throw new AuthenticationError('Unauthorized');
    const kind = params.kind === 'memory' || params.kind === 'rules' ? params.kind : null;
    if (!kind) throw new ValidationError('Invalid document kind');
    return {
      ok: true,
      data: publicFile(
        readProjectMemoryDocument(getRequestProjectRoot(request), params.name, kind),
        `${kind}/${params.name}`,
      ),
    };
  })
  .put(
    '/documents/:kind/:name',
    async ({ request, params, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) throw new AuthenticationError('Unauthorized');
      if (body.expectedRevision === undefined) {
        throw new ValidationError('expectedRevision is required for Memory document updates');
      }
      const kind = params.kind === 'memory' || params.kind === 'rules' ? params.kind : null;
      if (!kind) throw new ValidationError('Invalid document kind');
      return {
        ok: true,
        data: publicFile(
          writeProjectMemoryDocument(
            getRequestProjectRoot(request),
            params.name,
            kind,
            body.content,
            body.expectedRevision,
          ),
          `${kind}/${params.name}`,
        ),
      };
    },
    {
      body: t.Object({
        content: t.String(),
        expectedRevision: t.Optional(t.Union([t.String(), t.Null()])),
      }),
    },
  )
  // Universal Memory
  .get('/universal', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) throw new AuthenticationError('Unauthorized');
    return { ok: true, data: publicFile(readUniversalMemory(), 'universal') };
  })
  .put(
    '/universal',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) throw new AuthenticationError('Unauthorized');
      if (body.expectedRevision === undefined) {
        throw new ValidationError('expectedRevision is required for Memory document updates');
      }
      const root = getRequestProjectRoot(request);
      const memory = writeUniversalMemory(body.content, root, body.expectedRevision);
      return { ok: true, data: publicFile(memory, 'universal') };
    },
    {
      body: t.Object({
        content: t.String(),
        expectedRevision: t.Optional(t.Union([t.String(), t.Null()])),
      }),
    },
  )
  .post('/universal/init', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) throw new AuthenticationError('Unauthorized');
    return {
      ok: true,
      data: publicFile(initializeUniversalMemory(getRequestProjectRoot(request)), 'universal'),
    };
  })

  // Project Memory
  .get('/project', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) throw new AuthenticationError('Unauthorized');
    return {
      ok: true,
      data: publicFile(readProjectMemory(getRequestProjectRoot(request)), 'project'),
    };
  })
  .put(
    '/project',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) throw new AuthenticationError('Unauthorized');
      if (body.expectedRevision === undefined) {
        throw new ValidationError('expectedRevision is required for Memory document updates');
      }
      const memory = writeProjectMemory(
        getRequestProjectRoot(request),
        body.content,
        body.expectedRevision,
      );
      return { ok: true, data: publicFile(memory, 'project') };
    },
    {
      body: t.Object({
        content: t.String(),
        expectedRevision: t.Optional(t.Union([t.String(), t.Null()])),
      }),
    },
  )
  .post('/project/init', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) throw new AuthenticationError('Unauthorized');
    return {
      ok: true,
      data: publicFile(initializeProjectMemory(getRequestProjectRoot(request)), 'project'),
    };
  })

  // Session Memory
  .get('/sessions/:id', async ({ request, params: { id }, set }) => {
    if (!requireLocalRouteAuth(request, set)) throw new AuthenticationError('Unauthorized');
    const validatedId = validateSessionId(id);
    if (!validatedId) throw new ValidationError('Invalid session ID');
    return {
      ok: true,
      data: publicFile(
        readSessionMemory(getRequestProjectRoot(request), validatedId),
        `session/${validatedId}`,
      ),
    };
  })
  .put(
    '/sessions/:id',
    async ({ request, params: { id }, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) throw new AuthenticationError('Unauthorized');
      if (body.expectedRevision === undefined) {
        throw new ValidationError('expectedRevision is required for Memory document updates');
      }
      const validatedId = validateSessionId(id);
      if (!validatedId) throw new ValidationError('Invalid session ID');
      const memory = writeSessionMemory(
        getRequestProjectRoot(request),
        validatedId,
        body.content,
        body.expectedRevision,
      );
      return { ok: true, data: publicFile(memory, `session/${validatedId}`) };
    },
    {
      body: t.Object({
        content: t.String(),
        expectedRevision: t.Optional(t.Union([t.String(), t.Null()])),
      }),
    },
  )
  .post('/sessions/:id/init', async ({ request, params: { id }, set }) => {
    if (!requireLocalRouteAuth(request, set)) throw new AuthenticationError('Unauthorized');
    const validatedId = validateSessionId(id);
    if (!validatedId) throw new ValidationError('Invalid session ID');
    return {
      ok: true,
      data: publicFile(
        initializeSessionMemory(getRequestProjectRoot(request), validatedId),
        `session/${validatedId}`,
      ),
    };
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
    return { ok: true, data: publicFile(readRules(getRequestProjectRoot(request)), 'rules') };
  })
  .put(
    '/rules',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) throw new AuthenticationError('Unauthorized');
      if (body.expectedRevision === undefined) {
        throw new ValidationError('expectedRevision is required for Memory document updates');
      }
      const rules = writeRules(getRequestProjectRoot(request), body.content, body.expectedRevision);
      return { ok: true, data: publicFile(rules, 'rules') };
    },
    {
      body: t.Object({
        content: t.String(),
        expectedRevision: t.Optional(t.Union([t.String(), t.Null()])),
      }),
    },
  )
  .post('/rules/init', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) throw new AuthenticationError('Unauthorized');
    return {
      ok: true,
      data: publicFile(initializeRules(getRequestProjectRoot(request)), 'rules'),
    };
  })

  // Settings
  .get('/settings', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) throw new AuthenticationError('Unauthorized');
    return { ok: true, data: loadMemorySettings(getRequestProjectRoot(request)) };
  })
  .put(
    '/settings',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) throw new AuthenticationError('Unauthorized');
      const root = getRequestProjectRoot(request);
      const currentSettings = loadMemorySettings(root);
      const newSettings = normalizeMemorySettings({
        ...currentSettings,
        ...(body as Partial<MemorySettings>),
      });
      saveMemorySettings(root, newSettings);
      return { ok: true, data: newSettings };
    },
    {
      body: t.Object({
        universalMemoryEnabled: t.Optional(t.Boolean()),
        projectMemoryEnabled: t.Optional(t.Boolean()),
        sessionMemoryEnabled: t.Optional(t.Boolean()),
        agentMemoryEnabled: t.Optional(t.Boolean()),
        rulesEnabled: t.Optional(t.Boolean()),
        autoIncludeInContext: t.Optional(t.Boolean()),
        maxContextTokens: t.Optional(t.Number()),
        maxContextTokensEnabled: t.Optional(t.Boolean()),
        autosaveEnabled: t.Optional(t.Boolean()),
        autosaveDelayMs: t.Optional(t.Number()),
        documentSizeLimitEnabled: t.Optional(t.Boolean()),
        maxDocumentBytes: t.Optional(t.Number()),
      }),
    },
  )
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
      const context = assembleMemoryContext(
        getRequestProjectRoot(request),
        query.sessionId ?? null,
      );
      const formatted = formatMemoryForContext(context);
      const publicContext = {
        ...context,
        universal: context.universal ? publicFile(context.universal, 'universal') : null,
        project: context.project ? publicFile(context.project, 'project') : null,
        session: context.session
          ? publicFile(context.session, `session/${query.sessionId ?? 'current'}`)
          : null,
        rules: context.rules ? publicFile(context.rules, 'rules') : null,
      };
      return {
        ok: true,
        data: {
          context: publicContext,
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
      const stats = getMemoryStats(getRequestProjectRoot(request), query.sessionId ?? undefined);
      return {
        ok: true,
        data: {
          ...stats,
          files: {
            universal: publicFile(stats.files.universal, 'universal'),
            project: publicFile(stats.files.project, 'project'),
            session: stats.files.session
              ? publicFile(stats.files.session, `session/${query.sessionId ?? 'current'}`)
              : null,
            rules: publicFile(stats.files.rules, 'rules'),
          },
          paths: {
            universal: 'universal',
            project: 'project',
            session: query.sessionId ? `session/${query.sessionId}` : null,
            rules: 'rules',
            settings: 'settings',
          },
        },
      };
    },
    {
      query: t.Object({
        sessionId: t.Optional(t.String()),
      }),
    },
  );
