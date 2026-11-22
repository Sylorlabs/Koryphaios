---
name: ios-swiftui
description: Engineer iOS and SwiftUI applications with state ownership, navigation, lifecycle, concurrency, accessibility, and platform conventions. Use when the request specifically requires swiftui, ios app, uikit ios, ios navigation; prefer a narrower child only when its boundary is established.
---

# Ios Swiftui

## Boundary

Model the source of truth for state, along with environment dependencies, navigation identity, scene lifecycle, task cancellation, persistence, and UIKit bridges explicitly. SwiftUI view state follows view lifetime and is not automatically durable application storage. Use platform controls and accessibility semantics unless a custom interaction has a demonstrated requirement.

## Hierarchy and routing

- Broader skills: native-interface.
- No narrower bundled child is declared.
- Required skills: verification.

Use this skill when the live task is specifically iOS, SwiftUI, UIKit integration, or Apple mobile lifecycle. Use `swift-engineering` alongside it when the core problem is language or concurrency semantics rather than UI lifecycle. Quoted, historical, negated, fixture only, or example text is not a live trigger.

## Decisions that change the implementation

- Place mutable UI state at the lowest stable owner shared by the views that need it. Do not duplicate a source of truth solely to simplify binding.
- Distinguish transient view state from durable model or persistence state. Recreating a view may legitimately recreate its local state.
- Give navigation destinations stable model identity. Avoid using transient view position or newly generated IDs as restoration identity.
- Tie asynchronous work to an owner whose lifecycle matches the work and handle cancellation when that owner disappears.
- Respect safe areas, Dynamic Type, localization, reduced motion, focus behavior, and VoiceOver semantics before replacing a platform control with a custom surface.

## Navigation and asynchronous detail state

- For a `NavigationStack` detail identified by a stable model ID, use a `.task(id: itemID)` scoped to identity or an explicitly cancelled owned task instead of launching detached loads in `onAppear` or `body`. Revisit, back navigation, and changing IDs must invalidate the previous request; a retry must issue a fresh generation.
- Cancellation is cooperative: an HTTP client or fake delayed loader may still return after cancellation. Capture the requested ID and a generation/token; on the main actor, verify the task was not cancelled **and** that the captured ID/generation still owns the displayed state before publishing success or error. Never let an old success overwrite the new screen, or an old failure clear its loading state.
- Compile against the iOS simulator SDK, not the host macOS toolchain. SwiftUI and UIKit types resolve only through `xcodebuild -scheme <scheme> -destination 'platform=iOS Simulator,id=<UDID>' build`, or through `swiftc -sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" -target arm64-apple-ios18.0-simulator`. A bare `swiftc` or `swift build` compiles against the macOS SDK and fails on correct SwiftUI code with missing modules, which reads as a defect that is not there.
- Edit only the sources the task names. A second feature's source and every fixture support file or test bundle belong to the evaluator: reading them is fine, and writing them invalidates the whole run even when the change looks harmless. When a macro expansion or a sandbox flag blocks the build, change the invocation and build in a scratch directory instead of editing a shared file.
- A failing build or a failing XCTest oracle means the delivery is unfinished. Do not offer a typecheck failure as a caveat beside a claimed fix: either the pinned simulator build and its native test run pass, or the change is incomplete and must say so.
- Model loading, success, offline error, and retry as explicit states with current item identity. Restore only stable, serializable navigation identity after process relaunch; reload transient data and do not resurrect a cancelled task. Verify accessibility labels and focus in loading/error/recovered states, not just the happy path.

## Document and scene ownership

- For a multiwindow editor, place the editable draft and focus/selection state inside the owning `WindowGroup`/document scene, with the document ID as its stable identity. A global singleton may coordinate immutable shared metadata or persistence, but cannot own one mutable draft, pending save, focus target, or undo history for every window.
- Keep durable document content and revision records in a store keyed by document (`DocumentGroup`/`FileDocument` or an equally explicit persistence boundary). Serialize saves for the same document, commit atomically where feasible, and preserve a dirty draft and actionable error when disk writes fail. Reopen a discarded scene from its own persisted document; do not infer durability from `@State`, `@SceneStorage`, or an in memory singleton.
- Scope undo operations to the correct document/scene and record the state transitions they invert; undo in one window must never mutate another document. Confirm concurrent scenes keep independent draft, undo, focus, autosave, and recovery lifecycles, including after process termination.

## Failure discriminators

- If state resets unexpectedly, determine whether the view identity changed, the owner moved, or persistence was incorrectly assumed before adding a global store.
- If navigation duplicates or pops unexpectedly, inspect destination identity and path mutation before rewriting the navigation stack.
- If work continues after leaving a screen, inspect task ownership and cancellation before adding manual flags.
- If behavior differs only on device, isolate hardware, entitlement, permission, background execution, and UIKit bridge assumptions from pure SwiftUI state.

## Verification at the iOS boundary

- Exercise cold launch, background and foreground transitions, and the relevant `scenePhase` changes when lifecycle is material.
- Test navigation restoration and repeated presentation for changes that are sensitive to identity.
- Verify keyboard and focus, large Dynamic Type sizes, and accessibility semantics for changed interactions.
- Use a physical device for camera, sensors, push, background modes, or other hardware and entitlement claims. Simulator evidence is sufficient only for behavior it faithfully implements.
- Cover permission denial and offline or interrupted state where the changed feature depends on them.
- For cancellation bugs, deliberately finish the older request after navigating to a newer ID; assert that its data, error, and loading transitions are ignored. Repeat after cancellation/revisit, app background/foreground, and recovery from offline to retry.
- For document bugs, open two actual iPad windows, edit and undo separately, inject save failure, discard/reopen one scene, terminate/relaunch the process, and independently check persisted document bytes/revisions. Exercise hardware keyboard focus and large Dynamic Type in each window.
- Preserve native simulator identity, Xcode build/test result bundles, per test status and attached rendered captures when claiming native interaction. XCTest accessibility tree checks do not by themselves prove spoken VoiceOver output; distinguish these claims explicitly.

## Completion evidence

- State and navigation ownership affected by the change
- Lifecycle and accessibility evidence for the changed interaction
- Device evidence for hardware, entitlement, permission, or background claims, with device only gaps stated explicitly

Use [the maintained source map](references/sources.md) for version sensitive facts and source conflicts.
