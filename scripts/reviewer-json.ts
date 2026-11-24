function invalid(): never {
  throw new Error('Invalid reviewer JSON (details redacted).');
}

// Validate the full grammar before JSON.parse can erase duplicate keys such as
// an error/tool field or a contradictory adjudication score.
export function strictJson(text: string): unknown {
  let offset = 0;
  const whitespace = () => {
    while (/[\x20\t\r\n]/u.test(text[offset] ?? '\0')) offset += 1;
  };
  const string = (): string => {
    const match = /^"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/u.exec(
      text.slice(offset),
    );
    if (!match) invalid();
    offset += match[0].length;
    return JSON.parse(match[0]) as string;
  };
  const value = (depth: number): void => {
    if (depth > 20) invalid();
    whitespace();
    const token = text[offset];
    if (token === '"') {
      string();
      return;
    }
    if (token === '{' || token === '[') {
      offset += 1;
      const end = token === '{' ? '}' : ']';
      const keys = new Set<string>();
      whitespace();
      if (text[offset] === end) {
        offset += 1;
        return;
      }
      while (true) {
        whitespace();
        if (token === '{') {
          const key = string();
          if (keys.has(key)) invalid();
          keys.add(key);
          whitespace();
          if (text[offset++] !== ':') invalid();
        }
        value(depth + 1);
        whitespace();
        const separator = text[offset++];
        if (separator === end) return;
        if (separator !== ',') invalid();
      }
    }
    const literal =
      /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/u.exec(
        text.slice(offset),
      );
    if (!literal) invalid();
    offset += literal[0].length;
  };
  value(0);
  whitespace();
  if (offset !== text.length) invalid();
  return JSON.parse(text);
}

export function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).sort().join(',') !== [...keys].sort().join(',')) invalid();
  return result;
}

export function validateAdjudication(output: string): void {
  const result = exactRecord(strictJson(output), [
    'artifactA',
    'artifactB',
    'preference',
    'rationale',
  ]);
  const strings = (value: unknown) =>
    Array.isArray(value) && value.every((item) => typeof item === 'string');
  for (const key of ['artifactA', 'artifactB']) {
    const score = exactRecord(result[key], [
      'passed',
      'quality',
      'verification',
      'integrityFailure',
      'evidence',
    ]);
    if (
      typeof score.passed !== 'boolean' ||
      typeof score.integrityFailure !== 'boolean' ||
      !strings(score.evidence)
    )
      invalid();
    for (const field of ['quality', 'verification']) {
      const number = score[field];
      if (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > 1)
        invalid();
    }
  }
  if (!['A', 'B', 'tie'].includes(result.preference as string) || !strings(result.rationale))
    invalid();
}

// This route's model emits an adjudication that repeats keys inside an artifact
// object: a second "evidence" array, or a trailing "quality"/"verification" pair
// after the evidence array. Measured on four captured samples, the repeated
// scalar values are identical and the repeated arrays differ only in being a
// shorter restatement, so the first occurrence is the substantive one. Keep the
// first occurrence, reject any duplicate whose scalar value disagrees, and hand
// the rebuilt JSON to the strict grammar so nothing else is relaxed.
export function normalizeDuplicateKeys(text: string): string {
  let index = 0;
  const whitespace = () => {
    while (/[\x20\t\r\n]/u.test(text[index] ?? '\0')) index += 1;
  };
  const readString = (): string => {
    const match = /^"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/u.exec(
      text.slice(index),
    );
    if (!match) throw new Error('Invalid reviewer JSON (details redacted).');
    index += match[0].length;
    return JSON.parse(match[0]) as string;
  };
  const readValue = (depth: number): string => {
    if (depth > 20) throw new Error('Invalid reviewer JSON (details redacted).');
    whitespace();
    const token = text[index];
    const start = index;
    if (token === '"') {
      readString();
      return text.slice(start, index);
    }
    if (token === '{') {
      index += 1;
      const seen = new Map<string, string>();
      const fields: string[] = [];
      whitespace();
      if (text[index] === '}') {
        index += 1;
        return '{}';
      }
      while (true) {
        whitespace();
        const key = readString();
        whitespace();
        if (text[index++] !== ':') throw new Error('Invalid reviewer JSON (details redacted).');
        const value = readValue(depth + 1);
        const previous = seen.get(key);
        if (previous === undefined) {
          seen.set(key, value);
          fields.push(`${JSON.stringify(key)}:${value}`);
        } else if (previous !== value && !(previous.startsWith('[') && value.startsWith('['))) {
          throw new Error('Invalid reviewer JSON (details redacted).');
        }
        whitespace();
        const separator = text[index++];
        if (separator === '}') return `{${fields.join(',')}}`;
        if (separator !== ',') throw new Error('Invalid reviewer JSON (details redacted).');
      }
    }
    if (token === '[') {
      index += 1;
      const items: string[] = [];
      whitespace();
      if (text[index] === ']') {
        index += 1;
        return '[]';
      }
      while (true) {
        items.push(readValue(depth + 1));
        whitespace();
        const separator = text[index++];
        if (separator === ']') return `[${items.join(',')}]`;
        if (separator !== ',') throw new Error('Invalid reviewer JSON (details redacted).');
      }
    }
    const literal =
      /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/u.exec(
        text.slice(index),
      );
    if (!literal) throw new Error('Invalid reviewer JSON (details redacted).');
    index += literal[0].length;
    return literal[0];
  };
  const candidateStart = text.indexOf('{');
  const candidateEnd = text.lastIndexOf('}');
  if (candidateStart < 0 || candidateEnd <= candidateStart) {
    throw new Error('Invalid reviewer JSON (details redacted).');
  }
  index = candidateStart;
  const normalized = readValue(0);
  whitespace();
  if (index !== candidateEnd + 1) throw new Error('Invalid reviewer JSON (details redacted).');
  return normalized;
}
