import { describe, expect, test } from 'bun:test';
import { auditSkillEvalExecutionReadiness } from '../skill-eval-execution';
import {
  EXTERNAL_ENVIRONMENT_GATES,
  EXTERNAL_ENVIRONMENT_SKILL_EVAL_MATERIALIZERS,
  EXTERNAL_ENVIRONMENT_SKILL_EVAL_SCORERS,
} from '../skill-eval-external-environment-fixtures';
import {
  BUILTIN_SKILL_EVAL_MATERIALIZERS,
  BUILTIN_SKILL_EVAL_SCORERS,
} from '../skill-eval-fixtures';
import { loadV5SkillPackages } from '../skill-packages';

describe('external full-task environment gates', () => {
  test('covers every otherwise-unmaterialized full task with a specific fail-closed gate', () => {
    const packages = loadV5SkillPackages().packages;
    const knownScenarios = new Set(
      packages.flatMap((skill) => skill.evaluation.tasks.map((task) => task.id)),
    );
    const gatedScenarioIds = EXTERNAL_ENVIRONMENT_GATES.flatMap((gate) => gate.scenarioIds);
    expect(gatedScenarioIds).toHaveLength(61);
    expect(new Set(gatedScenarioIds).size).toBe(gatedScenarioIds.length);
    for (const scenarioId of gatedScenarioIds)
      expect(knownScenarios.has(scenarioId), scenarioId).toBe(true);

    const promotedBrowserScenarios = [
      'web-interface-full-task-async-operations-console',
      'web-interface-full-task-content-led-product-page',
      'visual-verification-full-task-1',
      'svelte-engineering-full-task-1-individual',
      'svelte-engineering-full-task-2-individual',
    ];
    for (const scenarioId of promotedBrowserScenarios) {
      expect(gatedScenarioIds, scenarioId).not.toContain(scenarioId);
    }

    const rows = auditSkillEvalExecutionReadiness(
      packages,
      BUILTIN_SKILL_EVAL_MATERIALIZERS,
      BUILTIN_SKILL_EVAL_SCORERS,
    );
    // New executable scenarios may increase the inventory. Keep the established
    // readiness floor and blocker ceiling, while requiring every declared task
    // to be represented exactly once; unrelated additions must not break gates.
    expect(rows).toHaveLength(knownScenarios.size);
    expect(new Set(rows.map((row) => row.scenarioId))).toEqual(knownScenarios);
    expect(rows.filter((row) => row.ready).length).toBeGreaterThanOrEqual(293);
    expect(rows.filter((row) => !row.ready).length).toBeLessThanOrEqual(67);
    for (const scenarioId of promotedBrowserScenarios) {
      const row = rows.find((item) => item.scenarioId === scenarioId)!;
      expect(row.ready, scenarioId).toBe(true);
      expect(row.materializerId, scenarioId).toContain('real-browser');
      expect(row.deterministicScorerId, scenarioId).toContain('real-browser');
    }
    for (const scenarioId of gatedScenarioIds) {
      const row = rows.find((item) => item.scenarioId === scenarioId)!;
      // Gate entries remain historical fallbacks. A registered real-runtime
      // evaluator may supersede one, but a concept fixture may not certify it.
      if (row.ready) {
        const replacement = BUILTIN_SKILL_EVAL_MATERIALIZERS.find(
          (materializer) => materializer.id === row.materializerId,
        );
        expect(replacement?.realRuntime, scenarioId).toBe(true);
        expect(row.materializerId, scenarioId).not.toContain('/external-environment-gate/');
        expect(row.deterministicScorerId, scenarioId).not.toContain(
          '/external-environment-gate-scorer/',
        );
        expect(row.reasons, scenarioId).toEqual([]);
        continue;
      }
      expect(row.ready, scenarioId).toBe(false);
      expect(row.materializerId, scenarioId).toContain('/external-environment-gate/');
      expect(row.deterministicScorerId, scenarioId).toContain('/external-environment-gate-scorer/');
      expect(row.reasons, scenarioId).toHaveLength(1);
      expect(row.reasons[0], scenarioId).not.toMatch(
        /no materializer|no registered deterministic scorer/iu,
      );
    }
  });

  test('gate scorers can never turn unavailable environment evidence into a pass', async () => {
    expect(EXTERNAL_ENVIRONMENT_SKILL_EVAL_MATERIALIZERS).toHaveLength(61);
    expect(EXTERNAL_ENVIRONMENT_SKILL_EVAL_SCORERS).toHaveLength(61);
    for (const scorer of EXTERNAL_ENVIRONMENT_SKILL_EVAL_SCORERS) {
      const score = await scorer.score({
        scenario: {} as never,
        experiment: {} as never,
        workingDirectory: '',
        observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
      });
      expect(score.passed, scorer.id).toBe(false);
      expect(score.verification, scorer.id).toBe(0);
    }
  });
});
