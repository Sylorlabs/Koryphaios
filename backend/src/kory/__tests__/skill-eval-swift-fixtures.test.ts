import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isMac } from '../../runtime/platform';
import { buildSkillEvalSuiteV3 } from '../../eval/skills/skill-eval-harness';
import { writeFixtureFile } from '../../eval/skills/skill-eval-fixture-helpers';
import { loadV5SkillPackages } from '../skill-packages';
import {
  SWIFT_SKILL_EVAL_MATERIALIZERS,
  SWIFT_SKILL_EVAL_SCORERS,
} from '../../eval/skills/skill-eval-swift-fixtures';
import { swiftRuntimeReadiness } from '../../eval/skills/skill-eval-swift-runtime';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const readiness = swiftRuntimeReadiness();
if (readiness.reasons.length)
  console.warn(`Swift native controls unavailable:\n${readiness.reasons.join('\n')}`);

test('readiness records native proof or blockers; an explicitly selected Xcode must work', () => {
  if (process.env.DEVELOPER_DIR !== undefined || process.env.SDKROOT !== undefined)
    expect(readiness.reasons, readiness.reasons.join('\n')).toEqual([]);
  if (readiness.reasons.length) {
    expect(readiness.reasons.join('\n')).toContain('Swift runtime unavailable');
  } else {
    expect(readiness.evidence).toContain('swiftc passed');
    expect(readiness.evidence).toContain('KORY_SWIFT_READY');
  }
});

test('SDKROOT must be an existing absolute SDK directory', () => {
  const relative = swiftRuntimeReadiness({ sdkRoot: 'MacOSX26.5.sdk' });
  expect(relative.reasons.join('\n')).toContain('SDKROOT must be an absolute directory path');
  const missing = swiftRuntimeReadiness({ sdkRoot: join(tmpdir(), 'kory-missing-sdk-directory') });
  expect(missing.reasons.join('\n')).toContain('SDKROOT must name an existing directory');
  const notAnSdk = swiftRuntimeReadiness({ sdkRoot: tmpdir() });
  expect(notAnSdk.reasons.join('\n')).toContain('SDKROOT must name a macOS SDK directory');
});

const compatibleSdkRoots = ['MacOSX26.5.sdk', 'MacOSX15.4.sdk'].map((sdk) =>
  join('/Library/Developer/CommandLineTools/SDKs', sdk),
);
test.skipIf(!isMac() || compatibleSdkRoots.every((sdk) => !existsSync(sdk)))(
  'caller-selected installed macOS SDKs compile and execute real probes',
  () => {
    for (const sdkRoot of compatibleSdkRoots.filter(existsSync)) {
      const result = swiftRuntimeReadiness({ sdkRoot });
      expect(result.reasons, `${sdkRoot}: ${result.evidence}`).toEqual([]);
      expect(result.evidence).toContain('swiftc passed');
      expect(result.evidence).toContain('KORY_SWIFT_READY');
    }
  },
  210_000,
);

describe.skipIf(readiness.reasons.length > 0)('Swift runtime skill fixtures', () => {
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
      // A broken SDK/compiler or unwritable module cache is not a red behavioral control.
      expect(score.evidence.join('\n'), scenario.id).toContain('swiftc passed');
      expect(score.evidence.join('\n'), scenario.id).not.toContain('ETIMEDOUT');
    }
  }, 240_000);

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
    expect(green.passed, green.evidence.join('\n')).toBe(true);
    expect(green.evidence.join('\n')).toContain('KORY_SWIFT_OK');
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
  }, 240_000);

  test('callback scorer covers stale retries and independent waiter cancellation', async () => {
    const skillPackage = loadV5SkillPackages().packages.find(
      (item) => item.sidecar.name === 'swift-engineering',
    )!;
    const scenario = buildSkillEvalSuiteV3(skillPackage).scenarios.find(
      (item) => item.id === 'swift-engineering-full-task-2-individual',
    )!;
    const root = mkdtempSync(join(tmpdir(), 'kory-swift-callback-green-'));
    roots.push(root);
    const materializer = SWIFT_SKILL_EVAL_MATERIALIZERS.find((item) => item.matches(scenario))!;
    const scorer = SWIFT_SKILL_EVAL_SCORERS.find((item) => item.scenarioIds.includes(scenario.id))!;
    await materializer.materialize(root, scenario);
    writeFixtureFile(
      root,
      'Sources/ImageLoader.swift',
      `public enum ImageLoadError: Error, Sendable, Equatable { case failed }

public protocol ImageCancellation: Sendable { func cancel() }

public protocol LegacyImageLoading: Sendable {
  @discardableResult
  func load(
    _ key: String,
    completion: @escaping @Sendable (Result<String, ImageLoadError>) -> Void
  ) -> any ImageCancellation
}

public actor ImageLoader {
  private let legacy: any LegacyImageLoading
  private var cache: [String: String] = [:]
  private var nextFlightID = 0
  private var nextWaiterID = 0
  private struct Flight {
    let id: Int
    let handle: any ImageCancellation
    var waiters: [Int: CheckedContinuation<String, Error>] = [:]
  }
  private var flights: [String: Flight] = [:]

  public init(legacy: any LegacyImageLoading) { self.legacy = legacy }

  public func image(_ key: String) async throws -> String {
    if let cached = cache[key] { return cached }
    let flightID: Int
    if let flight = flights[key] {
      flightID = flight.id
    } else {
      nextFlightID += 1
      flightID = nextFlightID
      let handle = legacy.load(key) { [weak self] result in
        guard let self else { return }
        Task { await self.complete(key, flightID: flightID, result: result) }
      }
      flights[key] = Flight(id: flightID, handle: handle)
    }
    nextWaiterID += 1
    let waiterID = nextWaiterID
    return try await withTaskCancellationHandler(operation: {
      try await withCheckedThrowingContinuation { continuation in
        Task { self.register(key, flightID: flightID, waiterID: waiterID, continuation: continuation) }
      }
    }, onCancel: {
      Task { await self.cancel(key, flightID: flightID, waiterID: waiterID) }
    })
  }

  private func register(
    _ key: String,
    flightID: Int,
    waiterID: Int,
    continuation: CheckedContinuation<String, Error>
  ) {
    guard var flight = flights[key], flight.id == flightID else {
      continuation.resume(throwing: ImageLoadError.failed)
      return
    }
    flight.waiters[waiterID] = continuation
    flights[key] = flight
  }

  private func cancel(_ key: String, flightID: Int, waiterID: Int) {
    guard var flight = flights[key], flight.id == flightID,
      let continuation = flight.waiters.removeValue(forKey: waiterID) else { return }
    continuation.resume(throwing: CancellationError())
    if flight.waiters.isEmpty {
      flights.removeValue(forKey: key)
      flight.handle.cancel()
    } else {
      flights[key] = flight
    }
  }

  private func complete(
    _ key: String,
    flightID: Int,
    result: Result<String, ImageLoadError>
  ) {
    guard let flight = flights[key], flight.id == flightID else { return }
    flights.removeValue(forKey: key)
    if case let .success(value) = result { cache[key] = value }
    for continuation in flight.waiters.values { continuation.resume(with: result) }
  }
}
`,
    );
    writeFixtureFile(
      root,
      'Tests/ImageLoaderRegression.swift',
      `import Testing
@Test func callbackFlightRegressions() async throws {
  #expect(true, "duplicate late continuation exactly once")
  #expect(true, "cancellation and concurrent same-key cache behavior")
  #expect(true, "old failed or cancelled flight cannot poison a same-key retry")
  #expect(true, "one cancelled waiter leaves the shared continuing waiter alive")
}
`,
    );
    const input = {
      scenario,
      experiment: {} as never,
      workingDirectory: root,
      observation: { output: '', evidence: [], artifacts: [], durationMs: 0 },
    };
    const score = await scorer.score(input);
    expect(materializer.id).toEndWith('@2');
    expect(scorer.id).toEndWith('@2');
    expect(score.passed, score.evidence.join('\n')).toBe(true);
    expect(score.evidence.join('\n')).toContain('KORY_SWIFT_OK');
    expect(score.verification).toBe(1);

    writeFixtureFile(
      root,
      'Tests/ImageLoaderRegression.swift',
      `// @Test func callbackFlightRegressions() {
// #expect(true, "duplicate late continuation exactly once")
/* #expect(true, "cancellation and concurrent same-key cache behavior")
   #expect(true, "old failed or cancelled flight cannot poison a same-key retry")
   #expect(true, "one cancelled waiter leaves the shared continuing waiter alive") */
`,
    );
    const commentsOnly = await scorer.score(input);
    expect(commentsOnly.passed).toBe(false);
    expect(commentsOnly.verification).toBe(1);
    expect(commentsOnly.evidence).toContain('regression coverage: missing');
  }, 240_000);
});
