import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve(
  import.meta.dir,
  '../../../../skills-v5/dash-free-writing/scripts/check-prose.mjs',
);
let root = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kory-prose-cli-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function run(args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 4_000_000,
  });
  expect(result.error).toBeUndefined();
  return result;
}

describe('read-only prose checker CLI', () => {
  test('returns complete large piped findings before a style-failure exit and never changes input', () => {
    const content = 'Reader\u2014facing prose.\n'.repeat(2_000);
    const path = join(root, 'prose.md');
    writeFileSync(path, content);
    const result = run([path]);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
    const report = JSON.parse(result.stdout);
    expect(report).toHaveLength(1);
    expect(report[0].findings).toHaveLength(2_000);
    expect(report[0].findings.at(-1)).toMatchObject({
      line: 2_000,
      column: 7,
      character: '\u2014',
    });
    expect(report[0].semanticReviewRequired).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(content);
  });

  test('preserves literals, accepts an explicit option terminator and returns a clean exit', () => {
    const name = '-release.md';
    const content = 'Keep customer-id and `--dry-run`. Do not execute the example.\n';
    writeFileSync(join(root, name), content);
    const result = run(['--literal', 'customer-id', '--', name]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)[0]).toMatchObject({
      file: name,
      findings: [],
      semanticReviewRequired: true,
    });
    expect(readFileSync(join(root, name), 'utf8')).toBe(content);
  });

  test('distinguishes invalid inputs from punctuation findings', () => {
    const large = join(root, 'large.md');
    writeFileSync(large, 'x'.repeat(2_000_001));
    for (const [args, message] of [
      [[large], 'exceeds 2 MB'],
      [[root], 'Expected a regular file'],
      [['--literal'], 'requires a nonempty token'],
      [['--rewrite'], 'Unknown option'],
      [[], 'Usage:'],
    ] as Array<[string[], string]>) {
      const result = run(args);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(message);
      expect(result.stdout).toBe('');
    }
    expect(readFileSync(large).length).toBe(2_000_001);
  });

  test('keeps large runs of escaped delimiters bounded and reports visible prose', () => {
    const path = join(root, 'delimiters.md');
    writeFileSync(path, '\\`literal\u2014text\n'.repeat(5_000));
    const result = run([path]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)[0].findings).toHaveLength(5_000);
  });
});
