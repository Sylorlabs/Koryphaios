import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type {
  SkillEvalDeterministicScore,
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import { writeFixtureFile } from './skill-eval-fixture-helpers';
import { runSwiftProgram, swiftRuntimeReadiness } from './skill-eval-swift-runtime';

const ACTOR = 'swift-engineering-full-task-1-individual';
const CALLBACK = 'swift-engineering-full-task-2-individual';

const ACTOR_SOURCE = `public actor Account {
  private var balance: Int

  public init(balance: Int) { self.balance = balance }
  public func currentBalance() -> Int { balance }

  public func withdraw(
    _ amount: Int,
    fraudCheck: @escaping @Sendable () async throws -> Bool
  ) async throws -> Bool {
    guard amount > 0, balance >= amount else { return false }
    // BUG: actor reentrancy means another withdrawal can pass this same check while suspended.
    guard try await fraudCheck() else { return false }
    balance -= amount
    return true
  }
}
`;

const CALLBACK_SOURCE = `public enum ImageLoadError: Error, Sendable, Equatable { case failed }

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

  public init(legacy: any LegacyImageLoading) { self.legacy = legacy }

  public func image(_ key: String) async throws -> String {
    if let cached = cache[key] { return cached }
    // BUG: duplicate/late callbacks can resume twice; task cancellation is not bridged;
    // concurrent same-key requests start duplicate underlying work.
    let value: String = try await withCheckedThrowingContinuation { continuation in
      legacy.load(key) { result in continuation.resume(with: result) }
    }
    cache[key] = value
    return value
  }
}
`;

function runSwift(
  root: string,
  source: string,
  hiddenSource: string,
): { passed: boolean; evidence: string } {
  const selection = {
    developerDir: process.env.DEVELOPER_DIR,
    sdkRoot: process.env.SDKROOT,
  };
  const readiness = swiftRuntimeReadiness(selection);
  if (readiness.reasons.length) return { passed: false, evidence: readiness.reasons.join('\n') };
  const build = join(root, '.kory-hidden-swift');
  rmSync(build, { recursive: true, force: true });
  mkdirSync(build, { recursive: true });
  const hidden = '__KoryHidden.swift';
  writeFixtureFile(root, hidden, hiddenSource);
  const binary = join(build, 'hidden');
  try {
    return runSwiftProgram(
      root,
      [join(root, source), join(root, hidden)],
      binary,
      'KORY_SWIFT_OK',
      selection,
    );
  } finally {
    rmSync(join(root, hidden), { force: true });
    rmSync(build, { recursive: true, force: true });
  }
}

function swiftRegressionBody(root: string, path: string, required: RegExp[]): boolean {
  try {
    const source = readFileSync(join(root, path), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/\/\/.*$/gmu, ' ');
    const hasTestBody = /@Test\b|\bfunc\s+test\w*\s*\(|\bXCTAssert\w*\s*\(|#expect\s*\(/u.test(
      code,
    );
    return (
      hasTestBody &&
      required.every((pattern) => {
        pattern.lastIndex = 0;
        return pattern.test(code);
      })
    );
  } catch {
    return false;
  }
}

function scoreActor(root: string): SkillEvalDeterministicScore {
  const runtime = runSwift(
    root,
    'Sources/Account.swift',
    `
enum FraudFailure: Error { case deniedByService }

@main struct __KoryHidden {
  static func main() async throws {
    let account = Account(balance: 100)
    async let first = account.withdraw(70) { try await Task.sleep(for: .milliseconds(20)); return true }
    async let second = account.withdraw(70) { try await Task.sleep(for: .milliseconds(20)); return true }
    let pair = try await (first, second)
    let successes = [pair.0, pair.1].filter { $0 }.count
    let finalBalance = await account.currentBalance()
    if successes != 1 || finalBalance != 30 { fatalError("reentrant overdraft invariant") }

    let denied = Account(balance: 90)
    if try await denied.withdraw(40, fraudCheck: { false }) { fatalError("fraud denial accepted") }
    if await denied.currentBalance() != 90 { fatalError("denial did not restore reservation") }

    let failed = Account(balance: 80)
    do { _ = try await failed.withdraw(50) { throw FraudFailure.deniedByService }; fatalError("failure accepted") }
    catch FraudFailure.deniedByService {}
    if await failed.currentBalance() != 80 { fatalError("error did not restore reservation") }

    let cancelled = Account(balance: 75)
    let task = Task { try await cancelled.withdraw(60) { try await Task.sleep(for: .seconds(2)); return true } }
    try await Task.sleep(for: .milliseconds(20)); task.cancel()
    do { _ = try await task.value; fatalError("cancel returned success") }
    catch is CancellationError {}
    if await cancelled.currentBalance() != 75 { fatalError("cancel did not restore reservation") }
    print("KORY_SWIFT_OK")
  }
}
`,
  );
  const regression = swiftRegressionBody(root, 'Tests/AccountRegression.swift', [
    /concurrent|reentran|reservation/iu,
    /denial|error|cancel/iu,
  ]);
  const source = existsSync(join(root, 'Sources/Account.swift'))
    ? readFileSync(join(root, 'Sources/Account.swift'), 'utf8')
    : '';
  const noUnchecked = !/@unchecked\s+Sendable/u.test(source);
  const passed = runtime.passed && regression && noUnchecked;
  return {
    passed,
    quality: passed ? 1 : runtime.passed && noUnchecked ? 0.85 : runtime.passed ? 0.7 : 0,
    verification: runtime.passed ? 1 : 0,
    integrityFailure: false,
    evidence: [
      `Swift strict-concurrency actor checks: ${runtime.passed ? 'pass' : 'fail'}`,
      `regression coverage: ${regression ? 'present' : 'missing'}`,
      `unchecked Sendable escape hatch: ${noUnchecked ? 'absent' : 'present'}`,
      runtime.evidence,
    ],
  };
}

function scoreCallback(root: string): SkillEvalDeterministicScore {
  const runtime = runSwift(
    root,
    'Sources/ImageLoader.swift',
    `
import Foundation

final class Handle: ImageCancellation, @unchecked Sendable {
  private let lock = NSLock(); private var cancelled = false
  func cancel() { lock.lock(); cancelled = true; lock.unlock() }
  func isCancelled() -> Bool { lock.lock(); defer { lock.unlock() }; return cancelled }
}

final class FakeLegacy: LegacyImageLoading, @unchecked Sendable {
  struct Pending { let call: Int; let handle: Handle; let completion: @Sendable (Result<String, ImageLoadError>) -> Void }
  private let lock = NSLock(); private var pending: [String: [Pending]] = [:]; private var calls: [String: Int] = [:]
  func load(_ key: String, completion: @escaping @Sendable (Result<String, ImageLoadError>) -> Void) -> any ImageCancellation {
    let handle = Handle(); lock.lock(); calls[key, default: 0] += 1; pending[key, default: []].append(Pending(call: calls[key]!, handle: handle, completion: completion)); lock.unlock(); return handle
  }
  func callCount(_ key: String) -> Int { lock.lock(); defer { lock.unlock() }; return calls[key, default: 0] }
  func complete(_ key: String, _ call: Int, _ result: Result<String, ImageLoadError>, twice: Bool = false) {
    lock.lock(); let callback = pending[key]?.firstIndex(where: { $0.call == call }).map { pending[key]!.remove(at: $0) }; lock.unlock();
    if let callback { callback.completion(result); if twice { callback.completion(result) } }
  }
  func cancelled(_ key: String, _ call: Int = 1) -> Bool { lock.lock(); defer { lock.unlock() }; return pending[key]?.first(where: { $0.call == call })?.handle.isCancelled() ?? false }
}

@main struct __KoryHidden {
  static func main() async throws {
    let fake = FakeLegacy(); let loader = ImageLoader(legacy: fake)
    let one = Task { try await loader.image("one") }; try await Task.sleep(for: .milliseconds(10)); fake.complete("one", 1, .success("img-one"), twice: true)
    if try await one.value != "img-one" { fatalError("success") }
    if try await loader.image("one") != "img-one" || fake.callCount("one") != 1 { fatalError("cache") }

    let a = Task { try await loader.image("shared") }; let b = Task { try await loader.image("shared") }
    try await Task.sleep(for: .milliseconds(10)); if fake.callCount("shared") != 1 { fatalError("same-key dedupe") }
    fake.complete("shared", 1, .success("shared-image")); if try await (a.value, b.value) != ("shared-image", "shared-image") { fatalError("waiters") }

    let failed = Task { try await loader.image("bad") }; try await Task.sleep(for: .milliseconds(10)); fake.complete("bad", 1, .failure(.failed))
    do { _ = try await failed.value; fatalError("failure became success") } catch ImageLoadError.failed {}

    let cancelled = Task { try await loader.image("cancel") }; try await Task.sleep(for: .milliseconds(10)); cancelled.cancel(); try await Task.sleep(for: .milliseconds(20))
    if !fake.cancelled("cancel") { fatalError("legacy cancellation not bridged") }
    do { _ = try await cancelled.value; fatalError("cancel became success") } catch is CancellationError {}
    fake.complete("cancel", 1, .success("late"), twice: true)

    let staleFailure = Task { try await loader.image("retry-failure") }
    try await Task.sleep(for: .milliseconds(10)); staleFailure.cancel()
    do { _ = try await staleFailure.value; fatalError("cancelled flight returned") } catch is CancellationError {}
    try await Task.sleep(for: .milliseconds(20))
    let failureRetry = Task { try await loader.image("retry-failure") }
    try await Task.sleep(for: .milliseconds(10))
    if fake.callCount("retry-failure") != 2 { fatalError("retry reused cancelled flight") }
    fake.complete("retry-failure", 1, .failure(.failed), twice: true)
    try await Task.sleep(for: .milliseconds(10))
    fake.complete("retry-failure", 2, .success("fresh-after-failure"))
    if try await failureRetry.value != "fresh-after-failure" { fatalError("stale failure poisoned retry") }

    let staleCancellation = Task { try await loader.image("retry-cancellation") }
    try await Task.sleep(for: .milliseconds(10)); staleCancellation.cancel()
    do { _ = try await staleCancellation.value; fatalError("cancelled stale flight returned") } catch is CancellationError {}
    try await Task.sleep(for: .milliseconds(20))
    let cancellationRetry = Task { try await loader.image("retry-cancellation") }
    try await Task.sleep(for: .milliseconds(10))
    if fake.callCount("retry-cancellation") != 2 { fatalError("cancelled retry was not a new flight") }
    fake.complete("retry-cancellation", 1, .success("stale"), twice: true)
    try await Task.sleep(for: .milliseconds(10))
    fake.complete("retry-cancellation", 2, .success("fresh-after-cancellation"))
    if try await cancellationRetry.value != "fresh-after-cancellation" { fatalError("stale cancellation completed retry") }

    let continuing = Task { try await loader.image("shared-waiter") }
    try await Task.sleep(for: .milliseconds(10))
    let cancelledWaiter = Task { try await loader.image("shared-waiter") }
    try await Task.sleep(for: .milliseconds(10))
    if fake.callCount("shared-waiter") != 1 { fatalError("waiters did not share flight") }
    cancelledWaiter.cancel()
    do { _ = try await cancelledWaiter.value; fatalError("cancelled waiter returned") } catch is CancellationError {}
    try await Task.sleep(for: .milliseconds(20))
    if fake.cancelled("shared-waiter") { fatalError("cancelled waiter cancelled shared flight") }
    fake.complete("shared-waiter", 1, .success("shared-after-one-cancel"))
    if try await continuing.value != "shared-after-one-cancel" { fatalError("continuing waiter did not finish") }
    try await Task.sleep(for: .milliseconds(10));
    print("KORY_SWIFT_OK")
  }
}
`,
  );
  const regression = swiftRegressionBody(root, 'Tests/ImageLoaderRegression.swift', [
    /duplicate|late|continuation|once/iu,
    /cancel|concurrent|same.?key|cache/iu,
    /retry|stale|flight/iu,
    /waiter|shared|continuing/iu,
  ]);
  const source = existsSync(join(root, 'Sources/ImageLoader.swift'))
    ? readFileSync(join(root, 'Sources/ImageLoader.swift'), 'utf8')
    : '';
  const noUnchecked = !/@unchecked\s+Sendable/u.test(source);
  const passed = runtime.passed && regression && noUnchecked;
  return {
    passed,
    quality: passed ? 1 : runtime.passed && noUnchecked ? 0.85 : runtime.passed ? 0.7 : 0,
    verification: runtime.passed ? 1 : 0,
    integrityFailure: false,
    evidence: [
      `Swift callback/cancellation checks: ${runtime.passed ? 'pass' : 'fail'}`,
      `regression coverage: ${regression ? 'present' : 'missing'}`,
      `unchecked Sendable escape hatch: ${noUnchecked ? 'absent' : 'present'}`,
      runtime.evidence,
    ],
  };
}

export const SWIFT_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] = [
  {
    id: 'swift-engineering/actor-reentrancy-reservation@1',
    realRuntime: true,
    get readinessBlockers() {
      return swiftRuntimeReadiness().reasons;
    },
    matches: (scenario) => scenario.id === ACTOR,
    materialize: (root) => {
      writeFixtureFile(root, 'Sources/Account.swift', ACTOR_SOURCE);
      writeFixtureFile(
        root,
        'Tests/AccountRegression.swift',
        '// Add concurrent reentrancy/reservation plus fraud denial, error, timeout, and cancellation regressions.\n',
      );
      writeFixtureFile(
        root,
        'README.md',
        '# Swift actor reentrancy\n\nFix Account.withdraw under Swift 6 strict concurrency. Do not hold a blocking lock across network work. Reserve or otherwise make the balance transition explicit before suspension and restore it on denial, error, or cancellation. Avoid @unchecked Sendable.\n',
      );
    },
  },
  {
    id: 'swift-engineering/callback-continuation-lifetime@2',
    realRuntime: true,
    get readinessBlockers() {
      return swiftRuntimeReadiness().reasons;
    },
    matches: (scenario) => scenario.id === CALLBACK,
    materialize: (root) => {
      writeFixtureFile(root, 'Sources/ImageLoader.swift', CALLBACK_SOURCE);
      writeFixtureFile(
        root,
        'Tests/ImageLoaderRegression.swift',
        '// Add duplicate/late callback exactly-once, cancellation bridging, concurrent same-key/cache, failure/retry stale-flight, and independent waiter cancellation regressions.\n',
      );
      writeFixtureFile(
        root,
        'README.md',
        '# Swift callback bridge\n\nFix ImageLoader under Swift 6 strict concurrency. Bridge Task cancellation to the legacy cancellation handle, prevent duplicate/late callbacks from resuming a continuation twice, deduplicate concurrent same-key loads, keep an old failed or cancelled flight from clearing or completing a same-key retry, let one cancelled waiter leave a continuing waiter alive, cache only successful live results, and avoid @unchecked Sendable in candidate code.\n',
      );
    },
  },
];

export const SWIFT_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  {
    id: 'swift-engineering/actor-reentrancy-reservation-scorer@2',
    scenarioIds: [ACTOR],
    score: ({ workingDirectory }) => scoreActor(workingDirectory),
  },
  {
    id: 'swift-engineering/callback-continuation-lifetime-scorer@2',
    scenarioIds: [CALLBACK],
    score: ({ workingDirectory }) => scoreCallback(workingDirectory),
  },
];
