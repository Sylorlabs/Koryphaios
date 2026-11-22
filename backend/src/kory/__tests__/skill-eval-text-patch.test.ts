import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  applySkillEvalTextPatch,
  parseSkillEvalTextPatch,
  snapshotSkillEvalWorkspace,
} from '../../eval/skills/skill-eval-text-patch';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('text-only skill evaluation patch adapter', () => {
  test('snapshots bounded text files while excluding generated and repository metadata', () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-text-patch-'));
    roots.push(root);
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, 'node_modules'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, '.git', 'config'), 'private metadata');
    writeFileSync(join(root, 'node_modules', 'ignored.js'), 'ignored dependency');
    writeFileSync(join(root, 'src', 'main.ts'), 'export const value = 1;\n');

    const snapshot = snapshotSkillEvalWorkspace(root);

    expect(snapshot).toContain('FILE src/main.ts');
    expect(snapshot).toContain('export const value = 1;');
    expect(snapshot).not.toContain('private metadata');
    expect(snapshot).not.toContain('ignored dependency');
  });

  test('keeps UTF-8 snapshots within the byte budget at a file boundary', () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-text-patch-'));
    roots.push(root);
    for (const name of ['a.txt', 'b.txt', 'c.txt', 'unicode.txt']) {
      writeFileSync(join(root, name), '🙂'.repeat(30_000));
    }

    const snapshot = snapshotSkillEvalWorkspace(root);

    expect(Buffer.byteLength(snapshot, 'utf8')).toBeLessThan(402_000);
    expect(snapshot).toContain('FILE unicode.txt');
    expect(snapshot).toContain('; truncated');
  });

  test('parses tagged and fenced machine-readable patches and rejects unsafe paths', () => {
    const tagged = parseSkillEvalTextPatch(
      '<kory-eval-patch>\n' +
        '[{"operation":"write","path":"src/out.txt","content":"ok\\n","executable":true}]\n' +
        '</kory-eval-patch>',
    );
    expect(tagged.format).toBe('tagged-json');
    expect(tagged.operations).toEqual([
      { operation: 'write', path: 'src/out.txt', content: 'ok\n', executable: true },
    ]);

    const fenced = parseSkillEvalTextPatch(
      '```json\n[{"operation":"delete","path":"old.txt"}]\n```',
    );
    expect(fenced.format).toBe('fenced-json');
    expect(fenced.operations).toEqual([{ operation: 'delete', path: 'old.txt' }]);

    const escapedDelimiters = parseSkillEvalTextPatch(
      '<kory-eval-patch>\\[{"operation":"delete","path":"old.txt"}\\]</kory-eval-patch>',
    );
    expect(escapedDelimiters.operations).toEqual([{ operation: 'delete', path: 'old.txt' }]);

    const trailingCommas = parseSkillEvalTextPatch(
      '<kory-eval-patch>[{"operation":"write","path":"src/out.ts","content":"const value = { a: 1, };\\n",},]</kory-eval-patch>',
    );
    expect(trailingCommas.operations).toEqual([
      { operation: 'write', path: 'src/out.ts', content: 'const value = { a: 1, };\n' },
    ]);

    expect(() =>
      parseSkillEvalTextPatch(
        '<kory-eval-patch>[{"operation":"write","path":"../escape","content":"x"}]</kory-eval-patch>',
      ),
    ).toThrow('Unsafe text patch path');
    expect(() =>
      parseSkillEvalTextPatch(
        '<kory-eval-patch>[{"operation":"delete","path":"same.txt"},{"operation":"write","path":"same.txt","content":"x"}]</kory-eval-patch>',
      ),
    ).toThrow('repeats the path');
  });

  test('skips an invalid placeholder block when exactly one later strict block is valid', () => {
    const parsed = parseSkillEvalTextPatch(
      '<kory-eval-patch>...</kory-eval-patch>\n' +
        '<kory-eval-patch>[{"operation":"write","path":"result.txt","content":"ok"}]</kory-eval-patch>',
    );
    expect(parsed.operations).toEqual([{ operation: 'write', path: 'result.txt', content: 'ok' }]);
  });

  test('rejects multiple valid patch blocks as ambiguous', () => {
    expect(() =>
      parseSkillEvalTextPatch(
        '<kory-eval-patch>[]</kory-eval-patch>\n' + '<kory-eval-patch>[]</kory-eval-patch>',
      ),
    ).toThrow('multiple valid patch blocks');
  });

  test('allows contained directory names ending in dots without treating them as traversal', () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-text-patch-'));
    roots.push(root);
    const path = 'release../summary.txt';

    expect(applySkillEvalTextPatch(root, [
      { operation: 'write', path, content: 'contained\n' },
    ])).toEqual([path]);
    expect(readFileSync(join(root, path), 'utf8')).toBe('contained\n');
    expect(applySkillEvalTextPatch(root, [{ operation: 'delete', path }])).toEqual([path]);
    expect(existsSync(join(root, path))).toBe(false);
  });

  test('applies writes and deletions inside the fixture root and refuses symlink traversal', () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-text-patch-'));
    const outside = mkdtempSync(join(tmpdir(), 'kory-text-patch-outside-'));
    roots.push(root, outside);
    writeFileSync(join(root, 'old.txt'), 'old');
    mkdirSync(join(root, 'link-parent'));
    symlinkSync(outside, join(root, 'link-parent', 'out'));

    const changed = applySkillEvalTextPatch(root, [
      { operation: 'write', path: 'src/new.txt', content: 'new\n' },
      { operation: 'delete', path: 'old.txt' },
    ]);

    expect(changed).toEqual(['src/new.txt', 'old.txt']);
    expect(readFileSync(join(root, 'src', 'new.txt'), 'utf8')).toBe('new\n');
    expect(existsSync(join(root, 'old.txt'))).toBe(false);
    expect(() =>
      applySkillEvalTextPatch(root, [
        { operation: 'write', path: 'link-parent/out/escaped.txt', content: 'nope' },
      ]),
    ).toThrow('Text patch parent is not a real directory');
    expect(existsSync(join(outside, 'escaped.txt'))).toBe(false);
    expect(lstatSync(join(root, 'link-parent', 'out')).isSymbolicLink()).toBe(true);
  });
});
