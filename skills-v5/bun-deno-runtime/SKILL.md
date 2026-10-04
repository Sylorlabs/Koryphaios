---
name: bun-deno-runtime
description: Engineer Bun and Deno systems by validating runtime-specific APIs, compatibility, packaging, permissions, and deployment behavior. Use when the request specifically requires bun runtime, bun test, deno runtime, deno deploy; prefer a narrower child only when its boundary is established.
---

# Bun Deno Runtime

## Responsibility

Treat Bun and Deno as distinct runtimes, not interchangeable Node replacements. Pin the actual runtime and deployment target; inspect package resolution, native dependencies, lifecycle scripts, lockfiles, permission boundaries, and test semantics before changing code. Preserve observable behavior and existing architecture unless the task requires otherwise.

## Hierarchy and routing

- Broader skills: backend-engineering.
- No narrower bundled child is declared.
- Required skills: verification.

Inherit shared backend principles. This child owns runtime compatibility and capability differences; it does not absorb general Node, compiler, or application architecture work. A skill cannot authorize additional access.

## Professional practice

For compatibility changes, capture the baseline first: install-generated files, package exports, CLI output/exit codes, timers, child processes, and interruption/shutdown cleanup as relevant. Repair demonstrated incompatibilities, not every Node idiom. Treat reviewed lifecycle command strings as part of that baseline contract: do not replace `node` with `bun` in scripts merely because Bun is the target runtime. Keep a compatible existing command unless evidence shows it fails or the task explicitly authorizes changing that command. Preserve lock semantics or document an explicitly authorized migration. Bun's dependency-script trust policy requires inspection; a successful install does not prove a dependency's generator ran.

For Deno, derive required capabilities from actual operations. Read and write permissions are independent: permission to create an output does not permit reading it back. Audit incidental metadata checks, canonicalization, existence probes, and verification reads as operations too. Preserve the authorized capability set; if verification needs access the task withholds, let an authorized host verify the output or report that limit rather than widening permissions or changing a valid write into a failure. Scope filesystem roots, network destinations, environment access, and executable paths; test denied neighbors and redirects, not only allowed paths. Do not use blanket permissions to hide a failure. Executable permission does not constrain command arguments, and child processes do not inherit Deno's sandbox. Validate argument/environment boundaries and use appropriate OS isolation or avoid spawning when confinement is required; do not promise that a permitted tool is intrinsically read-only.

## Completion evidence

Run the pinned runtime through relevant install/build/test and external behavior paths. Exercise failures, cancellation, signal cleanup, package consumers, denied access, and deployment-sensitive behavior. Keep compatibility deviations and permission failures reproducible. Distinguish actual Bun/Deno execution from policy simulations or records supplied for analysis; a Node test or matching API name does not establish parity. Missing runtime evidence remains a qualification blocker.

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
