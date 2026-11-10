import { describe, expect, it } from 'bun:test';
import { normalizeToolArguments } from '../tool-arguments';

/**
 * Gateways proxy several upstreams and do not all stream tool arguments the way
 * the first-party API does. Each of these shapes used to abort the whole turn
 * with "Provider tool arguments must be a valid JSON object".
 */
describe('normalizeToolArguments', () => {
  it('passes clean JSON through untouched', () => {
    expect(normalizeToolArguments('{"path":"a.ts"}')).toEqual({
      input: { path: 'a.ts' },
      repaired: false,
      recovered: true,
    });
  });

  it('treats an empty payload as a no-argument call', () => {
    expect(normalizeToolArguments('')).toEqual({ input: {}, repaired: false, recovered: true });
    expect(normalizeToolArguments('   ')).toEqual({ input: {}, repaired: false, recovered: true });
    expect(normalizeToolArguments(undefined)).toEqual({
      input: {},
      repaired: false,
      recovered: true,
    });
  });

  it('recovers the object from a fenced or prose-prefixed payload', () => {
    expect(normalizeToolArguments('```json\n{"path":"a.ts"}\n```')).toMatchObject({
      input: { path: 'a.ts' },
      recovered: true,
    });
    expect(normalizeToolArguments('Here are the arguments: {"path":"a.ts"}')).toMatchObject({
      input: { path: 'a.ts' },
      recovered: true,
    });
  });

  it('closes a payload the upstream truncated mid-object', () => {
    expect(normalizeToolArguments('{"path":"a.ts"')).toMatchObject({
      input: { path: 'a.ts' },
      repaired: true,
      recovered: true,
    });
    expect(normalizeToolArguments('{"paths":["a.ts"')).toMatchObject({
      input: { paths: ['a.ts'] },
      recovered: true,
    });
  });

  it('drops a trailing comma the model emitted', () => {
    expect(normalizeToolArguments('{"path":"a.ts",}')).toMatchObject({
      input: { path: 'a.ts' },
      recovered: true,
    });
  });

  it('stops at the end of the first complete object', () => {
    expect(normalizeToolArguments('{"path":"a.ts"} trailing noise')).toMatchObject({
      input: { path: 'a.ts' },
      recovered: true,
    });
  });

  it('reports scalar and array payloads as unrecovered instead of coercing them', () => {
    for (const raw of ['null', '[]', '"text"', '42', '{not json']) {
      const result = normalizeToolArguments(raw);
      expect(result.recovered).toBe(false);
      expect(result.input).toEqual({});
    }
  });
});
