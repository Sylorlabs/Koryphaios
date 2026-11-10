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
  MODEL_DATA_CONCEPTS,
  MODEL_DATA_SKILL_EVAL_MATERIALIZERS,
  MODEL_DATA_SKILL_EVAL_SCORERS,
} from '../skill-eval-model-data-concept-fixtures';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe('model and data concept fixtures', () => {
  test('all four fixed-corpus scenarios are executable', () => {
    const packages = loadV5SkillPackages().packages;
    const rows = auditSkillEvalExecutionReadiness(
      packages,
      BUILTIN_SKILL_EVAL_MATERIALIZERS,
      BUILTIN_SKILL_EVAL_SCORERS,
    );
    expect(MODEL_DATA_CONCEPTS).toHaveLength(4);
    for (const definition of MODEL_DATA_CONCEPTS) {
      const row = rows.find((item) => item.scenarioId === definition.id);
      expect(row, definition.id).toBeDefined();
      expect(row?.ready, definition.id).toBe(definition.blockers?.length ? false : true);
      expect(row?.reasons, definition.id).toEqual(definition.blockers ?? []);
    }
  });
  test('representative scenarios start red', async () => {
    for (const d of [MODEL_DATA_CONCEPTS[0]!, MODEL_DATA_CONCEPTS[2]!]) {
      const p = loadV5SkillPackages().packages.find((x) => x.sidecar.name === d.skill)!;
      const s = buildSkillEvalSuiteV3(p).scenarios.find((x) => x.id === d.id)!;
      const root = mkdtempSync(join(tmpdir(), 'kory-model-data-test-'));
      roots.push(root);
      const m = MODEL_DATA_SKILL_EVAL_MATERIALIZERS.find((x) => x.matches(s))!;
      const scorer = MODEL_DATA_SKILL_EVAL_SCORERS.find((x) => x.scenarioIds.includes(s.id))!;
      await m.materialize(root, s);
      const score = await scorer.score({
        scenario: s,
        experiment: {} as never,
        workingDirectory: root,
        observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
      });
      expect(score.passed, s.id).toBe(false);
    }
  }, 20_000);
});
