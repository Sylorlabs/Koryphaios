import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditSkillEvalExecutionReadiness } from '../../eval/skills/skill-eval-execution';
import {
  BUILTIN_SKILL_EVAL_MATERIALIZERS,
  BUILTIN_SKILL_EVAL_SCORERS,
} from '../../eval/skills/skill-eval-fixtures';
import { buildSkillEvalSuiteV3 } from '../../eval/skills/skill-eval-harness';
import { loadV5SkillPackages } from '../skill-packages';
import {
  INTERFACE_SEARCH_GRAPHICS_CONCEPTS,
  INTERFACE_SEARCH_GRAPHICS_SKILL_EVAL_MATERIALIZERS,
  INTERFACE_SEARCH_GRAPHICS_SKILL_EVAL_SCORERS,
} from '../../eval/skills/skill-eval-interface-search-graphics-concept-fixtures';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('interface search and graphics concept fixtures', () => {
  test('terminal narrow-mode label is part of the public evaluator contract', () => {
    const terminal = INTERFACE_SEARCH_GRAPHICS_CONCEPTS.find(
      (definition) => definition.id === 'terminal-interface-full-task-1-individual',
    )!;
    expect(terminal.generation).toBe(2);
    expect(terminal.contract).toContain(
      'If tty=true and width<40 return mode compact with columns name,status',
    );
  });

  test('all explicit local scenarios are executable', () => {
    const packages = loadV5SkillPackages().packages;
    const readiness = auditSkillEvalExecutionReadiness(
      packages,
      BUILTIN_SKILL_EVAL_MATERIALIZERS,
      BUILTIN_SKILL_EVAL_SCORERS,
    );
    expect(INTERFACE_SEARCH_GRAPHICS_CONCEPTS).toHaveLength(7);
    for (const definition of INTERFACE_SEARCH_GRAPHICS_CONCEPTS) {
      const row = readiness.find((item) => item.scenarioId === definition.id);
      expect(row, definition.id).toBeDefined();
      const materializer = BUILTIN_SKILL_EVAL_MATERIALIZERS.find(
        (item) => item.id === row?.materializerId,
      );
      expect(materializer, definition.id).toBeDefined();
      // The search-indexing concepts are gated on a real Elasticsearch runtime, so
      // their blockers come from the environment rather than the static fixture.
      // The audit row has to mirror the materializer's own blockers, and a concept
      // that declares blockers statically must have them reported.
      const blockers = materializer?.readinessBlockers ?? [];
      for (const declared of definition.blockers ?? []) {
        expect(blockers, definition.id).toContain(declared);
      }
      expect(row?.reasons, definition.id).toEqual(blockers);
      expect(row?.ready, definition.id).toBe(blockers.length === 0);
    }
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
