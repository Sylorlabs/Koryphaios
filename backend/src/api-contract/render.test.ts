import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  findStaleFiles,
  PRETTIER_OPTIONS,
  stableStringify,
  renderApiContract,
  CLIENT_PATH,
  OPENAPI_PATH,
} from './render';

const ROOT = join(import.meta.dir, '..', '..', '..');

describe('stableStringify', () => {
  test('output does not depend on key declaration order', () => {
    const a = stableStringify({ b: 1, a: { d: [2, 1], c: 'x' } });
    const b = stableStringify({ a: { c: 'x', d: [2, 1] }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe(
      '{\n  "a": {\n    "c": "x",\n    "d": [\n      2,\n      1\n    ]\n  },\n  "b": 1\n}\n',
    );
  });

  test('array order is preserved', () => {
    expect(stableStringify([3, 1, 2])).toBe('[\n  3,\n  1,\n  2\n]\n');
  });
});

describe('findStaleFiles (drift detection)', () => {
  const expected = { 'b.json': '{}\n', 'a.ts': 'export {};\n' };

  test('reports nothing when committed content matches', () => {
    const actual = (p: string) => expected[p as keyof typeof expected];
    expect(findStaleFiles(expected, actual)).toEqual([]);
  });

  test('reports a changed file, sorted by path', () => {
    const actual = (p: string) =>
      p === 'b.json' ? '{"x":1}\n' : expected[p as keyof typeof expected];
    expect(findStaleFiles(expected, actual)).toEqual(['b.json']);
  });

  test('reports a missing file as stale', () => {
    expect(findStaleFiles(expected, () => undefined)).toEqual(['a.ts', 'b.json']);
  });
});

describe('formatting parity', () => {
  test('PRETTIER_OPTIONS mirrors the repository .prettierrc', () => {
    const rc = JSON.parse(readFileSync(join(ROOT, '.prettierrc'), 'utf8')) as Record<
      string,
      unknown
    >;
    for (const [key, value] of Object.entries(PRETTIER_OPTIONS)) expect(rc[key]).toBe(value);
  });
});

describe('committed contract is current', () => {
  test('openapi.json and the generated client match a fresh render', async () => {
    const files = await renderApiContract();
    expect(
      findStaleFiles(files, (p) => {
        try {
          return readFileSync(join(ROOT, p), 'utf8');
        } catch {
          return undefined;
        }
      }),
    ).toEqual([]);
    expect(Object.keys(files).sort()).toEqual([CLIENT_PATH, OPENAPI_PATH].sort());
  }, 60_000);
});
