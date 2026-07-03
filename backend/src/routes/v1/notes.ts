/**
 * Notes API Routes
 *
 * REST endpoints for the Obsidian-style note knowledge network.
 * Prefix: /api/notes
 */

import { Elysia, t } from 'elysia';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';
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

export const notesRoutes = new Elysia({ prefix: '/api/notes' })

  // ── List all notes (supports ?search=, ?folder=) ─────────────────────────
  .get('/', async ({ request, query, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const notesList = await notesService.listNotes({
      folderPath: query.folder as string | undefined,
      search: query.search as string | undefined,
    }, (query.projectRoot as string | undefined) || PROJECT_ROOT);
    return { ok: true, data: notesList };
  })

  .post('/sync-project', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    try {
      const url = new URL(request.url);
      const result = await notesService.syncProjectDocuments(url.searchParams.get('projectRoot') || PROJECT_ROOT);
      broadcastNotesNetworkUpdate('update');
      return { ok: true, data: result };
    } catch (err: unknown) {
      set.status = 500;
      return { ok: false, error: err instanceof Error ? err.message : 'Failed to sync project documents' };
    }
  })

  // ── Create note ───────────────────────────────────────────────────────────
  .post(
    '/',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      try {
        const note = await notesService.createNote(body as any);
        broadcastNotesNetworkUpdate('create', note.id);
        return { ok: true, data: note };
      } catch (err: any) {
        set.status = 500;
        return { ok: false, error: err.message };
      }
    },
    {
      body: t.Object({
        title: t.String(),
        content: t.Optional(t.String()),
        folderPath: t.Optional(t.String()),
        tags: t.Optional(t.Array(t.String())),
        pinned: t.Optional(t.Boolean()),
        includeInContext: t.Optional(t.Boolean()),
      }),
    },
  )

  // ── General notes settings ────────────────────────────────────────────────
  // Persisted server-side so context injection actually honors them.
  .get('/settings', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    return { ok: true, data: loadNotesSettings(getRequestProjectRoot(request)) };
  })

  .put(
    '/settings',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      try {
        const merged = saveNotesSettings(getRequestProjectRoot(request), body as Partial<NotesSettings>);
        return { ok: true, data: merged };
      } catch (err: unknown) {
        set.status = 500;
        return {
          ok: false,
          error: err instanceof Error ? err.message : 'Failed to save notes settings',
        };
      }
    },
    {
      body: t.Object({
        enabled: t.Optional(t.Boolean()),
        autoIncludeInContext: t.Optional(t.Boolean()),
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
  .get('/settings/agent-permissions', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    return { ok: true, data: loadNotesAgentPermissions(getRequestProjectRoot(request)) };
  })

  .put(
    '/settings/agent-permissions',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      try {
        const merged = saveNotesAgentPermissions(
          getRequestProjectRoot(request),
          body as Partial<NotesAgentPermissions>,
        );
        return { ok: true, data: merged };
      } catch (err: unknown) {
        set.status = 500;
        return {
          ok: false,
          error: err instanceof Error ? err.message : 'Failed to save permissions',
        };
      }
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

  .post('/settings/agent-permissions/reset', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    return { ok: true, data: resetNotesAgentPermissions(getRequestProjectRoot(request)) };
  })

  .get('/settings/agent-permissions/defaults', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    return { ok: true, data: DEFAULT_NOTES_AGENT_PERMISSIONS };
  })

  // ── Graph data ────────────────────────────────────────────────────────────
  .get('/graph', async ({ request, query, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const graph = await notesService.getGraphData(query.projectRoot as string | undefined);
    return { ok: true, data: graph };
  })

  // ── Folder tree ───────────────────────────────────────────────────────────
  .get('/folders', async ({ request, query, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const tree = await notesService.getFolderTree(query.projectRoot as string | undefined);
    return { ok: true, data: tree };
  })

  // ── Full-text search ──────────────────────────────────────────────────────
  .get('/search', async ({ request, query, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const results = await notesService.searchNotes((query.q as string) ?? '');
    return { ok: true, data: results };
  })

  // ── Import memory files as notes (must come before /:id to avoid collision) ─
  .post('/import-memory', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    try {
      const notes = await notesService.importMemoryAsNotes(getRequestProjectRoot(request));
      broadcastNotesNetworkUpdate('update');
      return { ok: true, data: notes };
    } catch (err: any) {
      set.status = 500;
      return { ok: false, error: err.message };
    }
  })

  // ── Serve attachment (must come before /:id to avoid path collision) ──────
  .get('/attachments/:attachmentId', async ({ request, params, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const att = await notesService.getAttachment(params.attachmentId);
    if (!att || !existsSync(att.storagePath)) {
      set.status = 404;
      return { ok: false, error: 'Not found' };
    }
    const data = readFileSync(att.storagePath);
    (set.headers as Record<string, string>)['Content-Type'] = att.mimeType;
    (set.headers as Record<string, string>)['Content-Disposition'] =
      'inline; filename="' + att.filename + '"';
    return data;
  })

  // ── Get single note with links ────────────────────────────────────────────
  .get('/:id', async ({ request, params, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const note = await notesService.getNoteWithLinks(params.id);
    if (!note) {
      set.status = 404;
      return { ok: false, error: 'Not found' };
    }
    return { ok: true, data: note };
  })

  // ── Update note ───────────────────────────────────────────────────────────
  .put(
    '/:id',
    async ({ request, params, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      try {
        const note = await notesService.updateNote(params.id, body as any);
        broadcastNotesNetworkUpdate('update', note.id);
        return { ok: true, data: note };
      } catch (err: any) {
        set.status = 500;
        return { ok: false, error: err.message };
      }
    },
    {
      body: t.Object({
        title: t.Optional(t.String()),
        content: t.Optional(t.String()),
        folderPath: t.Optional(t.String()),
        tags: t.Optional(t.Array(t.String())),
        pinned: t.Optional(t.Boolean()),
        includeInContext: t.Optional(t.Boolean()),
      }),
    },
  )

  // ── Delete note ───────────────────────────────────────────────────────────
  .delete('/:id', async ({ request, params, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    await notesService.deleteNote(params.id);
    broadcastNotesNetworkUpdate('delete', params.id);
    return { ok: true };
  })

  // ── Get backlinks ─────────────────────────────────────────────────────────
  .get('/:id/backlinks', async ({ request, params, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const backlinks = await notesService.getNoteBacklinks(params.id);
    return { ok: true, data: backlinks };
  })

  // ── Upload attachment (multipart form) ────────────────────────────────────
  .post('/:id/attachments', async ({ request, params, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    try {
      const formData = await request.formData();
      const file = formData.get('file') as File | null;
      if (!file) {
        set.status = 400;
        return { ok: false, error: 'No file provided' };
      }
      const buffer = Buffer.from(await file.arrayBuffer());
      const attachment = await notesService.saveAttachment(
        params.id,
        file.name,
        file.type || 'application/octet-stream',
        buffer,
      );
      return { ok: true, data: attachment };
    } catch (err: any) {
      set.status = 500;
      return { ok: false, error: err.message };
    }
  })

  // ── Delete attachment ─────────────────────────────────────────────────────
  .delete('/:id/attachments/:attachmentId', async ({ request, params, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    try {
      await notesService.deleteAttachment(params.attachmentId);
      return { ok: true };
    } catch (err: any) {
      set.status = 500;
      return { ok: false, error: err.message };
    }
  });
