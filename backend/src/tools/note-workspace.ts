import {
  NOTE_WORKSPACE_TOOL_DEFINITIONS,
  NOTE_PROPERTY_TYPES,
  validateNoteCanvas,
  setNoteProperty,
  removeNoteProperty,
  type NoteProperty,
  type NoteCanvasDocument,
} from '@koryphaios/shared';
import { isAbsolute } from 'node:path';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import * as bases from '../notes/note-bases-service';
import * as notes from '../notes/notes-service';
import { listNoteAppearances } from '../notes/note-appearances';
import { setFolderAppearance, setTagAppearance } from '../notes/notes-appearance';
import { getNotePropertyProjection } from '../notes/note-properties-service';
import { noteDraftService } from '../notes/note-draft-service';
import { checkNoteToolPermission } from '../notes/notes-settings';
import { broadcastNotesNetworkUpdate } from '../notes/notes-events';
import { noteHostProvenance } from './note-host-provenance';
import { validateToolInputAgainstSchema } from './tool-exposure';
import type { Tool, ToolContext } from './registry';

const id = { type: 'string', minLength: 1, maxLength: 2048 };
const revision = { type: 'integer', minimum: 1 };
const page = {
  limit: { type: 'integer', minimum: 1, maximum: 100 },
  offset: { type: 'integer', minimum: 0, maximum: 100000 },
};
const definition = {
  type: 'object',
  description:
    'Validated Base definition: version:1, filter predicate/group, sort[], optional groupBy, view:{kind:table/list/card,fields[]}. Fields use source:system with field, or source:property with key and type. No SQL.',
};
const document = {
  type: 'object',
  description:
    'Canvas v:1, name, cards:[{id,x,y,w,h,text,color,noteId?}], edges:[{id,from,to}]. Coordinates bounded; colors are six-digit hex. All note IDs must belong to this project.',
};
const propertyValue = {
  oneOf: [
    { type: 'string', maxLength: 2048 },
    { type: 'number' },
    { type: 'boolean' },
    { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 2048 } },
  ],
};
const patch = {
  type: 'object',
  additionalProperties: false,
  properties: {
    op: { type: 'string', enum: ['set', 'remove'] },
    key: { type: 'string', minLength: 1, maxLength: 80 },
    type: { type: 'string', enum: [...NOTE_PROPERTY_TYPES] },
    value: propertyValue,
  },
  required: ['op', 'key'],
};
const nullableText = (maxLength: number) => ({
  oneOf: [{ type: 'string', maxLength }, { type: 'null' }],
});
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required,
});

export const NOTE_WORKSPACE_SCHEMAS: Record<string, Record<string, unknown>> = {
  list_note_bases: schema({ ...page, includeTrashed: { type: 'boolean' } }),
  read_note_base: schema({ baseId: id, includeTrashed: { type: 'boolean' } }, ['baseId']),
  create_note_base: schema({ name: { type: 'string', minLength: 1, maxLength: 120 }, definition }, [
    'name',
    'definition',
  ]),
  update_note_base: schema(
    {
      baseId: id,
      expectedRevision: revision,
      name: { type: 'string', minLength: 1, maxLength: 120 },
      definition,
    },
    ['baseId', 'expectedRevision'],
  ),
  trash_note_base: schema({ baseId: id, expectedRevision: revision }, [
    'baseId',
    'expectedRevision',
  ]),
  restore_note_base: schema({ baseId: id, expectedRevision: revision }, [
    'baseId',
    'expectedRevision',
  ]),
  list_note_canvases: schema(page),
  read_note_canvas: schema({ noteId: id }, ['noteId']),
  create_note_canvas: schema({ document }, ['document']),
  patch_note_canvas: schema(
    {
      noteId: id,
      expectedRevision: revision,
      name: { type: 'string', minLength: 1, maxLength: 200 },
      upsertCards: { type: 'array', maxItems: 100, items: { type: 'object' } },
      removeCardIds: { type: 'array', maxItems: 100, items: id },
      upsertEdges: { type: 'array', maxItems: 200, items: { type: 'object' } },
      removeEdgeIds: { type: 'array', maxItems: 200, items: id },
    },
    ['noteId', 'expectedRevision'],
  ),
  remove_note_property: schema(
    {
      noteId: id,
      expectedRevision: revision,
      key: { type: 'string', minLength: 1, maxLength: 80 },
    },
    ['noteId', 'expectedRevision', 'key'],
  ),
  patch_note_properties: schema(
    {
      noteId: id,
      expectedRevision: revision,
      patches: { type: 'array', minItems: 1, maxItems: 100, items: patch },
    },
    ['noteId', 'expectedRevision', 'patches'],
  ),
  set_folder_appearance: schema(
    {
      path: { type: 'string', minLength: 1, maxLength: 1000 },
      emoji: nullableText(32),
      color: nullableText(32),
    },
    ['path'],
  ),
  set_tag_appearance: schema(
    {
      tag: { type: 'string', minLength: 1, maxLength: 100 },
      emoji: nullableText(32),
      color: nullableText(32),
    },
    ['tag'],
  ),
  list_note_appearances: schema({ noteId: id }, ['noteId']),
  list_note_relationships: schema({
    noteId: id,
    status: { type: 'string', enum: ['proposed', 'accepted', 'rejected'] },
    limit: { type: 'integer', minimum: 1, maximum: 200 },
    offset: page.offset,
  }),
  refresh_note_relationship: schema(
    {
      fromId: id,
      toId: id,
      expectedRevision: revision,
      expectedSourceRevision: revision,
      expectedTargetRevision: revision,
      type: {
        type: 'string',
        enum: ['related_to', 'supports', 'contradicts', 'depends_on', 'supersedes'],
      },
      evidence: { type: 'string', minLength: 1, maxLength: 2000 },
      weight: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
    },
    [
      'fromId',
      'toId',
      'expectedRevision',
      'expectedSourceRevision',
      'expectedTargetRevision',
      'type',
      'evidence',
    ],
  ),
  remove_note_relationship: schema({ fromId: id, toId: id, expectedRevision: revision }, [
    'fromId',
    'toId',
    'expectedRevision',
  ]),
  list_note_trash: schema(page),
  restore_note: schema({ noteId: id, expectedRevision: revision }, ['noteId', 'expectedRevision']),
  list_note_revisions: schema({ noteId: id, ...page }, ['noteId']),
  read_note_revision: schema(
    { noteId: id, revision, maxChars: { type: 'integer', minimum: 256, maximum: 16000 } },
    ['noteId', 'revision'],
  ),
  restore_note_revision: schema({ noteId: id, revision, expectedRevision: revision }, [
    'noteId',
    'revision',
    'expectedRevision',
  ]),
  list_note_drafts: schema(page),
  read_note_draft: schema(
    { draftId: id, maxChars: { type: 'integer', minimum: 256, maximum: 16000 } },
    ['draftId'],
  ),
  discard_note_draft: schema({ draftId: id, expectedDraftRevision: revision }, [
    'draftId',
    'expectedDraftRevision',
  ]),
  list_note_attachments: schema({ noteId: id, ...page }, ['noteId']),
  read_note_attachment: schema(
    { attachmentId: id, maxChars: { type: 'integer', minimum: 256, maximum: 16000 } },
    ['attachmentId'],
  ),
  add_note_attachment: schema(
    {
      noteId: id,
      expectedRevision: revision,
      filename: { type: 'string', minLength: 1, maxLength: 255 },
      mimeType: { type: 'string', maxLength: 100 },
      encoding: { type: 'string', enum: ['utf8', 'base64'] },
      data: { type: 'string', maxLength: 350000 },
    },
    ['noteId', 'expectedRevision', 'filename', 'mimeType', 'encoding', 'data'],
  ),
  remove_note_attachment: schema({ attachmentId: id, expectedRevision: revision }, [
    'attachmentId',
    'expectedRevision',
  ]),
};

function paginate<T>(rows: T[], input: Record<string, unknown>) {
  const offset = Number(input.offset ?? 0),
    limit = Number(input.limit ?? 50);
  const slice = rows.slice(offset, offset + limit);
  return {
    rows: slice,
    offset,
    limit,
    hasMore: offset + slice.length < rows.length,
    nextOffset: offset + slice.length < rows.length ? offset + slice.length : null,
  };
}
function metadata<T extends { content: string }>(row: T) {
  const { content, ...rest } = row;
  return { ...rest, contentChars: content.length };
}
function boundedBody<T extends { content: string }>(row: T, input: Record<string, unknown>) {
  const maxChars = Number(input.maxChars ?? 6000);
  return {
    ...row,
    content: row.content.slice(0, maxChars),
    truncated: row.content.length > maxChars,
    totalChars: row.content.length,
  };
}
async function canvasNote(noteId: string, root: string) {
  const note = await notes.getNote(noteId, root);
  if (!note || !note.tags.includes('canvas')) throw new Error('Canvas not found in this project');
  return { note, document: validateNoteCanvas(JSON.parse(note.content)) };
}
async function validateEndpoints(doc: NoteCanvasDocument, root: string) {
  for (const noteId of new Set(doc.cards.flatMap((card) => (card.noteId ? [card.noteId] : [])))) {
    if (!(await notes.getNote(noteId, root)))
      throw new Error('Canvas card refers to a missing, trashed or foreign note');
  }
}
async function execute(
  name: string,
  input: Record<string, unknown>,
  root: string,
  ctx: ToolContext,
): Promise<unknown> {
  const noteId = input.noteId as string,
    baseId = input.baseId as string;
  const expected = input.expectedRevision as number;
  const host = { provenance: 'agent' as const, actor: noteHostProvenance(ctx) };
  switch (name) {
    case 'list_note_bases':
      return paginate(
        bases.listNoteBases(root, { includeTrashed: input.includeTrashed === true }),
        input,
      );
    case 'read_note_base': {
      const base = bases.getNoteBase(baseId, root, {
        includeTrashed: input.includeTrashed === true,
      });
      if (!base) throw new Error('Base not found');
      return base;
    }
    case 'create_note_base':
      return bases.createNoteBase(
        { name: input.name as string, definition: input.definition },
        root,
      );
    case 'update_note_base':
      return bases.updateNoteBase(
        baseId,
        {
          expectedRevision: expected,
          name: input.name as string | undefined,
          definition: input.definition,
        },
        root,
      );
    case 'trash_note_base':
      return bases.trashNoteBase(baseId, expected, root);
    case 'restore_note_base':
      return bases.restoreNoteBase(baseId, expected, root);
    case 'list_note_canvases':
      return paginate(
        (await notes.listNotes({}, root))
          .filter((note) => note.tags.includes('canvas'))
          .map(metadata),
        input,
      );
    case 'read_note_canvas': {
      const { note, document } = await canvasNote(noteId, root);
      return { noteId, revision: note.revision, document };
    }
    case 'create_note_canvas': {
      const doc = validateNoteCanvas(input.document);
      await validateEndpoints(doc, root);
      const note = await notes.createNote(
        {
          title: doc.name,
          content: JSON.stringify(doc),
          tags: ['canvas'],
          folderPath: '/canvases',
        },
        root,
      );
      return { noteId: note.id, revision: note.revision, document: doc };
    }
    case 'patch_note_canvas': {
      const { note, document: current } = await canvasNote(noteId, root);
      if (note.revision !== expected)
        throw new Error('Canvas revision conflict; read the latest board before editing');
      const removeCards = new Set((input.removeCardIds as string[]) ?? []),
        removeEdges = new Set((input.removeEdgeIds as string[]) ?? []);
      const cards = new Map(
        current.cards.filter((card) => !removeCards.has(card.id)).map((card) => [card.id, card]),
      );
      for (const card of (input.upsertCards as NoteCanvasDocument['cards']) ?? [])
        cards.set(card.id, card);
      const edges = new Map(
        current.edges
          .filter(
            (edge) =>
              !removeEdges.has(edge.id) && !removeCards.has(edge.from) && !removeCards.has(edge.to),
          )
          .map((edge) => [edge.id, edge]),
      );
      for (const edge of (input.upsertEdges as NoteCanvasDocument['edges']) ?? [])
        edges.set(edge.id, edge);
      const doc = validateNoteCanvas({
        ...current,
        name: input.name ?? current.name,
        cards: [...cards.values()],
        edges: [...edges.values()],
      });
      await validateEndpoints(doc, root);
      const updated = await notes.updateNote(
        noteId,
        { title: doc.name, content: JSON.stringify(doc), expectedRevision: expected },
        root,
      );
      return { noteId, revision: updated.revision, document: doc };
    }
    case 'remove_note_property':
    case 'patch_note_properties': {
      const note = await notes.getNote(noteId, root);
      if (!note || note.format === 'html') throw new Error('Markdown note not found');
      const projection = await getNotePropertyProjection(noteId, root);
      if (note.revision !== expected || projection.revision !== expected)
        throw new Error('Property revision conflict');
      if (projection.status !== 'valid')
        throw new Error('Repair malformed or unsupported frontmatter before editing properties');
      let content = note.content;
      const patches =
        name === 'remove_note_property'
          ? [{ op: 'remove', key: input.key }]
          : (input.patches as Array<Record<string, unknown>>);
      for (const patch of patches) {
        if (patch.op === 'remove') content = removeNoteProperty(content, patch.key as string);
        else {
          if (!patch.type || !Object.hasOwn(patch, 'value'))
            throw new Error('Set patches require type and value');
          content = setNoteProperty(content, patch as unknown as NoteProperty);
        }
      }
      const updated = await notes.updateNote(noteId, { content, expectedRevision: expected }, root);
      return {
        noteId,
        revision: updated.revision,
        properties: (await getNotePropertyProjection(noteId, root)).properties,
      };
    }
    case 'set_folder_appearance':
      return setFolderAppearance(root, {
        path: input.path as string,
        emoji: input.emoji as string | null | undefined,
        color: input.color as string | null | undefined,
      });
    case 'set_tag_appearance':
      return setTagAppearance(root, {
        tag: input.tag as string,
        emoji: input.emoji as string | null | undefined,
        color: input.color as string | null | undefined,
      });
    case 'list_note_appearances':
      return listNoteAppearances(noteId, root);
    case 'list_note_relationships': {
      const limit = Number(input.limit ?? 100),
        offset = Number(input.offset ?? 0);
      const rows = await notes.listNoteRelationships(root, {
        noteId,
        status: input.status as 'proposed' | 'accepted' | 'rejected' | undefined,
        limit,
        offset,
      });
      return {
        rows,
        offset,
        limit,
        possiblyMore: rows.length === limit,
        nextOffset: rows.length === limit ? offset + rows.length : null,
      };
    }
    case 'refresh_note_relationship':
      return notes.refreshNoteRelationship(
        input as unknown as notes.ProposeNoteRelationshipInput & { expectedRevision: number },
        root,
        host,
      );
    case 'remove_note_relationship':
      await notes.unlinkNotes(
        input.fromId as string,
        input.toId as string,
        { ...host, syncContent: false, expectedRelationshipRevision: expected },
        root,
      );
      return { removed: true };
    case 'list_note_trash':
      return paginate((await notes.listTrashedNotes(root)).map(metadata), input);
    case 'restore_note':
      return metadata(await notes.restoreNote(noteId, root, expected));
    case 'list_note_revisions':
      return paginate(await notes.listNoteRevisions(noteId, root), input);
    case 'read_note_revision': {
      const row = await notes.getNoteRevision(noteId, input.revision as number, root);
      if (!row) throw new Error('Revision not found');
      return boundedBody(row, input);
    }
    case 'restore_note_revision':
      return metadata(
        await notes.restoreNoteRevision(noteId, input.revision as number, expected, root),
      );
    case 'list_note_drafts':
      return paginate(noteDraftService.listDrafts(root), input);
    case 'read_note_draft': {
      const draft = noteDraftService.getDraft(input.draftId as string, root);
      if (!draft) throw new Error('Draft not found');
      return boundedBody(draft, input);
    }
    case 'discard_note_draft':
      noteDraftService.discardDraft(
        input.draftId as string,
        input.expectedDraftRevision as number,
        root,
      );
      return { discarded: true };
    case 'list_note_attachments': {
      const note = await notes.getNoteWithLinks(noteId, root);
      if (!note) throw new Error('Note not found');
      return paginate(note.attachments, input);
    }
    case 'read_note_attachment': {
      const attachment = await notes.getAttachment(input.attachmentId as string, root);
      if (!attachment) throw new Error('Attachment not found');
      if (!['text/plain', 'text/markdown', 'application/json'].includes(attachment.mimeType))
        throw new Error('Only text, Markdown and JSON attachments can be read as agent context');
      const maxChars = Number(input.maxChars ?? 6000);
      const handle = await open(attachment.storagePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const bytes = Buffer.alloc(maxChars * 4 + 4);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        const text = bytes.subarray(0, bytesRead).toString('utf8');
        return {
          attachmentId: attachment.id,
          noteId: attachment.noteId,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          content: text.slice(0, maxChars),
          truncated: text.length > maxChars || (await handle.stat()).size > bytesRead,
        };
      } finally {
        await handle.close();
      }
    }
    case 'add_note_attachment': {
      const value = input.data as string;
      if (
        input.encoding === 'base64' &&
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
      )
        throw new Error('Invalid base64 attachment data');
      const data = Buffer.from(value, input.encoding as 'utf8' | 'base64');
      if (data.length > 256000)
        throw new Error('Agent attachments are limited to 256000 bytes per call');
      return notes.saveAttachment(
        noteId,
        input.filename as string,
        input.mimeType as string,
        data,
        root,
        expected,
      );
    }
    case 'remove_note_attachment':
      await notes.deleteAttachment(input.attachmentId as string, root, expected);
      return { removed: true };
    default:
      throw new Error('Unknown Notes workspace operation');
  }
}

export const noteWorkspaceTools: Tool[] = NOTE_WORKSPACE_TOOL_DEFINITIONS.map(
  (definition): Tool => ({
    name: definition.name,
    description:
      definition.description +
      '. Project scoped; writes require the revision you read. Canvas lines are visual only, not knowledge claims.',
    role: definition.category === 'read' ? 'any' : 'worker',
    inputSchema: NOTE_WORKSPACE_SCHEMAS[definition.name]!,
    async run(ctx, call) {
      const start = Date.now();
      try {
        const root = ctx.settingsRoot ?? ctx.workingDirectory;
        if (!root || !isAbsolute(root)) throw new Error('Absolute project scope required');
        const permission = checkNoteToolPermission(definition.name, root, {
          mode: ctx.permissionPolicy?.mode,
        });
        if (
          !permission.allowed ||
          (permission.requiresApproval && !ctx.approvedToolCallIds?.has(call.id))
        )
          throw new Error(permission.reason);
        if (ctx.signal?.aborted) throw new Error('Notes operation canceled');
        const valid = await validateToolInputAgainstSchema(
          NOTE_WORKSPACE_SCHEMAS[definition.name]!,
          call.input,
        );
        if (!valid.valid) throw new Error(valid.error);
        const result = await execute(definition.name, valid.value, root, ctx);
        if (definition.category === 'read') {
          const current = checkNoteToolPermission(definition.name, root, {
            mode: ctx.permissionPolicy?.mode,
          });
          if (
            !current.allowed ||
            (current.requiresApproval && !ctx.approvedToolCallIds?.has(call.id))
          )
            throw new Error('Notes access changed before the result could be published');
          if (ctx.signal?.aborted) throw new Error('Notes read canceled');
        }
        if (definition.category === 'write')
          broadcastNotesNetworkUpdate(
            'update',
            valid.value.noteId as string | undefined,
            ctx.sessionId,
          );
        return {
          callId: call.id,
          name: call.name,
          output: JSON.stringify(result),
          isError: false,
          durationMs: Date.now() - start,
        };
      } catch (error) {
        return {
          callId: call.id,
          name: call.name,
          output: `Error: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
          durationMs: Date.now() - start,
        };
      }
    },
  }),
);
