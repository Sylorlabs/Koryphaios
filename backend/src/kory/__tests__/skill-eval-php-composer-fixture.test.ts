import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSkillEvalSuiteV3 } from '../skill-eval-harness';
import { writeFixtureFile } from '../skill-eval-fixture-helpers';
import {
  PHP_JSON_CONTROL,
  PHP_JSON_SCENARIO,
  PHP_WORKER_CONTROL,
  PHP_WORKER_SCENARIO,
  V5_LANGUAGE_HOST_SKILL_EVAL_MATERIALIZERS,
  V5_LANGUAGE_HOST_SKILL_EVAL_SCORERS,
  phpHostReadiness,
} from '../skill-eval-v5-language-host-fixtures';
import { loadV5SkillPackages } from '../skill-packages';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const phpPackage = loadV5SkillPackages().packages.find(
  (item) => item.sidecar.name === 'php-engineering',
)!;
const phpRuntimeTest = test.skipIf(phpHostReadiness().length > 0);

test('PHP scorer versions change when their defect-detection contract changes', () => {
  expect(
    V5_LANGUAGE_HOST_SKILL_EVAL_SCORERS.filter((item) =>
      item.scenarioIds.some((id) => id === PHP_WORKER_SCENARIO || id === PHP_JSON_SCENARIO),
    ).map((item) => item.id),
  ).toEqual([
    'php-engineering/actual-php-worker-lifecycle-scorer@5',
    'php-engineering/actual-php-strict-json-scorer@6',
  ]);
});

phpRuntimeTest(
  'both immutable PHP starter projects pass the strict Composer gate before any candidate edits',
  async () => {
    for (const id of [PHP_WORKER_SCENARIO, PHP_JSON_SCENARIO]) {
      const scenario = buildSkillEvalSuiteV3(phpPackage).scenarios.find((item) => item.id === id)!;
      const root = mkdtempSync(join(tmpdir(), 'kory-php-baseline-composer-'));
      roots.push(root);
      const materializer = V5_LANGUAGE_HOST_SKILL_EVAL_MATERIALIZERS.find((item) =>
        item.matches(scenario),
      )!;
      expect(materializer.id).toEndWith('@4');
      await materializer.materialize(root, scenario);

      const result = spawnSync(
        join(root, '.kory-runtime/composer'),
        ['validate', '--strict', '--no-check-publish', '--no-ansi'],
        { cwd: root, encoding: 'utf8', timeout: 8_000 },
      );
      expect({
        scenario: id,
        exit: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      }).toMatchObject({
        scenario: id,
        exit: 0,
      });
      expect(readFileSync(join(root, 'README.md'), 'utf8')).toContain(
        'fail against the original defective',
      );
    }
  },
  30_000,
);

phpRuntimeTest(
  'both PHP scorers can promote valid runtime implementations with executable candidate regressions',
  async () => {
    const candidates = [
      {
        id: PHP_WORKER_SCENARIO,
        source: 'src/Worker.php',
        code: PHP_WORKER_CONTROL,
        tests: `<?php
require __DIR__ . '/../src/Worker.php';
$worker = new Worker();
if ($worker->handle('tenant-alpha') !== 'tenant-alpha:cfg:version') throw new RuntimeException('tenant alpha');
if ($worker->handle('tenant-beta') !== 'tenant-beta:cfg:version') throw new RuntimeException('alternating request');
try { $worker->handle('exception-tenant', true); } catch (RuntimeException $e) {}
if ($worker->handle('tenant-after-exception') !== 'tenant-after-exception:cfg:version') throw new RuntimeException('exception cleanup');
$fiberA = new Fiber(fn() => $worker->handle('fiber-a'));
$fiberB = new Fiber(fn() => $worker->handle('fiber-b'));
$fiberA->start(); $fiberB->start();
if ($fiberA->getReturn() !== 'fiber-a:cfg:version' || $fiberB->getReturn() !== 'fiber-b:cfg:version') throw new RuntimeException('fiber isolation');
$worker->recycle();
if ($worker->handle('after-recycle') !== 'after-recycle:cfg:version') throw new RuntimeException('recycle reuse');
if (ServiceCache::immutableEntries() !== 1) throw new RuntimeException('immutable cache lost');
`,
        shallowTests: `<?php
require __DIR__ . '/../src/Worker.php';
$worker = new Worker();
if ($worker->handle('tenant-only') !== 'tenant-only:cfg:version') throw new RuntimeException('tenant request');
if (ServiceCache::config('version') !== 'cfg:version') throw new RuntimeException('recycle cache');
`,
      },
      {
        id: PHP_JSON_SCENARIO,
        source: 'src/RequestDecoder.php',
        code: PHP_JSON_CONTROL,
        tests: `<?php
require __DIR__ . '/../src/RequestDecoder.php';
$invalid = [
    ['{}', 422, 'MISSING_QUANTITY'],
    ['[]', 422, 'INVALID_TYPE'],
    ['{"quantity":null}', 422, 'NULL_QUANTITY'],
    ['{"quantity":false}', 422, 'INVALID_TYPE'],
    ['{"quantity":1.5}', 422, 'INVALID_TYPE'],
    ['{"quantity":"0"}', 422, 'INVALID_TYPE'],
    ['{"quantity":"7"}', 422, 'INVALID_TYPE'],
    ['{"quantity":"100000000000000000000"}', 422, 'INVALID_TYPE'],
    ['{"quantity":-1}', 422, 'OUT_OF_RANGE'],
    ['{"quantity":100000000000000000000}', 422, 'OUT_OF_RANGE'],
    ['{invalid', 400, 'INVALID_JSON'],
    ['{"quantity":"' . chr(0xC3) . chr(0x28) . '"}', 400, 'INVALID_JSON'],
];
foreach ($invalid as [$raw, $status, $reason]) {
    $result = RequestDecoder::decode($raw);
    if ($result['ok'] !== false || $result['status'] !== $status || $result['error'] !== $reason) throw new RuntimeException('invalid compatibility: ' . $raw);
}
$valid = RequestDecoder::decode('{"quantity":0}');
if ($valid['ok'] !== true || $valid['status'] !== 200 || !($valid['value'] instanceof Quantity) || $valid['value']->value !== 0) throw new RuntimeException('valid integer zero');
$compatible = RequestDecoder::decode('{"quantity":42,"legacy":"kept"}');
if ($compatible['ok'] !== true || $compatible['status'] !== 200 || !($compatible['value'] instanceof Quantity) || $compatible['value']->value !== 42) throw new RuntimeException('valid compatibility payload');
`,
        shallowTests: `<?php
require __DIR__ . '/../src/RequestDecoder.php';
$result = RequestDecoder::decode('{"quantity":7}');
if ($result['ok'] !== true || !($result['value'] instanceof Quantity) || $result['value']->value !== 7) throw new RuntimeException('missing numeric string invalid compatibility');
`,
      },
    ] as const;

    for (const candidate of candidates) {
      const scenario = buildSkillEvalSuiteV3(phpPackage).scenarios.find(
        (item) => item.id === candidate.id,
      )!;
      const root = mkdtempSync(join(tmpdir(), 'kory-php-positive-scorer-'));
      roots.push(root);
      const materializer = V5_LANGUAGE_HOST_SKILL_EVAL_MATERIALIZERS.find((item) =>
        item.matches(scenario),
      )!;
      const scorer = V5_LANGUAGE_HOST_SKILL_EVAL_SCORERS.find((item) =>
        item.scenarioIds.includes(candidate.id),
      )!;
      await materializer.materialize(root, scenario);

      // The broken starter has no candidate coverage and must fail the full gate.
      const baseline = await scorer.score({
        scenario,
        experiment: {} as never,
        workingDirectory: root,
        observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
      });
      expect(baseline.passed).toBe(false);
      expect(baseline.integrityFailure).toBe(false);

      writeFixtureFile(root, candidate.source, candidate.code);
      const untestedImplementation = await scorer.score({
        scenario,
        experiment: {} as never,
        workingDirectory: root,
        observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
      });
      expect({ candidate: candidate.id, ...untestedImplementation }).toMatchObject({
        candidate: candidate.id,
        passed: false,
        verification: 1,
        integrityFailure: false,
      });

      writeFixtureFile(root, 'tests/regression.php', candidate.tests);
      const publicRun = spawnSync(join(root, '.kory-runtime/php'), ['tests/regression.php'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 8_000,
      });
      expect({
        candidate: candidate.id,
        exit: publicRun.status,
        stderr: publicRun.stderr,
      }).toMatchObject({
        candidate: candidate.id,
        exit: 0,
      });
      const score = await scorer.score({
        scenario,
        experiment: {} as never,
        workingDirectory: root,
        observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
      });
      expect({ candidate: candidate.id, ...score }).toMatchObject({
        candidate: candidate.id,
        passed: true,
        quality: 1,
        verification: 1,
        integrityFailure: false,
      });
      expect(score.evidence).toContain('candidate regressions reject original defective starter: yes');
      expect(readFileSync(join(root, candidate.source), 'utf8')).toBe(candidate.code);

      // These tests have the old keyword coverage and pass under the repaired
      // code, but they also pass under the original defective implementation.
      // A pass must require tests that actually discriminate the regression.
      writeFixtureFile(root, 'tests/regression.php', candidate.shallowTests);
      const shallowCandidate = await scorer.score({
        scenario,
        experiment: {} as never,
        workingDirectory: root,
        observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
      });
      expect(shallowCandidate).toMatchObject({
        passed: false,
        verification: 1,
        integrityFailure: false,
      });
      expect(shallowCandidate.evidence).toContain(
        'candidate regression coverage: present; execution: pass',
      );
      expect(shallowCandidate.evidence).toContain(
        'candidate regressions reject original defective starter: no',
      );
      expect(readFileSync(join(root, candidate.source), 'utf8')).toBe(candidate.code);

      // An authored test with adequate coverage text must actually execute successfully.
      writeFixtureFile(
        root,
        'tests/regression.php',
        `${candidate.tests}\nthrow new RuntimeException('deliberately failing candidate regression');\n`,
      );
      const failingCandidateRegression = await scorer.score({
        scenario,
        experiment: {} as never,
        workingDirectory: root,
        observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
      });
      expect(failingCandidateRegression).toMatchObject({
        passed: false,
        integrityFailure: false,
      });
      expect(failingCandidateRegression.evidence.join('\n')).toContain(
        'candidate regression coverage: present; execution: fail',
      );
    }
  },
  45_000,
);
