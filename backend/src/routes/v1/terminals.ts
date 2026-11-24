// Integrated terminal REST surface. Every route is local-authenticated and names
// its chat with `sessionId`; the lookup runs against that chat's own terminal
// table, so one chat can never read or drive another chat's shell.
// Linked devices never reach these routes (see remote-target REST descriptors).

import { Elysia, t } from 'elysia';
import type { TerminalScope } from '@koryphaios/shared';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';
import { getContext } from '../../context';
import {
  AuthenticationError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../errors/types';
import { terminalService, type TerminalTable } from '../../terminal/terminal-service';

async function requireTerminalSession(sessionId: string, mode: 'active' | 'any'): Promise<void> {
  const { sessions } = getContext();
  if (await sessions.getActive(sessionId)) return;
  if (mode === 'any' && (await sessions.get(sessionId))) return;
  if (await sessions.get(sessionId)) {
    throw new ConflictError('Recover this archived chat before opening a terminal.');
  }
  throw new NotFoundError('Session', sessionId);
}

/** Read paths never create a chat's runtime; a missing runtime has no terminals. */
function readTable(sessionId: string): TerminalTable {
  return getContext().kory.peekSessionRuntime(sessionId)?.terminals ?? new Map();
}

async function resolveTerminalCwd(sessionId: string, scope: TerminalScope): Promise<string> {
  const { kory, sessions } = getContext();
  if (scope === 'chat') return kory.resolveSessionWorkingDirectoryPublic(sessionId);
  const session = await sessions.get(sessionId);
  if (!session?.workingDirectory) {
    throw new ValidationError('This chat has no project folder to open a project terminal in.');
  }
  return session.workingDirectory;
}

function requireAuth(request: Request): void {
  if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
}

export const terminalRoutes = new Elysia({ prefix: '/api/terminals' })
  .get(
    '/',
    async ({ request, query }) => {
      requireAuth(request);
      await requireTerminalSession(query.sessionId, 'any');
      return { ok: true, terminals: terminalService.list(readTable(query.sessionId)) };
    },
    { query: t.Object({ sessionId: t.String({ minLength: 1, maxLength: 200 }) }) },
  )
  .post(
    '/',
    async ({ request, body }) => {
      requireAuth(request);
      const sessionId = body.sessionId;
      await requireTerminalSession(sessionId, 'active');
      const scope: TerminalScope = body.scope ?? 'chat';
      const cwd = await resolveTerminalCwd(sessionId, scope);
      const { kory } = getContext();
      const table = kory.sessionRuntimeFor(sessionId).terminals;
      const session = terminalService.create(table, {
        sessionId,
        scope,
        cwd,
        cols: body.cols ?? 80,
        rows: body.rows ?? 24,
        name: body.name,
      });
      return { ok: true, terminal: session.info() };
    },
    {
      body: t.Object({
        sessionId: t.String({ minLength: 1, maxLength: 200 }),
        scope: t.Optional(t.Union([t.Literal('chat'), t.Literal('project')])),
        cols: t.Optional(t.Number()),
        rows: t.Optional(t.Number()),
        name: t.Optional(t.String({ maxLength: 60 })),
      }),
    },
  )
  .get(
    '/:id',
    async ({ request, params: { id }, query }) => {
      requireAuth(request);
      await requireTerminalSession(query.sessionId, 'any');
      return { ok: true, terminal: terminalService.get(readTable(query.sessionId), id).info() };
    },
    { query: t.Object({ sessionId: t.String({ minLength: 1, maxLength: 200 }) }) },
  )
  .get(
    '/:id/scrollback',
    async ({ request, params: { id }, query }) => {
      requireAuth(request);
      await requireTerminalSession(query.sessionId, 'any');
      return { ok: true, scrollback: terminalService.scrollback(readTable(query.sessionId), id) };
    },
    { query: t.Object({ sessionId: t.String({ minLength: 1, maxLength: 200 }) }) },
  )
  .delete(
    '/:id',
    async ({ request, params: { id }, query }) => {
      requireAuth(request);
      await requireTerminalSession(query.sessionId, 'any');
      const table = readTable(query.sessionId);
      if (!table.has(id)) throw new NotFoundError('Terminal', id);
      terminalService.remove(table, id);
      return { ok: true };
    },
    { query: t.Object({ sessionId: t.String({ minLength: 1, maxLength: 200 }) }) },
  );
