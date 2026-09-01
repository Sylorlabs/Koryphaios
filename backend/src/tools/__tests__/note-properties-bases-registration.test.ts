import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_NOTE_TOOL_PERMISSIONS,
  NOTE_TOOL_DEFINITIONS,
  NOTE_TOOL_NAMES,
  parseNoteProperties,
} from '@koryphaios/shared';
import type { NoteBaseQueryResult } from '../../notes/note-bases-service';
import type { NotePropertyProjection } from '../../notes/note-properties-service';
import { KORY_TOOLS, toolsForRole } from '../../providers/kory-mcp-bridge';
import { DEFAULT_PERMISSION_MATRIX } from '../../security/permission-matrix';
import { READ_ONLY_TOOLS } from '../permission-policy';
import type { ToolCallInput, ToolContext } from '../registry';
import {
  createNotePropertiesBaseTools,
  type NotePropertiesBaseToolDependencies,
} from '../note-properties-bases';
import { formatReadNoteOutput, noteTools, updateNoteTool } from '../notes';

const PROJECT_ROOT = '/tmp/kory-agent-properties-project';

const context: ToolContext = {
  sessionId: 'agent-property-session',
  workingDirectory: PROJECT_ROOT,
};

function call(name: string, input: Record<string, unknown>): ToolCallInput {
  return { id: `${name}-call`, name, input };
}

function dependencies(
  overrides: Partial<NotePropertiesBaseToolDependencies> = {},
): NotePropertiesBaseToolDependencies {
  return {
    getNote: async () => null,
    updateNote: async () => {
      throw new Error('unexpected update');
    },
    getNotePropertyProjection: async () => {
      throw new Error('unexpected projection read');
    },
    queryNoteBase: async () => {
      throw new Error('unexpected Base query');
    },
    resolveNoteBaseIdByName: async () => null,
    broadcastUpdate: () => undefined,
    ...overrides,
  };
}

function projected(content: string, revision: number): NotePropertyProjection {
  const parsed = parseNoteProperties(content);
  return {
    noteId: 'note-a',
    revision,
    status: parsed.warnings.length > 0 ? 'unsupported' : 'valid',
    properties: parsed.properties,
    warnings: parsed.warnings,
  };
}

describe('typed Properties and saved Bases agent registration', () => {
  test('registers shared permissions, runtime roles, and the static MCP catalog consistently', () => {
    const expected = [
      ['get_note_properties', 'read', 'auto', 'any'],
      ['query_note_base', 'read', 'auto', 'any'],
      ['set_note_property', 'write', 'ask', 'worker'],
    ] as const;

    for (const [name, category, permission, role] of expected) {
      expect(NOTE_TOOL_NAMES).toContain(name);
      expect(NOTE_TOOL_DEFINITIONS).toContainEqual(expect.objectContaining({ name, category }));
      expect(DEFAULT_NOTE_TOOL_PERMISSIONS[name]).toBe(permission);
      expect(DEFAULT_PERMISSION_MATRIX.tools[name]).toEqual({ tool: name, level: permission });
      expect(noteTools.find((tool) => tool.name === name)?.role).toBe(role);
      expect(KORY_TOOLS.find((tool) => tool.name === `kory__${name}`)?.role).toBe(role);
    }

    expect(READ_ONLY_TOOLS.has('get_note_properties')).toBe(true);
    expect(READ_ONLY_TOOLS.has('query_note_base')).toBe(true);
    expect(READ_ONLY_TOOLS.has('set_note_property')).toBe(false);
    expect(toolsForRole('critic').map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['kory__get_note_properties', 'kory__query_note_base']),
    );
    expect(toolsForRole('critic').map((tool) => tool.name)).not.toContain(
      'kory__set_note_property',
    );

    const querySchema = KORY_TOOLS.find((tool) => tool.name === 'kory__query_note_base')
      ?.inputSchema as {
      additionalProperties?: boolean;
      properties?: Record<string, unknown>;
    };
    expect(querySchema.additionalProperties).toBe(false);
    expect(Object.keys(querySchema.properties ?? {}).sort()).toEqual([
      'baseId',
      'baseName',
      'limit',
      'offset',
    ]);
    expect(querySchema.properties).not.toHaveProperty('definition');
    expect(querySchema.properties).not.toHaveProperty('filter');
    expect(querySchema.properties).not.toHaveProperty('sql');

    const writeSchema = KORY_TOOLS.find((tool) => tool.name === 'kory__set_note_property')
      ?.inputSchema as { required?: string[] };
    expect(writeSchema.required).toContain('expectedRevision');

    expect((updateNoteTool.inputSchema as { required?: string[] }).required).toContain(
      'expectedRevision',
    );
    expect(
      (
        KORY_TOOLS.find((tool) => tool.name === 'kory__update_note')?.inputSchema as {
          required?: string[];
        }
      ).required,
    ).toContain('expectedRevision');
  });

  test('read_note output exposes the authoritative revision needed by optimistic writes', async () => {
    const output = formatReadNoteOutput(
      {
        id: 'note-a',
        title: 'Alpha',
        folderPath: '/',
        tags: ['agentic'],
        revision: 17,
        content: '# Alpha',
      },
      [{ title: 'Backlink' }],
      [{ title: 'Outlink' }],
    );
    expect(output).toContain('ID: note-a\nRevision: 17\nFolder: /');

    const missingRevision = await updateNoteTool.run(
      context,
      call('update_note', { id: 'note-a', content: 'unsafe blind write' }),
    );
    expect(missingRevision.isError).toBe(true);
    expect(missingRevision.output).toMatch(/expectedRevision must be a positive integer/);
  });
});

describe('typed Properties and saved Bases agent execution', () => {
  test('sets YAML through the optimistic note write and verifies the new projection', async () => {
    let note = {
      id: 'note-a',
      title: 'Alpha',
      content: '---\npriority: 3\n---\n# Alpha',
      format: 'markdown' as const,
      revision: 4,
    };
    const observedRoots: string[] = [];
    let broadcast: { noteId: string; sessionId: string } | undefined;
    const tools = createNotePropertiesBaseTools(
      dependencies({
        getNote: async (_noteId, root) => {
          observedRoots.push(root);
          return { ...note };
        },
        getNotePropertyProjection: async (_noteId, root) => {
          observedRoots.push(root);
          return projected(note.content, note.revision);
        },
        updateNote: async (noteId, input, root) => {
          observedRoots.push(root);
          expect(noteId).toBe('note-a');
          expect(input.expectedRevision).toBe(4);
          expect(input.content).toContain('priority: 9');
          note = { ...note, content: input.content, revision: 5 };
          return { ...note };
        },
        broadcastUpdate: (noteId, sessionId) => {
          broadcast = { noteId, sessionId };
        },
      }),
    );

    const result = await tools.setNotePropertyTool.run(
      context,
      call('set_note_property', {
        noteId: 'note-a',
        expectedRevision: 4,
        key: 'priority',
        type: 'number',
        value: 9,
      }),
    );

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.output)).toEqual({
      noteId: 'note-a',
      revision: 5,
      property: { key: 'priority', type: 'number', value: 9 },
    });
    expect(observedRoots).toEqual([PROJECT_ROOT, PROJECT_ROOT, PROJECT_ROOT, PROJECT_ROOT]);
    expect(broadcast).toEqual({
      noteId: 'note-a',
      sessionId: 'agent-property-session',
    });
  });

  test('rejects stale revisions and malformed frontmatter before any write', async () => {
    let updateCalls = 0;
    const staleTools = createNotePropertiesBaseTools(
      dependencies({
        getNote: async () => ({
          id: 'note-a',
          title: 'Alpha',
          content: '---\nstatus: newer\n---\n',
          format: 'markdown',
          revision: 8,
        }),
        updateNote: async () => {
          updateCalls++;
          throw new Error('must not write');
        },
      }),
    );
    const stale = await staleTools.setNotePropertyTool.run(
      context,
      call('set_note_property', {
        noteId: 'note-a',
        expectedRevision: 7,
        key: 'status',
        type: 'text',
        value: 'stale write',
      }),
    );
    expect(stale.isError).toBe(true);
    expect(stale.output).toMatch(/changed after its properties were read/i);
    expect(updateCalls).toBe(0);

    const malformedProjection: NotePropertyProjection = {
      noteId: 'note-a',
      revision: 8,
      status: 'invalid',
      properties: [],
      warnings: [{ message: 'Frontmatter is missing a closing --- marker.' }],
    };
    const malformedTools = createNotePropertiesBaseTools(
      dependencies({
        getNote: async () => ({
          id: 'note-a',
          title: 'Alpha',
          content: '---\nstatus: broken',
          format: 'markdown',
          revision: 8,
        }),
        getNotePropertyProjection: async () => malformedProjection,
        updateNote: async () => {
          updateCalls++;
          throw new Error('must not write');
        },
      }),
    );
    const malformed = await malformedTools.setNotePropertyTool.run(
      context,
      call('set_note_property', {
        noteId: 'note-a',
        expectedRevision: 8,
        key: 'status',
        type: 'text',
        value: 'unsafe write',
      }),
    );
    expect(malformed.isError).toBe(true);
    expect(malformed.output).toMatch(/malformed or unsupported/i);
    expect(updateCalls).toBe(0);

    const malformedRead = await malformedTools.getNotePropertiesTool.run(
      context,
      call('get_note_properties', { noteId: 'note-a' }),
    );
    expect(malformedRead.isError).toBe(true);
    expect(malformedRead.output).toMatch(/malformed frontmatter/i);
  });

  test('queries only a saved Base selection with bounded project-scoped pagination', async () => {
    let queryCalls = 0;
    let observed:
      { baseId: string; options: { limit?: number; offset?: number }; root: string } | undefined;
    const queryResult: NoteBaseQueryResult = {
      rows: [
        {
          id: 'note-a',
          title: 'Alpha',
          folderPath: '/',
          tags: ['agentic'],
          pinned: false,
          includeInContext: false,
          format: 'markdown',
          createdAt: new Date('2026-08-30T00:00:00.000Z'),
          updatedAt: new Date('2026-08-30T01:00:00.000Z'),
          properties: { priority: 9 },
        },
      ],
      limit: 25,
      offset: 50,
      hasMore: true,
      invalidDocumentCount: 0,
    };
    const tools = createNotePropertiesBaseTools(
      dependencies({
        resolveNoteBaseIdByName: async (baseName, root) => {
          expect(baseName).toBe('Evidence ledger');
          expect(root).toBe(PROJECT_ROOT);
          return 'base-a';
        },
        queryNoteBase: async (baseId, options, root) => {
          queryCalls++;
          observed = { baseId, options, root };
          return queryResult;
        },
      }),
    );

    const injectedAst = await tools.queryNoteBaseTool.run(
      context,
      call('query_note_base', { baseId: 'base-a', definition: { filter: [] } }),
    );
    expect(injectedAst.isError).toBe(true);
    expect(injectedAst.output).toMatch(/Unexpected input field: definition/);
    expect(queryCalls).toBe(0);

    const ambiguousSelector = await tools.queryNoteBaseTool.run(
      context,
      call('query_note_base', { baseId: 'base-a', baseName: 'Evidence ledger' }),
    );
    expect(ambiguousSelector.isError).toBe(true);
    expect(ambiguousSelector.output).toMatch(/Exactly one of baseId or baseName/);
    expect(queryCalls).toBe(0);

    const result = await tools.queryNoteBaseTool.run(
      context,
      call('query_note_base', { baseName: 'Evidence ledger', limit: 25, offset: 50 }),
    );
    expect(result.isError).toBe(false);
    expect(observed).toEqual({
      baseId: 'base-a',
      options: { limit: 25, offset: 50 },
      root: PROJECT_ROOT,
    });
    expect(JSON.parse(result.output)).toMatchObject({
      baseId: 'base-a',
      baseName: 'Evidence ledger',
      limit: 25,
      offset: 50,
      hasMore: true,
      nextOffset: 51,
      rows: [{ id: 'note-a', properties: { priority: 9 } }],
    });
  });

  test('does not return a partial Base result when property projection health is degraded', async () => {
    const tools = createNotePropertiesBaseTools(
      dependencies({
        queryNoteBase: async (): Promise<NoteBaseQueryResult> => ({
          rows: [],
          limit: 50,
          offset: 0,
          hasMore: false,
          invalidDocumentCount: 1,
        }),
      }),
    );
    const result = await tools.queryNoteBaseTool.run(
      context,
      call('query_note_base', { baseId: 'base-a' }),
    );
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/cannot be returned safely/i);
  });
});
