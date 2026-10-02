---
name: python-engineering
description: Engineer Python applications and libraries with explicit typing, packaging, concurrency, and runtime behavior. Use when the request specifically requires python, pyproject, pytest, asyncio; prefer a narrower child only when its boundary is established.
---

# Python Engineering

## Boundary

Confirm supported Python versions, packaging layout, interpreter environment, type-checking policy, and sync or async execution model. Keep import side effects, mutable defaults, resource lifetime, exception boundaries, and data-model semantics explicit. Type annotations describe a contract but do not replace runtime validation where untrusted data crosses the boundary.

## Hierarchy and routing

- Broader skills: implementation.
- No narrower bundled child is declared.
- Required skills: verification.

Use this skill when Python language, packaging, interpreter, typing, or asyncio behavior is material. Framework-specific lifecycle belongs here only when Python runtime semantics are part of the problem. Quoted, historical, negated, fixture-only, or example text is not a live trigger.

## Decisions that change the implementation

- Resolve the supported interpreter range before adopting syntax, typing features, `asyncio` APIs, or packaging metadata that vary by Python release.
- Preserve `CancelledError` as cancellation in asyncio code after cleanup. Swallowing cancellation can break structured-concurrency helpers such as `TaskGroup` and timeouts.
- Put resource release in context managers or `try` and `finally` at the owner boundary. Use async context managers for resources whose acquisition or release is asynchronous.
- Avoid import-time mutation, network calls, or process-global configuration unless startup semantics explicitly require them.
- Keep environment resolution separate from declared project dependencies. A package present in one virtual environment is not evidence that the project declares it.

## Failure discriminators

- If async shutdown hangs, distinguish swallowed cancellation, blocking sync work, orphan tasks, and resources whose cleanup never ran.
- If tests pass only in one environment, compare interpreter version, lock or dependency metadata, extras, environment variables, and import path before editing application logic.
- If a type checker and runtime disagree, identify whether the annotation, dynamic input, plugin, stub, or runtime behavior is authoritative for the contract.
- If state leaks between tests, inspect module globals, mutable defaults, cached singletons, and fixture scope before resetting interpreter state globally.

## Verification at the Python boundary

- Run focused tests under affected supported interpreters when version behavior can differ.
- Run configured static checks when the repository treats them as authoritative, but verify runtime behavior separately for dynamic inputs.
- For asyncio changes, exercise normal completion, cancellation during an await, child failure, and cleanup.
- Test context-manager cleanup on both success and exception paths when resource ownership changes.
- Validate package installation or import from a clean environment when `pyproject.toml`, extras, entry points, or dependency declarations change.
- Run the affected regression checks and state which broader or narrower skill owns adjacent behavior; preserve established contracts and explain any boundary that is intentionally left to another specialist.

## Completion evidence

- Interpreter, packaging, typing, and sync or async assumptions affected
- Runtime evidence for cancellation, cleanup, imports, or environment-sensitive behavior that changed
- Clean-environment installation evidence when package metadata is part of the task
- Regression results and the hierarchy boundary for adjacent language, framework, or verification work

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
