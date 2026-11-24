---
name: php-engineering
description: Engineer PHP applications and libraries with type, request lifecycle, dependency, persistence, and runtime-version discipline. Use when the request specifically requires php, composer package, phpstan, laravel php; prefer a narrower child only when its boundary is established.
---

# Php Engineering

## Boundary

Confirm PHP target versions, Composer constraints, request lifecycle, autoloading, strict typing policy, framework container scope, and persistence boundaries. Distinguish behavior at the language level from framework conveniences and from persistent worker behavior.

## Hierarchy and routing

- Broader skills: implementation.
- No narrower bundled child is declared.
- Required skills: verification.

Use this skill when PHP language, Composer, request or worker lifecycle, or PHP runtime version is material. Behavior specific to Laravel applies only when Laravel is actually present. Quoted, historical, negated, fixture, or example text is not a live trigger.

## Decisions that change the implementation

- Resolve supported PHP versions and Composer constraints before using language features or changing dependency ranges.
- Remember that `strict_types` is declared per calling file. A callee cannot assume all callers use strict scalar coercion rules merely because its own file declares strict types.
- At JSON boundaries, distinguish an absent object key (`array_key_exists` for associative arrays or `property_exists` for objects) from an explicitly present `null` (`=== null`). Associative decoding can collapse `{}` and `[]` into the same PHP value, so preserve root object versus array identity where the contract distinguishes them. `??`, `isset`, `empty`, and loose comparisons merge input states and can silently change public error codes. Validate decoded `mixed` values before constructing typed DTOs; `strict_types` does not validate JSON fields for you.
- Establish the API's numeric string policy from its documented error contract before accepting or rejecting `"0"`, `"42"`, or other quoted numbers. Distinguish a quoted JSON string from a JSON numeric token; `JSON_BIGINT_AS_STRING` converts overflowing unquoted integers to PHP strings, so preserve token provenance or use a safe overflow strategy when their error codes differ. Reject booleans and floats as integers unless the API explicitly permits them.
- Make explicit which state is local to a request and which is global to the process, especially under persistent workers where static or singleton state can survive multiple requests.
- For a persistent worker, store mutable request identity in a context owned by the request or a lifecycle manager owned by the instance, never in `static` properties shared across the process or a global registry. A `WeakMap<Fiber, Context>` provides request isolation only if its _owner_ is itself scoped to the worker/request lifecycle; a static WeakMap still carries mutable state shared across the process. Keep immutable caches that span requests separate and preserve them across request cleanup.
- Establish request identity explicitly on entry and end it in `finally` on every normal/exceptional request path. Make lookups outside an active request fail rather than lazily inventing a context; protect against interleaved Fibers, nested calls, stale tenants after recycle, and late async completion. Scope lifecycle state to the worker instance when the API allows it.
- When moving mutable request state from a static cache into a worker owned by the instance, preserve the existing public lifecycle behavior. If the old cache's `recycle()` no longer applies, provide the worker's own callable `recycle()` and confirm a subsequent `handle()` works; never leave a call to a removed method. Recycling clears request and Fiber context while retaining safe immutable configuration/cache entries. Keep documented `handle()`, cache configuration, and cache count observations callable.
- Preserve exception context and cleanup. On normal return or exception unwinding, `finally` can replace an earlier result or failure with its own return or exception. `exit()` bypasses `finally`; do not promise cleanup on every termination path.
- Use framework container scope, transaction helpers, and facades only as contracts of the framework version actually in use.

## Failure discriminators

- If the same function accepts input from one caller and rejects another, compare the callers' strict typing context before changing the function signature.
- If state leaks only under workers or queues, inspect static state, singleton services, and reused connections before blaming request parsing.
- If an original exception disappears, inspect `catch` and `finally` control flow before broadening logging or rescue behavior.
- If production differs from local execution, compare PHP minor version, extensions, ini settings, opcache or worker model, and Composer lock state.

## Verification at the PHP boundary

- Run Composer validation plus the repository's configured static analysis and tests under affected supported PHP versions.
- Before editing a provided fixture or application, identify files and tooling declared immutable by its task contract. Preserve its README, Composer metadata and pinned runtime/toolchain files where immutable; implement changes in the allowed source and regression tests. Do not make Composer validation green by rewriting a protected `composer.json`, nor edit the expected outputs in the contract.
- Test representative strict and coercive callers when scalar type behavior changes.
- For JSON decoding changes, assert exact status/error fields for missing, explicit `null`, `false`, quoted `"0"`, integer `0`, negative and overflowing integers, malformed JSON or invalid `UTF-8`, and valid payloads with compatible extra fields. Verify the intended response contract rather than deriving expected results from the changed implementation.
- Exercise two sequential requests or jobs through a persistent worker when request isolation is material.
- For persistent workers, also test alternating tenants, exception unwinding, interleaved Fibers, context access before/after the request, worker recycle followed by reuse, and preservation of safe immutable cache. Verify the tests actually execute under the declared PHP version; source review or test names are insufficient.
- For a repair fixture with a known defective starter, execute focused regression tests against the repair and against the original starter, restoring the repaired source afterward. The tests must pass on the repair and fail on the starter for the behavior being fixed; a successful smoke test on the happy path does not establish a regression.
- Record the actual exit status of Composer validation, configured static analysis, and runtime tests separately. Repair baseline package metadata when authorized and appropriate, or identify an existing warning or failure as unresolved. Do not claim a test count or version matrix unless the retained command output substantiates it.
- Verify rollback and exception propagation for changed persistence boundaries.
- Check timezone, serialization, and paths that depend on extensions only when the changed contract uses them.

## Completion evidence

- PHP version, caller coercion, lifecycle, and dependency assumptions affected
- Static analysis and runtime evidence for the changed request or worker boundary
- Persistence or exception flow evidence when those contracts changed

Use [the maintained source map](references/sources.md) for facts that vary by version and source conflicts.
