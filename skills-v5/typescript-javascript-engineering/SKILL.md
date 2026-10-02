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
- Quoted, historical, negated, fixture-only, or example language names are not live triggers.

## Decision criteria

### Runtime before types

TypeScript types do not validate runtime input. Treat network payloads, persisted data, environment variables, untyped libraries, and other external values as runtime data that must be checked before trusted narrowing. Prefer `unknown` plus evidence-based narrowing over `any`, broad casts, or non-null assertions that merely silence the compiler.

Model mutually exclusive states as discriminated unions when that matches the runtime domain. Use exhaustive checks when a new variant should force callers to handle it. Do not make properties optional just to make an invalid state typecheck.

### Public type contracts

Choose generics, overloads, unions, and utility types based on what callers can actually rely on. Preserve distinctions such as absent versus present-with-`undefined` when the runtime API observes them. Before changing exported types, inspect downstream usage and generated declarations so a local improvement does not create a source or declaration compatibility break.

### Modules and package boundaries

Trace module behavior from repository evidence: `package.json` `type`, `exports` and `imports`, `tsconfig` `module` and `moduleResolution`, file extensions, bundler settings, and the runtime that loads the emitted code. TypeScript can resolve declarations successfully while the runtime still resolves a different file or condition.

Use type-only imports and exports when that distinction matters to emitted code or isolated compilation. Do not assume ESM, CommonJS, browser, Node, or Bun semantics from syntax alone.

### Async ownership

Make promise rejection, cancellation, timeout, and cleanup ownership explicit. Pass an existing `AbortSignal` through a call chain when cancellation is part of the API instead of inventing a second cancellation mechanism. Do not convert rejected work into a successful `undefined` result unless that is the declared contract.

## Boundary verification

Identify the supported TypeScript version, JavaScript runtime or bundler targets, and the package or API boundary that changed.

- Run the repository typecheck, but treat it as static evidence only.
- Exercise representative runtime behavior in each supported target affected by the change.
- For package changes, test the built package through its public import paths and relevant export conditions, not only source-relative imports.
- Inspect emitted declarations when consumers depend on them.
- Exercise the highest-risk rejected promise, cancellation, invalid external value, or module-resolution path that the change touches.
- Do not claim a runtime contract is fixed because transpilation succeeds.

Use [the maintained source map](references/sources.md) for version-sensitive language and module-resolution behavior.
