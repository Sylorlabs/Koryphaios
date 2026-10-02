---
name: ios-swiftui
description: Engineer iOS and SwiftUI applications with state ownership, navigation, lifecycle, concurrency, accessibility, and platform conventions. Use when the request specifically requires swiftui, ios app, uikit ios, ios navigation; prefer a narrower child only when its boundary is established.
---

# Ios Swiftui

## Boundary

Model source-of-truth state, environment dependencies, navigation identity, scene lifecycle, task cancellation, persistence, and UIKit bridges explicitly. SwiftUI view state follows view lifetime and is not automatically durable application storage. Use platform controls and accessibility semantics unless a custom interaction has a demonstrated requirement.

## Hierarchy and routing

- Broader skills: native-interface.
- No narrower bundled child is declared.
- Required skills: verification.

Use this skill when the live task is specifically iOS, SwiftUI, UIKit integration, or Apple mobile lifecycle. Use `swift-engineering` alongside it when the core problem is language or concurrency semantics rather than UI lifecycle. Quoted, historical, negated, fixture-only, or example text is not a live trigger.

## Decisions that change the implementation

- Place mutable UI state at the lowest stable owner shared by the views that need it. Do not duplicate a source of truth solely to simplify binding.
- Distinguish transient view state from durable model or persistence state. Recreating a view may legitimately recreate its local state.
- Give navigation destinations stable model identity. Avoid using transient view position or newly generated IDs as restoration identity.
- Tie asynchronous work to an owner whose lifecycle matches the work and handle cancellation when that owner disappears.
- Respect safe areas, Dynamic Type, localization, reduced motion, focus behavior, and VoiceOver semantics before replacing a platform control with a custom surface.

## Failure discriminators

- If state resets unexpectedly, determine whether the view identity changed, the owner moved, or persistence was incorrectly assumed before adding a global store.
- If navigation duplicates or pops unexpectedly, inspect destination identity and path mutation before rewriting the navigation stack.
- If work continues after leaving a screen, inspect task ownership and cancellation before adding manual flags.
- If behavior differs only on device, isolate hardware, entitlement, permission, background execution, and UIKit bridge assumptions from pure SwiftUI state.

## Verification at the iOS boundary

- Exercise cold launch, background and foreground transitions, and the relevant `scenePhase` changes when lifecycle is material.
- Test navigation restoration and repeated presentation for identity-sensitive changes.
- Verify keyboard and focus, large Dynamic Type sizes, and accessibility semantics for changed interactions.
- Use a physical device for camera, sensors, push, background modes, or other hardware and entitlement claims. Simulator evidence is sufficient only for behavior it faithfully implements.
- Cover permission denial and offline or interrupted state where the changed feature depends on them.

## Completion evidence

- State and navigation ownership affected by the change
- Lifecycle and accessibility evidence for the changed interaction
- Device evidence for hardware, entitlement, permission, or background claims, with device-only gaps stated explicitly

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
