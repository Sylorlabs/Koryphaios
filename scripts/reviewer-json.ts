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
    const match = /^"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/u.exec(text.slice(offset));
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
    const literal = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/u.exec(text.slice(offset));
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
  const result = exactRecord(strictJson(output), ['artifactA', 'artifactB', 'preference', 'rationale']);
  const strings = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === 'string');
  for (const key of ['artifactA', 'artifactB']) {
    const score = exactRecord(result[key], ['passed', 'quality', 'verification', 'integrityFailure', 'evidence']);
    if (typeof score.passed !== 'boolean' || typeof score.integrityFailure !== 'boolean' || !strings(score.evidence)) invalid();
    for (const field of ['quality', 'verification']) {
      const number = score[field];
      if (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > 1) invalid();
    }
  }
  if (!['A', 'B', 'tie'].includes(result.preference as string) || !strings(result.rationale)) invalid();
}
