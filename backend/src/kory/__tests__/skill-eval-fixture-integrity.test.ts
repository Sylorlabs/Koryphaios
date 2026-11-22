import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hasRegressionText,
  readJsonArtifact,
  runCandidateBunTests,
  runHiddenBunTest,
  writeFixtureFile,
} from '../../eval/skills/skill-eval-fixture-helpers';

const roots: string[] = [];
function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'kory-fixture-integrity-'));
  roots.push(root);
  mkdirSync(join(root, 'tests'));
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('shared evaluation fixture integrity', () => {
  test('accepts completed hidden assertions and rejects real failing assertions', () => {
    const root = workspace();
    expect(
      runHiddenBunTest(
        root,
        "import{test,expect}from'bun:test';test('valid',()=>expect(2+2).toBe(4));",
      ).passed,
    ).toBe(true);
    expect(
      runHiddenBunTest(
        root,
        "import{test,expect}from'bun:test';test('invalid',()=>expect(2+2).toBe(5));",
      ).passed,
    ).toBe(false);
  });

  test('does not treat process exit zero as executed tests', () => {
    const root = workspace();
    const result = runHiddenBunTest(
      root,
      "process.exit(0); import{test,expect}from'bun:test';test('never reached',()=>expect(false).toBe(true));",
    );
    expect(result.passed).toBe(false);
  });

  test('does not let candidate Bun configuration replace the evaluator with a preload', () => {
    const root = workspace();
    writeFixtureFile(root, 'bunfig.toml', '[test]\npreload = ["./attack.ts"]\n');
    writeFixtureFile(root, 'attack.ts', 'process.exit(0);');
    expect(
      runHiddenBunTest(
        root,
        "import{test,expect}from'bun:test';test('valid',()=>expect(2+2).toBe(4));",
      ).passed,
    ).toBe(true);
    expect(
      runHiddenBunTest(
        root,
        "import{test,expect}from'bun:test';test('invalid',()=>expect(2+2).toBe(5));",
      ).passed,
    ).toBe(false);
  });

  test('runs public tests separately and keeps failures from either suite', () => {
    const root = workspace();
    writeFixtureFile(
      root,
      'tests/public.test.ts',
      "import{test,expect}from'bun:test';test('public',()=>expect(true).toBe(true));",
    );
    expect(
      runHiddenBunTest(
        root,
        "import{test,expect}from'bun:test';test('hidden',()=>expect(true).toBe(true));",
      ).passed,
    ).toBe(true);
    writeFixtureFile(root, 'tests/public.test.ts', 'process.exit(0);');
    expect(
      runHiddenBunTest(
        root,
        "import{test,expect}from'bun:test';test('hidden',()=>expect(true).toBe(true));",
      ).passed,
    ).toBe(false);
  });

  test('reports whether candidate tests actually execute and detect behavioral failure', () => {
    const root = workspace();
    writeFixtureFile(root, 'src.ts', 'export const value = 2;\n');
    writeFixtureFile(
      root,
      'tests/public.test.ts',
      "import{test,expect}from'bun:test';import{value}from'../src';test('value',()=>expect(value).toBe(2));",
    );
    expect(runCandidateBunTests(root)).toMatchObject({ completed: true, passed: true });
    writeFixtureFile(root, 'src.ts', 'export const value = 3;\n');
    expect(runCandidateBunTests(root)).toMatchObject({ completed: true, passed: false });
    rmSync(join(root, 'tests/public.test.ts'));
    expect(runCandidateBunTests(root)).toMatchObject({ completed: false, passed: false });
  });

  test('discovers colocated regression tests outside the tests directory', () => {
    const root = workspace();
    mkdirSync(join(root, 'src'));
    writeFixtureFile(
      root,
      'src/parser.test.ts',
      "import{test,expect}from'bun:test';test('regression',()=>expect(true).toBe(true));",
    );
    expect(hasRegressionText(root, [/regression/u])).toBe(true);
    expect(
      runHiddenBunTest(
        root,
        "import{test,expect}from'bun:test';test('hidden',()=>expect(true).toBe(true));",
      ).passed,
    ).toBe(true);
    writeFixtureFile(
      root,
      'src/parser.test.ts',
      "import{test,expect}from'bun:test';test('regression',()=>expect(true).toBe(false));",
    );
    expect(
      runHiddenBunTest(
        root,
        "import{test,expect}from'bun:test';test('hidden',()=>expect(true).toBe(true));",
      ).passed,
    ).toBe(false);
  });

  test('discovers shell regression tests without treating them as Bun tests', () => {
    const root = workspace();
    writeFixtureFile(
      root,
      'tests/rename.test.sh',
      '#!/bin/bash\n# collision cycle rollback dry-run path with spaces\n',
    );
    expect(hasRegressionText(root, [/collision|cycle|rollback/iu, /space|path/iu])).toBe(true);
    expect(runCandidateBunTests(root)).toMatchObject({ completed: false, passed: false });
  });

  test('rejects an edited evaluator test and reports the evidence boundary', () => {
    const root = workspace();
    const result = runHiddenBunTest(
      root,
      "import{test,expect}from'bun:test';import{writeFileSync}from'node:fs';writeFileSync(import.meta.path,'// changed');test('mutation',()=>expect(true).toBe(true));",
    );
    expect(result.passed).toBe(false);
    expect(result.evidence).toMatch(/integrity|modified/i);
  });

  test('does not inherit unrelated credentials into candidate test execution', () => {
    const root = workspace();
    const previous = process.env.KORY_EVAL_TEST_SECRET;
    process.env.KORY_EVAL_TEST_SECRET = 'synthetic-canary-not-a-real-credential';
    try {
      expect(
        runHiddenBunTest(
          root,
          "import{test,expect}from'bun:test';test('environment',()=>expect(process.env.KORY_EVAL_TEST_SECRET).toBeUndefined());",
        ).passed,
      ).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.KORY_EVAL_TEST_SECRET;
      else process.env.KORY_EVAL_TEST_SECRET = previous;
    }
  });

  test('refuses symlinked tests and artifacts without writing through them', () => {
    const root = workspace();
    const outside = workspace();
    rmSync(join(root, 'tests'), { recursive: true });
    symlinkSync(join(outside, 'tests'), join(root, 'tests'));
    const result = runHiddenBunTest(
      root,
      "import{test,expect}from'bun:test';test('valid',()=>expect(true).toBe(true));",
    );
    expect(result.passed).toBe(false);
    writeFileSync(join(outside, 'result.json'), '{"ok":true}');
    symlinkSync(join(outside, 'result.json'), join(root, 'result.json'));
    expect(readJsonArtifact(root, 'result.json')).toBeNull();
    expect(hasRegressionText(root, [/regression/u])).toBe(false);
    expect(() => writeFixtureFile(root, 'tests/escape.txt', 'no')).toThrow();
  });

  test('bounds artifact reads and rejects path traversal while preserving an outside file', () => {
    const root = workspace();
    writeFileSync(join(root, 'large.json'), JSON.stringify({ text: 'x'.repeat(2_000_001) }));
    expect(readJsonArtifact(root, 'large.json')).toBeNull();
    expect(readJsonArtifact(root, '../not-a-fixture.json')).toBeNull();
    const target = join(root, 'safe.json');
    writeFileSync(target, '{"ok":true}');
    expect(readJsonArtifact(root, 'safe.json')).toEqual({ ok: true });
    const nested = join(root, 'nested');
    mkdirSync(nested);
    expect(() => writeFixtureFile(nested, '../safe.json', 'no')).toThrow();
    expect(readFileSync(target, 'utf8')).toBe('{"ok":true}');
  });
});
