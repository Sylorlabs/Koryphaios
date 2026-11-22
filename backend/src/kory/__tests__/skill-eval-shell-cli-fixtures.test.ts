import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSkillEvalSuiteV3 } from '../../eval/skills/skill-eval-harness';
import { loadV5SkillPackages } from '../skill-packages';
import {
  SHELL_CLI_SKILL_EVAL_MATERIALIZERS,
  SHELL_CLI_SKILL_EVAL_SCORERS,
} from '../../eval/skills/skill-eval-shell-cli-fixtures';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('shell CLI full-task fixtures', () => {
  test('both real shell fixtures start red', async () => {
    const skillPackage = loadV5SkillPackages().packages.find(
      (item) => item.sidecar.name === 'shell-cli-engineering',
    )!;
    const suite = buildSkillEvalSuiteV3(skillPackage);
    for (const scenario of suite.scenarios.filter((item) => item.category === 'full-task')) {
      const root = mkdtempSync(join(tmpdir(), 'kory-shell-fixture-test-'));
      roots.push(root);
      const materializer = SHELL_CLI_SKILL_EVAL_MATERIALIZERS.find((item) =>
        item.matches(scenario),
      )!;
      const scorer = SHELL_CLI_SKILL_EVAL_SCORERS.find((item) =>
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
  });
});
