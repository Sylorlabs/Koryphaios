---
name: ruby-engineering
description: Engineer Ruby systems with explicit object boundaries, dependency behavior, metaprogramming restraint, and runtime observability. Use when the request specifically requires ruby, bundler, rake task, ruby gem; prefer a narrower child only when its boundary is established.
---

# Ruby Engineering

## Boundary

Confirm Ruby and gem versions, runtime entry points, dependency ownership, mutation patterns, and concurrency assumptions. Prefer explicit objects and messages over hidden metaprogramming, keep monkey patches narrowly scoped, and distinguish Ruby core behavior from Rails or ActiveSupport behavior.

## Hierarchy and routing

- Broader skills: implementation.
- No narrower bundled child is declared.
- Required skills: verification.

Use this skill when Ruby runtime, gems, Bundler, Rake, exception flow, or Ruby concurrency is material. Rails conventions are conditional on Rails actually being in scope. Quoted, historical, negated, fixture-only, or example text is not a live trigger.

## Decisions that change the implementation

- Rescue the narrow exception class the operation can handle. Bare `rescue` targets `StandardError`; rescuing `Exception` also catches control-flow and system exceptions that usually should escape.
- Put must-run cleanup in `ensure`. Treat `retry` as a loop with an explicit stopping condition because it restarts the protected `begin` body.
- Give spawned threads an owner that joins, stops, or otherwise accounts for them. The main process can exit while unjoined threads still have work.
- Treat a lazy streaming response as part of the request lifecycle. Keep request context available until the body has been consumed or explicitly closed, then clear it in the same guaranteed cleanup boundary; clearing it immediately after returning an Enumerator makes deferred work observe the wrong identity. Verify cleanup after normal, exceptional, and abandoned or closed streams without creating a thread per request.
- Use `Queue` or another synchronization primitive for cross-thread producer-consumer state instead of assuming ordinary array or hash mutation is coordinated.
- Keep monkey patches and refinements bounded to the intended runtime surface, and do not depend on incidental load order.

## Failure discriminators

- If an exception disappears, inspect rescue class, re-raise behavior, and `ensure` before adding logging wrappers.
- If a job or CLI exits while background work is incomplete, inspect thread ownership and joins before increasing sleeps.
- If a concurrency bug disappears under logging, distinguish shared mutable state, queue ownership, and scheduling from pure timing.
- If a library works only inside Rails, identify the implicit ActiveSupport or framework extension before adding it to the library contract.

## Verification at the Ruby boundary

Treat request context as owned by the request, not the reusable thread. Clear it through `ensure` on success and exception, and bind deferred stream work to explicit context instead of leaked thread locals. When keyword behavior changes, preserve each supported positional hash and keyword call shape through forwarding and subclasses; test defaults and unknown options under the declared Ruby version. Retain these as executable Ruby regressions, not only comments describing cases.

- Run the configured tests under the supported Ruby version or versions affected by the change.
- Exercise handled and unhandled exception paths plus `ensure` cleanup when exception flow changes.
- For thread changes, verify completion and shutdown with representative producer-consumer load.
- For request-context changes, exercise deferred stream consumption and stream close/abandonment on a reused worker, as well as exceptions before and after authorization. The regression must execute on the same worker when that is the behavior under test; a newly created thread is not equivalent evidence.
- Verify transaction rollback, time, encoding, or nil behavior only when those boundaries are materially changed.
- Reproduce gem and Bundler behavior from the committed dependency state rather than an incidental local gem set.

## Completion evidence

- Ruby and gem version, exception, mutation, and concurrency assumptions affected
- Runtime evidence for exception cleanup or thread ownership when those paths changed
- Dependency-state evidence for Bundler or gem behavior

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
