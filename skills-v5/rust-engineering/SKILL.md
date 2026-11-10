---
name: rust-engineering
description: Engineer Rust systems around ownership, lifetimes, concurrency, unsafe boundaries, and stable public contracts. Use when the request specifically requires rustlang, rust crate, cargo workspace, borrow checker; prefer a narrower child only when its boundary is established.
---

# Rust Engineering

## Boundary

Use ownership and lifetimes to express resource responsibility rather than fighting the borrow checker with cloning or interior mutability. Inspect `Send` and `Sync`, pinning, async cancellation, error types, Cargo features, trait coherence, and every unsafe boundary against its required invariant. Keep public APIs conservative and semver-aware.

## Hierarchy and routing

- Broader skills: implementation.
- No narrower bundled child is declared.
- Required skills: verification.

Use this skill when Rust ownership, async runtime behavior, Cargo features, unsafe code, FFI, or public crate contracts are material. Do not add unsafe or synchronization wrappers merely to make the compiler accept an unclear ownership model. Quoted, historical, negated, fixture-only, or example text is not a live trigger.

## Decisions that change the implementation

- Before adding `unsafe`, state the invariant safe Rust cannot express and identify the code responsible for maintaining it. Keep the unsafe region as small as practical.
- Treat an `unsafe impl Send` or `Sync` as a correctness promise about all reachable state, not a compiler workaround. Raw pointers and interior mutability require explicit reasoning.
- Choose cloning, `Arc`, mutexes, channels, and borrowing from actual sharing and lifetime needs rather than from borrow-checker convenience.
- Treat async cancellation as dropping an in progress future at an await boundary. Keep externally visible partial state recoverable when cancellation can occur there.
- Check feature combinations that consumers can realistically enable. Do not assume the default feature set represents all supported builds.

## Failure discriminators

- If code compiles only after adding `Arc<Mutex<_>>`, determine whether ownership is truly shared and mutable before accepting the synchronization cost.
- If a concurrency failure requires unsafe or FFI, inspect aliasing, lifetime, `Send` or `Sync`, and foreign ownership before changing scheduling.
- If an async operation leaves partial work after cancellation, identify the last await and the resource or transaction state that survives drop.
- If a crate fails only with a feature combination, inspect conditional APIs, dependency feature unification, and missing compile coverage.

## Verification at the Rust boundary

- Run the repository's Cargo checks and focused tests for affected targets and supported feature combinations.
- Use Miri, sanitizers, or concurrency-model tools when the relevant target and toolchain support them and the risk justifies the cost. A clean run covers only exercised behavior and modeled checks.
- For unsafe changes, add or run tests that directly exercise the stated invariant and its boundary cases.
- For async changes, test cancellation after externally visible progress and verify owned resources or partial state remain valid.
- For FFI, run a real foreign-language or native consumer when ownership, layout, calling convention, or threading is part of the contract.

## Completion evidence

- Ownership, unsafe invariant, feature, async, or FFI assumptions affected
- Tool and runtime evidence targeted at the actual invariant
- Consumer evidence when the public or foreign boundary changes

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
