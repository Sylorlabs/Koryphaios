import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSkillEvalSuiteV3 } from '../../eval/skills/skill-eval-harness';
import { readJsonArtifact, writeFixtureFile } from '../../eval/skills/skill-eval-fixture-helpers';
import {
  PERFORMANCE_TESTING_SKILL_EVAL_MATERIALIZERS,
  PERFORMANCE_TESTING_SKILL_EVAL_SCORERS,
  PERFORMANCE_TESTING_VALID_PLAN,
} from '../../eval/skills/skill-eval-performance-testing-fixtures';
import { loadV5SkillPackages } from '../skill-packages';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('performance-testing native benchmark fixture', () => {
  test('starts red then executes the complete cold/warm five-repetition benchmark protocol', async () => {
    const skill = loadV5SkillPackages().packages.find(
      (item) => item.sidecar.name === 'performance-testing',
    )!;
    const scenario = buildSkillEvalSuiteV3(skill).scenarios.find(
      (item) => item.id === 'performance-testing-full-task-2',
    )!;
    const materializer = PERFORMANCE_TESTING_SKILL_EVAL_MATERIALIZERS.find((item) =>
      item.matches(scenario),
    )!;
    const scorer = PERFORMANCE_TESTING_SKILL_EVAL_SCORERS.find((item) =>
      item.scenarioIds.includes(scenario.id),
    )!;
    const root = mkdtempSync(join(tmpdir(), 'kory-performance-testing-'));
    roots.push(root);
    await materializer.materialize(root, scenario);
    const input = {
      scenario,
      experiment: {} as never,
      workingDirectory: root,
      observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
    };

    const red = await scorer.score(input);
    expect(red.passed).toBe(false);
    expect(red.integrityFailure).toBe(false);

    writeFixtureFile(
      root,
      'benchmark-plan.json',
      `${JSON.stringify(PERFORMANCE_TESTING_VALID_PLAN, null, 2)}\n`,
    );
    const green = await scorer.score(input);
    expect(green.passed).toBe(true);
    expect(green.integrityFailure).toBe(false);
    expect(green.quality).toBe(1);
    expect(green.verification).toBe(1);
    const result = readJsonArtifact<{
      cold: { latencyMs: number; correct: boolean };
      warmup: { discarded: boolean; durationMs: number };
      repetitions: Array<{
        durationMs: number;
        throughputEventsPerSecond: number;
        correct: boolean;
      }>;
      environment: { corpusBytes: number; powerStable: boolean; buildOptimization: string };
      correctness: { oracleMatched: boolean };
    }>(root, 'evaluation/performance-testing-scenario-2-raw.json')!;
    expect(result.cold.correct).toBe(true);
    expect(result.cold.latencyMs).toBeGreaterThan(0);
    expect(result.warmup.discarded).toBe(true);
    expect(result.repetitions).toHaveLength(5);
    expect(result.repetitions.every((item) => item.correct)).toBe(true);
    expect(result.repetitions.every((item) => item.durationMs >= 40)).toBe(true);
    expect(result.repetitions.every((item) => item.throughputEventsPerSecond > 0)).toBe(true);
    expect(result.environment.corpusBytes).toBe(64 * 1024);
    expect(result.environment.powerStable).toBe(true);
    expect(result.environment.buildOptimization).toContain('minify=true');
    expect(result.correctness.oracleMatched).toBe(true);
  });

  test('fails integrity if evaluator-owned parser evidence is changed', async () => {
    const skill = loadV5SkillPackages().packages.find(
      (item) => item.sidecar.name === 'performance-testing',
    )!;
    const scenario = buildSkillEvalSuiteV3(skill).scenarios.find(
      (item) => item.id === 'performance-testing-full-task-2',
    )!;
    const materializer = PERFORMANCE_TESTING_SKILL_EVAL_MATERIALIZERS.find((item) =>
      item.matches(scenario),
    )!;
    const scorer = PERFORMANCE_TESTING_SKILL_EVAL_SCORERS.find((item) =>
      item.scenarioIds.includes(scenario.id),
    )!;
    const root = mkdtempSync(join(tmpdir(), 'kory-performance-testing-tamper-'));
    roots.push(root);
    await materializer.materialize(root, scenario);
    writeFixtureFile(root, 'src/parser.ts', 'export const parseEvent = () => ({ id: "fake" });\n');
    writeFixtureFile(
      root,
      'benchmark-plan.json',
      `${JSON.stringify(PERFORMANCE_TESTING_VALID_PLAN, null, 2)}\n`,
    );
    const score = await scorer.score({
      scenario,
      experiment: {} as never,
      workingDirectory: root,
      observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
    });
    expect(score.passed).toBe(false);
    expect(score.integrityFailure).toBe(true);
  });
});
