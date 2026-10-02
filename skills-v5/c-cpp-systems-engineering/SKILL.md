---
name: c-cpp-systems-engineering
description: Engineer C and C++ changes involving memory ownership, native interfaces, undefined behavior, concurrency, or toolchains. Use when native language rules or CMake usage requirements affect correctness; other languages and protocol-only design remain separate responsibilities.
---

# C Cpp Systems Engineering

## Boundary

Establish compiler, language standard, ABI, allocation ownership, object lifetime, thread model, and error conventions before changing native interfaces. In C++, prefer ownership that is visible in types and RAII. In C, make buffer length and ownership transfer explicit. Treat FFI, alignment, aliasing, integer conversion, and undefined behavior as contract risks.

## Hierarchy and routing

- Broader skills: implementation.
- No narrower bundled child is declared.
- Required skills: verification.

Use this skill when native language, toolchain, ABI, ownership, or object lifetime rules are material to the task. A CMake-only edit still belongs here when it changes compile definitions, include contracts, link interfaces, standard selection, or ABI exposure. Quoted, historical, negated, fixture-only, or example text is not a live trigger.

## Decisions that change the implementation

- For an exported C or C++ boundary, identify who allocates, who destroys, exception behavior, calling convention, layout assumptions, and symbol visibility before changing the signature. Never let a C++ exception or allocator obligation cross an ABI that does not define it.
- Treat non-owning pointers, references, spans, and string views as lifetime claims. If the producer can outlive the consumer only by convention, make that convention visible or change the ownership shape.
- Keep callback targets alive for the entire admitted use, including concurrent removal and exception unwinding. Do not hold an internal lock while invoking unknown user code. Shared ownership is one valid mechanism when lifetimes overlap, not a requirement to replace every unique owner.
- Prefer target-scoped CMake usage requirements when the repository already models libraries as targets. Do not reorganize a build merely to match a style guide.
- Separate a compiler diagnostic from runtime undefined behavior. A warning-free build does not establish valid aliasing, alignment, bounds, or object lifetime.

## Failure discriminators

- If a failure changes between debug and optimized builds, first test for undefined behavior, uninitialized state, data races, and lifetime violations before blaming optimization.
- If only one consumer or shared library combination fails, compare ABI inputs: compiler and standard library, packing, visibility, calling convention, feature macros, and allocator ownership.
- If corruption appears after return or callback completion, inspect borrowed views and destruction order before adding copies indiscriminately.
- If a sanitizer reports a fault, preserve the smallest reproducer and the exact sanitizer class. Do not suppress it until the violated invariant is understood.

## Verification at the native boundary

- Run the repository's supported compiler and configuration matrix where the change can vary by compiler, standard mode, architecture, or linkage.
- Use focused sanitizers when supported and relevant. UndefinedBehaviorSanitizer is execution-path evidence for enabled checks, not proof that no undefined behavior remains.
- Exercise zero, one, maximum, and ownership-transfer sizes at buffer boundaries, plus allocation failure only where the program models it.
- For ABI changes, build and run at least one real consumer against the produced artifact. For concurrency changes, include the repository's race or thread instrumentation when available.
- Recheck optimized output for bugs whose symptom depends on layout, timing, or undefined assumptions.

## Completion evidence

- Compiler, standard, ABI, ownership, and lifetime assumptions affected by the change
- Build and runtime evidence from the relevant consumer and configuration boundary
- Sanitizer, concurrency, or optimized-build evidence when those risks are material, with unavailable checks stated explicitly

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
