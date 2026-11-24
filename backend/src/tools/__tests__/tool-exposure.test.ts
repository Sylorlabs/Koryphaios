import { describe, expect, test } from 'bun:test';
import {
  STUB_INPUT_SCHEMA,
  buildExposedToolset,
  toolExposureHint,
  toolSchemaGuidance,
  validateToolInputAgainstSchema,
  type ExposedToolDefinition,
} from '../tool-exposure';
import { ToolRegistry, type Tool, type ToolContext } from '../registry';

function tool(
  name: string,
  required: string[] = [],
  properties: string[] = [],
): ExposedToolDefinition {
  return {
    name,
    description: `${name} full prose description that should never be advertised`,
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(properties.map((property) => [property, { type: 'string' }])),
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    },
  };
}

describe('manager tool exposure', () => {
  test('exposes every tool by name with a stub schema', () => {
    const declared = [
      tool('read_file', ['path'], ['path', 'offset']),
      tool('manage_mcp_server', ['action'], ['action', 'name']),
      tool('totally_obscure_tool', ['alpha'], ['alpha']),
    ];
    const exposed = buildExposedToolset(declared);

    expect(exposed.map((entry) => entry.name)).toEqual([
      'manage_mcp_server',
      'read_file',
      'totally_obscure_tool',
    ]);
    for (const entry of exposed) {
      expect(entry.inputSchema).toEqual(STUB_INPUT_SCHEMA);
    }
  });

  test('never advertises a tool full prose description', () => {
    const exposed = buildExposedToolset([
      tool('read_file', ['path'], ['path']),
      tool('delegate_to_worker', ['task'], ['task']),
    ]);
    for (const entry of exposed) {
      expect(entry.description).not.toContain('full prose description');
      expect(entry.description.length).toBeLessThan(120);
    }
  });

  test('hints required params for tools with no explicit hint', () => {
    expect(toolExposureHint('read_file', { required: ['path', 'offset'] })).toBe(
      'params: path, offset',
    );
    // No required params means there is nothing useful to name.
    expect(toolExposureHint('some_unmapped_tool', { type: 'object' })).toBeUndefined();
    // Too many params stops being a hint.
    expect(toolExposureHint('wide_tool', { required: ['a', 'b', 'c', 'd', 'e'] })).toBeUndefined();
  });

  test('disambiguates tools whose names collide on meaning', () => {
    const fetch = toolExposureHint('fetch_context', {});
    const prune = toolExposureHint('prune_context', {});
    const askHuman = toolExposureHint('ask_user', {});
    const askAgent = toolExposureHint('ask_manager', {});

    expect(fetch).toContain('back into');
    expect(prune).toContain('free space');
    expect(fetch).not.toBe(prune);
    expect(askHuman).toContain('human');
    expect(askAgent).toContain('manager');
  });

  test('output is byte-stable regardless of registration order', () => {
    const declared = [tool('write_file', ['path', 'content']), tool('bash', ['command'])];
    expect(buildExposedToolset(declared)).toEqual(buildExposedToolset([...declared].reverse()));
  });
});

describe('stubbed call recovery', () => {
  const strict: Tool = {
    name: 'create_resource',
    description: 'create a note',
    role: 'manager',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' }, body: { type: 'string' } },
      required: ['title'],
      additionalProperties: false,
    },
    async run(_ctx, call) {
      return {
        callId: call.id,
        name: call.name,
        output: `ran:${JSON.stringify(call.input)}`,
        isError: false,
        durationMs: 0,
      };
    },
  };

  function ctx(validateToolInput: boolean): ToolContext {
    return {
      sessionId: 'test',
      callerRole: 'manager',
      workingDirectory: process.cwd(),
      validateToolInput,
    };
  }

  test('a valid call runs normally', async () => {
    const registry = new ToolRegistry();
    registry.register(strict);
    const result = await registry.execute(ctx(true), {
      id: '1',
      name: 'create_resource',
      input: { title: 'a' },
    });
    expect(result.isError).toBe(false);
    expect(result.output).toBe('ran:{"title":"a"}');
  });

  test('a rejected call returns the authoritative schema so the model can retry', async () => {
    const registry = new ToolRegistry();
    registry.register(strict);
    const result = await registry.execute(ctx(true), {
      id: '2',
      name: 'create_resource',
      input: { wrong: 'guess' },
    });
    expect(result.isError).toBe(true);
    // The whole point: no discovery call is needed, the fix is in the result.
    expect(result.output).toContain('"required"');
    expect(result.output).toContain('"title"');
    expect(result.output).toContain('create_resource');
  });

  test('validation is off unless the turn opts in', async () => {
    const registry = new ToolRegistry();
    registry.register(strict);
    const result = await registry.execute(ctx(false), {
      id: '3',
      name: 'create_resource',
      input: { wrong: 'guess' },
    });
    expect(result.isError).toBe(false);
  });

  test('role enforcement still precedes schema feedback', async () => {
    const registry = new ToolRegistry();
    registry.register(strict);
    const result = await registry.execute(
      { ...ctx(true), callerRole: 'worker' },
      { id: '4', name: 'create_resource', input: { wrong: 'guess' } },
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('not available to the worker role');
  });
});

describe('tool input validation', () => {
  test('accepts input matching the schema', async () => {
    const schema = {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    };
    expect(await validateToolInputAgainstSchema(schema, { path: 'README.md' })).toEqual({
      valid: true,
      value: { path: 'README.md' },
    });
  });

  test('rejects input violating the schema', async () => {
    const schema = {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    };
    const invalid = await validateToolInputAgainstSchema(schema, { path: 42, extra: true });
    expect(invalid.valid).toBe(false);
    if (!invalid.valid) expect(invalid.error).toContain('must');
  });

  test('rescues a JSON-encoded array sent as a string', async () => {
    const schema = {
      type: 'object',
      properties: { skills: { type: 'array', items: { type: 'string' } } },
      required: ['skills'],
    };
    // The exact form a flash model sent four times in a row during the live
    // skill-feeder smoke test.
    expect(await validateToolInputAgainstSchema(schema, { skills: '["response-style"]' })).toEqual({
      valid: true,
      value: { skills: ['response-style'] },
    });
  });

  test('rescues a bare string where string items are expected', async () => {
    const schema = {
      type: 'object',
      properties: { skills: { type: 'array', items: { type: 'string' } } },
      required: ['skills'],
    };
    expect(await validateToolInputAgainstSchema(schema, { skills: 'response-style' })).toEqual({
      valid: true,
      value: { skills: ['response-style'] },
    });
  });

  test('rescues through an anyOf array branch when no branch takes a string', async () => {
    const schema = {
      type: 'object',
      properties: {
        skills: {
          anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'number' }],
        },
      },
      required: ['skills'],
    };
    // The raw string matches no branch (not an array, not a number), so the
    // rescue pass must parse it into the array branch.
    expect(
      await validateToolInputAgainstSchema(schema, { skills: '["plan-mode", "critic-review"]' }),
    ).toEqual({ valid: true, value: { skills: ['plan-mode', 'critic-review'] } });
  });

  test('rescues a JSON-encoded array of objects', async () => {
    const schema = {
      type: 'object',
      properties: { files: { type: 'array', items: { type: 'object' } } },
      required: ['files'],
    };
    const rescued = await validateToolInputAgainstSchema(schema, { files: '[{"path":"a"}]' });
    expect(rescued).toEqual({ valid: true, value: { files: [{ path: 'a' }] } });
  });

  test('leaves genuine type errors untouched', async () => {
    const schema = {
      type: 'object',
      properties: { path: { type: 'string' }, count: { type: 'number' } },
      required: ['count'],
    };
    const invalid = await validateToolInputAgainstSchema(schema, { count: 'lots' });
    expect(invalid.valid).toBe(false);
  });

  test('guidance names the tool and its required keys', () => {
    const schema = { type: 'object', required: ['objective', 'scope'] };
    const guidance = toolSchemaGuidance('create_goal', schema, 'missing objective');
    expect(guidance).toContain('create_goal');
    expect(guidance).toContain('missing objective');
    expect(guidance).toContain('Required keys: objective, scope');
    expect(guidance).toContain('"required"');
  });
});
