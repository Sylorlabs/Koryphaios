# Source map

Source curation for `go-engineering`. Routing fixtures and eval IDs remain in `kory.json`. This revision does not claim paired skill/no-skill or blind qualification.

## Adopted primary guidance

- **Go memory model**: https://go.dev/ref/mem
  - Adopted: treat unordered conflicting accesses as a data-race boundary and rely on stronger sequential-consistency reasoning only for race-free programs.
  - Conditional: use the memory model when shared-memory ordering is material. It is not a reason to replace message passing or ownership patterns that are already simpler.
  - Limit: the model describes language guarantees, not whether this program is race-free.
- **Go data race detector**: https://go.dev/doc/articles/race_detector
  - Adopted: run race-enabled tests for concurrency changes when the supported platform and runtime cost permit it, and use realistic workloads to expand exercised paths.
  - Conditional: prioritize it for shared-memory, goroutine-lifecycle, and synchronization changes.
  - Limit: the detector finds races only on execution paths that run. A clean result is not proof of absence.
- **Go language specification**: https://go.dev/ref/spec
  - Preserved use: language semantics, types, interfaces, channels, and version-sensitive syntax.
  - Adopted from Program execution, opened 2026-09-06: returning from `main` ends the program without waiting for other goroutines. Adapt shutdown checks to inspect explicit joins and cleanup; reject the claim that background goroutines keep a returned `main` alive.
  - Limit: the specification does not prove goroutine termination, shutdown behavior, or absence of races in a concrete program.

Repository tests and runtime observations control claims about goroutine ownership and shutdown. The specification controls language semantics.
