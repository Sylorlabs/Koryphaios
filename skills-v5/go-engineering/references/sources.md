# Source map

`go-engineering` is individually authored for V5; empirical qualification is
tracked separately in the audit/evaluation ledger. The Go toolchain, standard
library contracts, and module behavior are version sensitive. Resolve the
repository's declared Go version and dependency graph before relying on newer
syntax, APIs, or commands.

## Maintained sources

- **Go language specification**: https://go.dev/ref/spec
  - Scope: language semantics, types, interfaces, channels, and program execution.
  - Use: returning from `main` does not join other goroutines; explicit ownership and cleanup evidence is required.
  - Verified: 2026-09-06; refresh after 90 days.
- **Go memory model**: https://go.dev/ref/mem
  - Scope: current Go memory order and data race guarantees.
  - Use: reason about unordered conflicting accesses and stronger ordering only for race free programs.
  - Verified: 2026-09-06; refresh after 90 days.
- **Go data race detector**: https://go.dev/doc/articles/race_detector
  - Scope: the supported `go test -race` workflow and detector limits.
  - Use: prioritize exercised shared memory and synchronization paths; a clean run is not proof for paths that did not execute.
  - Verified: 2026-09-06; refresh after 90 days.
- **Effective Go**: https://go.dev/doc/effective_go
  - Scope: Go naming, formatting, interfaces, zero values, errors, and package idioms.
  - Use: prefer Go native package structure and conventions; the page itself notes that it does not cover newer modules or libraries, so newer behavior needs current documentation.
  - Verified: 2026-10-17; refresh after 90 days.
- **`context` package documentation**: https://pkg.go.dev/context
  - Scope: current standard library context contract.
  - Use: pass context explicitly as the first parameter, do not store it in structs, call cancel functions, and distinguish cancellation signals from waiting for work to stop.
  - Verified: 2026-10-17; refresh after 30 days.
- **Canceling operations in progress**: https://go.dev/doc/database/cancel-operations
  - Scope: request and database cancellation with deadlines.
  - Use: pass derived contexts into supported downstream APIs and defer their cancel functions; a context is effective only where the dependency observes it.
  - Verified: 2026-10-17; refresh after 90 days.
- **`errors` package documentation**: https://pkg.go.dev/errors
  - Scope: current `errors.Is`, `errors.As`, wrapping, and joined error behavior.
  - Use: preserve and inspect semantic identity rather than matching error text; package APIs must decide which underlying conditions they expose.
  - Verified: 2026-10-17; refresh after 30 days.
- **Working with Errors in Go 1.13**: https://go.dev/blog/go1.13-errors
  - Scope: error wrapping and public API compatibility decisions.
  - Use: wrap only conditions the package is willing to expose and document; use `%w` to preserve caller inspectable identity.
  - Verified: 2026-10-17; refresh after 180 days.
- **Managing dependencies**: https://go.dev/doc/modules/managing-dependencies
  - Scope: modules, `go.mod`, `go.sum`, replacement directives, toolchain requirements, and dependency workflows.
  - Use: verify a module outside the local workspace and keep declared requirements and checksums authoritative.
  - Verified: 2026-10-17; refresh after 30 days.
- **Getting started with fuzzing**: https://go.dev/doc/tutorial/fuzz
  - Scope: Go fuzz test structure, seed corpora, and execution boundaries.
  - Use: apply fuzzing to input and parser invariants after deterministic tests establish the ordinary contract; retain minimized failures as regression inputs.
  - Verified: 2026-10-17; refresh after 90 days.

## Interpretation rules

- Official Go specifications and package documentation control language and
  standard library semantics. Current package documentation controls APIs that
  have evolved after older blog posts.
- Repository tests and runtime observations control claims about a concrete
  package's goroutine ownership, dependency cancellation, shutdown, storage,
  process, and network boundaries.
- `go test`, the race enabled Go test command, `go vet`, fuzzing, and goroutine count checks are
  evidence about the paths and workload they exercise. They are not substitutes
  for process crash, broker, disk durability, or non cooperative dependency
  evidence.
- Refresh a source before relying on it after its declared interval, and record
  the repository's actual Go version or module graph when a claim depends on
  it.
