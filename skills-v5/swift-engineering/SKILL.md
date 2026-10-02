---
name: swift-engineering
description: Engineer Swift systems with value semantics, actor isolation, async lifecycles, package boundaries, and Apple runtime constraints. Use when the request specifically requires swift language, swift package, swift concurrency, swift actor; prefer a narrower child only when its boundary is established.
---

# Swift Engineering

## Boundary

Choose value versus reference semantics intentionally, preserve `Sendable` and actor isolation, model ownership around ARC, and treat task cancellation as API behavior. Inspect Swift language mode, platform availability, package products, Codable compatibility, and Objective-C interoperability before changing public interfaces.

## Hierarchy and routing

- Broader skills: implementation.
- No narrower bundled child is declared.
- Required skills: verification.

Use this skill for Swift language, package, ARC, actor, and concurrency behavior. Use `ios-swiftui` alongside it only when Apple UI lifecycle is also material. Quoted, historical, negated, fixture-only, or example text is not a live trigger.

## Decisions that change the implementation

- Choose structs for value identity and classes when shared reference identity or inheritance is actually required. Do not switch semantics merely to satisfy mutation convenience.
- Treat actor isolation and `Sendable` as concurrency contracts. Avoid `@unchecked Sendable` until the type's synchronization invariant is explicit and reviewed.
- Model closure captures under ARC. Use weak references when the referenced object may validly disappear and unowned only when the lifetime relationship guarantees the reference remains valid.
- Treat task cancellation as cooperative. Check cancellation at meaningful boundaries and keep cleanup valid if a task stops after partial progress.
- Resolve Swift language mode, package tools version, and platform availability before adopting concurrency or API behavior that changes by toolchain.

## Failure discriminators

- If an object never deinitializes, inspect strong closure and delegate or ownership cycles before adding manual teardown.
- If concurrency warnings appear only in a newer language mode, identify the real isolation or sendability boundary before suppressing diagnostics.
- If a task continues after its caller is gone, inspect task ownership and cancellation propagation before adding global flags.
- If host tests pass but platform behavior fails, separate Swift semantics from Apple framework, entitlement, runtime, or device behavior.

## Verification at the Swift boundary

- Run the supported Swift Package or Xcode test path under affected toolchain and language modes.
- Exercise actor-isolated mutation from the intended callers and test cancellation after partial progress for changed async APIs.
- Verify ARC-sensitive objects release in the expected lifecycle when capture ownership changes.
- Test Codable or Objective-C interop with representative existing consumers when those public contracts change.
- Use the actual supported Apple platform for framework or device claims that host-only Swift tests cannot establish.

## Completion evidence

- Swift language mode, ownership, isolation, and public-contract assumptions affected
- Cancellation, actor, and ARC evidence when those boundaries changed
- Platform or existing-consumer evidence when package, Codable, Objective-C, or Apple API behavior is claimed

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
