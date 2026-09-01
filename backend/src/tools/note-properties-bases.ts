import {
  NOTE_PROPERTY_TYPES,
  setNoteProperty,
  type NoteProperty,
  type NotePropertyType,
} from '@koryphaios/shared';
import { isAbsolute } from 'node:path';
import { ConflictError, NotFoundError, ValidationError } from '../errors/types';
import {
  listNoteBases,
  queryNoteBase,
  type NoteBaseQueryResult,
} from '../notes/note-bases-service';
import {
  getNotePropertyProjection,
  type NotePropertyProjection,
} from '../notes/note-properties-service';
import { broadcastNotesNetworkUpdate } from '../notes/notes-events';
import * as notesService from '../notes/notes-service';
import type { Tool, ToolCallInput, ToolCallOutput, ToolContext } from './registry';

const MAX_AGENT_BASE_PAGE_SIZE = 100;
const MAX_AGENT_BASE_OFFSET = 100_000;
const MAX_RESOURCE_ID_LENGTH = 512;

interface AgentNoteRecord {
  id: string;
  title: string;
  content: string;
  format: 'markdown' | 'html';
  revision: number;
}

export interface NotePropertiesBaseToolDependencies {
  getNote(noteId: string, projectRoot: string): Promise<AgentNoteRecord | null>;
  updateNote(
    noteId: string,
    input: { content: string; expectedRevision: number },
    projectRoot: string,
  ): Promise<AgentNoteRecord>;
  getNotePropertyProjection(noteId: string, projectRoot: string): Promise<NotePropertyProjection>;
  queryNoteBase(
    baseId: string,
    options: { limit?: number; offset?: number },
    projectRoot: string,
  ): Promise<NoteBaseQueryResult>;
  resolveNoteBaseIdByName(baseName: string, projectRoot: string): Promise<string | null>;
  broadcastUpdate(noteId: string, sessionId: string): void;
}

const defaultDependencies: NotePropertiesBaseToolDependencies = {
  async getNote(noteId, projectRoot) {
    const note = await notesService.getNote(noteId, projectRoot);
    return note
      ? {
          id: note.id,
          title: note.title,
          content: note.content,
          format: note.format === 'html' ? 'html' : 'markdown',
          revision: note.revision,
        }
      : null;
  },
  async updateNote(noteId, input, projectRoot) {
    const note = await notesService.updateNote(noteId, input, projectRoot);
    return {
      id: note.id,
      title: note.title,
      content: note.content,
      format: note.format === 'html' ? 'html' : 'markdown',
      revision: note.revision,
    };
  },
  getNotePropertyProjection,
  queryNoteBase,
  async resolveNoteBaseIdByName(baseName, projectRoot) {
    const normalizedName = baseName.normalize('NFKC').toLowerCase();
    const matches = listNoteBases(projectRoot).filter(
      (base) => base.name.normalize('NFKC').toLowerCase() === normalizedName,
    );
    if (matches.length > 1) {
      throw new ConflictError('The saved Base name is ambiguous in this project.', {
        baseName,
      });
    }
    return matches[0]?.id ?? null;
  },
  broadcastUpdate(noteId, sessionId) {
    broadcastNotesNetworkUpdate('update', noteId, sessionId);
  },
};

const NOTE_PROPERTY_VALUE_SCHEMA = {
  oneOf: [
    { type: 'string', maxLength: 2_048 },
    { type: 'number' },
    { type: 'boolean' },
    {
      type: 'array',
      maxItems: 100,
      items: { type: 'string', maxLength: 2_048 },
    },
  ],
} as const;

function inputRecord(call: ToolCallInput): Record<string, unknown> {
  const input = call.input as unknown;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('Tool input must be an object');
  }
  return input as Record<string, unknown>;
}

function assertOnlyKeys(input: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(input).filter((key) => !allowedKeys.has(key));
  if (unexpected.length > 0) {
    throw new ValidationError(`Unexpected input field: ${unexpected.sort()[0]}`);
  }
}

function requireProjectRoot(ctx: ToolContext): string {
  const root = ctx.workingDirectory;
  if (typeof root !== 'string' || !root.trim() || !isAbsolute(root)) {
    throw new ValidationError('A project-scoped absolute workingDirectory is required');
  }
  return root;
}

function boundedId(value: unknown, field: 'noteId' | 'baseId'): string {
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string`);
  const id = value.trim();
  if (!id || id.length > MAX_RESOURCE_ID_LENGTH || /[\r\n\0]/.test(id)) {
    throw new ValidationError(`${field} is invalid`);
  }
  return id;
}

function boundedBaseName(value: unknown): string {
  if (typeof value !== 'string') throw new ValidationError('baseName must be a string');
  const name = value.trim();
  if (!name || name.length > 120 || /\p{Cc}/u.test(name)) {
    throw new ValidationError('baseName is invalid');
  }
  return name;
}

function positiveRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new ValidationError('expectedRevision must be a positive integer');
  }
  return Number(value);
}

function boundedPageInteger(
  value: unknown,
  field: 'limit' | 'offset',
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new ValidationError(`${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return Number(value);
}

function propertyFromInput(input: Record<string, unknown>): NoteProperty {
  if (typeof input.key !== 'string') throw new ValidationError('key must be a string');
  if (
    typeof input.type !== 'string' ||
    !NOTE_PROPERTY_TYPES.includes(input.type as NotePropertyType)
  ) {
    throw new ValidationError('type must be a supported note property type');
  }
  if (!Object.prototype.hasOwnProperty.call(input, 'value')) {
    throw new ValidationError('value is required');
  }
  return {
    key: input.key,
    type: input.type as NotePropertyType,
    value: input.value as NoteProperty['value'],
  };
}

function failedToolCall(call: ToolCallInput, startedAt: number, error: unknown): ToolCallOutput {
  return {
    callId: call.id,
    name: call.name,
    output: 'Error: ' + (error instanceof Error ? error.message : String(error)),
    isError: true,
    durationMs: Date.now() - startedAt,
  };
}

export function createNotePropertiesBaseTools(
  dependencies: NotePropertiesBaseToolDependencies = defaultDependencies,
): {
  getNotePropertiesTool: Tool;
  queryNoteBaseTool: Tool;
  setNotePropertyTool: Tool;
} {
  const getNotePropertiesTool: Tool = {
    name: 'get_note_properties',
    description:
      'Read the bounded typed YAML properties projected from one Markdown note. Rejects malformed frontmatter instead of returning partial values.',
    role: 'any',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        noteId: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_RESOURCE_ID_LENGTH,
          description: 'Project-scoped note ID',
        },
      },
      required: ['noteId'],
    },
    async run(ctx, call) {
      const startedAt = Date.now();
      try {
        const projectRoot = requireProjectRoot(ctx);
        const input = inputRecord(call);
        assertOnlyKeys(input, ['noteId']);
        const noteId = boundedId(input.noteId, 'noteId');
        const projection = await dependencies.getNotePropertyProjection(noteId, projectRoot);
        if (projection.status === 'invalid') {
          throw new ValidationError(
            'The note has malformed frontmatter. Repair it in source mode before reading typed properties.',
            { noteId, warnings: projection.warnings },
          );
        }
        return {
          callId: call.id,
          name: call.name,
          output: JSON.stringify({
            noteId,
            revision: projection.revision,
            status: projection.status,
            properties: projection.properties,
            warnings: projection.warnings,
          }),
          isError: false,
          durationMs: Date.now() - startedAt,
        };
      } catch (error: unknown) {
        return failedToolCall(call, startedAt, error);
      }
    },
  };

  const queryNoteBaseTool: Tool = {
    name: 'query_note_base',
    description:
      'Query an already-saved project Base by its ID or unique name. Returns at most 100 deterministic rows and never accepts SQL or a caller-supplied query/filter AST.',
    role: 'any',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        baseId: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_RESOURCE_ID_LENGTH,
          description: 'ID of an existing saved Base in this project',
        },
        baseName: {
          type: 'string',
          minLength: 1,
          maxLength: 120,
          description: 'Unique saved Base name in this project',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_AGENT_BASE_PAGE_SIZE,
          description: 'Rows to return (default 50, maximum 100)',
        },
        offset: {
          type: 'integer',
          minimum: 0,
          maximum: MAX_AGENT_BASE_OFFSET,
          description: 'Deterministic result offset',
        },
      },
      oneOf: [{ required: ['baseId'] }, { required: ['baseName'] }],
    },
    async run(ctx, call) {
      const startedAt = Date.now();
      try {
        const projectRoot = requireProjectRoot(ctx);
        const input = inputRecord(call);
        assertOnlyKeys(input, ['baseId', 'baseName', 'limit', 'offset']);
        const hasBaseId = input.baseId !== undefined;
        const hasBaseName = input.baseName !== undefined;
        if (hasBaseId === hasBaseName) {
          throw new ValidationError('Exactly one of baseId or baseName is required');
        }
        const baseName = hasBaseName ? boundedBaseName(input.baseName) : undefined;
        const baseId = hasBaseId
          ? boundedId(input.baseId, 'baseId')
          : await dependencies.resolveNoteBaseIdByName(baseName!, projectRoot);
        if (!baseId) throw new NotFoundError('Note Base', baseName);
        const limit = boundedPageInteger(input.limit, 'limit', 50, 1, MAX_AGENT_BASE_PAGE_SIZE);
        const offset = boundedPageInteger(input.offset, 'offset', 0, 0, MAX_AGENT_BASE_OFFSET);
        const result = await dependencies.queryNoteBase(baseId, { limit, offset }, projectRoot);
        if (result.invalidDocumentCount > 0) {
          throw new ValidationError(
            'The saved Base cannot be returned safely until malformed or unsupported frontmatter is repaired.',
            { baseId, invalidDocumentCount: result.invalidDocumentCount },
          );
        }
        return {
          callId: call.id,
          name: call.name,
          output: JSON.stringify({
            baseId,
            ...(baseName ? { baseName } : {}),
            ...result,
            nextOffset: result.hasMore ? result.offset + result.rows.length : null,
          }),
          isError: false,
          durationMs: Date.now() - startedAt,
        };
      } catch (error: unknown) {
        return failedToolCall(call, startedAt, error);
      }
    },
  };

  const setNotePropertyTool: Tool = {
    name: 'set_note_property',
    description:
      'Set one typed YAML property in a Markdown note. expectedRevision is mandatory; stale writes conflict instead of overwriting newer Markdown.',
    role: 'worker',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        noteId: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_RESOURCE_ID_LENGTH,
          description: 'Project-scoped note ID',
        },
        expectedRevision: {
          type: 'integer',
          minimum: 1,
          description: 'Revision returned by get_note_properties or read_note',
        },
        key: { type: 'string', minLength: 1, maxLength: 80 },
        type: { type: 'string', enum: [...NOTE_PROPERTY_TYPES] },
        value: NOTE_PROPERTY_VALUE_SCHEMA,
      },
      required: ['noteId', 'expectedRevision', 'key', 'type', 'value'],
    },
    async run(ctx, call) {
      const startedAt = Date.now();
      try {
        const projectRoot = requireProjectRoot(ctx);
        const input = inputRecord(call);
        assertOnlyKeys(input, ['noteId', 'expectedRevision', 'key', 'type', 'value']);
        const noteId = boundedId(input.noteId, 'noteId');
        const expectedRevision = positiveRevision(input.expectedRevision);
        const property = propertyFromInput(input);
        const note = await dependencies.getNote(noteId, projectRoot);
        if (!note) throw new NotFoundError('Note', noteId);
        if (note.format !== 'markdown') {
          throw new ValidationError('Typed YAML properties can only be written to Markdown notes');
        }
        if (note.revision !== expectedRevision) {
          throw new ConflictError(
            'This note changed after its properties were read. Review the newer revision before saving.',
            { expectedRevision, currentRevision: note.revision },
          );
        }
        const currentProjection = await dependencies.getNotePropertyProjection(noteId, projectRoot);
        if (currentProjection.revision !== expectedRevision) {
          throw new ConflictError('The note property projection is no longer current.', {
            expectedRevision,
            currentRevision: currentProjection.revision,
          });
        }
        if (currentProjection.status !== 'valid') {
          throw new ValidationError(
            'The note frontmatter is malformed or unsupported. Repair it in source mode before changing typed properties.',
            { noteId, warnings: currentProjection.warnings },
          );
        }

        let nextContent: string;
        try {
          nextContent = setNoteProperty(note.content, property);
        } catch (error: unknown) {
          throw new ValidationError(
            error instanceof Error ? error.message : 'The property value is invalid',
          );
        }
        const updated = await dependencies.updateNote(
          noteId,
          { content: nextContent, expectedRevision },
          projectRoot,
        );
        dependencies.broadcastUpdate(noteId, ctx.sessionId);
        const verified = await dependencies.getNotePropertyProjection(noteId, projectRoot);
        if (verified.revision !== updated.revision || verified.status !== 'valid') {
          throw new ConflictError(
            'The note was saved, but its typed property projection could not be verified.',
            { noteRevision: updated.revision, projectedRevision: verified.revision },
          );
        }
        const normalizedKey = property.key.normalize('NFKC').toLowerCase();
        const projectedProperty = verified.properties.find(
          (candidate) => candidate.key.normalize('NFKC').toLowerCase() === normalizedKey,
        );
        if (!projectedProperty) {
          throw new ConflictError(
            'The note was saved, but the requested property was not present in its projection.',
            { noteRevision: updated.revision, key: property.key },
          );
        }
        return {
          callId: call.id,
          name: call.name,
          output: JSON.stringify({
            noteId,
            revision: updated.revision,
            property: projectedProperty,
          }),
          isError: false,
          durationMs: Date.now() - startedAt,
        };
      } catch (error: unknown) {
        return failedToolCall(call, startedAt, error);
      }
    },
  };

  return { getNotePropertiesTool, queryNoteBaseTool, setNotePropertyTool };
}

export const { getNotePropertiesTool, queryNoteBaseTool, setNotePropertyTool } =
  createNotePropertiesBaseTools();
