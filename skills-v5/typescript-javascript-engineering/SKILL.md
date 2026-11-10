---
name: typescript-javascript-engineering
description: Engineer TypeScript and JavaScript behavior where runtime semantics, narrowing, public types, module resolution, package exports, or async control flow is material. Use when the live task depends on TypeScript or JavaScript language behavior, not merely because framework files happen to use TS, JS, or TSX.
---

# Typescript Javascript Engineering

## Scope and routing

- Broader skill: `implementation`.
- Required skill: `verification`.
- Select this skill when the issue is controlled by JavaScript runtime behavior, TypeScript narrowing or inference, declaration design, module resolution, package export conditions, emitted output, or async semantics.
- Do not select it solely because a React, Vue, Svelte, or Next.js task is written in TypeScript. Let the framework skill own framework behavior and compose this skill only when the language boundary changes the answer.
- If runtime behavior differs among Node, browsers, Bun, workers, or a bundler, the actual target environment is part of the contract.
- Quoted, historical, negated, names appearing only in fixtures, or example language names are not live triggers.

## Decision criteria

### Runtime before types

TypeScript types do not validate runtime input. Treat network payloads, persisted data, environment variables, untyped libraries, and other external values as runtime data that must be checked before trusted narrowing. Prefer `unknown` plus narrowing based on evidence over `any`, broad casts, or non null assertions that merely silence the compiler.

At an untrusted boundary, validate the container, discriminant, and every required field specific to the variant (including nested values) before constructing or dispatching a trusted discriminated union. Define the policy for unknown tags, malformed known tags, and compatibility with versions and extra fields; reject or quarantine invalid input without applying partial side effects. A cast after `JSON.parse` is not validation.

Model mutually exclusive states as discriminated unions when that matches the runtime domain. Exhaustively handle the *validated* union using a `never` check so added variants surface at compile time; this does not protect against unknown runtime input. Do not make properties optional just to make an invalid state typecheck.

### Public type contracts

Choose generics, overloads, unions, and utility types based on what callers can actually rely on. Preserve distinctions such as absent versus present with `undefined` when the runtime API observes them. Before changing exported types, inspect downstream usage and generated declarations so a local improvement does not create a source or declaration compatibility break.

### Modules and package boundaries

Trace module behavior from repository evidence: `package.json` `type`, `exports` and `imports`, `tsconfig` `module` and `moduleResolution`, file extensions, bundler settings, and the runtime that loads the emitted code. TypeScript can resolve declarations successfully while the runtime still resolves a different file or condition.

Use imports and exports of types only when that distinction matters to emitted code or isolated compilation. Do not assume ESM, CommonJS, browser, Node, or Bun semantics from syntax alone.

### Async ownership

Make promise rejection, cancellation, timeout, and cleanup ownership explicit. Pass an existing `AbortSignal` through a call chain when cancellation is part of the API instead of inventing a second cancellation mechanism. Do not convert rejected work into a successful `undefined` result unless that is the declared contract.

`Promise.race` can settle a timeout wrapper while leaving the losing operation running. Decide who owns cancellation, timer teardown, and listener removal; propagate abort to cooperating work, and state what happens to work that cannot be cancelled. Preserve underlying rejection identity and any public contract for timeout errors.

Check a caller signal that is already aborted before starting work. Install cancellation observation and a guard that settles and cleans up only once *before* invoking user work; invoke work synchronously so it can subscribe to abort before the caller can cancel in the same turn. Handle synchronous throws and timer callbacks that fire during setup. On every terminal path, remove listeners and clear any installed timer, even when its handle is falsy or `undefined`; preserve explicit abort reasons such as `null` rather than replacing them with a default.

Use [runtime boundary and async failure checks](references/runtime-boundary-and-async-checks.md) when either contract changes.

## Boundary verification

Identify the supported TypeScript version, JavaScript runtime or bundler targets, and the package or API boundary that changed.

Record the actual compiler/runtime versions, module configuration, and command results for each claimed typecheck or runtime test. When a command cannot run, identify the unavailable dependency or permission and label the result unverified; configuration alone is not execution evidence.

When TypeScript cannot resolve a runtime's test library (for example `bun:test`), first inspect the package manager, installed runtime type package, `types` / `typeRoots`, and the intended project typecheck command. Use the real runtime declarations in that command and preserve the repository's declared test imports. Do not add ad hoc ambient `test`, `describe`, or `expect` declarations or a local `bun:test` shim as a substitute: these can redeclare names already supplied by the runtime and make the authoritative typecheck fail. If real declarations cannot be resolved, report that limitation rather than presenting a compile assisted by a stub as verified.

- Run the repository typecheck, but treat it as static evidence only.
- Exercise representative runtime behavior in each supported target affected by the change.
- For package changes, test the built package through its public import paths and relevant export conditions, not only imports relative to the source.
- Inspect emitted declarations when consumers depend on them.
- Exercise the rejected promise with the highest risk, cancellation, invalid external value, or module resolution path that the change touches.
- For external data, test each supported variant plus missing/unknown tags, fields of the wrong shape, and failure routing; assert that rejected data caused no unintended state changes.
- For timeout/cancellation, use controlled clocks and observable listeners to test success, rejection, abort before start, abort in the same turn, timeout, late settlement, and competing outcomes. Assert underlying cancellation and resource cleanup, not merely the wrapper's result.
- Do not claim a runtime contract is fixed because transpilation succeeds.

Use [the maintained source map](references/sources.md) for language behavior that is version sensitive and for module resolution behavior.
