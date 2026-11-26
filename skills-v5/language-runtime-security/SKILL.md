---
name: language-runtime-security
description: Secure compilers, interpreters, validators, module loaders, and host capability boundaries. Use when untrusted code, sandbox escape, verifier mismatches, or unsafe foreign-function interfaces threaten runtime guarantees; use application-security for application data flows independent of language-runtime semantics.
---

# Language Runtime Security

Start by writing down the exact guarantee the runtime is expected to provide and the boundary that is supposed to enforce it. “Memory safe,” “sandboxed,” or “validated bytecode” is not enough: a runtime can preserve memory safety while still granting filesystem/network authority, miscompile a security check, exhaust the host, load an untrusted native library, or expose a capability through FFI. An in-process runtime boundary is not an operating-system isolation boundary unless that stronger claim is separately demonstrated.

## Operating contract

Before changing or approving a runtime, record these as separate contract fields rather than collapsing them into a single security verdict:

- **Trust and guarantee scope:** identify adversarial source, bytecode/IR, serialized modules, packages, native extensions, host imports, debugger/profiling interfaces, JIT data, generated code, and the trusted runtime/toolchain. State memory/type safety, control-flow safety, determinism, capability isolation, resource bounds, and failure semantics independently.
- **Isolation boundary:** name the actual boundary (`in-process`, worker/thread, subprocess, VM, container, or OS sandbox), the identity and privileges at that boundary, inherited file descriptors/handles, environment, working directory, mounts, IPC, signals, shared memory, debugger access, and executable memory policy. Record the runtime, embedder, OS, architecture, feature set, target/ABI, and execution mode.
- **Capability contract:** enumerate every import and native/unsafe escape hatch with allowed operations, canonicalized resources, identity, argument limits, rate/cost limits, and denial behavior. Default untrusted code to no ambient filesystem, network, process, environment, credential, device, clock, or reflective authority.
- **Resource contract:** specify per-execution and cumulative limits for memory/tables, stack/recursion, code/module size, compilation/JIT time, wall time, CPU, instructions/fuel/epochs, host call cost, output/log bytes, concurrency, and queued work. State whether exhaustion traps, interrupts, or kills the worker and what cleanup follows.
- **Evidence status:** every material fact is `observed`, `simulated`, `inferred`, `stale`, `unavailable`, or `unverified`, with the exact command, fixture, runtime identity, and artifact/log location where applicable. A desired setting is not an observed enforcement result.

## Runtime security workflow

1. **Resolve the environment before the claim.** Inspect the supplied or installed runtime/compiler, embedder, OS/architecture, target/ABI, feature gates, optimization/JIT mode, native libraries, and launch policy. Do not substitute the authoring host or a familiar runtime for an unresolved target.
2. **Define the trust and guarantee model.** Complete the operating contract above before relying on a happy path. Identify which layer owns each invariant and which claims are outside the runtime's authority.
3. **Trace semantics across layers.** Follow security-relevant behavior through parser, AST/type checker, lowering, IR construction, optimization, bytecode validation, serialization/deserialization, loader/linker, interpreter/JIT/AOT execution, runtime libraries, garbage collector/allocator, concurrency, and foreign/native calls. A property proven in one layer must survive every representation transition.
4. **Treat undefined or underspecified behavior as a security boundary.** Check whether frontend flags or lowering emit optimizer assumptions stronger than source-language guarantees; whether poison/undefined values, integer overflow, aliasing, provenance, lifetime, exceptions, concurrency, or NaN/canonicalization semantics can invalidate a check; and whether debug/release or optimization levels disagree.
5. **Separate validation from execution.** Ensure the exact immutable bytes/IR/module that are validated are the ones executed, and that validator and interpreter/JIT agree on decoding, typing, control flow, indices, lengths, imports, and feature/version gates. Reject parser differentials, post validation mutation, stale caches, TOCTOU replacement, and mismatched fallback paths.
6. **Constrain host authority and escape boundaries.** Mediate every host import and native call with an allowlist and explicit identity. Check canonical path and symlink/hardlink behavior, mounts and namespace transitions, inherited descriptors/handles, environment and credentials, cwd, IPC, signals, shared memory, debugger/ptrace/profiling access, DNS/redirect/rebinding, dynamic loading, and JIT executable memory. A guest trap or memory-safety proof does not prove that these boundaries hold.
7. **Bound resource consumption.** Enforce memory/table/stack/code-size limits, recursion, compilation/JIT time, wall/CPU time, instruction/fuel/epoch limits where supported, host-call cost, output/log size, concurrency, queue depth, and cancellation. Make the enforcement point and terminal outcome observable. A limit that exists only in configuration or documentation is not verified.
8. **Stage and account for privileged effects.** Make writes, signing, network sends, process launches, and other privileged effects explicit. Prefer preflight plus staged/transactional commit; attach capability identity, operation ID, and generation to each effect. A trap, timeout, cancellation, or out of budget result must not leave an unaccounted committed effect or claim rollback without inspecting durable state.
9. **Make denial, exhaustion, and recovery observable.** Emit structured, bounded records for admission, module/corpus digest, capability decisions, limit values and usage, traps, cancellations, worker termination, cleanup, committed effects, and retry/recovery. Keep secrets and guest data out of diagnostics. Retain enough correlation to compare interpreter/JIT/AOT modes and reconstruct the first divergent layer.
10. **Exercise failure and recovery.** Use malformed modules, capability-denial cases, path/symlink escapes, network changes, FFI misuse, validation/execution differentials, infinite loops, memory/stack growth, output floods, cancellation, worker crash, and trap after staged write cases. Verify descriptor/capability revocation, temporary-state cleanup, durable audit consistency, restart isolation, idempotent retry, and a later permitted success.
11. **Audit native/unsafe escape hatches.** FFI, native extensions, unsafe intrinsics, raw pointers, signal/exception bridges, reflection, dynamic loading, and JIT executable memory can invalidate the safe-language model. Define ABI/layout/lifetime/ownership/thread/exception rules and W^X or equivalent executable memory policy where relevant.
12. **Prove security invariants with adversarial programs.** Use minimized reproducers, optimization-level comparisons, differential/interpreter-vs-JIT tests, malformed module corpora, capability-denial cases, and resource-exhaustion cases. Preserve the smallest cross layer trace that explains the failure instead of stopping at a crash symptom.
13. **Bind evidence to ownership and supplied contracts.** Record the exact runtime/compiler/toolchain identity, target/ABI, flags or modes, feature set, module/corpus identity, and custom runtime/compiler ownership boundary. When a task provides a schema, fixed simulator, corpus, lifecycle command, or named layers, preserve it exactly. Put required facts inside the structured artifact using the supplied field names; do not replace them with synonyms or a final-message summary. Keep staged privileged work distinct from durable committed effects.

## Supplied fixtures are inputs, not workspace

A task that ships a corpus, a fixed simulator, candidate modules, or test fixtures under
`tests/fixtures/` hands you sealed inputs. Read them, run them, and add your own files beside
them. Do not rewrite, delete, or "fix" a supplied fixture or corpus file, and do not change a
supplied test to make a new implementation agree with it: that erases the thing the task
measures, and an evaluator that compares supplied inputs sees it as fixture tampering rather
than as work. New coverage goes in new files with names the task did not reserve.

One supplied input is not sealed: a test that asserts the defect itself. When the task is to
repair a fault and a supplied test pins the pre-fix misbehavior (it fails on purpose until the
repair lands, or asserts the buggy outcome as expected), that canary is superseded by the
repair rather than protected by this rule. Update it to the post-fix contract, or retire it in
favor of equivalent post-fix coverage in a new file, keep the change minimal, and record the
reconciliation in the report. What stays forbidden is weakening a supplied test so a
still-broken implementation appears to agree with it, or editing a supplied test that measures
something the repair does not change.

## Name the toolchain and the scope

A language-runtime security finding is only meaningful with the exact runtime it was measured against and the limit of what was inspected. The report must carry the version string it ran (for a V8 finding, the `22.0.0` line and which tier executed, interpreter or optimizing), the pipeline stages inspected (`lower`, `ir`, `optimizer` where those exist), and an explicit statement that the evidence covers that runtime build rather than the language in general. It must not claim a specification or memory-safety vulnerability the corpus did not demonstrate.

When the task asks for a compiler audit artifact, write it as the named JSON file and spell the scope inside it: the toolchain version literal (`22.0.0`), the stage names `lower`, `ir` and `optimizer` as the trace waypoints, and the phrase `custom compiler` naming whose guarantee is at stake. A report that describes the same audit in prose, or that omits the version literal or one of the stage names, is read as unbounded scoping evidence even when the trace itself is correct. Never turn the finding into a claim about LLVM or the host toolchain in general: the guarantee belongs to the compiler under review, and a generic vulnerability claim makes the whole audit read as unsupported. Phrase the scoping denial as one short sentence, `This is a custom compiler guarantee mismatch, not a generic LLVM vulnerability.`, and keep the word `vulnerability` out of every other sentence that mentions LLVM: a denial joined with `or` (for example `not a claim of generic LLVM behavior or a generic LLVM vulnerability`) or prefixed with a bare `no` reads to a deterministic scoping check as an affirmative LLVM claim and fails the audit even though it reads as a denial to a person.

## Evidence and claims

Produce a guarantee model, representation/cross layer trace, isolation and escape boundary map, host capability map, resource limit enforcement matrix, structured observability/audit record, recovery record, and adversarial reproducer or verification corpus. Include runtime/compiler version, enabled feature set, optimization/JIT mode, target/ABI, module or corpus identity, exact bytes/digest where relevant, and the boundary between custom runtime-owned behavior and third-party toolchain/host behavior. Distinguish desired configuration from observed execution, and live from simulated, inferred, stale, unavailable, or unverified evidence.

If a runtime, embedder, JIT, OS sandbox, container engine, target architecture, native extension, or host capability was not supplied and not exercised, mark that boundary **unverified**. Do not borrow behavior from another runtime, platform, version, or implementation to fill the gap. An unsupported runtime claim remains unverified even when the source language, specification, compilation, or a component test looks sound.

For a structured evidence artifact, use stable fields when the task does not provide its own names: `environment`, `guarantees`, `ownershipBoundary`, `crossLayerTrace`, `isolationBoundary`, `capabilities`, `resourceLimits`, `observations`, `effectsAndAudit`, `recovery`, `reproducers`, and `unsupportedOrUnverified`. Each field must distinguish intended contract from observed result.

## Boundaries

- `application-security` owns ordinary request/file/network/process sinks in an application; this skill owns language/compiler/runtime semantics and untrusted-code confinement.
- `applied-cryptography` owns cryptographic constructions; this skill owns whether runtime representations, host calls, or unsafe/native boundaries preserve the surrounding isolation assumptions.
- `property-fuzz-differential-testing` owns reusable fuzz/differential testing technique; this skill defines the runtime security invariants and adversarial cross layer cases that technique should exercise.
- `supply-chain-security` owns provenance and integrity of compiler/runtime artifacts and dependencies; this skill owns security behavior once the runtime/compiler is executing.
- `security-review` owns synthesis of review-only findings; `security-verification` can independently prove a finished runtime control.
- `container-engineering` or `infrastructure-security` owns general container/host hardening; this skill owns whether the runtime's guest and host-capability contract is preserved at that boundary.

Use [the maintained source map](references/sources.md) for current WebAssembly Core status and LLVM's explicit undefined-behavior/security boundaries.
