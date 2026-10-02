import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSkillEvalSuiteV3 } from '../skill-eval-harness';
import { loadV5SkillPackages } from '../skill-packages';
import {
  REPOSITORY_COMMUNICATION_SKILL_EVAL_MATERIALIZERS,
  REPOSITORY_COMMUNICATION_SKILL_EVAL_SCORERS,
} from '../skill-eval-repository-communication-fixtures';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe('repository communication and planning fixtures', () => {
  test('all four authored evidence packets start red', async () => {
    const packages = loadV5SkillPackages().packages;
    const targets = new Set([
      'documents-communication-full-task-1-individual',
      'instructional-communication-full-task-1-individual',
      'planning-full-task-2-individual',
      'technical-communication-full-task-1-individual',
    ]);
    for (const skillPackage of packages) {
      for (const scenario of buildSkillEvalSuiteV3(skillPackage).scenarios.filter((s) =>
        targets.has(s.id),
      )) {
        const root = mkdtempSync(join(tmpdir(), 'kory-repository-communication-test-'));
        roots.push(root);
        const materializer = REPOSITORY_COMMUNICATION_SKILL_EVAL_MATERIALIZERS.find((m) =>
          m.matches(scenario),
        )!;
        const scorer = REPOSITORY_COMMUNICATION_SKILL_EVAL_SCORERS.find((s) =>
          s.scenarioIds.includes(scenario.id),
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
    }
  });
});
