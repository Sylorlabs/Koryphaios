---
name: compiler-runtime-backend
description: Engineer compiler, language-server, build, VM, and language-runtime backends around semantics, diagnostics, determinism, and incremental behavior. Use when the request specifically requires compiler runtime, language server, build daemon, virtual machine.
---

# Compiler Runtime Backend

## Responsibility

Establish language semantics, phase boundaries, intermediate representations, source mapping, diagnostics, determinism, incremental invalidation, caching, concurrency, resource limits, compatibility, and host/target boundaries. Keep parser, semantic analysis, lowering, optimization, code generation, runtime services, and tooling contracts explicit without forcing a conventional compiler layout where the language differs.

Treat diagnostics and developer interaction as product interfaces. Preserve reproducibility, stable identifiers where required, cancellation, partial results, malformed-source recovery, and safe execution boundaries. Test golden diagnostics, semantic invariants, differential behavior, incremental versus clean builds, cache invalidation, concurrency, malformed input, target differences, and end-to-end execution. Do not default to a web server, SQL store, or TypeScript host.

## Hierarchy and routing

- Broader skills: backend-engineering.
- Narrower children: embedded-firmware.
- Cross-cutting facets: developer-experience.

## Professional practice

### Operating contract

Engineer language, compiler, interpreter, VM, or runtime machinery with explicit semantic and resource contracts.

### Execution sequence

1. Define source, intermediate, execution, diagnostic, ABI, and compatibility boundaries.
2. Specify parsing, typing, lowering, optimization, execution, memory, and error invariants.
3. Implement the smallest end-to-end semantic slice through existing representations.
4. Add introspection, deterministic fixtures, malformed inputs, and cleanup checks.
5. Verify semantics, diagnostics, compatibility, performance, and resource lifetime.

Match the proof to the requested scope. For a helper local to one phase, name the producer/consumer representation boundary and verify the local invariant there; do not present a helper test as evidence for the whole compiler, runtime, ABI, or toolchain. When the requested behavior crosses phases, add an end to end or legitimate differential/oracle check through the affected phases, or mark that evidence unavailable. Exercise malformed or partial state and a representative recovery path. Where the affected component is incremental, cancellable, concurrent, restartable, or owns resources, verify the corresponding invalidation, interruption/retry, determinism, and cleanup behavior instead of assuming it from a successful unit test. Do not invent concurrency or recovery semantics that the component does not have.

### Decisions that must be explicit

- Which layer owns each invariant and diagnostic.
- Representation and ABI stability.
- Compile-time versus runtime enforcement.
- Optimization legality and fallback behavior.

### Failure and recovery discipline

- A later layer compensates for an earlier broken invariant.
- Optimization changes observable semantics.
- Malformed input crashes or consumes unbounded resources.
- Host behavior is mistaken for target behavior.

### Evidence required before completion

For garbage collector maps, derive roots from liveness and value kind at the safepoint across registers and spill slots. Preserve every live reference location while excluding integers and dead values; test mixed locations and movement across spills. Tie the result to the phase, representation and runtime contract being changed. A small helper test establishes only that helper, not a complete compiler or ABI claim.

- Semantic and affected representation/phase contract.
- Positive, negative, and malformed corpus.
- Scope-matched executed regression evidence, plus differential, oracle, or end-to-end comparison where the claim legitimately crosses those boundaries.
- Target/runtime identity and resource results.
- Recovery, interruption, invalidation, determinism, and cleanup evidence matched to the behaviors the component actually exposes.

### Anti-misinterpretation boundaries

- Do not copy another language model without fit.
- Do not use undefined host behavior as a contract.
- Do not claim target portability from one backend.
- Do not trade diagnostic truth for apparent success.

## Completion evidence

- Semantic and affected phase/representation contract
- Scope-matched executed regressions plus legitimate differential, oracle, or end-to-end language checks
- Negative/malformed and recovery/cleanup evidence when those behaviors are applicable

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
