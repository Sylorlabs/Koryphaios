import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSkillEvalSuiteV3 } from '../skill-eval-harness';
import { writeFixtureFile } from '../skill-eval-fixture-helpers';
import {
  KOTLIN_COROUTINE_CONTROL,
  KOTLIN_COROUTINE_SCENARIO,
  KOTLIN_SEALED_CONTROL,
  KOTLIN_SEALED_SCENARIO,
  V5_KOTLIN_HOST_SKILL_EVAL_MATERIALIZERS,
  V5_KOTLIN_HOST_SKILL_EVAL_SCORERS,
  kotlinHostReadiness,
} from '../skill-eval-v5-kotlin-host-fixtures';
import { loadV5SkillPackages } from '../skill-packages';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const kotlinPackage = loadV5SkillPackages().packages.find(
  (item) => item.sidecar.name === 'kotlin-engineering',
)!;
const suite = buildSkillEvalSuiteV3(kotlinPackage);
const coroutineScenario = suite.scenarios.find((item) => item.id === KOTLIN_COROUTINE_SCENARIO)!;
const prerequisites = kotlinHostReadiness();
const runtimeTest = test.skipIf(prerequisites.length > 0);

async function materializeScenario(id: string) {
  const scenario = suite.scenarios.find((item) => item.id === id)!;
  const root = mkdtempSync(join(tmpdir(), 'kory-kotlin-control-'));
  roots.push(root);
  const materializer = V5_KOTLIN_HOST_SKILL_EVAL_MATERIALIZERS.find((item) =>
    item.matches(scenario),
  )!;
  await materializer.materialize(root, scenario);
  return { root, scenario };
}

async function scoreScenario(root: string, scenario: (typeof suite.scenarios)[number]) {
  const scorer = V5_KOTLIN_HOST_SKILL_EVAL_SCORERS.find((item) =>
    item.scenarioIds.includes(scenario.id),
  )!;
  return scorer.score({
    scenario,
    experiment: {} as never,
    workingDirectory: root,
    observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
  });
}

describe('actual Kotlin host evaluators', () => {
  test('Kotlin scorer generations reflect the repaired runtime contract', () => {
    expect(
      V5_KOTLIN_HOST_SKILL_EVAL_MATERIALIZERS.find((item) => item.matches(coroutineScenario))!.id,
    ).toBe('kotlin-engineering/actual-coroutine-ownership@2');
    expect(
      V5_KOTLIN_HOST_SKILL_EVAL_MATERIALIZERS.find((item) =>
        item.matches(suite.scenarios.find((scenario) => scenario.id === KOTLIN_SEALED_SCENARIO)!),
      )!.id,
    ).toBe('kotlin-engineering/actual-sealed-json-retention@2');
    expect(
      V5_KOTLIN_HOST_SKILL_EVAL_SCORERS.filter(
        (item) =>
          item.scenarioIds.includes(KOTLIN_COROUTINE_SCENARIO) ||
          item.scenarioIds.includes(KOTLIN_SEALED_SCENARIO),
      ).map((item) => item.id),
    ).toEqual([
      'kotlin-engineering/actual-coroutine-ownership-scorer@2',
      'kotlin-engineering/actual-sealed-json-retention-scorer@2',
    ]);
  });

  runtimeTest(
    'coroutine control reaches and passes the hidden runtime checks',
    async () => {
      const { root, scenario } = await materializeScenario(KOTLIN_COROUTINE_SCENARIO);
      writeFixtureFile(root, 'src/RequestService.kt', KOTLIN_COROUTINE_CONTROL);
      writeFixtureFile(
        root,
        'tests/regression.kt',
        [
          'virtual testScheduler cancellation timeout request failure durable progress',
          'failDurableWrites SupervisorJob durable failure',
          'durable recovery after failure with a later durable child',
        ].join('\n'),
      );

      const result = await scoreScenario(root, scenario);
      expect(result.passed).toBe(true);
      expect(result.verification).toBe(1);
      expect(result.evidence[0]).toBe('Kotlin 2.4.20/JDK 27 runtime checks: pass');
      expect(result.evidence).toContain('kotlinx-coroutines 1.10.2 virtual-time checks: pass');
    },
    30_000,
  );

  runtimeTest(
    'sealed-message control reaches and passes the hidden runtime checks',
    async () => {
      const { root, scenario } = await materializeScenario(KOTLIN_SEALED_SCENARIO);
      writeFixtureFile(root, 'src/QueueCodec.kt', KOTLIN_SEALED_CONTROL);
      writeFixtureFile(
        root,
        'tests/regression.kt',
        'unknown subtype retain quarantine; ordering restart reprocess upgrade malformed\n',
      );

      const result = await scoreScenario(root, scenario);
      expect(result.passed).toBe(true);
      expect(result.verification).toBe(1);
      expect(result.evidence[0]).toBe('Kotlin 2.4.20/JDK 27 runtime checks: pass');
    },
    30_000,
  );
});
