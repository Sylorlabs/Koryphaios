---
name: kotlin-engineering
description: Engineer Kotlin systems with null-safety, coroutine structure, Java interoperability, and stable data contracts. Use when the request specifically requires kotlin, kotlin coroutine, ktor, gradle kotlin; prefer a narrower child only when its boundary is established.
---

# Kotlin Engineering

## Boundary

Use Kotlin nullability and sealed types to represent real domain states rather than relying on `!!` or sentinel values. Keep coroutine scope ownership, dispatcher choice, cancellation, Flow collection lifetime, Java interop, and target platform explicit. A data class is convenient syntax, not automatically a stable persistence or wire contract.

## Hierarchy and routing

- Broader skills: implementation.
- No narrower bundled child is declared.
- Required skills: verification.

Use this skill when Kotlin language semantics, coroutines, Flow, Java interop, or Kotlin target behavior is material. Use Java JVM guidance alongside it only when the shared JVM boundary is actually part of the task. Quoted, historical, negated, fixture-only, or example text is not a live trigger.

## Decisions that change the implementation

- Give coroutine work a scope whose owner matches the required lifetime. Avoid `GlobalScope` for work that should end with a request, component, screen, or service.
- Preserve structured cancellation and failure propagation unless the product requires an explicitly supervised child failure boundary.
- Choose dispatchers from the nature of the work and the runtime target. Do not solve blocking work by scattering dispatcher switches without identifying the blocking boundary.
- Collect Flow from a lifecycle that can stop collection. A hot stream and a cold stream have different ownership and replay implications.
- Treat Kotlin/JVM, Kotlin/Native, and Kotlin/JS behavior separately when target-specific APIs, concurrency, or interop is involved.

## Failure discriminators

- If child work survives its caller, inspect scope ownership before adding explicit cancellation flags.
- If cancellation does not stop a pipeline, identify blocking calls, swallowed cancellation, unstructured work, and Flow operators that change lifetime.
- If failures disappear when changing dispatcher, distinguish thread confinement, blocking, race, and test-scheduler assumptions.
- If Java callers observe a different API than Kotlin callers, inspect nullability metadata, generated overloads, default arguments, and interop annotations.

## Verification at the Kotlin boundary

- Run the configured checks for every affected target, not only Kotlin/JVM when the project is multiplatform.
- Test coroutine success, parent cancellation, child failure, and cleanup for changed structured-concurrency boundaries.
- Verify Flow collection stops at the intended owner lifecycle and does not duplicate work unexpectedly after restart.
- Compile or test representative Java callers when a public JVM API changes.
- Record any target-specific behavior instead of presenting one target's result as universal Kotlin behavior.

## Completion evidence

- Coroutine scope, cancellation, Flow, and target assumptions affected
- Target-specific test evidence for the changed behavior
- Java interop evidence when the public JVM surface changes

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
