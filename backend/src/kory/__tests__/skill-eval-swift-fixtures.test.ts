import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSkillEvalSuiteV3 } from '../skill-eval-harness';
import { loadV5SkillPackages } from '../skill-packages';
import {
  SWIFT_SKILL_EVAL_MATERIALIZERS,
  SWIFT_SKILL_EVAL_SCORERS,
} from '../skill-eval-swift-fixtures';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Swift runtime skill fixtures', () => {
  test('both strict-concurrency fixtures compile and start red', async () => {
    const skillPackage = loadV5SkillPackages().packages.find(
      (item) => item.sidecar.name === 'swift-engineering',
    )!;
    for (const scenario of buildSkillEvalSuiteV3(skillPackage).scenarios.filter(
      (item) => item.category === 'full-task',
    )) {
      const root = mkdtempSync(join(tmpdir(), 'kory-swift-fixture-test-'));
      roots.push(root);
      const materializer = SWIFT_SKILL_EVAL_MATERIALIZERS.find((item) => item.matches(scenario))!;
      const scorer = SWIFT_SKILL_EVAL_SCORERS.find((item) =>
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
  }, 60_000);
});
