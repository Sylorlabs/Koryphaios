# Source map

This package is individually authored for V5; empirical qualification is tracked separately in the audit/evaluation ledger. Re-check the actual repository framework/runtime before applying version-sensitive details; the sources establish patterns and current tool behavior, not a universal command line.

## Authoritative and versioned sources

- **Hypothesis 6.167.1**: https://hypothesis.readthedocs.io/en/latest/
  - Release: 6.167.1, 2026-08-30; verified 2026-11-07.
  - Use for: property-based generated domains, shrinking, stateful testing, settings, failure replay, and seed behavior.
  - Important boundary: a fixed seed reproduces generated choices only when other nondeterminism is controlled. The current replay guide recommends durable explicit examples for correctness instead of relying only on the local example database or version-sensitive opaque replay blobs.

- **Go fuzzing / Go 1.27.1 release line**: https://go.dev/doc/security/fuzz/
  - Verified 2026-11-07 against Go 1.27.1, released 2026-09-01.
  - Use for: deterministic fuzz targets, seed versus generated corpora, coverage-guided execution, target isolation, and replaying seed-corpus entries as ordinary tests.
  - Important boundary: coverage instrumentation and supported fuzz argument types are implementation/runtime constraints; inspect the actual Go version and target architecture before prescribing them.

- **LLVM libFuzzer**: https://llvm.org/docs/LibFuzzer.html
  - Snapshot verified 2026-11-07; libFuzzer requires a matching Clang version.
  - Use for: coverage-guided corpus growth, seed reporting, bounded `-runs`/time campaigns, crash artifacts, `-minimize_crash`, and corpus merge/minimization.
  - Important boundary: libFuzzer is still supported, but its original authors have moved active feature work to Centipede. Do not present libFuzzer-specific flags as framework-neutral property-testing behavior.

- **OSS-Fuzz ideal integration**: https://google.github.io/oss-fuzz/advanced-topics/ideal-integration/
  - Snapshot verified 2026-11-07.
  - Use for: repository-owned fuzz targets, small representative seed corpora, dictionaries, coverage monitoring, sanitizer-backed regression execution, and adding former bug-triggering inputs to the maintained corpus.
  - Important boundary: a minimal corpus means minimal for the chosen coverage signal, not proof that the explored behavioral space is complete.

- **jqwik 1.9.3 Property API**: https://jqwik.net/docs/1.9.3/javadoc/net/jqwik/api/Property.html
  - Version: 1.9.3; verified 2026-11-07.
  - Use for: a second versioned property-testing implementation with explicit tries, seed, maximum discard ratio, edge-case, and shrinking controls.
  - Important boundary: shrinking and seed semantics differ across frameworks. Preserve the framework/version identity with any reproduction claim.

## High-quality practitioner and research patterns

- **Csmith**: https://github.com/csmith-project/csmith
  - Repository snapshot verified 2026-11-07; related PLDI 2011 work is “Finding and Understanding Bugs in C Compilers,” DOI 10.1145/1993316.1993532.
  - Pattern: generate only programs inside a semantics-preserving domain, compare independent implementations, treat disagreement as a bug signal rather than proof of which implementation is wrong, and reduce the disagreement before reporting it.
  - Why it matters here: differential testing fails as an oracle when generated inputs admit undefined/unspecified behavior or when compared implementations share the same faulty logic.

- **Metamorphic testing study**: https://doi.org/10.1109/TSE.2013.46
  - IEEE Transactions on Software Engineering study, verified 2026-11-07.
  - Pattern: when exact expected outputs are unavailable or expensive, assert justified relations among outputs from related inputs/executions.
  - Why it matters here: a metamorphic relation is itself part of the specification. Do not invent transformations that merely “seem reasonable.”

## Applied interpretation rules

1. Resolve the actual generator/fuzzer, version, runtime, sanitizer, architecture, and corpus format before using tool-specific flags or replay guarantees.
2. Separate **discovery identity** (seed, opaque replay token, corpus artifact) from **durable regression identity** (explicit minimized input or maintained corpus entry). Preserve both when useful.
3. Keep generated targets deterministic with respect to the input. If nondeterminism is intrinsic, record it and weaken the reproduction claim rather than retrying until a failure disappears.
4. Treat shrinking as preservation of a failing predicate under a framework-specific shrink order. A shrunk result is not automatically the globally smallest reproducer.
5. Treat coverage as a search signal. Report unreached or structurally inaccessible partitions; do not equate coverage percentage, corpus size, or a time-bounded pass with correctness.
6. For differential oracles, pin every compared implementation/version/configuration and normalize only differences explicitly allowed by the contract.
