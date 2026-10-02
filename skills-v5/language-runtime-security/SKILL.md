---
name: language-runtime-security
description: Secure compilers, interpreters, validators, module loaders, and host capability boundaries. Use when untrusted code, sandbox escape, verifier mismatches, or unsafe foreign-function interfaces threaten runtime guarantees; use application-security for application data flows independent of language-runtime semantics.
---

# Language Runtime Security

Start by writing down the exact guarantee the runtime is expected to provide. “Memory safe,” “sandboxed,” or “validated bytecode” is not enough: a runtime can preserve memory safety while still granting filesystem/network authority, miscompile a security check, exhaust the host, load an untrusted native library, or expose a capability through FFI.

## Runtime-security workflow

1. **Define the trust and guarantee model.** Identify which inputs are adversarial: source text, bytecode/IR, serialized modules, packages, native extensions, host imports, debugger/profiling interfaces, JIT data, or generated code. State promised memory/type safety, control-flow constraints, capability isolation, determinism, resource bounds, and failure semantics separately.
2. **Trace semantics across layers.** Follow security-relevant behavior through parser, AST/type checker, lowering, IR construction, optimization, bytecode validation, serialization/deserialization, loader/linker, interpreter/JIT/AOT execution, runtime libraries, garbage collector/allocator, and foreign/native calls. A property proven in one layer must survive every representation transition.
3. **Treat undefined or underspecified behavior as a security boundary.** Check whether the frontend emits optimizer assumptions that are stronger than source-language guarantees; whether poison/undefined values, integer overflow, aliasing, provenance, lifetime, exceptions, concurrency, or NaN/canonicalization semantics can invalidate a check; and whether debug/release or optimization levels disagree.
4. **Separate validation from execution.** Ensure the exact bytes/IR/module that are validated are the ones executed, and that validator and interpreter/JIT agree on decoding, typing, control flow, indices, lengths, imports, and feature/version gates. Reject parser differentials and post-validation mutation.
5. **Constrain host authority.** Model host imports/capabilities explicitly. Default untrusted modules to no ambient filesystem, network, process, environment, credential, device, or clock authority unless the task grants it. Resolve path/symlink and namespace semantics at the capability boundary; a memory-safe guest can still escape through an overpowered host API.
6. **Bound resource consumption.** Enforce memory/table/stack/code-size limits, recursion, compilation/JIT time, instruction/fuel or epoch limits where supported, host-call cost, output size, and cancellation. Traps and out-of-fuel paths must not leave privileged partial effects behind.
7. **Audit native/unsafe escape hatches.** FFI, native extensions, unsafe intrinsics, raw pointers, signal/exception bridges, reflection, dynamic loading, and JIT executable memory can invalidate the safe-language model. Define ABI/layout/lifetime/ownership rules and W^X or equivalent executable-memory policy where relevant.
8. **Prove security invariants with adversarial programs.** Use minimized reproducers, optimization-level comparisons, differential/interpreter-vs-JIT tests, malformed module corpora, capability-denial cases, and resource-exhaustion cases. Preserve the smallest cross-layer trace that explains the failure instead of stopping at a crash symptom.

## Evidence and claims

Produce a guarantee model, representation/cross-layer trace, host-capability map, resource-limit contract, and adversarial reproducer or verification corpus. Record runtime/compiler version, enabled feature set, optimization/JIT mode, target/ABI, and module digest when those facts affect the result. Do not generalize a property of WebAssembly core semantics, Rust safe code, a bytecode verifier, or another language subset across host APIs, unsafe code, native extensions, or implementation bugs without evidence.

## Boundaries

- `application-security` owns ordinary request/file/network/process sinks in an application; this skill owns language/compiler/runtime semantics and untrusted-code confinement.
- `applied-cryptography` owns cryptographic constructions; this skill owns whether runtime representations, host calls, or unsafe/native boundaries preserve the surrounding isolation assumptions.
- `property-fuzz-differential-testing` owns reusable fuzz/differential testing technique; this skill defines the runtime-security invariants and adversarial cross-layer cases that technique should exercise.
- `supply-chain-security` owns provenance and integrity of compiler/runtime artifacts and dependencies; this skill owns security behavior once the runtime/compiler is executing.
- `security-review` owns review-only finding synthesis; `security-verification` can independently prove a finished runtime control.

Use [the maintained source map](references/sources.md) for current WebAssembly Core status and LLVM's explicit undefined-behavior/security boundaries.
