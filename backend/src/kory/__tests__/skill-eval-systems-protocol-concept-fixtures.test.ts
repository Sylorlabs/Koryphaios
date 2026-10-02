import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditSkillEvalExecutionReadiness } from '../skill-eval-execution';
import {
  BUILTIN_SKILL_EVAL_MATERIALIZERS,
  BUILTIN_SKILL_EVAL_SCORERS,
} from '../skill-eval-fixtures';
import { buildSkillEvalSuiteV3 } from '../skill-eval-harness';
import { loadV5SkillPackages } from '../skill-packages';
import {
  SYSTEMS_PROTOCOL_CONCEPTS,
  SYSTEMS_PROTOCOL_SKILL_EVAL_MATERIALIZERS,
  SYSTEMS_PROTOCOL_SKILL_EVAL_SCORERS,
} from '../skill-eval-systems-protocol-concept-fixtures';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('systems protocol concept fixtures', () => {
  test('every explicit scenario becomes executable without widening unrelated environments', () => {
    const packages = loadV5SkillPackages().packages;
    const readiness = auditSkillEvalExecutionReadiness(
      packages,
      BUILTIN_SKILL_EVAL_MATERIALIZERS,
      BUILTIN_SKILL_EVAL_SCORERS,
    );
    expect(SYSTEMS_PROTOCOL_CONCEPTS).toHaveLength(26);
    for (const definition of SYSTEMS_PROTOCOL_CONCEPTS) {
      expect(readiness.find((row) => row.scenarioId === definition.id)?.ready, definition.id).toBe(
        true,
      );
    }
  });

  test('representative scenarios start red before implementation', async () => {
    for (const definition of [
      SYSTEMS_PROTOCOL_CONCEPTS[0]!,
      SYSTEMS_PROTOCOL_CONCEPTS[10]!,
      SYSTEMS_PROTOCOL_CONCEPTS[14]!,
      SYSTEMS_PROTOCOL_CONCEPTS[20]!,
    ]) {
      const skillPackage = loadV5SkillPackages().packages.find(
        (item) => item.sidecar.name === definition.skill,
      )!;
      const scenario = buildSkillEvalSuiteV3(skillPackage).scenarios.find(
        (item) => item.id === definition.id,
      )!;
      const root = mkdtempSync(join(tmpdir(), 'kory-systems-protocol-test-'));
      roots.push(root);
      const materializer = SYSTEMS_PROTOCOL_SKILL_EVAL_MATERIALIZERS.find((item) =>
        item.matches(scenario),
      )!;
      const scorer = SYSTEMS_PROTOCOL_SKILL_EVAL_SCORERS.find((item) =>
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
    }
  }, 20_000);
});
