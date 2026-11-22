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
  AI_PROTOCOL_CONCEPTS,
  AI_PROTOCOL_SKILL_EVAL_MATERIALIZERS,
  AI_PROTOCOL_SKILL_EVAL_SCORERS,
} from '../../eval/skills/skill-eval-ai-protocol-concept-fixtures';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('AI/retrieval protocol concept fixtures', () => {
  test('all explicit protocol scenarios are registered with their active full-task gates', () => {
    const skills = new Set(AI_PROTOCOL_CONCEPTS.map((definition) => definition.skill));
    const packages = loadV5SkillPackages().packages.filter((pkg) => skills.has(pkg.sidecar.name));
    const readiness = auditSkillEvalExecutionReadiness(
      packages,
      BUILTIN_SKILL_EVAL_MATERIALIZERS,
      BUILTIN_SKILL_EVAL_SCORERS,
    );
    expect(AI_PROTOCOL_CONCEPTS).toHaveLength(16);
    for (const definition of AI_PROTOCOL_CONCEPTS) {
      const scenario = buildSkillEvalSuiteV3(
        packages.find((pkg) => pkg.sidecar.name === definition.skill)!,
      ).scenarios.find((item) => item.id === definition.id)!;
      const materializer = AI_PROTOCOL_SKILL_EVAL_MATERIALIZERS.find((item) =>
        item.matches(scenario),
      )!;
      const scorer = AI_PROTOCOL_SKILL_EVAL_SCORERS.find((item) =>
        item.scenarioIds.includes(definition.id),
      )!;
      expect(materializer, definition.id).toBeDefined();
      expect(scorer, definition.id).toBeDefined();
      const row = readiness.find((item) => item.scenarioId === definition.id);
      expect(row, definition.id).toBeDefined();
      expect(row?.materializerId, definition.id).toBe(materializer.id);
      expect(row?.deterministicScorerId, definition.id).toBe(scorer.id);
      // Vector concepts now dispatch through Elasticsearch. Registration is
      // unconditional; executability follows that adapter's runtime probe.
      const blockers = materializer.readinessBlockers ?? [];
      expect(row?.ready, definition.id).toBe(blockers.length === 0);
      expect(row?.reasons, definition.id).toEqual(blockers);
      if (definition.skill === 'vector-search-systems') {
        expect(materializer.realRuntime, definition.id).toBe(true);
        expect(materializer.id).toContain('/concept-elasticsearch@3');
        expect(scorer.id).toContain('/concept-elasticsearch-scorer@3');
      } else {
        expect(blockers, definition.id).toEqual(definition.blockers ?? []);
      }
    }
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

  test('LLM scorer fixtures disclose their distinct identity and blind-label input contracts', () => {
    const one = AI_PROTOCOL_CONCEPTS.find(
      (item) => item.id === 'llm-evaluation-full-task-1-individual',
    )!;
    const two = AI_PROTOCOL_CONCEPTS.find(
      (item) => item.id === 'llm-evaluation-full-task-2-individual',
    )!;
    expect(one.contract).toContain('blindLabels:string[]');
    expect(one.contract).toContain('caseId:string');
    expect(two.contract).toContain('taskId:string');
    expect(two.contract).toContain('leakage:string[]');
    for (const vector of one.vectors()) {
      const input = vector.input as { blindLabels: unknown; runs: Record<string, unknown>[] };
      expect(Array.isArray(input.blindLabels)).toBe(true);
      expect(input.runs.every((run) => typeof run.caseId === 'string')).toBe(true);
    }
    for (const vector of two.vectors()) {
      const input = vector.input as { runs: Record<string, unknown>[] };
      expect(input.runs.every((run) => typeof run.taskId === 'string')).toBe(true);
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
