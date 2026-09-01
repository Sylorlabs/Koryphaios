export const NOTE_PROPERTY_TYPES = [
  'text',
  'number',
  'checkbox',
  'date',
  'datetime',
  'list',
  'tags',
] as const;

export type NotePropertyType = (typeof NOTE_PROPERTY_TYPES)[number];
export type NotePropertyValue = string | number | boolean | string[];

export interface NoteProperty {
  key: string;
  type: NotePropertyType;
  value: NotePropertyValue;
}

export interface NotePropertyWarning {
  key?: string;
  message: string;
}

export interface ParsedNoteProperties {
  properties: NoteProperty[];
  warnings: NotePropertyWarning[];
  hasFrontmatter: boolean;
  body: string;
}

interface FrontmatterBlock {
  prefix: string;
  raw: string;
  body: string;
  newline: '\n' | '\r\n';
}

interface PropertyEntry {
  key: string;
  start: number;
  end: number;
  valueSource: string;
  continuation: string[];
}

const MAX_FRONTMATTER_BYTES = 64 * 1024;
const MAX_PROPERTY_KEY_LENGTH = 80;
const MAX_PROPERTY_TEXT_LENGTH = 2_048;
const MAX_PROPERTY_LIST_ITEMS = 100;

function splitFrontmatter(content: string): FrontmatterBlock | null {
  const opening = /^(\uFEFF?---[ \t]*)(\r?\n)/.exec(content);
  if (!opening) return null;
  const newline = opening[2] as '\n' | '\r\n';
  const start = opening[0].length;
  const closing = new RegExp(`^---[ \\t]*(?:${newline === '\r\n' ? '\\r\\n' : '\\n'}|$)`, 'm');
  const remainder = content.slice(start);
  const match = closing.exec(remainder);
  if (!match) return null;
  const raw = remainder.slice(0, match.index).replace(/\r?\n$/, '');
  return {
    prefix: opening[1],
    raw,
    body: remainder.slice(match.index + match[0].length),
    newline,
  };
}

function startsWithFrontmatterMarker(content: string): boolean {
  return /^\uFEFF?---[ \t]*(?:\r?\n|$)/.test(content);
}

function validPropertyKey(key: string): boolean {
  return (
    key.length > 0 &&
    key.length <= MAX_PROPERTY_KEY_LENGTH &&
    !/\p{Cc}/u.test(key) &&
    !/[\r\n:#\[\]{},&*!|>'"%@`]/.test(key) &&
    key.trim() === key
  );
}

function normalizedPropertyKey(key: string): string {
  return key.normalize('NFKC').toLowerCase();
}

function propertyEntries(raw: string): PropertyEntry[] {
  const lines = raw ? raw.split(/\r?\n/) : [];
  const entries: PropertyEntry[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (/^[ \t]/.test(line) || /^\s*(?:#|$)/.test(line)) continue;
    const match = /^([^:]+):(?:[ \t]*(.*))$/.exec(line);
    if (!match) continue;
    const key = match[1]!.trim();
    let end = index + 1;
    while (end < lines.length && (/^[ \t]/.test(lines[end]!) || /^\s*$/.test(lines[end]!))) {
      end++;
    }
    entries.push({
      key,
      start: index,
      end,
      valueSource: match[2] ?? '',
      continuation: lines.slice(index + 1, end),
    });
    index = end - 1;
  }
  return entries;
}

function unquote(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      return typeof parsed === 'string' ? parsed : null;
    } catch {
      return null;
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

function splitInlineList(source: string): string[] | null {
  const trimmed = source.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
  const body = trimmed.slice(1, -1);
  if (!body.trim()) return [];
  const values: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const char of body) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (quote === '"' && char === '\\') {
      current += char;
      escaped = true;
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ',') {
      const value = unquote(current);
      if (value === null) return null;
      values.push(value);
      current = '';
      continue;
    }
    current += char;
  }
  if (quote || escaped) return null;
  const value = unquote(current);
  if (value === null) return null;
  values.push(value);
  return values;
}

function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function validDateTime(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function parseEntry(entry: PropertyEntry): NoteProperty | null {
  const inline = splitInlineList(entry.valueSource);
  const blockItems = entry.continuation
    .map((line) => /^\s*-\s*(.*?)\s*$/.exec(line)?.[1])
    .filter((value): value is string => value !== undefined);
  if (inline || (!entry.valueSource.trim() && blockItems.length > 0)) {
    const rawItems = inline ?? blockItems;
    const values = rawItems.map(unquote);
    if (values.some((value) => value === null)) return null;
    return {
      key: entry.key,
      type: entry.key.toLowerCase() === 'tags' ? 'tags' : 'list',
      value: values as string[],
    };
  }

  const source = entry.valueSource.trim();
  if (!source && entry.continuation.length === 0) {
    return { key: entry.key, type: 'text', value: '' };
  }
  if (entry.continuation.some((line) => line.trim() && !/^\s*#/.test(line))) return null;
  if (/^(?:true|false)$/i.test(source)) {
    return { key: entry.key, type: 'checkbox', value: source.toLowerCase() === 'true' };
  }
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(source)) {
    const value = Number(source);
    if (Number.isFinite(value)) return { key: entry.key, type: 'number', value };
  }
  if (validDate(source)) return { key: entry.key, type: 'date', value: source };
  if (validDateTime(source)) return { key: entry.key, type: 'datetime', value: source };
  const value = unquote(source);
  return value === null ? null : { key: entry.key, type: 'text', value };
}

export function parseNoteProperties(content: string): ParsedNoteProperties {
  const block = splitFrontmatter(content);
  if (!block) {
    if (startsWithFrontmatterMarker(content)) {
      return {
        properties: [],
        warnings: [{ message: 'Frontmatter is missing a closing --- marker.' }],
        hasFrontmatter: true,
        body: content,
      };
    }
    return { properties: [], warnings: [], hasFrontmatter: false, body: content };
  }
  if (new TextEncoder().encode(block.raw).byteLength > MAX_FRONTMATTER_BYTES) {
    return {
      properties: [],
      warnings: [{ message: 'Frontmatter exceeds the 64 KiB property safety limit.' }],
      hasFrontmatter: true,
      body: block.body,
    };
  }

  const properties: NoteProperty[] = [];
  const warnings: NotePropertyWarning[] = [];
  const seen = new Set<string>();
  for (const entry of propertyEntries(block.raw)) {
    const normalized = normalizedPropertyKey(entry.key);
    if (!validPropertyKey(entry.key)) {
      warnings.push({ key: entry.key, message: 'Property key is not safely editable.' });
      continue;
    }
    if (seen.has(normalized)) {
      warnings.push({ key: entry.key, message: 'Duplicate property key was ignored.' });
      continue;
    }
    seen.add(normalized);
    const property = parseEntry(entry);
    if (!property) {
      warnings.push({
        key: entry.key,
        message: 'Nested or unsupported YAML is preserved in source mode.',
      });
      continue;
    }
    properties.push(property);
  }
  return { properties, warnings, hasFrontmatter: true, body: block.body };
}

function validateProperty(property: NoteProperty): void {
  if (!validPropertyKey(property.key)) throw new Error('Invalid property key');
  if (!NOTE_PROPERTY_TYPES.includes(property.type)) throw new Error('Invalid property type');
  const checkText = (value: string) => {
    if (value.length > MAX_PROPERTY_TEXT_LENGTH || /[\r\n\0]/.test(value)) {
      throw new Error('Property text is too long or contains a line break');
    }
  };
  if (property.type === 'number') {
    if (typeof property.value !== 'number' || !Number.isFinite(property.value)) {
      throw new Error('Number property must be finite');
    }
  } else if (property.type === 'checkbox') {
    if (typeof property.value !== 'boolean') throw new Error('Checkbox property must be boolean');
  } else if (property.type === 'list' || property.type === 'tags') {
    if (!Array.isArray(property.value) || property.value.length > MAX_PROPERTY_LIST_ITEMS) {
      throw new Error('List property has too many values');
    }
    for (const value of property.value) checkText(value);
  } else {
    if (typeof property.value !== 'string') throw new Error('Property value must be text');
    checkText(property.value);
    if (property.type === 'date' && !validDate(property.value)) throw new Error('Invalid date');
    if (property.type === 'datetime' && !validDateTime(property.value)) {
      throw new Error('Invalid date and time');
    }
  }
}

function serializeProperty(property: NoteProperty, newline: string): string[] {
  validateProperty(property);
  if (property.type === 'list' || property.type === 'tags') {
    const values = property.value as string[];
    if (values.length === 0) return [`${property.key}: []`];
    return [`${property.key}:`, ...values.map((value) => `  - ${JSON.stringify(value)}`)];
  }
  if (property.type === 'text') {
    return [`${property.key}: ${JSON.stringify(property.value)}`];
  }
  return [`${property.key}: ${String(property.value)}`];
}

function rebuildFrontmatter(block: FrontmatterBlock, lines: string[]): string {
  const raw = lines.join(block.newline);
  return `${block.prefix}${block.newline}${raw}${raw ? block.newline : ''}---${block.newline}${block.body}`;
}

export function setNoteProperty(content: string, property: NoteProperty): string {
  validateProperty(property);
  const block = splitFrontmatter(content);
  if (!block && startsWithFrontmatterMarker(content)) {
    throw new Error('Frontmatter is malformed; repair it in source mode first');
  }
  if (!block) {
    const lines = serializeProperty(property, '\n');
    return `---\n${lines.join('\n')}\n---\n${content}`;
  }
  const lines = block.raw ? block.raw.split(/\r?\n/) : [];
  const matches = propertyEntries(block.raw).filter(
    (entry) => normalizedPropertyKey(entry.key) === normalizedPropertyKey(property.key),
  );
  if (matches.length > 1) throw new Error(`Property ${property.key} is duplicated`);
  const replacement = serializeProperty(property, block.newline);
  if (matches.length === 1) {
    const match = matches[0]!;
    lines.splice(match.start, match.end - match.start, ...replacement);
  } else {
    if (lines.length > 0 && lines.at(-1)?.trim()) lines.push('');
    lines.push(...replacement);
  }
  return rebuildFrontmatter(block, lines);
}

export function removeNoteProperty(content: string, key: string): string {
  if (!validPropertyKey(key)) throw new Error('Invalid property key');
  const block = splitFrontmatter(content);
  if (!block && startsWithFrontmatterMarker(content)) {
    throw new Error('Frontmatter is malformed; repair it in source mode first');
  }
  if (!block) return content;
  const lines = block.raw ? block.raw.split(/\r?\n/) : [];
  const matches = propertyEntries(block.raw).filter(
    (entry) => normalizedPropertyKey(entry.key) === normalizedPropertyKey(key),
  );
  if (matches.length > 1) throw new Error(`Property ${key} is duplicated`);
  if (matches.length === 0) return content;
  const match = matches[0]!;
  lines.splice(match.start, match.end - match.start);
  while (lines.length > 0 && !lines.at(-1)?.trim()) lines.pop();
  return rebuildFrontmatter(block, lines);
}
