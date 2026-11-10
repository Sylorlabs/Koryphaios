# Source map

`language-runtime-security` is individually authored for V5; empirical qualification is tracked separately in the audit/evaluation ledger. These sources bound concrete language/runtime semantics and project security scope; runtime version, feature set, target ABI, host embedding, and observed execution remain decisive for a specific claim.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader security-review.
- Routing: five positive, five near neighbor negative, three compound/ambiguous, and three adversarial held out cases through the real resolver.
- Full task evaluation: two individual scenarios with six falsifiable checks, same model skill pairing with and without the skill, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **WebAssembly Core Specification release 3.0**: https://www.w3.org/TR/wasm-core/
  - Scope: W3C Candidate Recommendation Draft dated 2026-08-12. The Working Group maintains it as a living Candidate Recommendation; do not call it a final W3C Recommendation.
  - Use: core validation, execution, typing, memories/tables, traps, and security considerations. Host imports and embedding authority are outside the core guarantee and must be modeled separately.
  - Verified: 2026-09-05; refresh after 90 days.
- **WebAssembly System Interface (WASI)**: https://wasi.dev/
  - Scope: official WASI project documentation and specification entry point; individual proposals, preview versions, engines, and host embeddings can differ and must be identified before making a claim.
  - Use: capability-oriented system interfaces and the boundary between a guest module's requested operation and the host embedding's granted authority. WASI presence alone does not prove filesystem, network, process, or operating-system isolation.
  - Verified: 2026-10-17; refresh after 90 days.
- **LLVM IR Undefined Behavior Manual**: https://llvm.org/docs/UndefinedBehavior.html
  - Scope: current LLVM 24.0.0git documentation as verified 2026-11-07.
  - Use: immediate UB, poison, undef/freeze, and optimizer assumptions when tracing whether lowering preserves source-language security checks.
  - Verified: 2026-11-07; refresh after 60 days.
- **LLVM Security Response Group scope**: https://llvm.org/docs/Security.html
  - Scope: current LLVM 24.0.0git documentation as verified 2026-11-07.
  - Use: explicit project boundaries for which LLVM components/inputs are treated as security-sensitive or not hardened; prevents assuming that every LLVM parser/JIT use is safe for hostile inputs.
  - Verified: 2026-11-07; refresh after 60 days.

## Interpretation rules

- Never extend a core-language memory/type-safety claim to host imports, native extensions, unsafe code, loaders, or implementation bugs without evidence.
- Never treat an engine, embedder, WASI implementation, container, VM, worker, or OS sandbox as interchangeable with another. If the named runtime or host boundary was not exercised, mark the claim unverified rather than importing behavior from an unsupported runtime.
- Treat parser/validator/interpreter/JIT agreement as a security property when untrusted modules cross those layers.
- When LLVM or another optimizing IR is involved, verify that frontend flags and undefined-behavior assumptions are justified by the source language's actual semantics.
- Resource exhaustion and privileged partial effects are part of sandbox security even when the guest cannot corrupt host memory.
- Preserve exact runtime/compiler/engine/embedder version, target, feature gates, host capability configuration, and optimization/JIT mode for any behavior that can vary across implementations.
- Documentation retrieval establishes source support and a proposed contract. It does not establish a live denial, resource limit, escape boundary, cleanup, audit, restart, or recovery result; those require the named runtime and host to be exercised.
