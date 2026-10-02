import { afterEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadV5SkillPackages } from '../skill-packages';
import {
  auditSkillEvalExecutionReadiness,
  fingerprintSkillEvalWorkspace,
  runPairedSkillEvaluationV3,
  type SkillEvalDeterministicScorer,
  type SkillEvalFixtureMaterializer,
} from '../skill-eval-execution';
import {
  BUILTIN_SKILL_EVAL_MATERIALIZERS,
  BUILTIN_SKILL_EVAL_SCORERS,
} from '../skill-eval-fixtures';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

describe('V5 skill evaluation execution', () => {
  const skillPackage = loadV5SkillPackages().packages.find(
    (item) => item.sidecar.name === 'deterministic-debugging',
  )!;
  const scenario = skillPackage.evaluation.tasks[0]!;
  const materializer: SkillEvalFixtureMaterializer = {
    id: 'test-fixture',
    matches: (candidate) => candidate.id === scenario.id,
    materialize: (destination) => {
      writeFileSync(join(destination, 'state.txt'), 'broken\n');
    },
  };
  const scorer: SkillEvalDeterministicScorer = {
    id: 'test-scorer',
    scenarioIds: [scenario.id],
    score: ({ workingDirectory }) => ({
      passed: true,
      quality: 1,
      verification: 1,
      integrityFailure: false,
      evidence: [fingerprintSkillEvalWorkspace(workingDirectory)],
    }),
  };

  test('fails readiness closed when fixtures or deterministic scorers are not registered', () => {
    const unready = auditSkillEvalExecutionReadiness([skillPackage], [], []);
    expect(unready.every((item) => !item.ready)).toBe(true);
    expect(unready[0]!.reasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining('no materializer'),
        'no registered deterministic scorer',
      ]),
    );
  });

  test('model budget exhaustion is a failed task even if workspace checks could pass', async () => {
    const result = await runPairedSkillEvaluationV3({
      projectRoot: process.cwd(),
      skillPackage,
      scenarioId: scenario.id,
      skillRevisionHash: 'a'.repeat(64),
      harnessVersion: 'test-model-budget',
      materializers: [materializer],
      scorers: [scorer],
      executor: {
        id: 'test-timeout',
        subject: 'other',
        provider: 'synthetic',
        model: 'timeout-control',
        runtimeIdentity: 'test',
        tools: [],
        budget: { wallClockMs: 1_000 },
        execute: async () => ({
          output: '',
          evidence: ['Task budget exhausted'],
          artifacts: [],
          durationMs: 1_000,
          taskFailure: 'Task budget exhausted',
        }),
      },
    });
    cleanups.push(result.cleanup);
    expect(result.withSkill.observation.infrastructureFailure).toBeUndefined();
    expect(result.withSkill.score).toMatchObject({
      passed: false,
      quality: 0,
      verification: 0,
      integrityFailure: false,
    });
    expect(result.withoutSkill.score?.passed).toBe(false);
  });

  test('runs same-snapshot skill and no-skill arms while changing only the skill context', async () => {
    const observations: Array<{
      prompt: string;
      skillContext: string | null;
      before: string;
    }> = [];
    const result = await runPairedSkillEvaluationV3({
      projectRoot: process.cwd(),
      skillPackage,
      scenarioId: scenario.id,
      skillRevisionHash: 'a'.repeat(64),
      harnessVersion: 'test-v3',
      materializers: [materializer],
      scorers: [scorer],
      executor: {
        id: 'synthetic-executor',
        subject: 'kory',
        provider: 'synthetic',
        model: 'deterministic-test',
        runtimeIdentity: 'bun-test',
        tools: ['filesystem'],
        budget: { wallClockMs: 1_000 },
        execute: async ({ taskPrompt, skillContext, workingDirectory }) => {
          observations.push({
            prompt: taskPrompt,
            skillContext,
            before: fingerprintSkillEvalWorkspace(workingDirectory),
          });
          writeFileSync(
            join(workingDirectory, 'result.txt'),
            skillContext ? 'with\n' : 'without\n',
          );
          return { output: 'done', evidence: ['synthetic run'], artifacts: [], durationMs: 1 };
        },
      },
    });
    cleanups.push(result.cleanup);

    expect(observations).toHaveLength(2);
    expect(observations[0]!.prompt).toBe(observations[1]!.prompt);
    expect(observations[0]!.before).toBe(result.initialFingerprint);
    expect(observations[1]!.before).toBe(result.initialFingerprint);
    expect(observations[0]!.skillContext).toContain('deterministic-debugging');
    expect(observations[1]!.skillContext).toBeNull();
    expect(result.withSkill.score?.passed).toBe(true);
    expect(result.withoutSkill.score?.passed).toBe(true);
  });

  test('materializes the deterministic-debugging pilot and proves the starting revision fails hidden checks', async () => {
    const readiness = auditSkillEvalExecutionReadiness(
      [skillPackage],
      BUILTIN_SKILL_EVAL_MATERIALIZERS,
      BUILTIN_SKILL_EVAL_SCORERS,
    );
    expect(readiness).toHaveLength(2);
    expect(readiness.every((item) => item.ready)).toBe(true);

    const result = await runPairedSkillEvaluationV3({
      projectRoot: process.cwd(),
      skillPackage,
      scenarioId: scenario.id,
      skillRevisionHash: 'b'.repeat(64),
      harnessVersion: 'fixture-self-test-v3',
      materializers: BUILTIN_SKILL_EVAL_MATERIALIZERS,
      scorers: BUILTIN_SKILL_EVAL_SCORERS,
      executor: {
        id: 'no-op-executor',
        subject: 'other',
        provider: 'synthetic',
        model: 'no-op',
        runtimeIdentity: 'fixture-self-test',
        tools: ['filesystem'],
        budget: { wallClockMs: 1_000 },
        execute: async () => ({
          output: 'unchanged',
          evidence: ['fixture intentionally left unchanged'],
          artifacts: [],
          durationMs: 1,
        }),
      },
    });
    cleanups.push(result.cleanup);
    expect(result.withSkill.score?.passed).toBe(false);
    expect(result.withoutSkill.score?.passed).toBe(false);
  });

  test('keeps every representative six-domain pilot executable and red before model intervention', async () => {
    const pilotSkills = new Set([
      'agentic-systems',
      'application-security',
      'backend-engineering',
      'data-analysis',
      'deterministic-debugging',
      'interaction-design',
    ]);
    const packages = loadV5SkillPackages().packages.filter((item) =>
      pilotSkills.has(item.sidecar.name),
    );
    expect(packages).toHaveLength(6);

    const readiness = auditSkillEvalExecutionReadiness(
      packages,
      BUILTIN_SKILL_EVAL_MATERIALIZERS,
      BUILTIN_SKILL_EVAL_SCORERS,
    );
    expect(readiness).toHaveLength(12);
    expect(readiness.every((item) => item.ready)).toBe(true);

    for (const candidate of packages) {
      for (const task of candidate.evaluation.tasks) {
        const result = await runPairedSkillEvaluationV3({
          projectRoot: process.cwd(),
          skillPackage: candidate,
          scenarioId: task.id,
          skillRevisionHash: 'c'.repeat(64),
          harnessVersion: 'pilot-fixture-self-test-v3',
          materializers: BUILTIN_SKILL_EVAL_MATERIALIZERS,
          scorers: BUILTIN_SKILL_EVAL_SCORERS,
          executor: {
            id: 'pilot-no-op-executor',
            subject: 'other',
            provider: 'synthetic',
            model: 'no-op',
            runtimeIdentity: 'fixture-self-test',
            tools: ['filesystem'],
            budget: { wallClockMs: 1_000 },
            execute: async () => ({
              output: 'unchanged',
              evidence: ['fixture intentionally left unchanged'],
              artifacts: [],
              durationMs: 1,
            }),
          },
        });
        cleanups.push(result.cleanup);
        expect(
          result.withSkill.score?.passed,
          `${candidate.sidecar.name}/${task.id} should start red`,
        ).toBe(false);
        expect(
          result.withoutSkill.score?.passed,
          `${candidate.sidecar.name}/${task.id} baseline should start red`,
        ).toBe(false);
      }
    }
  });

  test('keeps the task-routing expansion executable and red before model intervention', async () => {
    const routingPackage = loadV5SkillPackages().packages.find(
      (item) => item.sidecar.name === 'task-routing',
    )!;
    const readiness = auditSkillEvalExecutionReadiness(
      [routingPackage],
      BUILTIN_SKILL_EVAL_MATERIALIZERS,
      BUILTIN_SKILL_EVAL_SCORERS,
    );
    expect(readiness).toHaveLength(2);
    expect(readiness.every((item) => item.ready)).toBe(true);

    for (const task of routingPackage.evaluation.tasks) {
      const result = await runPairedSkillEvaluationV3({
        projectRoot: process.cwd(),
        skillPackage: routingPackage,
        scenarioId: task.id,
        skillRevisionHash: 'd'.repeat(64),
        harnessVersion: 'routing-fixture-self-test-v3',
        materializers: BUILTIN_SKILL_EVAL_MATERIALIZERS,
        scorers: BUILTIN_SKILL_EVAL_SCORERS,
        executor: {
          id: 'routing-no-op-executor',
          subject: 'other',
          provider: 'synthetic',
          model: 'no-op',
          runtimeIdentity: 'fixture-self-test',
          tools: ['filesystem'],
          budget: { wallClockMs: 1_000 },
          execute: async () => ({
            output: 'unchanged',
            evidence: ['fixture intentionally left unchanged'],
            artifacts: [],
            durationMs: 1,
          }),
        },
      });
      cleanups.push(result.cleanup);
      expect(result.withSkill.score?.passed, `${task.id} should start red`).toBe(false);
      expect(result.withoutSkill.score?.passed, `${task.id} baseline should start red`).toBe(false);
    }
  });

  test('keeps repository discovery fixtures executable and red before model intervention', async () => {
    const discoveryPackage = loadV5SkillPackages().packages.find(
      (item) => item.sidecar.name === 'repository-environment-discovery',
    )!;
    const readiness = auditSkillEvalExecutionReadiness(
      [discoveryPackage],
      BUILTIN_SKILL_EVAL_MATERIALIZERS,
      BUILTIN_SKILL_EVAL_SCORERS,
    );
    expect(readiness).toHaveLength(2);
    expect(readiness.every((item) => item.ready)).toBe(true);

    for (const task of discoveryPackage.evaluation.tasks) {
      const result = await runPairedSkillEvaluationV3({
        projectRoot: process.cwd(),
        skillPackage: discoveryPackage,
        scenarioId: task.id,
        skillRevisionHash: 'e'.repeat(64),
        harnessVersion: 'repository-discovery-fixture-self-test-v3',
        materializers: BUILTIN_SKILL_EVAL_MATERIALIZERS,
        scorers: BUILTIN_SKILL_EVAL_SCORERS,
        executor: {
          id: 'repository-discovery-no-op-executor',
          subject: 'other',
          provider: 'synthetic',
          model: 'no-op',
          runtimeIdentity: 'fixture-self-test',
          tools: ['filesystem'],
          budget: { wallClockMs: 1_000 },
          execute: async () => ({
            output: 'unchanged',
            evidence: ['fixture intentionally left unchanged'],
            artifacts: [],
            durationMs: 1,
          }),
        },
      });
      cleanups.push(result.cleanup);
      expect(result.withSkill.score?.passed, `${task.id} should start red`).toBe(false);
      expect(result.withoutSkill.score?.passed, `${task.id} baseline should start red`).toBe(false);
    }
  });

  test('keeps Plan-mode fixtures executable and red before model intervention', async () => {
    const planModePackage = loadV5SkillPackages().packages.find(
      (item) => item.sidecar.name === 'plan-mode',
    )!;
    const readiness = auditSkillEvalExecutionReadiness(
      [planModePackage],
      BUILTIN_SKILL_EVAL_MATERIALIZERS,
      BUILTIN_SKILL_EVAL_SCORERS,
    );
    expect(readiness).toHaveLength(2);
    expect(readiness.every((item) => item.ready)).toBe(true);

    for (const task of planModePackage.evaluation.tasks) {
      const result = await runPairedSkillEvaluationV3({
        projectRoot: process.cwd(),
        skillPackage: planModePackage,
        scenarioId: task.id,
        skillRevisionHash: 'f'.repeat(64),
        harnessVersion: 'plan-mode-fixture-self-test-v3',
        materializers: BUILTIN_SKILL_EVAL_MATERIALIZERS,
        scorers: BUILTIN_SKILL_EVAL_SCORERS,
        executor: {
          id: 'plan-mode-no-op-executor',
          subject: 'other',
          provider: 'synthetic',
          model: 'no-op',
          runtimeIdentity: 'fixture-self-test',
          tools: ['filesystem'],
          budget: { wallClockMs: 1_000 },
          execute: async () => ({
            output: 'unchanged',
            evidence: ['fixture intentionally left unchanged'],
            artifacts: [],
            durationMs: 1,
          }),
        },
      });
      cleanups.push(result.cleanup);
      expect(result.withSkill.score?.passed, `${task.id} should start red`).toBe(false);
      expect(result.withoutSkill.score?.passed, `${task.id} baseline should start red`).toBe(false);
    }
  });

  test('keeps webhook integration fixtures executable and red before model intervention', async () => {
    const webhookPackage = loadV5SkillPackages().packages.find(
      (item) => item.sidecar.name === 'webhook-integration',
    )!;
    const readiness = auditSkillEvalExecutionReadiness(
      [webhookPackage],
      BUILTIN_SKILL_EVAL_MATERIALIZERS,
      BUILTIN_SKILL_EVAL_SCORERS,
    );
    expect(readiness).toHaveLength(2);
    expect(readiness.every((item) => item.ready)).toBe(true);

    for (const task of webhookPackage.evaluation.tasks) {
      const result = await runPairedSkillEvaluationV3({
        projectRoot: process.cwd(),
        skillPackage: webhookPackage,
        scenarioId: task.id,
        skillRevisionHash: 'a'.repeat(64),
        harnessVersion: 'webhook-fixture-self-test-v3',
        materializers: BUILTIN_SKILL_EVAL_MATERIALIZERS,
        scorers: BUILTIN_SKILL_EVAL_SCORERS,
        executor: {
          id: 'webhook-no-op-executor',
          subject: 'other',
          provider: 'synthetic',
          model: 'no-op',
          runtimeIdentity: 'fixture-self-test',
          tools: ['filesystem'],
          budget: { wallClockMs: 1_000 },
          execute: async () => ({
            output: 'unchanged',
            evidence: ['fixture intentionally left unchanged'],
            artifacts: [],
            durationMs: 1,
          }),
        },
      });
      cleanups.push(result.cleanup);
      expect(result.withSkill.score?.passed, `${task.id} should start red`).toBe(false);
      expect(result.withoutSkill.score?.passed, `${task.id} baseline should start red`).toBe(false);
    }
  });

  test('keeps API contract design fixtures executable and red before model intervention', async () => {
    const apiPackage = loadV5SkillPackages().packages.find(
      (item) => item.sidecar.name === 'api-contract-design',
    )!;
    const readiness = auditSkillEvalExecutionReadiness(
      [apiPackage],
      BUILTIN_SKILL_EVAL_MATERIALIZERS,
      BUILTIN_SKILL_EVAL_SCORERS,
    );
    expect(readiness).toHaveLength(2);
    expect(readiness.every((item) => item.ready)).toBe(true);

    for (const task of apiPackage.evaluation.tasks) {
      const result = await runPairedSkillEvaluationV3({
        projectRoot: process.cwd(),
        skillPackage: apiPackage,
        scenarioId: task.id,
        skillRevisionHash: 'b'.repeat(64),
        harnessVersion: 'api-contract-fixture-self-test-v3',
        materializers: BUILTIN_SKILL_EVAL_MATERIALIZERS,
        scorers: BUILTIN_SKILL_EVAL_SCORERS,
        executor: {
          id: 'api-contract-no-op-executor',
          subject: 'other',
          provider: 'synthetic',
          model: 'no-op',
          runtimeIdentity: 'fixture-self-test',
          tools: ['filesystem'],
          budget: { wallClockMs: 1_000 },
          execute: async () => ({
            output: 'unchanged',
            evidence: ['fixture intentionally left unchanged'],
            artifacts: [],
            durationMs: 1,
          }),
        },
      });
      cleanups.push(result.cleanup);
      expect(result.withSkill.score?.passed, `${task.id} should start red`).toBe(false);
      expect(result.withoutSkill.score?.passed, `${task.id} baseline should start red`).toBe(false);
    }
  });

  test('keeps every executable V5 full-task fixture red before model intervention', async () => {
    const packages = loadV5SkillPackages().packages;
    const readiness = auditSkillEvalExecutionReadiness(
      packages,
      BUILTIN_SKILL_EVAL_MATERIALIZERS,
      BUILTIN_SKILL_EVAL_SCORERS,
    );
    const readyScenarioIds = new Set(
      readiness.filter((item) => item.ready).map((item) => item.scenarioId),
    );
    // Real-runtime fixtures drive bounded child processes and real browser sessions. They assert
    // red-then-green in their own dedicated suites; sweeping them here would accumulate
    // process/browser spawn churn inside one test process. Keep the exclusion auditable.
    const realRuntimeMaterializerIds = new Set(
      BUILTIN_SKILL_EVAL_MATERIALIZERS.filter((item) => item.realRuntime).map((item) => item.id),
    );
    const realRuntimeScenarioIds = readiness
      .filter(
        (item) =>
          item.ready &&
          item.materializerId !== null &&
          realRuntimeMaterializerIds.has(item.materializerId),
      )
      .map((item) => item.scenarioId)
      .sort();
    expect(realRuntimeScenarioIds).toEqual([
      'novel-ui-toolkit-full-task-1-individual',
      'novel-ui-toolkit-full-task-2-individual',
      'performance-debugging-full-task-1',
      'performance-debugging-full-task-2',
      'performance-testing-full-task-1',
    ]);
    for (const scenarioId of realRuntimeScenarioIds) readyScenarioIds.delete(scenarioId);

    for (const skillPackage of packages) {
      for (const task of skillPackage.evaluation.tasks) {
        if (!readyScenarioIds.has(task.id)) continue;
        const result = await runPairedSkillEvaluationV3({
          projectRoot: process.cwd(),
          skillPackage,
          scenarioId: task.id,
          skillRevisionHash: 'd'.repeat(64),
          harnessVersion: 'all-ready-fixture-self-test-v3',
          materializers: BUILTIN_SKILL_EVAL_MATERIALIZERS,
          scorers: BUILTIN_SKILL_EVAL_SCORERS,
          executor: {
            id: 'all-ready-no-op-executor',
            subject: 'other',
            provider: 'synthetic',
            model: 'no-op',
            runtimeIdentity: 'fixture-self-test',
            tools: ['filesystem'],
            budget: { wallClockMs: 1_000 },
            execute: async () => ({
              output: 'unchanged',
              evidence: ['fixture intentionally left unchanged'],
              artifacts: [],
              durationMs: 1,
            }),
          },
        });
        cleanups.push(result.cleanup);
        expect(result.withSkill.score?.passed, `${skillPackage.sidecar.name}/${task.id}`).toBe(
          false,
        );
        expect(result.withoutSkill.score?.passed, `${skillPackage.sidecar.name}/${task.id}`).toBe(
          false,
        );
      }
    }
    // Ready fixtures now include real-runtime evaluators (bounded local processes and real
    // browser sessions), so the full sweep needs a wider budget than the source-only fixtures.
  }, 240_000);
});
