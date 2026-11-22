import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSkillEvalSuiteV3 } from '../../eval/skills/skill-eval-harness';
import { loadV5SkillPackages } from '../skill-packages';
import {
  REPOSITORY_COMMUNICATION_SKILL_EVAL_MATERIALIZERS,
  REPOSITORY_COMMUNICATION_SKILL_EVAL_SCORERS,
} from '../../eval/skills/skill-eval-repository-communication-fixtures';

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

  test('planning scorer rejects dangling, forward, duplicate, and malformed phase dependencies', async () => {
    const planning = loadV5SkillPackages().packages.find((candidate) =>
      candidate.sidecar.name === 'planning',
    )!;
    const scenario = buildSkillEvalSuiteV3(planning).scenarios.find(
      (candidate) => candidate.id === 'planning-full-task-2-individual',
    )!;
    const root = mkdtempSync(join(tmpdir(), 'kory-planning-dependencies-'));
    roots.push(root);
    await REPOSITORY_COMMUNICATION_SKILL_EVAL_MATERIALIZERS.find((candidate) =>
      candidate.matches(scenario),
    )!.materialize(root, scenario);
    const scorer = REPOSITORY_COMMUNICATION_SKILL_EVAL_SCORERS.find((candidate) =>
      candidate.scenarioIds.includes(scenario.id),
    )!;
    const ids = ['inventory', 'contract', 'outbox', 'shadow-reconcile', 'cutover', 'retire'];
    const plan = {
      phases: ids.map((id, index) => ({
        id,
        owners: ['Messaging team'],
        dependsOn: index === 0 ? [] : [ids[index - 1]!],
        gate: 'Observable compatibility evidence supports proceeding.',
        rollback: 'Restore the previous delivery owner and reconcile work.',
      })),
      openQuestions: ['What is the peak retry volume?'],
      cutoverEvidence: ['zero missing emails', 'reconciled events', 'roll-back rehearsal'],
    };
    writeFileSync(join(root, 'plan.md'), 'password-reset receipt security-alert reconciliation\n');
    const score = async (phases: unknown) => {
      writeFileSync(join(root, 'plan.json'), `${JSON.stringify({ ...plan, phases })}\n`);
      return scorer.score({
        scenario,
        experiment: {} as never,
        workingDirectory: root,
        observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
      });
    };
    expect((await score(plan.phases)).passed).toBe(true);
    const invalid = [
      plan.phases.map((phase, index) => index === 1 ? { ...phase, dependsOn: ['missing'] } : phase),
      plan.phases.map((phase, index) => index === 2 ? { ...phase, dependsOn: ['retire'] } : phase),
      plan.phases.map((phase, index) => index === 3 ? { ...phase, dependsOn: ['shadow-reconcile'] } : phase),
      plan.phases.map((phase, index) => index === 3 ? { ...phase, id: 'outbox' } : phase),
      [null, ...plan.phases.slice(1)],
    ];
    for (const phases of invalid) {
      const result = await score(phases);
      expect(result.passed).toBe(false);
      expect(result.evidence).toContain('dependency graph: fail');
    }
  });
});
