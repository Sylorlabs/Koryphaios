import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSkillEvalSuiteV3 } from '../skill-eval-harness';
import { readJsonArtifact, writeFixtureFile } from '../skill-eval-fixture-helpers';
import {
  PERFORMANCE_DEBUGGING_HTTP_FIXED_SOURCE,
  PERFORMANCE_DEBUGGING_HTTP_PLAUSIBLE_FAULTY_SOURCE,
  PERFORMANCE_DEBUGGING_RETENTION_FIXED_SOURCE,
  PERFORMANCE_DEBUGGING_RETENTION_PLAUSIBLE_FAULTY_SOURCE,
  PERFORMANCE_DEBUGGING_SKILL_EVAL_MATERIALIZERS,
  PERFORMANCE_DEBUGGING_SKILL_EVAL_SCORERS,
} from '../skill-eval-performance-debugging-fixtures';
import { loadV5SkillPackages } from '../skill-packages';

const roots: string[] = [];

function scenario(id: string) {
  const skill = loadV5SkillPackages().packages.find(
    (item) => item.sidecar.name === 'performance-debugging',
  )!;
  return buildSkillEvalSuiteV3(skill).scenarios.find((item) => item.id === id)!;
}

async function fixture(id: string) {
  const selectedScenario = scenario(id);
  const materializer = PERFORMANCE_DEBUGGING_SKILL_EVAL_MATERIALIZERS.find((item) =>
    item.matches(selectedScenario),
  )!;
  const scorer = PERFORMANCE_DEBUGGING_SKILL_EVAL_SCORERS.find((item) =>
    item.scenarioIds.includes(id),
  )!;
  const root = mkdtempSync(join(tmpdir(), 'kory-performance-debugging-test-'));
  roots.push(root);
  await materializer.materialize(root, selectedScenario);
  return {
    root,
    score: () =>
      scorer.score({
        scenario: selectedScenario,
        experiment: {} as never,
        workingDirectory: root,
        observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
      }),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('performance-debugging local evaluator fixtures', () => {
  test('HTTP fixture starts red and passes only the real fixed implementation with repeated runtime evidence', async () => {
    const subject = await fixture('performance-debugging-full-task-1');
    const red = await subject.score();
    expect(red.passed).toBe(false);
    expect(red.integrityFailure).toBe(false);

    writeFixtureFile(subject.root, 'src/service.ts', PERFORMANCE_DEBUGGING_HTTP_FIXED_SOURCE);
    const green = await subject.score();
    expect(green.passed).toBe(true);
    expect(green.quality).toBe(1);
    expect(green.verification).toBe(1);
    const report = readJsonArtifact<{
      integrity: { fixedInputsVerified: boolean; receiptsVerified: boolean };
      protocol: {
        localLoopbackHttp: boolean;
        datasetRecords: number;
        offeredRequestsPerSecond: number;
        repetitions: number;
      };
      baseline: { raw: { warmup: { discarded: boolean }; repetitions: unknown[] } };
      before: { summary: { p95Ms: number; throughput: number; handlerCpuMicros: number } };
      after: { summary: { p95Ms: number; throughput: number; handlerCpuMicros: number } };
    }>(subject.root, 'evaluation/performance-debugging-scenario-1-runtime.json')!;
    expect(report.integrity).toEqual(
      expect.objectContaining({ fixedInputsVerified: true, receiptsVerified: true }),
    );
    expect(report.protocol).toEqual(
      expect.objectContaining({
        localLoopbackHttp: true,
        datasetRecords: 20_000,
        offeredRequestsPerSecond: 400,
        repetitions: 5,
      }),
    );
    expect(report.baseline.raw.warmup.discarded).toBe(true);
    expect(report.baseline.raw.repetitions).toHaveLength(5);
    expect(report.after.summary.p95Ms).toBeLessThan(report.before.summary.p95Ms);
    expect(report.after.summary.throughput).toBeGreaterThan(report.before.summary.throughput);
    expect(report.after.summary.handlerCpuMicros).toBeLessThan(
      report.before.summary.handlerCpuMicros,
    );
  }, 120_000);

  test('HTTP evaluator rejects a plausible partial fix and candidate-authored success claims', async () => {
    const subject = await fixture('performance-debugging-full-task-1');
    writeFixtureFile(
      subject.root,
      'src/service.ts',
      PERFORMANCE_DEBUGGING_HTTP_PLAUSIBLE_FAULTY_SOURCE,
    );
    writeFixtureFile(
      subject.root,
      'evaluation/performance-debugging-scenario-1-runtime.json',
      '{"passed":true,"p95Ms":1,"receipt":"candidate-claim"}\n',
    );
    const score = await subject.score();
    expect(score.passed).toBe(false);
    expect(score.integrityFailure).toBe(false);
    expect(score.evidence.join('\n')).toMatch(/profile|post-fix|throughput/i);
  }, 120_000);

  test('retention fixture starts red and passes only when all 20 close checkpoints release ownership', async () => {
    const subject = await fixture('performance-debugging-full-task-2');
    const red = await subject.score();
    expect(red.passed).toBe(false);
    expect(red.integrityFailure).toBe(false);

    writeFixtureFile(
      subject.root,
      'src/lifecycle.ts',
      PERFORMANCE_DEBUGGING_RETENTION_FIXED_SOURCE,
    );
    const green = await subject.score();
    expect(green.passed).toBe(true);
    expect(green.quality).toBe(1);
    expect(green.verification).toBe(1);
    const report = readJsonArtifact<{
      integrity: { fixedInputsVerified: boolean; receiptsVerified: boolean };
      protocol: {
        projectBytes: number;
        retainedBytesPerCycle: number;
        cycles: number;
        checkpoints: number[];
        oneProcessPerRun: boolean;
        evaluatorGcCheckpoints: number;
      };
      before: {
        summary: {
          retainedAtCheckpoints: number[];
          retainedBytesAtCheckpoints: number[];
          finalRetainedTokenBytes: number;
          rssGrowthBytes: number;
        };
      };
      after: {
        summary: {
          retainedAtCheckpoints: number[];
          retainedBytesAtCheckpoints: number[];
          finalRetainedTokenBytes: number;
          rssGrowthBytes: number;
        };
        raw: { correctness: { reopenCorrect: boolean }; cycles: Array<{ pid: number }> };
      };
    }>(subject.root, 'evaluation/performance-debugging-scenario-2-runtime.json')!;
    expect(report.integrity).toEqual(
      expect.objectContaining({ fixedInputsVerified: true, receiptsVerified: true }),
    );
    expect(report.protocol).toEqual(
      expect.objectContaining({
        projectBytes: 50 * 1024 * 1024,
        retainedBytesPerCycle: 18 * 1024 * 1024,
        cycles: 20,
        checkpoints: [1, 10, 20],
        oneProcessPerRun: true,
        evaluatorGcCheckpoints: 20,
      }),
    );
    expect(report.before.summary.retainedAtCheckpoints).toEqual([1, 10, 20]);
    expect(report.before.summary.retainedBytesAtCheckpoints).toEqual([
      18 * 1024 * 1024,
      10 * 18 * 1024 * 1024,
      20 * 18 * 1024 * 1024,
    ]);
    expect(Math.max(...report.after.summary.retainedAtCheckpoints)).toBeLessThanOrEqual(1);
    expect(report.after.summary.finalRetainedTokenBytes).toBeLessThanOrEqual(18 * 1024 * 1024);
    expect(report.after.summary.rssGrowthBytes).toBeLessThan(report.before.summary.rssGrowthBytes);
    expect(report.before.summary.rssGrowthBytes).toBeGreaterThanOrEqual(8 * 18 * 1024 * 1024);
    expect(report.after.raw.correctness.reopenCorrect).toBe(true);
    expect(new Set(report.after.raw.cycles.map((cycle) => cycle.pid)).size).toBe(1);
  }, 120_000);

  test('retention evaluator rejects a slower leak and candidate-authored bounded-memory claims', async () => {
    const subject = await fixture('performance-debugging-full-task-2');
    writeFixtureFile(
      subject.root,
      'src/lifecycle.ts',
      PERFORMANCE_DEBUGGING_RETENTION_PLAUSIBLE_FAULTY_SOURCE,
    );
    writeFixtureFile(
      subject.root,
      'evaluation/performance-debugging-scenario-2-runtime.json',
      '{"passed":true,"retainedTokens":0,"receipt":"candidate-claim"}\n',
    );
    const score = await subject.score();
    expect(score.passed).toBe(false);
    expect(score.integrityFailure).toBe(false);
    expect(score.evidence.join('\n')).toMatch(/ownership|bounded steady state/i);
  }, 120_000);

  test('fails closed when evaluator-owned workload evidence is changed', async () => {
    const http = await fixture('performance-debugging-full-task-1');
    writeFixtureFile(http.root, 'workload/http-workload.json', '{"offeredRequestsPerSecond":1}\n');
    const httpScore = await http.score();
    expect(httpScore.passed).toBe(false);
    expect(httpScore.integrityFailure).toBe(true);

    const retention = await fixture('performance-debugging-full-task-2');
    writeFixtureFile(retention.root, 'workload/project-manifest.json', '{"cycles":1}\n');
    const retentionScore = await retention.score();
    expect(retentionScore.passed).toBe(false);
    expect(retentionScore.integrityFailure).toBe(true);
  });

  test('bounds a nonterminating candidate process and fails closed', async () => {
    const subject = await fixture('performance-debugging-full-task-1');
    writeFixtureFile(subject.root, 'src/service.ts', 'while (true) {}\n');
    const started = Date.now();
    const score = await subject.score();
    expect(score.passed).toBe(false);
    expect(score.evidence.join('\n')).toMatch(/timed out|SIGKILL|bounded local process failed/i);
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);
});
