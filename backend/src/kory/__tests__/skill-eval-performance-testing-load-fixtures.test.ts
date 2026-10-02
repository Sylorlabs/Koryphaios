import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSkillEvalSuiteV3 } from '../skill-eval-harness';
import { readJsonArtifact, writeFixtureFile } from '../skill-eval-fixture-helpers';
import {
  PERFORMANCE_TESTING_LOAD_FAULTY_PLAN,
  PERFORMANCE_TESTING_LOAD_SKILL_EVAL_MATERIALIZERS,
  PERFORMANCE_TESTING_LOAD_SKILL_EVAL_SCORERS,
  PERFORMANCE_TESTING_LOAD_VALID_PLAN,
} from '../skill-eval-performance-testing-load-fixtures';
import { loadV5SkillPackages } from '../skill-packages';

const SCENARIO = 'performance-testing-full-task-1';
const RESULT_ARTIFACT = 'evaluation/performance-testing-scenario-1-result.json';
const VERIFICATION_ARTIFACT = 'evaluation/performance-testing-scenario-1-verification.json';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface RepetitionRecord {
  index: number;
  arrivalModel: string;
  arrivalRatePerSecond: number;
  offered: number;
  started: number;
  completed: number;
  dropped: number;
  errors: number;
  errorRate: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  minMs: number;
  throughputRequestsPerSecond: number;
  latencySamplesMs: number[];
  saturation: { maxInFlight: number; maxConcurrentServiceRequests: number };
  correctness: {
    validated: number;
    mismatches: number;
    failedResponses: number;
    oracleMatched: boolean;
  };
  resources: {
    service: { pid: number; cpuUserMicros: number; cpuSystemMicros: number; rssBytes: number };
    generator: { pid: number; droppedFraction: number; generatorLimited: boolean };
  };
  identityFingerprint: string;
}

interface LoadResultArtifact {
  schemaVersion: number;
  scenarioId: string;
  receipt: string;
  identityFingerprint: string;
  service: { pid: number; port: number; datasetRecords: number; datasetFingerprint: string };
  generator: { pid: number };
  warmup: { discarded: boolean; offered: number; started: number; dropped: number };
  repetitions: RepetitionRecord[];
  rawArtifacts: string[];
  generatorHeadroom: { generatorLimited: boolean; note: string };
}

async function fixture() {
  const skill = loadV5SkillPackages().packages.find(
    (item) => item.sidecar.name === 'performance-testing',
  )!;
  const scenario = buildSkillEvalSuiteV3(skill).scenarios.find((item) => item.id === SCENARIO)!;
  const materializer = PERFORMANCE_TESTING_LOAD_SKILL_EVAL_MATERIALIZERS.find((item) =>
    item.matches(scenario),
  )!;
  const scorer = PERFORMANCE_TESTING_LOAD_SKILL_EVAL_SCORERS.find((item) =>
    item.scenarioIds.includes(scenario.id),
  )!;
  const root = mkdtempSync(join(tmpdir(), 'kory-performance-testing-load-'));
  roots.push(root);
  await materializer.materialize(root, scenario);
  return {
    root,
    scenario,
    score: () =>
      scorer.score({
        scenario,
        experiment: {} as never,
        workingDirectory: root,
        observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
      }),
  };
}

function writePlan(root: string, plan: unknown): void {
  writeFixtureFile(root, 'load-plan.json', `${JSON.stringify(plan, null, 2)}\n`);
}

describe('performance-testing open-model load fixture', () => {
  test('starts red, then passes only with a real open-model load run', async () => {
    const subject = await fixture();
    const red = await subject.score();
    expect(red.passed).toBe(false);
    expect(red.integrityFailure).toBe(false);
    expect(red.evidence.join('\n')).toMatch(/must model arrivals independently of response time/i);

    writePlan(subject.root, PERFORMANCE_TESTING_LOAD_VALID_PLAN);
    const green = await subject.score();
    expect(green.passed).toBe(true);
    expect(green.integrityFailure).toBe(false);
    expect(green.quality).toBe(1);
    expect(green.verification).toBe(1);

    const result = readJsonArtifact<LoadResultArtifact>(subject.root, RESULT_ARTIFACT)!;
    expect(result.schemaVersion).toBe(1);
    expect(result.scenarioId).toBe(SCENARIO);
    expect(result.receipt.startsWith('KORY_PERF_LOAD_')).toBe(true);
    expect(result.warmup.discarded).toBe(true);
    expect(result.warmup.offered).toBe(180);
    expect(result.warmup.started + result.warmup.dropped).toBe(result.warmup.offered);
    expect(result.service.datasetRecords).toBe(1_000_000);
    expect(result.service.datasetFingerprint).toBe(
      result.identityFingerprint.length > 0 ? result.service.datasetFingerprint : '',
    );
    expect(result.service.pid).not.toBe(result.generator.pid);
    expect(result.repetitions).toHaveLength(3);
    expect(result.rawArtifacts).toHaveLength(3);
    expect(result.generatorHeadroom.generatorLimited).toBe(false);

    for (const [index, repetition] of result.repetitions.entries()) {
      expect(repetition.index).toBe(index + 1);
      expect(repetition.arrivalModel).toBe('open');
      expect(repetition.arrivalRatePerSecond).toBe(300);
      // Open model: offered is a pure function of arrival rate and phase length.
      expect(repetition.offered).toBe(300);
      expect(repetition.started + repetition.dropped).toBe(repetition.offered);
      // A loaded machine may drop a few iterations, but the schedule must never silently
      // re-send them late, and the dropped fraction must stay far below maxDroppedFraction.
      expect(repetition.started).toBeGreaterThanOrEqual(295);
      expect(repetition.dropped).toBeLessThanOrEqual(5);
      expect(repetition.completed).toBe(repetition.started);
      expect(repetition.errors).toBe(0);
      expect(repetition.errorRate).toBe(0);
      // Latency is measured from the actual send, so no sample can be negative.
      expect(repetition.latencySamplesMs).toHaveLength(repetition.correctness.validated);
      expect(repetition.latencySamplesMs.every((value) => value >= 0)).toBe(true);
      expect(repetition.minMs).toBeGreaterThanOrEqual(0);
      expect(repetition.p50Ms).toBeGreaterThan(0);
      expect(repetition.p50Ms).toBeLessThanOrEqual(repetition.p95Ms);
      expect(repetition.p95Ms).toBeLessThanOrEqual(repetition.p99Ms);
      expect(repetition.throughputRequestsPerSecond).toBeGreaterThan(0);
      expect(repetition.correctness.validated).toBe(repetition.started);
      expect(repetition.correctness.mismatches).toBe(0);
      expect(repetition.correctness.failedResponses).toBe(0);
      expect(repetition.correctness.oracleMatched).toBe(true);
      expect(repetition.saturation.maxInFlight).toBeGreaterThan(0);
      expect(repetition.resources.service.pid).toBe(result.service.pid);
      expect(repetition.resources.generator.pid).toBe(result.generator.pid);
      expect(repetition.resources.service.cpuUserMicros).toBeGreaterThan(0);
      expect(repetition.resources.service.rssBytes).toBeGreaterThan(0);
      expect(repetition.identityFingerprint).toBe(result.identityFingerprint);
      expect(repetition.resources.generator.generatorLimited).toBe(false);

      const raw = readJsonArtifact<{
        receipt: string;
        repetitionIndex: number;
        record: { offered: number };
      }>(subject.root, result.rawArtifacts[index]!)!;
      expect(raw.receipt).toBe(result.receipt);
      expect(raw.repetitionIndex).toBe(index + 1);
      expect(raw.record.offered).toBe(repetition.offered);
    }

    const verification = readJsonArtifact<{
      passed: boolean;
      checks: Record<string, boolean>;
    }>(subject.root, VERIFICATION_ARTIFACT)!;
    expect(verification.passed).toBe(true);
    expect(Object.values(verification.checks).every(Boolean)).toBe(true);
  }, 120_000);

  test('rejects a plausible closed-model plan on the substantive protocol check and ignores candidate claims', async () => {
    const subject = await fixture();
    writePlan(subject.root, PERFORMANCE_TESTING_LOAD_FAULTY_PLAN);
    writeFixtureFile(
      subject.root,
      RESULT_ARTIFACT,
      '{"passed":true,"scenarioId":"performance-testing-full-task-1","p95Ms":0.01,"receipt":"candidate-claim"}\n',
    );
    const score = await subject.score();
    expect(score.passed).toBe(false);
    expect(score.integrityFailure).toBe(false);
    expect(score.evidence.join('\n')).toMatch(
      /must model arrivals independently of response time/i,
    );
    expect(score.evidence.join('\n')).not.toMatch(/is missing or is not a JSON object/i);
  }, 120_000);

  test('rejects an out-of-bounds plan without running the load harness', async () => {
    const subject = await fixture();
    writePlan(subject.root, { ...PERFORMANCE_TESTING_LOAD_VALID_PLAN, measuredMs: 999_999 });
    const score = await subject.score();
    expect(score.passed).toBe(false);
    expect(score.integrityFailure).toBe(false);
    expect(score.evidence.join('\n')).toMatch(/measuredMs must be within/i);
    expect(readJsonArtifact(subject.root, RESULT_ARTIFACT)).toBeNull();
  }, 60_000);

  test('fails integrity when an evaluator-owned fixed file is changed', async () => {
    const subject = await fixture();
    writePlan(subject.root, PERFORMANCE_TESTING_LOAD_VALID_PLAN);
    writeFixtureFile(subject.root, 'corpus/dataset.js', 'export const SPEC = { records: 1 };\n');
    const score = await subject.score();
    expect(score.passed).toBe(false);
    expect(score.integrityFailure).toBe(true);

    const harnessTamper = await fixture();
    writePlan(harnessTamper.root, PERFORMANCE_TESTING_LOAD_VALID_PLAN);
    writeFixtureFile(harnessTamper.root, 'harness/load-core.mjs', 'process.exit(0);\n');
    const harnessScore = await harnessTamper.score();
    expect(harnessScore.passed).toBe(false);
    expect(harnessScore.integrityFailure).toBe(true);

    const serviceTamper = await fixture();
    writePlan(serviceTamper.root, PERFORMANCE_TESTING_LOAD_VALID_PLAN);
    writeFixtureFile(serviceTamper.root, 'src/service.ts', 'export function startService() {}\n');
    const serviceScore = await serviceTamper.score();
    expect(serviceScore.passed).toBe(false);
    expect(serviceScore.integrityFailure).toBe(true);
  }, 60_000);

  test('bounds a nonterminating service child and fails closed', async () => {
    const subject = await fixture();
    writePlan(subject.root, PERFORMANCE_TESTING_LOAD_VALID_PLAN);
    writeFixtureFile(subject.root, 'src/service.ts', 'while (true) {}\n');
    const started = Date.now();
    const run = spawnSync(
      process.execPath,
      ['run', '--no-env-file', 'harness/load-core.mjs', 'load-plan.json', RESULT_ARTIFACT],
      {
        cwd: subject.root,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: subject.root,
          TMPDIR: subject.root,
          TEMP: subject.root,
          TMP: subject.root,
          NO_COLOR: '1',
          TERM: 'dumb',
          KORY_PERF_LOAD_RECEIPT: 'KORY_PERF_LOAD_NONTERMINATION_TEST',
        },
        encoding: 'utf8',
        timeout: 25_000,
        killSignal: 'SIGKILL',
        maxBuffer: 2_000_000,
      },
    );
    const elapsed = Date.now() - started;
    const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
    expect(run.error).toBeUndefined();
    expect(run.status).not.toBe(0);
    expect(elapsed).toBeLessThan(20_000);
    expect(output).toMatch(/timed out|service readiness|load harness failed/i);
    expect(readJsonArtifact(subject.root, RESULT_ARTIFACT)).toBeNull();
    await Bun.sleep(300);
    const lingering = spawnSync('/usr/bin/pgrep', ['-f', 'harness/service-runner.mjs'], {
      encoding: 'utf8',
    });
    expect(lingering.stdout.trim()).toBe('');
  }, 60_000);
});
