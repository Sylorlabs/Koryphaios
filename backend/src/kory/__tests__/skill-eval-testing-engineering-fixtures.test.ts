import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
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
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('testing-engineering mutation fixtures', () => {
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
