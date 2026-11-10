# iOS SwiftUI native evaluator qualification plan

Status on 2026-10-20: **native evaluator calibrated and registered; skill
qualification remains unclaimed**.

This plan covers only `ios-swiftui-full-task-1-individual` and
`ios-swiftui-full-task-2-individual`. Their source contracts are
`skills-v5/ios-swiftui/evals/tasks/scenario-{1,2}.json`.
The native materializers and deterministic scorers now precede the historical
external-environment gates in the shared registry. The external gates remain
as historical fallbacks. Registration does not claim a skill/no-skill quality
or promotion result; the separate paired blind evaluation remains required.

## Confirmed environment and evidence

- Xcode 27.0, Swift 6.4, and the iOS 27.0 Simulator SDK were selected by the
  caller-scoped developer directory. Readiness returned no blockers for both
  scenarios on the pinned booted simulators: iPhone navigation target
  `4ADB02EE-1CC6-4433-909A-1B1F247FA068` and iPad multiwindow target
  `331D33CB-8128-48E8-AC93-76D36ED2123B`.
- Developer-directory resolution is intentionally caller scoped and ordered as
  `KORY_IOS_EVAL_DEVELOPER_DIR`, then `DEVELOPER_DIR`, then the runtime's
  platform default. Every Xcode and `simctl` invocation receives the selected
  value, so an unrelated process-wide `DEVELOPER_DIR` cannot replace the
  explicit evaluator selection.
- The authorized evidence is under
  `.koryphaios/evidence/ios-swiftui-20261020-summary.md` and
  `.koryphaios/evidence/ios-swiftui-optin-20261020/`. It records the actual
  Xcode result bundles, Apple test trees, attachment manifests, PNG hashes,
  and the independent iPad disk oracle.
- The native opt-in runtime test recorded **10 passed, 0 failed, 0 skipped,
  76 assertions**. The iPhone defective control failed the intended
  `stale-response-overwrote-B` assertion and its repaired full suite passed.
  The iPad defective control failed the intended
  `global-draft-leaked-across-scenes` assertion and its repaired full suite
  passed, including process restoration and the host disk oracle.
- These are evaluator calibration controls, not a qualification campaign.
  They do not establish a paired skill/no-skill quality or promotion result.

## Implemented fixture structure

The following structure is now present and is checked before every native run:

1. Introduce `backend/src/kory/fixtures/ios-swiftui-v5/` with a pinned
   Xcode project, SwiftUI application target, real XCUITest target, fixed
   scenario injector, fixture-specific persistence, and two intentionally
   defective candidate files: `DetailFeature.swift` and
   `DocumentFeature.swift`. Include separately versioned **repaired controls**
   used solely in red/green verification. The candidate workspace must not
   contain evaluator tests or repaired controls.
2. Materialize a per-scenario project plus
   `.kory-eval/ios-swiftui-native-contract.json` specifying the original
   scenario ID, `native-interface` parent, scenario-1 neighbor
   `android-compose`, scenario-2 neighbor `desktop-electron-tauri`, supported
   OS/SDK, and explicit separate paired-evaluation requirement. Preserve
   stable navigation/document IDs across runs.
3. Implement `backend/src/kory/skill-eval-ios-swiftui-runtime.ts` with
   readiness, materializer, and deterministic scorer exports matching
   the existing skill-eval contracts. Copy only allowlisted candidate Swift
   source into a freshly generated **evaluator-owned** build project. Pin and
   hash the Xcode configuration, app entry point, injection hooks, test
   implementation, and contract before any native run. Reject symlinks,
   hidden test replacements, out-of-tree paths, excessive file counts,
   forged run receipts, and modifications to fixed files.
4. Require caller-selected, **already booted** simulator UDIDs, one iPhone
   and one multiwindow-capable iPad. Refuse ambiguous `booted` selectors,
   unmatched OS versions, missing Xcode tools, or a failed XCTest smoke.
   Never boot, erase, or reconfigure another person's simulator implicitly.

## Scenario 1: navigation, cancellation, lifecycle

Build an actual `NavigationStack` with two stable detail IDs, deterministic
controllable async requests, and a test-owned transport that can deliberately
ignore or delay cancellation. The starting implementation must reproduce a
late first-request completion overwriting the second detail. Correct source
should tie loading to the current detail identity (for example a task with
an `id` dependency) **and** reject stale completion even if upstream work
ignores cancellation. Cancellation must be observable without assuming the
loader always cooperates.

The independent XCUITest suite must fail the defective implementation and
pass the corrected control on an actual iPhone simulator for **all** of:

| Phase             | Required observable assertion                                                                                                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Navigation race   | Visit A, immediately move to B, release B first and A last; only B can own the displayed content and its accessibility semantics.                                                                     |
| Cancel/revisit    | Pop to the list while A is pending; its completion cannot update a subsequent A or B instance. Revisit with a new request generation.                                                                 |
| Offline and retry | Inject network-unavailable error; accessible error and retry controls appear; retry succeeds after transport recovery without inheriting a stale result.                                              |
| Lifecycle         | Press Home, reactivate the app, and deliver delayed responses around background/foreground transitions. Check scene phase and navigation identity, including restoration after a controlled relaunch. |
| Accessibility     | Query actual XCTest accessibility tree for loading, error, retry, and content labels/values/traits; inspect focus behavior with keyboard and content-size changes to an accessibility category.       |

Capture diagnostics and rendered screenshots from the simulator associated
with each phase. A source-level assertion, an invented event trace, or a
screen image without the corresponding live XCTest assertion is inadequate.
XCTest accessibility labels establish VoiceOver-facing semantics but do not
by themselves prove spoken VoiceOver output or traversal; record that
limitation or independently verify assistive-technology behavior.

## Scenario 2: actual concurrent iPad scenes

Build a native iPad `WindowGroup(for:)` or `DocumentGroup` fixture. Two
distinct document IDs must be open **simultaneously in separate real scene
sessions**. Provide evaluator-owned versioned document storage, an undo
operation ledger, save-failure injection, and per-scene presentation/focus
state. Begin from the defective global singleton draft and supply a control
where durable state is keyed by document identity, transient focus/selection
is scene-owned, and undo registrations have the intended document scope.

The independent XCTest suite must verify:

| Phase                  | Required observable assertion                                                                                                                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two real scenes        | Both windows are concurrently represented in the iPad scene list and the XCTest UI hierarchy; editing document A cannot change B's draft, window title, undo, or accessibility value.                |
| Autosave and undo      | Persist A, edit B, undo B, and confirm A's durable revision and both visible drafts remain correctly separated.                                                                                      |
| Failed save            | Reject a real controlled disk-store save, show an accessible error/dirty state without pretending to persist, then retry and verify the expected revision.                                           |
| Scene discard/reopen   | Close one actual window/session, keep the other live, reopen the original document by stable ID, and verify independent restoration and focus.                                                       |
| Process termination    | Kill the **fixture app process**, not the simulator, relaunch, reopen both documents, and compare contents with the independent disk store. Distinguish document recovery from ephemeral view state. |
| Keyboard/accessibility | Exercise focus transfer between two real windows, text editing and undo, a large Dynamic Type category, and per-window labels/values/traits without a global state leak.                             |

Fail closed if the test can only swap tabs or simulated scene IDs inside a
single window, if XCTest cannot enumerate and interact with both windows, or
if persistence checks only read the app's mutable in-memory singleton. The
evaluator may use a fixed test-owned document oracle in a separate process
or persisted store, but it must not rely on candidate-provided success logs.

## Runner and native evidence

- Build and run the evaluator-controlled application and XCUITest using
  `xcodebuild test -project <project> -scheme <scheme>
-destination 'platform=iOS Simulator,id=<pinned-UDID>'
-parallel-testing-enabled NO -derivedDataPath <isolated-dir>
-resultBundlePath <isolated.xcresult>` with the chosen `DEVELOPER_DIR`.
  Enforce command timeouts and isolate bundle IDs, DerivedData, and documents
  for each candidate; never clear a user's simulator or unrelated app data.
- Parse `xcrun xcresulttool get test-results summary --path
<isolated.xcresult>` and per-test details. Require exactly the expected
  XCTest test IDs and successful completed results, the expected device/OS,
  no skipped tests, no crash, and a successful native command status. Validate
  screenshots as real PNGs captured from the relevant live simulator run;
  preserve their hashes and paths with the associated XCTest evidence.
- Assert a **red/green pair on the same pinned simulator** for each scenario:
  defective starter fails the intended behavioral assertions; verified
  repair passes all of them. Reject forged `** TEST SUCCEEDED **` stdout,
  fake `.xcresult` files, swapped test bundles, missing accessibility nodes,
  and a one-window UI dressed as a multiwindow app.
- Capture and restore any simulator content-size/appearance setting changed
  for testing, even on failures. Treat restoration failure as a reported
  cleanup failure. Avoid implicit simulator boot/erase, forced global UI
  settings changes, and physical-device claims.
- Return `passed=true` or nonzero native verification only when every
  required phase and integrity check completes. A build success, test
  discovery success, or screenshot alone must score zero native completion.
  Include explicit limitations for real VoiceOver speech, physical keyboard,
  sensors, notifications, entitlements, and any unexercised hardware behavior.

## Promotion and regression criteria

The independent tests in
`backend/src/kory/__tests__/skill-eval-ios-swiftui-runtime.test.ts` cover
missing Xcode/UDID fail-closed behavior, immutable-file tampering, fake
receipts, native `.xcresult` parsing, and the real red/green iPhone and iPad
controls now pass. The registration test verifies that the first matching
materializer and scorer for each scenario are the native entries, while the
historical gates remain available after them, and verifies the `@2` IDs. A
distinct paired same-model skill/no-skill
comparison with identical starting snapshots and blind review is still
mandatory before claiming the full evaluation's quality or promotion outcome;
do not write a ledger or launch a campaign as part of this evaluator task.

## Reproducible scoped setup

The examples below require the caller to supply paths and identifiers. They do
not select, boot, erase, or reconfigure a simulator:

```sh
export IOS_XCODE_DEVELOPER_DIR="${IOS_XCODE_DEVELOPER_DIR:?set this to an Xcode 27 Developer directory}"
export KORY_IOS_EVAL_DEVELOPER_DIR="$IOS_XCODE_DEVELOPER_DIR"
export DEVELOPER_DIR="${DEVELOPER_DIR:-$IOS_XCODE_DEVELOPER_DIR}"
export KORY_IOS_EVAL_IPHONE_UDID="${KORY_IOS_EVAL_IPHONE_UDID:?set an already-booted iOS 27 iPhone UDID}"
export KORY_IOS_EVAL_IPAD_UDID="${KORY_IOS_EVAL_IPAD_UDID:?set an already-booted iOS 27 iPad UDID}"

bun test \
  backend/src/kory/__tests__/skill-eval-ios-swiftui-registration.test.ts \
  backend/src/kory/__tests__/skill-eval-ios-swiftui-runtime.test.ts
```

The native controls are opt-in and coordinator-owned because they build and
launch real applications. When a fresh authorized calibration is required,
the scoped form is:

```sh
KORY_IOS_EVAL_NATIVE_TESTS=1 \
TMPDIR="$PWD/.koryphaios/evidence/<run-id>" \
bun test backend/src/kory/__tests__/skill-eval-ios-swiftui-runtime.test.ts \
  --reporter=junit \
  --reporter-outfile="$PWD/.koryphaios/evidence/<run-id>/runtime-tests.junit.xml"
```

The recorded 2026-10-20 evidence, rather than a repeat native run in this
task, is the readiness proof for the current registration.

## Current test boundary and remaining blockers

- Registration and non-native runtime checks pass with the native entries
  selected for both scenarios. The native evidence bundle's JUnit receipt
  reports 10 passed, 0 failed, and 0 skipped.
- The current registration is not a qualification result. A coordinator-owned
  paired same-model skill/no-skill run with identical starting snapshots and
  blind review is still an external blocker to any quality or promotion claim.
- The demonstrated native boundary remains simulator XCTest accessibility and
  rendering. Spoken VoiceOver, manual traversal, a physical keyboard or
  device, sensors, notifications, entitlements, and other unexercised hardware
  behavior remain outside the evidence.
