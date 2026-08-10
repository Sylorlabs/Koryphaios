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
import { requireLocalRouteAuth } from '../../auth/local-route-auth';
import * as notesService from '../../notes/notes-service';
import { broadcastNotesNetworkUpdate } from '../../notes/notes-events';
import {
  loadNotesAgentPermissions,
  saveNotesAgentPermissions,
  resetNotesAgentPermissions,
  loadNotesSettings,
  saveNotesSettings,
  NOTES_HARD_MAX_ATTACHMENT_BYTES,
  NOTES_HARD_MAX_BYTES,
} from '../../notes/notes-settings';
import {
  DEFAULT_NOTES_AGENT_PERMISSIONS,
  type NotesAgentPermissions,
  type NotesSettings,
} from '@koryphaios/shared';
import { readFileSync, existsSync } from 'fs';
import { getRequestProjectRoot } from '../../runtime/request-project';
import { traceBlockingOp } from '../../monitoring/event-loop-monitor';
import {
  AuthenticationError,
  NotFoundError,
  PayloadTooLargeError,
  ValidationError,
} from '../../errors/types';

export const notesRoutes = new Elysia({ prefix: '/api/notes' })
  .onBeforeHandle(({ request }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
  })

  // ── List all notes (supports ?search=, ?folder=) ─────────────────────────
  .get('/', async ({ request, query }) => {
    const notesList = await notesService.listNotes(
      {
        folderPath: query.folder as string | undefined,
        search: query.search as string | undefined,
      },
      getRequestProjectRoot(request),
    );
    return {
      ok: true,
      data: notesList,
      meta: {
        projectSync: notesService.getProjectSyncStatus(getRequestProjectRoot(request)),
      },
    };
  })

  .post('/sync-project', async ({ request }) => {
    const result = await traceBlockingOp('syncProjectDocuments', () =>
      notesService.syncProjectDocuments(getRequestProjectRoot(request)),
    );
    broadcastNotesNetworkUpdate('update');
    return { ok: true, data: result };
  })

  // ── Create note ───────────────────────────────────────────────────────────
  .post(
    '/',
    async ({ request, body }) => {
      const note = await notesService.createNote(body, getRequestProjectRoot(request));
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
      const merged = saveNotesSettings(
        getRequestProjectRoot(request),
        body as Partial<NotesSettings>,
      );
      return { ok: true, data: merged };
    },
    {
      body: t.Object({
        enabled: t.Optional(t.Boolean()),
        autoIncludeInContext: t.Optional(t.Boolean()),
        maxContextTokensEnabled: t.Optional(t.Boolean()),
        maxContextTokens: t.Optional(t.Number()),
        autosaveEnabled: t.Optional(t.Boolean()),
        autosaveDelayMs: t.Optional(t.Number()),
        noteSizeLimitEnabled: t.Optional(t.Boolean()),
        maxNoteBytes: t.Optional(t.Number()),
        attachmentSizeLimitEnabled: t.Optional(t.Boolean()),
        maxAttachmentBytes: t.Optional(t.Number()),
        maxAttachmentsPerNote: t.Optional(t.Number()),
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
  .get('/graph', async ({ request }) => {
    const graph = await traceBlockingOp('getGraphData', () =>
      notesService.getGraphData(getRequestProjectRoot(request)),
    );
    return {
      ok: true,
      data: graph,
      meta: {
        projectSync: notesService.getProjectSyncStatus(getRequestProjectRoot(request)),
      },
    };
  })

  // ── Folder tree ───────────────────────────────────────────────────────────
  .get('/folders', async ({ request }) => {
    const tree = await traceBlockingOp('getFolderTree', () =>
      notesService.getFolderTree(getRequestProjectRoot(request)),
    );
    return { ok: true, data: tree };
  })

  // ── Full-text search ──────────────────────────────────────────────────────
  .get('/search', async ({ request, query }) => {
    const results = await notesService.searchNotes(
      (query.q as string) ?? '',
      50,
      getRequestProjectRoot(request),
    );
    return { ok: true, data: results };
  })

  // ── Import memory files as notes (must come before /:id to avoid collision) ─
  .post('/import-memory', async ({ request }) => {
    const report = await traceBlockingOp('importMemoryAsNotes', () =>
      notesService.importMemoryAsNotesWithReport(getRequestProjectRoot(request)),
    );
    // The caller receives per-source outcomes. Imports are intentionally
    // independent, so a partial batch is explicit instead of masquerading as
    // an all-or-nothing transaction.
    // Broadcasting the generic mutation event would make that same client
    // reload the entire vault, graph, and folder tree a second time.
    return { ok: true, data: report };
  })

  // ── Import one Markdown/HTML document as a project-scoped note ───────────
  .post('/import-file', async ({ request }) => {
    const formData = await request.formData();
    const file = formData.get('file');
    if (!(file instanceof File)) throw new ValidationError('No file provided');
    const extension = file.name.toLowerCase().match(/\.(md|markdown|html|htm)$/)?.[1];
    if (!extension) throw new ValidationError('Only Markdown and HTML note files can be imported');
    const settings = loadNotesSettings(getRequestProjectRoot(request));
    const maxBytes = settings.noteSizeLimitEnabled ? settings.maxNoteBytes : NOTES_HARD_MAX_BYTES;
    if (file.size > maxBytes) {
      throw new PayloadTooLargeError(`${maxBytes} bytes`, {
        actualBytes: file.size,
        maxBytes,
      });
    }
    const content = await file.text();
    if (content.includes('\0')) throw new ValidationError('Imported note contains binary data');
    const title = file.name.replace(/\.(md|markdown|html|htm)$/i, '');
    const note = await notesService.createNote(
      {
        title,
        content,
        folderPath: '/Imported',
        format: extension === 'html' || extension === 'htm' ? 'html' : 'markdown',
        tags: ['imported-file'],
      },
      getRequestProjectRoot(request),
    );
    broadcastNotesNetworkUpdate('create', note.id);
    return { ok: true, data: note };
  })

  // ── Serve attachment (must come before /:id to avoid path collision) ──────
  .get('/attachments/:attachmentId', async ({ request, params, set }) => {
    const att = await notesService.getAttachment(
      params.attachmentId,
      getRequestProjectRoot(request),
    );
    if (!att || !existsSync(att.storagePath)) {
      throw new NotFoundError('Attachment', params.attachmentId);
    }
    const data = readFileSync(att.storagePath);
    // Elysia's Set.headers type is a strict literal in some versions; cast to
    // a writable record to set dynamic Content-Type/Disposition headers.
    const headers = set.headers as Record<string, string>;
    const inlineImage = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(
      att.mimeType,
    );
    headers['Content-Type'] = att.mimeType;
    headers['Content-Disposition'] =
      `${inlineImage ? 'inline' : 'attachment'}; filename="${att.filename}"`;
    headers['X-Content-Type-Options'] = 'nosniff';
    headers['Content-Security-Policy'] = "sandbox; default-src 'none'";
    headers['Cache-Control'] = 'private, no-store';
    return data;
  })

  // ── Export one note without leaking server storage metadata ──────────────
  .get('/:id/export', async ({ request, params, set }) => {
    const note = await notesService.getNote(params.id, getRequestProjectRoot(request));
    if (!note) throw new NotFoundError('Note', params.id);
    const extension = note.format === 'html' ? 'html' : 'md';
    const filename =
      note.title.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'note';
    const headers = set.headers as Record<string, string>;
    headers['Content-Type'] =
      note.format === 'html' ? 'text/html; charset=utf-8' : 'text/markdown; charset=utf-8';
    headers['Content-Disposition'] = `attachment; filename="${filename}.${extension}"`;
    headers['X-Content-Type-Options'] = 'nosniff';
    headers['Content-Security-Policy'] = "sandbox; default-src 'none'";
    return note.content;
  })

  // ── Get single note with links ────────────────────────────────────────────
  .get('/:id', async ({ request, params }) => {
    const note = await notesService.getNoteWithLinks(params.id, getRequestProjectRoot(request));
    if (!note) {
      throw new NotFoundError('Note', params.id);
    }
    return { ok: true, data: note };
  })

  // ── Update note ───────────────────────────────────────────────────────────
  .put(
    '/:id',
    async ({ request, params, body }) => {
      if (body.expectedRevision === undefined) {
        throw new ValidationError('expectedRevision is required for note updates');
      }
      const note = await notesService.updateNote(params.id, body, getRequestProjectRoot(request));
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
        expectedRevision: t.Optional(t.Number()),
        restoreDeletedSource: t.Optional(t.Boolean()),
      }),
    },
  )

  // ── Delete note ───────────────────────────────────────────────────────────
  .delete('/:id', async ({ request, params }) => {
    const revisionHeader = request.headers.get('x-kory-note-revision');
    const expectedRevision = revisionHeader ? Number(revisionHeader) : Number.NaN;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new ValidationError('x-kory-note-revision is required for note deletion');
    }
    await notesService.deleteNote(params.id, getRequestProjectRoot(request), expectedRevision);
    broadcastNotesNetworkUpdate('delete', params.id);
    return { ok: true };
  })

  // ── Get backlinks ─────────────────────────────────────────────────────────
  .get('/:id/backlinks', async ({ request, params }) => {
    const backlinks = await notesService.getNoteBacklinks(
      params.id,
      getRequestProjectRoot(request),
    );
    return { ok: true, data: backlinks };
  })

  // ── Upload attachment (multipart form) ────────────────────────────────────
  .post('/:id/attachments', async ({ request, params }) => {
    const formData = await request.formData();
    const file = formData.get('file');
    if (!(file instanceof File)) {
      throw new ValidationError('No file provided');
    }
    const settings = loadNotesSettings(getRequestProjectRoot(request));
    const maxBytes = settings.attachmentSizeLimitEnabled
      ? settings.maxAttachmentBytes
      : NOTES_HARD_MAX_ATTACHMENT_BYTES;
    if (file.size > maxBytes) {
      throw new PayloadTooLargeError(`${maxBytes} bytes`, {
        actualBytes: file.size,
        maxBytes,
      });
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const attachment = await notesService.saveAttachment(
      params.id,
      file.name,
      file.type || 'application/octet-stream',
      buffer,
      getRequestProjectRoot(request),
    );
    return { ok: true, data: attachment };
  })

  // ── Delete attachment ─────────────────────────────────────────────────────
  .delete('/:id/attachments/:attachmentId', async ({ request, params }) => {
    const projectRoot = getRequestProjectRoot(request);
    const attachment = await notesService.getAttachment(params.attachmentId, projectRoot);
    if (!attachment || attachment.noteId !== params.id) {
      throw new NotFoundError('Attachment', params.attachmentId);
    }
    await notesService.deleteAttachment(params.attachmentId, projectRoot);
    return { ok: true };
  });
