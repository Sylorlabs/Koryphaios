import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { SkillEvalScenarioV3 } from '../skill-eval-harness';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSkillEvalSuiteV3 } from '../skill-eval-harness';
import { loadV5SkillPackages } from '../skill-packages';
import {
  TESTING_ENGINEERING_SKILL_EVAL_MATERIALIZERS,
  TESTING_ENGINEERING_SKILL_EVAL_SCORERS,
} from '../skill-eval-testing-engineering-fixtures';

const roots: string[] = [];
afterEach(() => {
  mock.restore();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const RETRY_TESTS = `import { expect, test } from 'bun:test';
import { FakeClock } from '../src/fake-clock';
import { requestWithRetry } from '../src/client';

test('abort during backoff rejects without another request', async () => {
  const clock = new FakeClock(), caller = new AbortController(), reason = new Error('cancelled');
  let requests = 0;
  const result = requestWithRetry(async () => ({status: ++requests === 1 ? 429 : 200}), caller.signal, clock)
    .then(value => ({kind: 'resolved', value}), error => ({kind: 'rejected', error}));
  await Promise.resolve(); await Promise.resolve();
  caller.abort(reason);
  await clock.advance(100);
  expect(await result).toEqual({kind: 'rejected', error: reason});
  expect(requests).toBe(1);
});

test('ordinary non-aborted 429 still retries', async () => {
  const clock = new FakeClock(); let requests = 0;
  const result = requestWithRetry(async () => ({status: ++requests === 1 ? 429 : 200}), new AbortController().signal, clock);
  await Promise.resolve(); await Promise.resolve();
  await clock.advance(100);
  expect((await result).status).toBe(200);
  expect(requests).toBe(2);
});
`;

const CLI_TESTS = `import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { normalizeArgs } from '../src/args';
import { serialize } from '../src/serialize';

test('public argument normalization accepts JSON and rejects invalid formats', () => {
  expect(() => normalizeArgs(['--format', 'json', 'value'])).not.toThrow();
  expect(normalizeArgs(['--format', 'json', 'value'])).toEqual({format: 'json', values: ['value']});
  expect(() => normalizeArgs(['--format', 'yaml'])).toThrow('INVALID_FORMAT');
});
test('JSON serialization preserves empty and Unicode fields', () => {
  expect(JSON.parse(serialize(['', 'café'], 'json'))).toEqual({values: ['', 'café']});
});
test('assembled CLI keeps errors off stdout', () => {
  const result = spawnSync(process.execPath, ['src/cli.ts', '--format', 'yaml'], {encoding: 'utf8', timeout: 3000});
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(2);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('INVALID_FORMAT\\n');
});
`;

async function fixture(id: string, tests: string) {
  const scenario = { id } as SkillEvalScenarioV3;
  const root = mkdtempSync(join(tmpdir(), 'kory-testing-engineering-control-'));
  roots.push(root);
  const materializer = TESTING_ENGINEERING_SKILL_EVAL_MATERIALIZERS.find(item => item.matches(scenario))!;
  const scorer = TESTING_ENGINEERING_SKILL_EVAL_SCORERS.find(item => item.scenarioIds.includes(id))!;
  await materializer.materialize(root, scenario);
  writeFileSync(join(root, 'tests/regression.test.ts'), tests);
  return {
    root,
    score: () => scorer.score({
      scenario, experiment: {} as never, workingDirectory: root,
      observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
    }),
  };
}

describe('testing-engineering mutation fixtures', () => {
  for (const [id, tests] of [
    ['testing-engineering-full-task-1', RETRY_TESTS],
    ['testing-engineering-full-task-2', CLI_TESTS],
  ]) {
    test(`${id}: real fixed-green and assertion-red mutations`, async () => {
      const control = await fixture(id!, tests!);
      const score = await control.score();
      expect(score.evidence.join('\n')).toContain('fixed suite: pass');
      expect(score.passed, score.evidence.join('\n')).toBe(true);
      expect(score.verification).toBe(1);
    }, 30_000);

    test(`${id}: mutation subprocess timeout is not a kill`, async () => {
      const control = await fixture(id!, tests!);
      const actualSpawn = childProcess.spawnSync;
      spyOn(childProcess, 'spawnSync').mockImplementation((...args: Parameters<typeof childProcess.spawnSync>) => {
        const options = args[2] as { cwd?: string };
        if (options?.cwd === control.root) return actualSpawn(...args);
        return { pid: 0, output: [], stdout: '', stderr: '', status: null, signal: 'SIGTERM', error: Object.assign(new Error('timed out'), {code: 'ETIMEDOUT'}) };
      });
      const score = await control.score();
      expect(score.evidence.join('\n')).toContain('fixed suite: pass');
      expect(score.passed, score.evidence.join('\n')).toBe(false);
      expect(score.verification).toBe(0);
      expect(score.evidence.join('\n')).toContain('infrastructure');
      expect(score.evidence.join('\n')).not.toContain('mutation killed: yes');
    }, 30_000);
  }
  test('both suites start red before regressions are authored', async () => {
    const skillPackage = loadV5SkillPackages().packages.find(
      (item) => item.sidecar.name === 'testing-engineering',
    )!;
    for (const scenario of buildSkillEvalSuiteV3(skillPackage).scenarios.filter(
      (item) => item.category === 'full-task',
    )) {
      const root = mkdtempSync(join(tmpdir(), 'kory-testing-engineering-test-'));
      roots.push(root);
      const materializer = TESTING_ENGINEERING_SKILL_EVAL_MATERIALIZERS.find((item) =>
        item.matches(scenario),
      )!;
      const scorer = TESTING_ENGINEERING_SKILL_EVAL_SCORERS.find((item) =>
        item.scenarioIds.includes(scenario.id),
      )!;
      await materializer.materialize(root, scenario);
      const score = await scorer.score({
        scenario,
        experiment: {} as never,
        workingDirectory: root,
        observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
      });
      expect(score.passed, scenario.id).toBe(false);
      expect(score.integrityFailure, scenario.id).toBe(false);
    }
  }, 30_000);
});
