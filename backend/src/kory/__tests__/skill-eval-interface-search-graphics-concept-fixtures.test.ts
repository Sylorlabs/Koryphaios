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
  INTERFACE_SEARCH_GRAPHICS_CONCEPTS,
  INTERFACE_SEARCH_GRAPHICS_SKILL_EVAL_MATERIALIZERS,
  INTERFACE_SEARCH_GRAPHICS_SKILL_EVAL_SCORERS,
} from '../skill-eval-interface-search-graphics-concept-fixtures';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('interface search and graphics concept fixtures', () => {
  test('all explicit local scenarios are executable', () => {
    const packages = loadV5SkillPackages().packages;
    const readiness = auditSkillEvalExecutionReadiness(
      packages,
      BUILTIN_SKILL_EVAL_MATERIALIZERS,
      BUILTIN_SKILL_EVAL_SCORERS,
    );
    expect(INTERFACE_SEARCH_GRAPHICS_CONCEPTS).toHaveLength(7);
    for (const definition of INTERFACE_SEARCH_GRAPHICS_CONCEPTS)
      expect(readiness.find((row) => row.scenarioId === definition.id)?.ready, definition.id).toBe(
        true,
      );
  });

  test('representative fixtures start red', async () => {
    for (const definition of [
      INTERFACE_SEARCH_GRAPHICS_CONCEPTS[0]!,
      INTERFACE_SEARCH_GRAPHICS_CONCEPTS[2]!,
      INTERFACE_SEARCH_GRAPHICS_CONCEPTS[4]!,
    ]) {
      const skillPackage = loadV5SkillPackages().packages.find(
        (item) => item.sidecar.name === definition.skill,
      )!;
      const scenario = buildSkillEvalSuiteV3(skillPackage).scenarios.find(
        (item) => item.id === definition.id,
      )!;
      const root = mkdtempSync(join(tmpdir(), 'kory-interface-search-graphics-test-'));
      roots.push(root);
      const materializer = INTERFACE_SEARCH_GRAPHICS_SKILL_EVAL_MATERIALIZERS.find((item) =>
        item.matches(scenario),
      )!;
      const scorer = INTERFACE_SEARCH_GRAPHICS_SKILL_EVAL_SCORERS.find((item) =>
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
