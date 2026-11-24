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
import { getContext } from '../../context';
import { sessions as sessionRows, messages as messageRows } from '../../db/schema';
import { getDatabase } from '../../db';
import { eq } from 'drizzle-orm';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';
import * as notesService from '../../notes/notes-service';
import { retrieveNoteContext } from '../../notes/note-context';
import { listNoteAppearances } from '../../notes/note-appearances';
import { buildChatFinding } from '../../notes/chat-finding';
import {
  getNoteSemanticIndexStatus,
  rebuildNoteSemanticIndex,
} from '../../notes/note-semantic-index';
import { noteDraftService } from '../../notes/note-draft-service';
import { commitVaultRestore, previewVaultRestore } from '../../notes/vault-restore-service';
import { DEFAULT_VAULT_ARCHIVE_LIMITS } from '../../notes/vault-archive';
import {
  assertProjectPropertyProjectionCurrent,
  getNotePropertyProjection,
  listNotePropertySchemas,
  repairProjectPropertyProjections,
} from '../../notes/note-properties-service';
import {
  createNoteBase,
  getNoteBase,
  listNoteBaseRevisions,
  listNoteBases,
  previewNoteBase,
  queryNoteBase,
  restoreNoteBase,
  trashNoteBase,
  updateNoteBase,
} from '../../notes/note-bases-service';
import { broadcastNotesNetworkUpdate, type NotesMutationOrigin } from '../../notes/notes-events';
import {
  deleteFolderAppearance,
  deleteTagAppearance,
  listNotesAppearance,
  renameNoteFolder,
  setFolderAppearance,
  setTagAppearance,
} from '../../notes/notes-appearance';
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
  type ChatFindingInput,
  type NotesAgentPermissions,
  type NotesSettings,
} from '@koryphaios/shared';
import { readFileSync, existsSync } from 'fs';
import { getRequestProjectRoot } from '../../runtime/request-project';
import { traceBlockingOp } from '../../monitoring/event-loop-monitor';
import {
  AuthenticationError,
  ConflictError,
  NotFoundError,
  PayloadTooLargeError,
  ValidationError,
} from '../../errors/types';
import { removeNoteProperty, setNoteProperty, type NoteProperty } from '@koryphaios/shared';

function mutationOrigin(request: Request): NotesMutationOrigin | undefined {
  const normalize = (value: string | null): string | undefined => {
    const trimmed = value?.trim();
    return trimmed && trimmed.length <= 128 && !/[\u0000-\u001f\u007f]/.test(trimmed)
      ? trimmed
      : undefined;
  };
  const clientId = normalize(request.headers.get('x-kory-client-id'));
  const mutationId = normalize(request.headers.get('x-kory-mutation-id'));
  return clientId || mutationId ? { clientId, mutationId } : undefined;
}

function requirePositiveRevision(value: number | undefined, label = 'expectedRevision'): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) < 1) {
    throw new ValidationError(`${label} must be a positive integer`);
  }
  return value!;
}

function publicVaultRestoreResult(value: {
  format: 'koryphaios-notes-vault';
  archiveVersion: 1 | 2;
  projectName: string;
  archiveSha256: string;
  notes: number;
  revisions: number;
  attachments: number;
  links: number;
  relationships?: number;
  bases: number;
  drafts: number;
  noOpNotes: number;
  conflicts: Array<{ kind: string; archiveId?: string; path?: string; message: string }>;
  canRestore: boolean;
  mode: 'safe-merge';
  restoredNotes?: number;
  restoredRevisions?: number;
  restoredAttachments?: number;
  restoredLinks?: number;
  restoredRelationships?: number;
  restoredBases?: number;
  restoredDrafts?: number;
}) {
  const preview = {
    format: value.format,
    archiveVersion: value.archiveVersion,
    projectName: value.projectName,
    archiveSha256: value.archiveSha256,
    notes: value.notes,
    revisions: value.revisions,
    attachments: value.attachments,
    links: value.links,
    relationships: value.relationships ?? 0,
    bases: value.bases,
    drafts: value.drafts,
    noOpNotes: value.noOpNotes,
    conflicts: value.conflicts,
    canRestore: value.canRestore,
    mode: value.mode,
  };
  return value.restoredNotes === undefined
    ? preview
    : {
        ...preview,
        restoredNotes: value.restoredNotes,
        restoredRevisions: value.restoredRevisions ?? 0,
        restoredAttachments: value.restoredAttachments ?? 0,
        restoredLinks: value.restoredLinks ?? 0,
        restoredRelationships: value.restoredRelationships ?? 0,
        restoredBases: value.restoredBases ?? 0,
        restoredDrafts: value.restoredDrafts ?? 0,
      };
}

async function vaultArchiveForm(request: Request): Promise<{
  file: File;
  archiveSha256?: string;
}> {
  const formData = await request.formData();
  const file = formData.get('file');
  if (!(file instanceof File)) throw new ValidationError('Choose a vault archive to restore');
  if (file.size === 0) throw new ValidationError('The selected vault archive is empty');
  if (file.size > DEFAULT_VAULT_ARCHIVE_LIMITS.maxArchiveBytes) {
    throw new PayloadTooLargeError(`${DEFAULT_VAULT_ARCHIVE_LIMITS.maxArchiveBytes} bytes`, {
      actualBytes: file.size,
      maxBytes: DEFAULT_VAULT_ARCHIVE_LIMITS.maxArchiveBytes,
    });
  }
  const digest = formData.get('archiveSha256');
  if (digest !== null && typeof digest !== 'string') {
    throw new ValidationError('Vault archive digest must be text');
  }
  return { file, ...(digest === null ? {} : { archiveSha256: digest }) };
}

const noteDraftSnapshotSchema = {
  title: t.String(),
  content: t.String(),
  folderPath: t.String(),
  tags: t.Array(t.String()),
  pinned: t.Boolean(),
  includeInContext: t.Boolean(),
  format: t.Union([t.Literal('markdown'), t.Literal('html')]),
};

const notePropertyValueSchema = t.Union([t.String(), t.Number(), t.Boolean(), t.Array(t.String())]);

export const notesRoutes = new Elysia({ prefix: '/api/notes' })
  .onBeforeHandle(({ request }) => {
    if (!requireLocalRouteAuth(request)) throw new AuthenticationError('Unauthorized');
  })

  .get(
    '/relationships',
    async ({ request, query }) => ({
      success: true,
      data: await notesService.listNoteRelationships(getRequestProjectRoot(request), query),
    }),
    {
      query: t.Object({
        noteId: t.Optional(t.String({ maxLength: 2048 })),
        limit: t.Optional(t.Numeric({ minimum: 1, maximum: 200 })),
        offset: t.Optional(t.Numeric({ minimum: 0, maximum: 100000 })),
        status: t.Optional(
          t.Union([t.Literal('proposed'), t.Literal('accepted'), t.Literal('rejected')]),
        ),
      }),
    },
  )
  .post(
    '/relationships',
    async ({ request, body }) => {
      const data = await notesService.proposeNoteRelationship(
        body,
        getRequestProjectRoot(request),
        { provenance: 'user' },
      );
      broadcastNotesNetworkUpdate('update', data.fromId, undefined, mutationOrigin(request));
      return { success: true, data };
    },
    {
      body: t.Object({
        fromId: t.String({ minLength: 1, maxLength: 2048 }),
        toId: t.String({ minLength: 1, maxLength: 2048 }),
        type: t.Union([
          t.Literal('related_to'),
          t.Literal('supports'),
          t.Literal('contradicts'),
          t.Literal('depends_on'),
          t.Literal('supersedes'),
        ]),
        evidence: t.String({ minLength: 1, maxLength: 2000 }),
        weight: t.Optional(t.Number({ exclusiveMinimum: 0, maximum: 1 })),
        expectedSourceRevision: t.Integer({ minimum: 1 }),
        expectedTargetRevision: t.Integer({ minimum: 1 }),
      }),
    },
  )
  .post(
    '/relationships/:fromId/:toId/refresh',
    async ({ request, params, body }) => {
      const data = await notesService.refreshNoteRelationship({ ...body, ...params }, getRequestProjectRoot(request), { provenance: 'user' });
      broadcastNotesNetworkUpdate('update', data.fromId, undefined, mutationOrigin(request));
      return { success: true, data };
    },
    { body: t.Object({ expectedRevision: t.Integer({ minimum: 1 }), expectedSourceRevision: t.Integer({ minimum: 1 }), expectedTargetRevision: t.Integer({ minimum: 1 }), type: t.Union([t.Literal('related_to'), t.Literal('supports'), t.Literal('contradicts'), t.Literal('depends_on'), t.Literal('supersedes')]), evidence: t.String({ minLength: 1, maxLength: 2000 }), weight: t.Optional(t.Number({ exclusiveMinimum: 0, maximum: 1 })) }) },
  )
  .patch(
    '/relationships/:fromId/:toId',
    async ({ request, params, body }) => {
      const data = await notesService.reviewNoteRelationship(
        params.fromId,
        params.toId,
        body,
        getRequestProjectRoot(request),
        { provenance: 'user' },
      );
      broadcastNotesNetworkUpdate('update', data.fromId, undefined, mutationOrigin(request));
      return { success: true, data };
    },
    {
      body: t.Object({
        status: t.Union([t.Literal('accepted'), t.Literal('rejected')]),
        expectedRevision: t.Integer({ minimum: 1 }),
      }),
    },
  )
  .delete(
    '/relationships/:fromId/:toId',
    async ({ request, params, body }) => {
      await notesService.unlinkNotes(
        params.fromId,
        params.toId,
        {
          syncContent: false,
          expectedRelationshipRevision: requirePositiveRevision(
            body.expectedRelationshipRevision,
            'expectedRelationshipRevision',
          ),
          provenance: 'user',
        },
        getRequestProjectRoot(request),
      );
      broadcastNotesNetworkUpdate('update', params.fromId, undefined, mutationOrigin(request));
      return { success: true, data: { removed: true } };
    },
    {
      body: t.Object({ expectedRelationshipRevision: t.Integer({ minimum: 1 }) }),
    },
  )
  .post(
    '/context',
    async ({ request, body }) => ({
      success: true,
      data: await retrieveNoteContext(body, getRequestProjectRoot(request), {
        signal: request.signal,
      }),
    }),
    {
      body: t.Object({
        query: t.String({ minLength: 1, maxLength: 2000 }),
        seedIds: t.Optional(t.Array(t.String({ minLength: 1, maxLength: 2048 }), { maxItems: 8 })),
        limit: t.Optional(t.Integer({ minimum: 1, maximum: 12 })),
        maxHops: t.Optional(t.Integer({ minimum: 0, maximum: 2 })),
        maxChars: t.Optional(t.Integer({ minimum: 256, maximum: 16000 })),
        excerptChars: t.Optional(t.Integer({ minimum: 128, maximum: 2000 })),
        semantic: t.Optional(t.Boolean()),
      }),
    },
  )
  .get('/semantic-index', ({ request }) => ({
    success: true,
    data: getNoteSemanticIndexStatus(getRequestProjectRoot(request)),
  }))
  .post(
    '/semantic-index/rebuild',
    async ({ request, body }) => ({
      success: true,
      data: await rebuildNoteSemanticIndex(getRequestProjectRoot(request), body, {
        signal: request.signal,
      }),
    }),
    {
      body: t.Object({
        optIn: t.Literal(true),
        limit: t.Optional(t.Integer({ minimum: 1, maximum: 128 })),
        reset: t.Optional(t.Boolean()),
      }),
    },
  )

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

  .post('/sync-project', async ({ request, body }) => {
    const projectRoot = getRequestProjectRoot(request);
    const settings = loadNotesSettings(projectRoot);
    const continueBeyondLimit =
      !!body &&
      typeof body === 'object' &&
      (body as { continueBeyondLimit?: unknown }).continueBeyondLimit === true;
    // 0 means no soft limit: either the user asked to continue past it for this
    // pass, or they disabled it for the project.
    const maxFiles =
      continueBeyondLimit || !settings.indexScanLimitEnabled ? 0 : settings.indexScanLimit;
    const result = await traceBlockingOp('syncProjectDocuments', () =>
      notesService.syncProjectDocuments(projectRoot, { maxFiles }),
    );
    broadcastNotesNetworkUpdate('update', undefined, undefined, mutationOrigin(request));
    return { ok: true, data: result };
  })

  // ── Create note ───────────────────────────────────────────────────────────
  .post(
    '/',
    async ({ request, body }) => {
      const note = await notesService.createNote(body, getRequestProjectRoot(request));
      broadcastNotesNetworkUpdate('create', note.id, undefined, mutationOrigin(request));
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

  // ── Save a chat finding as a sourced note ────────────────────────────────
  .post(
    '/chat-findings',
    async ({ request, body }) => {
      const { title, body: findingBody, source } = body;
      const session = await getDatabase()
        .select({ id: sessionRows.id, workingDirectory: sessionRows.workingDirectory })
        .from(sessionRows)
        .where(eq(sessionRows.id, source.sessionId))
        .limit(1)
        .then((rows) => rows[0]);
      if (!session) throw new NotFoundError('Chat session', source.sessionId);

      const projectRoot = getRequestProjectRoot(request);
      if (session.workingDirectory) {
        const { resolveProjectIdentity } = await import('../../runtime/request-project');
        if (resolveProjectIdentity(session.workingDirectory) !== resolveProjectIdentity(projectRoot)) {
          throw new ValidationError('The source chat does not belong to the selected project.');
        }
      }

      let verifiedSource: ChatFindingInput['source'] = {
        sessionId: session.id,
        ...(source.messageId ? { messageId: source.messageId } : {}),
      };
      if (source.messageId) {
        const message = await getDatabase()
          .select({ id: messageRows.id, sessionId: messageRows.sessionId, role: messageRows.role, model: messageRows.model, provider: messageRows.provider })
          .from(messageRows)
          .where(eq(messageRows.id, source.messageId))
          .limit(1)
          .then((rows) => rows[0]);
        if (!message || message.sessionId !== session.id || message.role !== 'assistant') {
          throw new ValidationError('The cited chat message is not an assistant response in this session.');
        }
        verifiedSource = {
          sessionId: session.id,
          messageId: message.id,
          role: message.role,
          ...(message.provider ? { provider: message.provider } : {}),
          ...(message.model ? { model: message.model } : {}),
        };
      }

      const built = buildChatFinding({ title, body: findingBody, source: verifiedSource });
      const note = await notesService.createNote(
        {
          title: built.title,
          content: built.content,
          folderPath: built.folderPath,
          tags: built.tags,
        },
        projectRoot,
      );
      broadcastNotesNetworkUpdate('create', note.id, undefined, mutationOrigin(request));
      return { ok: true, data: note };
    },
    {
      body: t.Object({
        title: t.String({ minLength: 1, maxLength: 240 }),
        body: t.String({ minLength: 1, maxLength: 8000 }),
        source: t.Object({
          sessionId: t.String({ minLength: 1, maxLength: 2048 }),
          messageId: t.Optional(t.String({ minLength: 1, maxLength: 2048 })),
        }),
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
        indexScanLimitEnabled: t.Optional(t.Boolean()),
        indexScanLimit: t.Optional(t.Number()),
        hideIndexLimitNotice: t.Optional(t.Boolean()),
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
        overrides: t.Optional(t.Record(t.String(), t.String())),
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

  // ── Folder and tag appearance (emoji + color), project scoped ────────────
  .get('/appearance', async ({ request }) => ({
    ok: true,
    data: listNotesAppearance(getRequestProjectRoot(request)),
  }))

  .put(
    '/appearance/folders',
    async ({ request, body }) => {
      const data = setFolderAppearance(getRequestProjectRoot(request), body);
      broadcastNotesNetworkUpdate('update', undefined, undefined, mutationOrigin(request));
      return { ok: true, data };
    },
    {
      body: t.Object({
        path: t.String(),
        emoji: t.Optional(t.Union([t.String(), t.Null()])),
        color: t.Optional(t.Union([t.String(), t.Null()])),
      }),
    },
  )

  .delete(
    '/appearance/folders',
    async ({ request, query }) => {
      const removed = deleteFolderAppearance(getRequestProjectRoot(request), query.path);
      broadcastNotesNetworkUpdate('update', undefined, undefined, mutationOrigin(request));
      return { ok: true, data: { removed } };
    },
    { query: t.Object({ path: t.String() }) },
  )

  .put(
    '/appearance/tags',
    async ({ request, body }) => {
      const data = setTagAppearance(getRequestProjectRoot(request), body);
      broadcastNotesNetworkUpdate('update', undefined, undefined, mutationOrigin(request));
      return { ok: true, data };
    },
    {
      body: t.Object({
        tag: t.String(),
        emoji: t.Optional(t.Union([t.String(), t.Null()])),
        color: t.Optional(t.Union([t.String(), t.Null()])),
      }),
    },
  )

  .delete(
    '/appearance/tags',
    async ({ request, query }) => {
      const removed = deleteTagAppearance(getRequestProjectRoot(request), query.tag);
      broadcastNotesNetworkUpdate('update', undefined, undefined, mutationOrigin(request));
      return { ok: true, data: { removed } };
    },
    { query: t.Object({ tag: t.String() }) },
  )

  // Renaming a folder moves its notes and carries its appearance along.
  .post(
    '/folders/rename',
    async ({ request, body }) => {
      const data = await renameNoteFolder(getRequestProjectRoot(request), body.from, body.to);
      broadcastNotesNetworkUpdate('update', undefined, undefined, mutationOrigin(request));
      return { ok: true, data };
    },
    { body: t.Object({ from: t.String(), to: t.String() }) },
  )

  // ── Full-text search ──────────────────────────────────────────────────────
  .get('/search', async ({ request, query }) => {
    const resultLimit = 50;
    const results = await notesService.searchNotes(
      (query.q as string) ?? '',
      resultLimit + 1,
      getRequestProjectRoot(request),
      { signal: request.signal },
    );
    request.signal.throwIfAborted();
    return {
      ok: true,
      data: results.slice(0, resultLimit),
      meta: { truncated: results.length > resultLimit, limit: resultLimit },
    };
  })

  // ── Import memory files as notes (must come before /:id to avoid collision) ─
  .post('/import-memory', async ({ request }) => {
    const report = await traceBlockingOp('importMemoryAsNotes', () =>
      notesService.importMemoryAsNotesWithReport(getRequestProjectRoot(request)),
    );
    // The caller receives per-source outcomes. Imports are intentionally
    // independent, so a partial batch is explicit instead of masquerading as
    // an all-or-nothing transaction.
    broadcastNotesNetworkUpdate('update', undefined, undefined, mutationOrigin(request));
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
    broadcastNotesNetworkUpdate('create', note.id, undefined, mutationOrigin(request));
    return { ok: true, data: note };
  })

  // ── Typed Markdown Properties (fixed prefixes must precede /:id) ────────
  .get('/properties/status', async ({ request }) => {
    const projectRoot = getRequestProjectRoot(request);
    try {
      assertProjectPropertyProjectionCurrent(projectRoot);
      return { ok: true, data: { current: true } };
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      return { ok: true, data: { current: false } };
    }
  })

  .post('/properties/reindex', async ({ request }) => ({
    ok: true,
    data: await repairProjectPropertyProjections(getRequestProjectRoot(request)),
  }))

  .get('/properties/schemas', async ({ request }) => ({
    ok: true,
    data: await listNotePropertySchemas(getRequestProjectRoot(request)),
  }))

  .get('/:id/properties', async ({ request, params }) => ({
    ok: true,
    data: await getNotePropertyProjection(params.id, getRequestProjectRoot(request)),
  }))

  .patch(
    '/:id/properties',
    async ({ request, params, body }) => {
      const projectRoot = getRequestProjectRoot(request);
      const current = await notesService.getNote(params.id, projectRoot);
      if (!current) throw new NotFoundError('Note', params.id);
      if (current.format === 'html') {
        throw new ValidationError('Typed YAML properties are available only for Markdown notes');
      }
      let content = current.content;
      try {
        for (const patch of body.patches) {
          if (patch.op === 'remove') {
            content = removeNoteProperty(content, patch.key);
          } else {
            content = setNoteProperty(content, patch as NoteProperty);
          }
        }
      } catch (error) {
        throw new ValidationError(
          error instanceof Error ? error.message : 'The property patch is invalid',
        );
      }
      const note = await notesService.updateNote(
        params.id,
        {
          content,
          expectedRevision: requirePositiveRevision(body.expectedRevision),
          restoreDeletedSource: body.restoreDeletedSource,
        },
        projectRoot,
      );
      const properties = await getNotePropertyProjection(params.id, projectRoot);
      broadcastNotesNetworkUpdate('update', note.id, undefined, mutationOrigin(request));
      return { ok: true, data: { note, properties } };
    },
    {
      body: t.Object({
        expectedRevision: t.Number(),
        restoreDeletedSource: t.Optional(t.Boolean()),
        patches: t.Array(
          t.Union([
            t.Object({ op: t.Literal('remove'), key: t.String() }),
            t.Object({
              op: t.Literal('set'),
              key: t.String(),
              type: t.Union([
                t.Literal('text'),
                t.Literal('number'),
                t.Literal('checkbox'),
                t.Literal('date'),
                t.Literal('datetime'),
                t.Literal('list'),
                t.Literal('tags'),
              ]),
              value: notePropertyValueSchema,
            }),
          ]),
          { minItems: 1, maxItems: 100 },
        ),
      }),
    },
  )

  // ── Persistent typed Bases (fixed prefixes must precede /:id) ───────────
  .get('/bases', async ({ request, query }) => ({
    ok: true,
    data: listNoteBases(getRequestProjectRoot(request), {
      includeTrashed: query.includeTrashed === 'true',
    }),
  }))

  .post(
    '/bases',
    async ({ request, body }) => ({
      ok: true,
      data: createNoteBase(body, getRequestProjectRoot(request)),
    }),
    { body: t.Object({ name: t.String(), definition: t.Any() }) },
  )

  .post(
    '/bases/query-preview',
    async ({ request, body }) => ({
      ok: true,
      data: await previewNoteBase(
        body.definition,
        { limit: body.limit, offset: body.offset },
        getRequestProjectRoot(request),
      ),
    }),
    {
      body: t.Object({
        definition: t.Any(),
        limit: t.Optional(t.Number()),
        offset: t.Optional(t.Number()),
      }),
    },
  )

  .get('/bases/:baseId', async ({ request, params }) => {
    const base = getNoteBase(params.baseId, getRequestProjectRoot(request), {
      includeTrashed: true,
    });
    if (!base) throw new NotFoundError('Note Base', params.baseId);
    return { ok: true, data: base };
  })

  .put(
    '/bases/:baseId',
    async ({ request, params, body }) => ({
      ok: true,
      data: updateNoteBase(params.baseId, body, getRequestProjectRoot(request)),
    }),
    {
      body: t.Object({
        expectedRevision: t.Number(),
        name: t.Optional(t.String()),
        definition: t.Optional(t.Any()),
      }),
    },
  )

  .delete('/bases/:baseId', async ({ request, params, query }) => ({
    ok: true,
    data: trashNoteBase(
      params.baseId,
      requirePositiveRevision(Number(query.expectedRevision)),
      getRequestProjectRoot(request),
    ),
  }))

  .post(
    '/bases/:baseId/restore',
    async ({ request, params, body }) => ({
      ok: true,
      data: restoreNoteBase(
        params.baseId,
        requirePositiveRevision(body.expectedRevision),
        getRequestProjectRoot(request),
      ),
    }),
    { body: t.Object({ expectedRevision: t.Number() }) },
  )

  .get('/bases/:baseId/revisions', async ({ request, params }) => ({
    ok: true,
    data: listNoteBaseRevisions(params.baseId, getRequestProjectRoot(request)),
  }))

  .post(
    '/bases/:baseId/query',
    async ({ request, params, body }) => ({
      ok: true,
      data: await queryNoteBase(
        params.baseId,
        { limit: body.limit, offset: body.offset },
        getRequestProjectRoot(request),
      ),
    }),
    {
      body: t.Object({
        limit: t.Optional(t.Number()),
        offset: t.Optional(t.Number()),
      }),
    },
  )

  // ── Crash-durable non-authoritative drafts (must precede /:id) ──────────
  .get('/drafts', async ({ request }) => ({
    ok: true,
    data: noteDraftService.listDrafts(getRequestProjectRoot(request)),
  }))

  .post(
    '/drafts',
    async ({ request, body }) => ({
      ok: true,
      data: noteDraftService.createDraft(body, getRequestProjectRoot(request)),
    }),
    {
      body: t.Object({
        noteId: t.String(),
        baseRevision: t.Number(),
        baseTitle: t.Optional(t.String()),
        ...noteDraftSnapshotSchema,
      }),
    },
  )

  .get('/drafts/:draftId', async ({ request, params }) => {
    const draft = noteDraftService.getDraft(params.draftId, getRequestProjectRoot(request));
    if (!draft) throw new NotFoundError('Notes draft', params.draftId);
    return { ok: true, data: draft };
  })

  .put(
    '/drafts/:draftId',
    async ({ request, params, body }) => ({
      ok: true,
      data: noteDraftService.updateDraft(params.draftId, body, getRequestProjectRoot(request)),
    }),
    {
      body: t.Object({
        expectedDraftRevision: t.Number(),
        ...noteDraftSnapshotSchema,
      }),
    },
  )

  .post(
    '/drafts/:draftId/discard',
    async ({ request, params, body }) => {
      noteDraftService.discardDraft(
        params.draftId,
        requirePositiveRevision(body.expectedDraftRevision, 'expectedDraftRevision'),
        getRequestProjectRoot(request),
      );
      return { ok: true };
    },
    { body: t.Object({ expectedDraftRevision: t.Number() }) },
  )

  // ── Recoverable trash (must precede /:id) ────────────────────────────────
  .get('/trash', async ({ request }) => {
    return {
      ok: true,
      data: await notesService.listTrashedNotes(getRequestProjectRoot(request)),
    };
  })

  // ── Whole-vault deterministic archive (must precede /:id) ───────────────
  .get('/export', async ({ request }) => {
    const artifact = await notesService.createVaultExport(getRequestProjectRoot(request));
    return new Response(artifact.body, {
      headers: {
        'Content-Type': artifact.contentType,
        'Content-Length': String(artifact.contentLength),
        'Content-Disposition': `attachment; filename="${artifact.filename}"`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store',
      },
    });
  })

  // ── Whole-vault verified restore (must precede /:id) ───────────────────
  .post('/import-vault/preview', async ({ request }) => {
    const { file } = await vaultArchiveForm(request);
    const plan = await previewVaultRestore(file, getRequestProjectRoot(request));
    return { ok: true, data: publicVaultRestoreResult(plan) };
  })

  .post('/import-vault/restore', async ({ request }) => {
    const { file, archiveSha256 } = await vaultArchiveForm(request);
    if (!archiveSha256) {
      throw new ValidationError('Preview this exact vault archive before restoring it');
    }
    const result = await commitVaultRestore(file, getRequestProjectRoot(request), archiveSha256);
    broadcastNotesNetworkUpdate('update', undefined, undefined, mutationOrigin(request));
    return { ok: true, data: publicVaultRestoreResult(result) };
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
  .put('/:id/icon', async ({ request, params, body }) => {
    const icon = await notesService.setNoteIcon(params.id, body.icon, getRequestProjectRoot(request));
    broadcastNotesNetworkUpdate('update', params.id, undefined, mutationOrigin(request));
    return { ok: true, data: icon };
  }, {
    body: t.Object({ icon: t.Union([t.Null(), t.Object({
      kind: t.Union([t.Literal('builtin'), t.Literal('image')]),
      value: t.String({ maxLength: 500000 }),
    })]) }),
  })

  .put(
    '/:id',
    async ({ request, params, body }) => {
      requirePositiveRevision(body.expectedRevision);
      const note = await notesService.updateNote(params.id, body, getRequestProjectRoot(request));
      broadcastNotesNetworkUpdate('update', note.id, undefined, mutationOrigin(request));
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
    const trashed = await notesService.deleteNote(
      params.id,
      getRequestProjectRoot(request),
      expectedRevision,
    );
    broadcastNotesNetworkUpdate('delete', params.id, undefined, mutationOrigin(request));
    return { ok: true, data: trashed };
  })

  // ── Restore a trashed note ───────────────────────────────────────────────
  .post(
    '/:id/restore',
    async ({ request, params, body }) => {
      const note = await notesService.restoreNote(
        params.id,
        getRequestProjectRoot(request),
        requirePositiveRevision(body.expectedRevision),
      );
      broadcastNotesNetworkUpdate('create', note.id, undefined, mutationOrigin(request));
      return { ok: true, data: note };
    },
    {
      body: t.Object({ expectedRevision: t.Number() }),
    },
  )

  // ── Immutable revision history ───────────────────────────────────────────
  .get('/:id/revisions', async ({ request, params }) => ({
    ok: true,
    data: await notesService.listNoteRevisions(params.id, getRequestProjectRoot(request)),
  }))

  .get('/:id/revisions/:revision', async ({ request, params }) => {
    const revision = Number(params.revision);
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new ValidationError('revision must be a positive integer');
    }
    const snapshot = await notesService.getNoteRevision(
      params.id,
      revision,
      getRequestProjectRoot(request),
    );
    if (!snapshot) throw new NotFoundError('Note revision', `${params.id}@${revision}`);
    return { ok: true, data: snapshot };
  })

  .post(
    '/:id/revisions/:revision/restore',
    async ({ request, params, body }) => {
      const revision = Number(params.revision);
      if (!Number.isSafeInteger(revision) || revision < 1) {
        throw new ValidationError('revision must be a positive integer');
      }
      const note = await notesService.restoreNoteRevision(
        params.id,
        revision,
        requirePositiveRevision(body.expectedRevision),
        getRequestProjectRoot(request),
      );
      broadcastNotesNetworkUpdate('update', note.id, undefined, mutationOrigin(request));
      return { ok: true, data: note };
    },
    { body: t.Object({ expectedRevision: t.Number() }) },
  )

  // ── Get backlinks ─────────────────────────────────────────────────────────
  .get('/:id/backlinks', async ({ request, params }) => {
    const backlinks = await notesService.getNoteBacklinks(
      params.id,
      getRequestProjectRoot(request),
    );
    return { ok: true, data: backlinks };
  })

  // ── Where this note appears ───────────────────────────────────────────────
  .get('/:id/appearances', async ({ request, params }) => ({
    ok: true,
    data: await listNoteAppearances(params.id, getRequestProjectRoot(request)),
  }))

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
    broadcastNotesNetworkUpdate('update', params.id, undefined, mutationOrigin(request));
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
    broadcastNotesNetworkUpdate('update', params.id, undefined, mutationOrigin(request));
    return { ok: true };
  });
