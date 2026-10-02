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
  AI_PROTOCOL_CONCEPTS,
  AI_PROTOCOL_SKILL_EVAL_MATERIALIZERS,
  AI_PROTOCOL_SKILL_EVAL_SCORERS,
} from '../skill-eval-ai-protocol-concept-fixtures';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('AI/retrieval protocol concept fixtures', () => {
  test('all explicit protocol scenarios are full-task executable', () => {
    const packages = loadV5SkillPackages().packages;
    const readiness = auditSkillEvalExecutionReadiness(
      packages,
      BUILTIN_SKILL_EVAL_MATERIALIZERS,
      BUILTIN_SKILL_EVAL_SCORERS,
    );
    expect(AI_PROTOCOL_CONCEPTS).toHaveLength(16);
    for (const definition of AI_PROTOCOL_CONCEPTS)
      expect(readiness.find((row) => row.scenarioId === definition.id)?.ready, definition.id).toBe(
        true,
      );
  });

  test('delegation vectors use the declared-scope field promised by the public contract', () => {
    const definition = AI_PROTOCOL_CONCEPTS.find(
      (item) => item.id === 'agentic-systems-full-task-2-individual',
    )!;
    expect(definition.generation).toBe(2);
    for (const vector of definition.vectors()) {
      const specialists = (vector.input as { specialists: Array<Record<string, unknown>> })
        .specialists;
      for (const specialist of specialists) {
        expect(Array.isArray(specialist.declaredScope)).toBe(true);
        expect(specialist.scope).toBeUndefined();
      }
    }
  });

  test('representative protocol fixtures start red before subject implementation', async () => {
    for (const definition of [
      AI_PROTOCOL_CONCEPTS[0]!,
      AI_PROTOCOL_CONCEPTS[6]!,
      AI_PROTOCOL_CONCEPTS[14]!,
    ]) {
      const skillPackage = loadV5SkillPackages().packages.find(
        (item) => item.sidecar.name === definition.skill,
      )!;
      const scenario = buildSkillEvalSuiteV3(skillPackage).scenarios.find(
        (item) => item.id === definition.id,
      )!;
      const root = mkdtempSync(join(tmpdir(), 'kory-ai-protocol-test-'));
      roots.push(root);
      const materializer = AI_PROTOCOL_SKILL_EVAL_MATERIALIZERS.find((item) =>
        item.matches(scenario),
      )!;
      const scorer = AI_PROTOCOL_SKILL_EVAL_SCORERS.find((item) =>
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
