import { describe, expect, test } from 'bun:test';
import { jsonSchemaToTs, propertyKey } from './typescript';

describe('jsonSchemaToTs', () => {
  test('primitives and literals', () => {
    expect(jsonSchemaToTs({ type: 'string' })).toBe('string');
    expect(jsonSchemaToTs({ type: 'integer' })).toBe('number');
    expect(jsonSchemaToTs({ type: 'boolean' })).toBe('boolean');
    expect(jsonSchemaToTs({ const: 'a' })).toBe('"a"');
    expect(jsonSchemaToTs({ enum: ['x', 'y'] })).toBe('"x" | "y"');
  });

  test('unions, arrays and nullable types', () => {
    expect(jsonSchemaToTs({ anyOf: [{ type: 'string' }, { type: 'number' }] })).toBe(
      'string | number',
    );
    expect(jsonSchemaToTs({ type: 'array', items: { type: 'string' } })).toBe('string[]');
    expect(jsonSchemaToTs({ type: ['string', 'null'] })).toBe('string | null');
  });

  test('objects mark required keys and optional keys', () => {
    const text = jsonSchemaToTs({
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' }, 'due-at': { type: 'number' } },
    });
    expect(text).toBe('{\n  "due-at"?: number;\n  id: string;\n}');
  });

  test('objects without properties are records, and additionalProperties=false is empty', () => {
    expect(jsonSchemaToTs({ type: 'object' })).toBe('Record<string, unknown>');
    expect(jsonSchemaToTs({ type: 'object', properties: {}, additionalProperties: false })).toBe(
      'Record<string, never>',
    );
  });

  test('schemas it cannot express degrade to unknown', () => {
    expect(jsonSchemaToTs({})).toBe('unknown');
    expect(jsonSchemaToTs(undefined)).toBe('unknown');
    expect(jsonSchemaToTs({ type: 'exotic' })).toBe('unknown');
  });

  test('property keys are quoted only when not identifiers', () => {
    expect(propertyKey('abc_1')).toBe('abc_1');
    expect(propertyKey('a-b')).toBe('"a-b"');
  });
});
