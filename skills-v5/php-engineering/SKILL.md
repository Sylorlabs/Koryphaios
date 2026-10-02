---
name: php-engineering
description: Engineer PHP applications and libraries with type, request lifecycle, dependency, persistence, and runtime-version discipline. Use when the request specifically requires php, composer package, phpstan, laravel php; prefer a narrower child only when its boundary is established.
---

# Php Engineering

## Boundary

Confirm PHP target versions, Composer constraints, request lifecycle, autoloading, strict-types policy, framework container scope, and persistence boundaries. Distinguish language-level behavior from framework conveniences and from long-lived worker behavior.

## Hierarchy and routing

- Broader skills: implementation.
- No narrower bundled child is declared.
- Required skills: verification.

Use this skill when PHP language, Composer, request or worker lifecycle, or PHP runtime version is material. Laravel-specific behavior applies only when Laravel is actually present. Quoted, historical, negated, fixture-only, or example text is not a live trigger.

## Decisions that change the implementation

- Resolve supported PHP versions and Composer constraints before using language features or changing dependency ranges.
- Remember that `strict_types` is declared per calling file. A callee cannot assume all callers use strict scalar coercion rules merely because its own file declares strict types.
- Make request-local versus process-global state explicit, especially under long-lived workers where static or singleton state can survive multiple requests.
- Preserve exception context and cleanup. On normal return or exception unwinding, `finally` can replace an earlier result or failure with its own return or exception. `exit()` bypasses `finally`; do not promise cleanup on every termination path.
- Use framework container scope, transaction helpers, and facades only as contracts of the framework version actually in use.

## Failure discriminators

- If the same function accepts input from one caller and rejects another, compare the callers' strict-types context before changing the function signature.
- If state leaks only under workers or queues, inspect static state, singleton services, and reused connections before blaming request parsing.
- If an original exception disappears, inspect `catch` and `finally` control flow before broadening logging or rescue behavior.
- If production differs from local execution, compare PHP minor version, extensions, ini settings, opcache or worker model, and Composer lock state.

## Verification at the PHP boundary

- Run Composer validation plus the repository's configured static analysis and tests under affected supported PHP versions.
- Test representative strict and coercive callers when scalar type behavior changes.
- Exercise two sequential requests or jobs through a long-lived worker when request isolation is material.
- Verify rollback and exception propagation for changed persistence boundaries.
- Check timezone, serialization, and extension-dependent paths only when the changed contract uses them.

## Completion evidence

- PHP version, caller coercion, lifecycle, and dependency assumptions affected
- Static-analysis and runtime evidence for the changed request or worker boundary
- Persistence or exception-flow evidence when those contracts changed

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
