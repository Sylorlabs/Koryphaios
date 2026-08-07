/**
 * Notes API Routes
 *
 * REST endpoints for the Obsidian-style note knowledge network.
 * Prefix: /api/notes
 *
 * Error handling: route handlers throw KoryphaiosError subclasses for
 * operational errors (not found, unauthorized, bad input) and let unknown
 * errors propagate to the global error-handling middleware
 * (middleware/error-handling.ts), which logs with context and formats the
 * response. Per AGENTS.md, route handlers do not try/catch just to format
 * errors — that duplicates the middleware and swallows context.
 */

import { Elysia, t } from 'elysia';
import { requireLocalRouteAuth, validateLocalBearerToken } from '../../auth/local-route-auth';
import * as notesService from '../../notes/notes-service';
import { broadcastNotesNetworkUpdate } from '../../notes/notes-events';
import {
  loadNotesAgentPermissions,
  saveNotesAgentPermissions,
  resetNotesAgentPermissions,
  loadNotesSettings,
  saveNotesSettings,
} from '../../notes/notes-settings';
import {
  DEFAULT_NOTES_AGENT_PERMISSIONS,
  type NotesAgentPermissions,
  type NotesSettings,
} from '@koryphaios/shared';
import { readFileSync, existsSync } from 'fs';
import { PROJECT_ROOT } from '../../runtime/paths';
import { getRequestProjectRoot } from '../../runtime/request-project';
import { traceBlockingOp } from '../../monitoring/event-loop-monitor';
import { AuthenticationError, NotFoundError, ValidationError } from '../../errors/types';

export const notesRoutes = new Elysia({ prefix: '/api/notes' })

  // ── List all notes (supports ?search=, ?folder=) ─────────────────────────
  .get('/', async ({ query }) => {
    const notesList = await notesService.listNotes(
      {
        folderPath: query.folder as string | undefined,
        search: query.search as string | undefined,
      },
      (query.projectRoot as string | undefined) || PROJECT_ROOT,
    );
    return { ok: true, data: notesList };
  })

  .post('/sync-project', async ({ request }) => {
    const url = new URL(request.url);
    const result = await traceBlockingOp('syncProjectDocuments', () =>
      notesService.syncProjectDocuments(url.searchParams.get('projectRoot') || PROJECT_ROOT),
    );
    broadcastNotesNetworkUpdate('update');
    return { ok: true, data: result };
  })

  // ── Create note ───────────────────────────────────────────────────────────
  .post(
    '/',
    async ({ body }) => {
      const note = await notesService.createNote(body);
      broadcastNotesNetworkUpdate('create', note.id);
      return { ok: true, data: note };
    },
    {
      body: t.Object({
        title: t.String(),
        content: t.Optional(t.String()),
        folderPath: t.Optional(t.String()),
        tags: t.Optional(t.Array(t.String())),
        pinned: t.Optional(t.Boolean()),
        includeInContext: t.Optional(t.Boolean()),
        format: t.Optional(t.Union([t.Literal('markdown'), t.Literal('html')])),
      }),
    },
  )

  // ── General notes settings ────────────────────────────────────────────────
  // Persisted server-side so context injection actually honors them.
  .get('/settings', async ({ request }) => {
    return { ok: true, data: loadNotesSettings(getRequestProjectRoot(request)) };
  })

  .put(
    '/settings',
    async ({ request, body }) => {
      const merged = saveNotesSettings(getRequestProjectRoot(request), body as Partial<NotesSettings>);
      return { ok: true, data: merged };
    },
    {
      body: t.Object({
        enabled: t.Optional(t.Boolean()),
        autoIncludeInContext: t.Optional(t.Boolean()),
        maxContextTokensEnabled: t.Optional(t.Boolean()),
        maxContextTokens: t.Optional(t.Number()),
        defaultFolderPath: t.Optional(t.String()),
        graphPhysics: t.Optional(
          t.Object({
            gravity: t.Optional(t.Number()),
            linkDistance: t.Optional(t.Number()),
            chargeStrength: t.Optional(t.Number()),
          }),
        ),
      }),
    },
  )

  // ── Agent permission settings ─────────────────────────────────────────────
  .get('/settings/agent-permissions', async ({ request }) => {
    return { ok: true, data: loadNotesAgentPermissions(getRequestProjectRoot(request)) };
  })

  .put(
    '/settings/agent-permissions',
    async ({ request, body }) => {
      const merged = saveNotesAgentPermissions(
        getRequestProjectRoot(request),
        body as Partial<NotesAgentPermissions>,
      );
      return { ok: true, data: merged };
    },
    {
      body: t.Object({
        preset: t.Optional(
          t.Union([
            t.Literal('default'),
            t.Literal('allow_all'),
            t.Literal('ask_all'),
            t.Literal('block_all'),
            t.Literal('custom'),
          ]),
        ),
        tools: t.Optional(t.Record(t.String(), t.String())),
      }),
    },
  )

  .post('/settings/agent-permissions/reset', async ({ request }) => {
    return { ok: true, data: resetNotesAgentPermissions(getRequestProjectRoot(request)) };
  })

  .get('/settings/agent-permissions/defaults', async () => {
    return { ok: true, data: DEFAULT_NOTES_AGENT_PERMISSIONS };
  })

  // ── Graph data ────────────────────────────────────────────────────────────
  .get('/graph', async ({ query }) => {
    const graph = await traceBlockingOp('getGraphData', () =>
      notesService.getGraphData(query.projectRoot as string | undefined),
    );
    return { ok: true, data: graph };
  })

  // ── Folder tree ───────────────────────────────────────────────────────────
  .get('/folders', async ({ query }) => {
    const tree = await traceBlockingOp('getFolderTree', () =>
      notesService.getFolderTree(query.projectRoot as string | undefined),
    );
    return { ok: true, data: tree };
  })

  // ── Full-text search ──────────────────────────────────────────────────────
  .get('/search', async ({ query }) => {
    const results = await notesService.searchNotes((query.q as string) ?? '');
    return { ok: true, data: results };
  })

  // ── Import memory files as notes (must come before /:id to avoid collision) ─
  .post('/import-memory', async ({ request }) => {
    const notes = await traceBlockingOp('importMemoryAsNotes', () =>
      notesService.importMemoryAsNotes(getRequestProjectRoot(request)),
    );
    // The caller receives every imported note and merges them directly.
    // Broadcasting the generic mutation event would make that same client
    // reload the entire vault, graph, and folder tree a second time.
    return { ok: true, data: notes };
  })

  // ── Serve attachment (must come before /:id to avoid path collision) ──────
  .get('/attachments/:attachmentId', async ({ request, params, query, set }) => {
    // <img src> can't send Authorization headers — accept the token via ?auth=.
    const authed =
      requireLocalRouteAuth(request) ??
      validateLocalBearerToken(String((query as { auth?: string })?.auth ?? ''));
    if (!authed) {
      throw new AuthenticationError('Unauthorized');
    }
    const att = await notesService.getAttachment(params.attachmentId);
    if (!att || !existsSync(att.storagePath)) {
      throw new NotFoundError('Attachment', params.attachmentId);
    }
    const data = readFileSync(att.storagePath);
    // Elysia's Set.headers type is a strict literal in some versions; cast to
    // a writable record to set dynamic Content-Type/Disposition headers.
    const headers = set.headers as Record<string, string>;
    headers['Content-Type'] = att.mimeType;
    headers['Content-Disposition'] = 'inline; filename="' + att.filename + '"';
    return data;
  })

  // ── Get single note with links ────────────────────────────────────────────
  .get('/:id', async ({ params }) => {
    const note = await notesService.getNoteWithLinks(params.id);
    if (!note) {
      throw new NotFoundError('Note', params.id);
    }
    return { ok: true, data: note };
  })

  // ── Update note ───────────────────────────────────────────────────────────
  .put(
    '/:id',
    async ({ params, body }) => {
      const note = await notesService.updateNote(params.id, body);
      broadcastNotesNetworkUpdate('update', note.id);
      return { ok: true, data: note };
    },
    {
      body: t.Object({
        title: t.Optional(t.String()),
        content: t.Optional(t.String()),
        folderPath: t.Optional(t.String()),
        tags: t.Optional(t.Array(t.String())),
        pinned: t.Optional(t.Boolean()),
        includeInContext: t.Optional(t.Boolean()),
        format: t.Optional(t.Union([t.Literal('markdown'), t.Literal('html')])),
      }),
    },
  )

  // ── Delete note ───────────────────────────────────────────────────────────
  .delete('/:id', async ({ params }) => {
    await notesService.deleteNote(params.id);
    broadcastNotesNetworkUpdate('delete', params.id);
    return { ok: true };
  })

  // ── Get backlinks ─────────────────────────────────────────────────────────
  .get('/:id/backlinks', async ({ params }) => {
    const backlinks = await notesService.getNoteBacklinks(params.id);
    return { ok: true, data: backlinks };
  })

  // ── Upload attachment (multipart form) ────────────────────────────────────
  .post('/:id/attachments', async ({ request, params }) => {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    if (!file) {
      throw new ValidationError('No file provided');
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const attachment = await notesService.saveAttachment(
      params.id,
      file.name,
      file.type || 'application/octet-stream',
      buffer,
    );
    return { ok: true, data: attachment };
  })

  // ── Delete attachment ─────────────────────────────────────────────────────
  .delete('/:id/attachments/:attachmentId', async ({ params }) => {
    await notesService.deleteAttachment(params.attachmentId);
    return { ok: true };
  });
