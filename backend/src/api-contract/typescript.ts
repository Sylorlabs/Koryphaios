// JSON Schema (the subset Elysia/TypeBox and zod emit) to TypeScript type text.
//
// Anything outside that subset becomes `unknown`, so a schema we cannot express
// is weaker in the client but never wrong.

type Schema = Record<string, unknown> | boolean | undefined;

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function propertyKey(name: string): string {
  return IDENT.test(name) ? name : JSON.stringify(name);
}

function literal(value: unknown): string {
  return JSON.stringify(value) ?? 'unknown';
}

function union(parts: string[]): string {
  const unique = [...new Set(parts)];
  if (unique.length === 0) return 'never';
  return unique.length === 1
    ? unique[0]!
    : unique.map((p) => (p.includes(' | ') || p.includes(' & ') ? `(${p})` : p)).join(' | ');
}

export function jsonSchemaToTs(schema: Schema, indent = ''): string {
  if (schema === true || schema === undefined || schema === null) return 'unknown';
  if (schema === false) return 'never';
  if (typeof schema !== 'object') return 'unknown';

  if ('const' in schema) return literal(schema['const']);
  if (Array.isArray(schema['enum'])) return union((schema['enum'] as unknown[]).map(literal));

  if (Array.isArray(schema['anyOf']) || Array.isArray(schema['oneOf'])) {
    const members = (schema['anyOf'] ?? schema['oneOf']) as Schema[];
    return union(members.map((m) => jsonSchemaToTs(m, indent)));
  }
  if (Array.isArray(schema['allOf'])) {
    const members = (schema['allOf'] as Schema[]).map((m) => jsonSchemaToTs(m, indent));
    return members.length
      ? members.map((m) => (m.includes(' | ') ? `(${m})` : m)).join(' & ')
      : 'unknown';
  }

  const type = schema['type'];
  if (Array.isArray(type)) {
    return union(type.map((t) => jsonSchemaToTs({ ...schema, type: t }, indent)));
  }

  switch (type) {
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array': {
      const items = schema['items'] as Schema;
      const inner = jsonSchemaToTs(items, indent);
      return inner.includes(' | ') || inner.includes(' & ') ? `(${inner})[]` : `${inner}[]`;
    }
    case 'object':
      return objectType(schema, indent);
    default:
      if (schema['properties']) return objectType(schema, indent);
      return 'unknown';
  }
}

function objectType(schema: Record<string, unknown>, indent: string): string {
  const props = (schema['properties'] ?? {}) as Record<string, Schema>;
  const required = new Set((schema['required'] as string[] | undefined) ?? []);
  const additional = schema['additionalProperties'];
  const valueSchema =
    additional && typeof additional === 'object' ? (additional as Schema) : undefined;
  const inner = `${indent}  `;
  const lines: string[] = [];
  for (const name of Object.keys(props).sort()) {
    const optional = required.has(name) ? '' : '?';
    lines.push(`${inner}${propertyKey(name)}${optional}: ${jsonSchemaToTs(props[name], inner)};`);
  }
  if (lines.length === 0) {
    if (additional === false) return 'Record<string, never>';
    return `Record<string, ${valueSchema ? jsonSchemaToTs(valueSchema, inner) : 'unknown'}>`;
  }
  if (valueSchema) lines.push(`${inner}[key: string]: ${jsonSchemaToTs(valueSchema, inner)};`);
  return `{\n${lines.join('\n')}\n${indent}}`;
}
