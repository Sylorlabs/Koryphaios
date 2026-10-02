# Source map

Source curation for `c-cpp-systems-engineering`. Routing fixtures and eval IDs remain in `kory.json`. This revision does not claim paired skill/no-skill or blind qualification.

## Adopted primary guidance

- **C++ Core Guidelines**: https://isocpp.github.io/CppCoreGuidelines/CppCoreGuidelines.html
  - Adopted: make ownership and lifetime visible, prefer RAII for resource ownership, and keep non-owning interfaces explicit. The CP.22 and CP.32 sections, inspected on 2026-09-06, distinguish safe callback lock boundaries from ownership shared across overlapping thread lifetimes.
  - Conditional: apply where C++ is the implementation language and repository compatibility permits the stronger ownership shape.
  - Limit: this is a living guidance document, not the normative language standard. It does not prove a program is free of undefined behavior.
- **Clang UndefinedBehaviorSanitizer**: https://clang.llvm.org/docs/UndefinedBehaviorSanitizer.html
  - Adopted: use focused runtime instrumentation for relevant undefined-behavior classes such as bounds, alignment, null, and signed-overflow checks when the configured Clang toolchain supports them.
  - Conditional: sanitizer selection must match the suspected invariant and supported target. Preserve repository sanitizer configuration when it already exists.
  - Limit: UBSan observes enabled checks on executed paths. A clean run is not proof that no undefined behavior exists.
- **CMake buildsystem manual**: https://cmake.org/cmake/help/latest/manual/cmake-buildsystem.7.html
  - Adopted: treat target usage requirements as build-interface contracts when an existing target-based CMake build exposes compile definitions, include paths, link requirements, or language-standard requirements transitively.
  - Conditional: use this only for CMake projects that already model the relevant boundary with targets.
  - Limit: do not restructure a working build merely to follow CMake style guidance.
- **ISO C++ standard information**: https://isocpp.org/std/the-standard
  - Preserved use: identify the current standard family and normative-standard entry point when language-version claims can drift.
  - Limit: the index alone is not evidence for a specific semantic rule. Use the applicable standard or compiler documentation for that rule.

When sources conflict, normative language and platform ABI documents outrank guidelines. Runtime evidence still controls claims about the repository's actual build and consumers.

## Native instrumentation evidence

On 2026-09-06 the Clang [AddressSanitizer](https://clang.llvm.org/docs/AddressSanitizer.html), [ThreadSanitizer](https://clang.llvm.org/docs/ThreadSanitizer.html), and [UndefinedBehaviorSanitizer](https://clang.llvm.org/docs/UndefinedBehaviorSanitizer.html) usage and limitation sections were inspected. The adopted pattern is to instrument compilation and final linking, exercise the relevant failure class, retain reports, and distinguish executed-path results from a universal safety proof. The current web documentation describes a development Clang version; the local fixture records its actual compiler identity rather than treating that page as the installed version.

The callback evaluator uses optimized, ASan/UBSan, and separate TSan builds. The frame evaluator uses C11 compilation, optimized and ASan/UBSan clients, and an explicit 32-bit arithmetic contract on the host architecture. Weak ownership and destructor counts test the callback lifetime requirement; they are not a general-purpose heap leak audit. Sanitizers and temporary workspaces are not a hostile-code sandbox.
