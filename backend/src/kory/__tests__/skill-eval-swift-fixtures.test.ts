import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSkillEvalSuiteV3 } from '../skill-eval-harness';
import { writeFixtureFile } from '../skill-eval-fixture-helpers';
import { loadV5SkillPackages } from '../skill-packages';
import {
  SWIFT_SKILL_EVAL_MATERIALIZERS,
  SWIFT_SKILL_EVAL_SCORERS,
} from '../skill-eval-swift-fixtures';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Swift runtime skill fixtures', () => {
  test('both strict-concurrency fixtures compile and start red', async () => {
    const skillPackage = loadV5SkillPackages().packages.find(
      (item) => item.sidecar.name === 'swift-engineering',
    )!;
    for (const scenario of buildSkillEvalSuiteV3(skillPackage).scenarios.filter(
      (item) => item.category === 'full-task',
    )) {
      const root = mkdtempSync(join(tmpdir(), 'kory-swift-fixture-test-'));
      roots.push(root);
      const materializer = SWIFT_SKILL_EVAL_MATERIALIZERS.find((item) => item.matches(scenario))!;
      const scorer = SWIFT_SKILL_EVAL_SCORERS.find((item) =>
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
      expect(score.integrityFailure, scenario.id).toBe(false);
    }
  }, 60_000);

  test('actor scorer compiles its hidden harness and requires executable regression code', async () => {
    const skillPackage = loadV5SkillPackages().packages.find(
      (item) => item.sidecar.name === 'swift-engineering',
    )!;
    const scenario = buildSkillEvalSuiteV3(skillPackage).scenarios.find(
      (item) => item.id === 'swift-engineering-full-task-1-individual',
    )!;
    const root = mkdtempSync(join(tmpdir(), 'kory-swift-actor-green-'));
    roots.push(root);
    const materializer = SWIFT_SKILL_EVAL_MATERIALIZERS.find((item) => item.matches(scenario))!;
    const scorer = SWIFT_SKILL_EVAL_SCORERS.find((item) => item.scenarioIds.includes(scenario.id))!;
    await materializer.materialize(root, scenario);
    writeFixtureFile(
      root,
      'Sources/Account.swift',
      `public actor Account {
  private var balance: Int
  public init(balance: Int) { self.balance = balance }
  public func currentBalance() -> Int { balance }
  public func withdraw(_ amount: Int, fraudCheck: @escaping @Sendable () async throws -> Bool) async throws -> Bool {
    guard balance >= amount else { return false }
    balance -= amount
    do {
      try Task.checkCancellation()
      let allowed = try await fraudCheck()
      try Task.checkCancellation()
      guard allowed else { balance += amount; return false }
      return true
    } catch {
      balance += amount
      throw error
    }
  }
}
`,
    );
    writeFixtureFile(
      root,
      'Tests/AccountRegression.swift',
      `import Testing
@Test func concurrentReservationDenialErrorAndCancellation() async throws {
  #expect(true, "concurrent reservation protects balance")
  #expect(true, "denial and error restore balance")
  #expect(true, "cancel restores balance")
}
`,
    );
    const input = {
      scenario,
      experiment: {} as never,
      workingDirectory: root,
      observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
    };
    const green = await scorer.score(input);
    expect(scorer.id).toEndWith('@2');
    expect(green.passed).toBe(true);
    expect(green.verification).toBe(1);

    writeFixtureFile(
      root,
      'Tests/AccountRegression.swift',
      '// concurrent reservation; denial error cancel coverage is described here only\n',
    );
    const commentsOnly = await scorer.score(input);
    expect(commentsOnly.passed).toBe(false);
    expect(commentsOnly.verification).toBe(1);
    expect(commentsOnly.evidence).toContain('regression coverage: missing');
  }, 60_000);
});
