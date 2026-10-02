import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  VERIFICATION_SKILL_EVAL_MATERIALIZERS,
  VERIFICATION_SKILL_EVAL_SCORERS,
} from '../skill-eval-verification-fixtures';
import { writeFixtureFile } from '../skill-eval-fixture-helpers';
import { buildSkillEvalSuiteV3 } from '../skill-eval-harness';
import { loadV5SkillPackages } from '../skill-packages';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function scoreReport(
  scenarioId: 'verification-full-task-1' | 'verification-full-task-2',
  report: Record<string, unknown>,
  finalResponse: string,
) {
  const skill = loadV5SkillPackages().packages.find(
    (item) => item.sidecar.name === 'verification',
  )!;
  const scenario = buildSkillEvalSuiteV3(skill).scenarios.find((item) => item.id === scenarioId)!;
  const materializer = VERIFICATION_SKILL_EVAL_MATERIALIZERS.find((item) =>
    item.matches(scenario),
  )!;
  const scorer = VERIFICATION_SKILL_EVAL_SCORERS.find((item) =>
    item.scenarioIds.includes(scenario.id),
  )!;
  const root = mkdtempSync(join(tmpdir(), 'kory-verification-fixture-'));
  roots.push(root);
  await materializer.materialize(root, scenario);
  const artifactName = scenarioId.endsWith('-1')
    ? '.kory-eval/verification-scenario-1.json'
    : '.kory-eval/verification-scenario-2.json';
  writeFixtureFile(root, artifactName, `${JSON.stringify(report, null, 2)}\n`);
  return scorer.score({
    scenario,
    experiment: {} as never,
    workingDirectory: root,
    observation: {
      output: `<kory-eval-patch>${JSON.stringify(report)}</kory-eval-patch>\n${finalResponse}`,
      evidence: [],
      artifacts: [],
      durationMs: 0,
    },
  });
}

describe('verification fixture scoring', () => {
  test('accepts a refuted overall verdict when an individual subclaim is confirmed', async () => {
    const score = await scoreReport(
      'verification-full-task-1',
      {
        claims: [
          {
            claim: 'Configuration selects nova',
            oracle: 'config/provider.json',
            observedResult: 'nova is configured',
            verdict: 'confirmed',
          },
          {
            claim: 'HTTP 200 proves provider identity',
            oracle: 'provider switch test',
            observedResult: 'Both providers return 200, so the status is insufficient.',
            verdict: 'refuted',
          },
          {
            claim: 'The real /chat path invokes nova',
            oracle: 'independent provider invocation record',
            observedResult: 'legacy is invoked',
            verdict: 'refuted',
          },
        ],
        focusedCheck: 'bun test tests/provider-switch.test.ts',
        independentReadback: 'provider invocation record shows legacy',
        overallVerdict: 'refuted',
      },
      'The completion claim is refuted: /chat still uses legacy while nova is configured.',
    );

    expect(score.passed).toBe(true);
    expect(score.quality).toBe(1);
    expect(score.verification).toBe(1);
  });

  test('accepts explicit unavailable runtime evidence when the hidden oracle independently proves it', async () => {
    const score = await scoreReport(
      'verification-full-task-2',
      {
        claims: [
          {
            claim: 'The packaged CLI emits parseable JSON',
            oracle: 'kory export --format json fixture/input.json followed by a JSON parser',
            observed_result: 'Runtime output is unavailable in this execution mode.',
            verdict: 'refuted',
          },
        ],
        focused_gates: [
          { command: 'bun test tests/formatter.test.ts', result: 'not run; unavailable' },
          { command: 'bun run typecheck', result: 'not run; unavailable' },
        ],
        consumer_command: 'kory export --format json fixture/input.json',
        json_validation: {
          method: 'Parse the consumer command stdout with a JSON parser',
          result: 'unavailable; stdout could not be obtained',
        },
        overall_verdict: 'refuted',
        unavailable_evidence: 'Exact consumer output is unavailable in this execution mode.',
      },
      'The completion claim is refuted by the supplied workspace state.',
    );

    expect(score.passed).toBe(true);
    expect(score.quality).toBe(1);
    expect(score.verification).toBe(1);
  });
});
