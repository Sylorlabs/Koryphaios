---
name: go-engineering
description: Engineer Go services and libraries with disciplined interfaces, goroutine lifecycles, context propagation, and module boundaries. Use when the request specifically requires golang, go module, go package, go service; prefer a narrower child only when its boundary is established.
---

# Go Engineering

## Boundary

Use this skill when Go language semantics, modules, package APIs, goroutine
lifecycle, channels, contexts, errors, or runtime behavior are material. Start
by identifying the package boundary, the caller visible contract, the owner of
each resource, and the supported Go toolchain. Keep generated code and wire
protocol ownership with their defining tool or schema when that is the narrower
boundary. Quoted, historical, negated, fixture only, and example text is not a
live trigger.

## Idiomatic package and API design

- Prefer short, consumer owned interfaces at the point of use. Do not create an
  interface solely to make a test double; define the smallest behavior the
  consumer needs and use a concrete implementation when no substitution
  boundary exists.
- Make the zero value useful when practical. Document constructors when a type
  cannot safely work at its zero value, and document ownership of returned
  slices, maps, readers, buffers, and closeable resources.
- Use ordinary Go names, package qualified names, `gofmt`, and doc comments for
  exported identifiers. Prefer early returns for errors and avoid getters,
  wrapper types, or abstractions that only translate another language's idioms.
- Treat an `error` interface as a two part value: a dynamic type and a dynamic
  value. Returning a typed nil pointer as `error` is non nil. Return a literal
  nil on success and test this at the owning boundary rather than adding
  reflection or caller specific fixes.
- Keep error identity deliberate. Use `%w` only when the wrapped condition is
  part of the caller contract; use `errors.Is` for sentinels and
  `errors.As` for typed conditions. Do not compare wrapped errors by text or
  expose an implementation error accidentally.
- Preserve compatibility inputs before changing an exported API: module path,
  minimum Go version, build tags, generated code, `go.work`, replacement
  directives, and the ownership of any public sentinel or error type.

## Hierarchy and routing

- Broader skill: `implementation`.
- Required skill: `verification`.
- No narrower bundled Go child is declared. A protocol or generated code
  specialist owns its schema and wire compatibility; this skill owns the Go
  package behavior around that boundary.
- Select this skill for an implementation or repair in Go, including idioms,
  module resolution, goroutine lifecycle, channel ownership, context
  propagation, error contracts, or Go specific tests.
- Pair it with `grpc-protobuf` when the task changes gRPC or protobuf schema,
  generated clients, status mapping, or wire compatibility. Pair it with
  `c-cpp-systems-engineering` when cgo or native ABI ownership is material.
  Pair it with `concurrency-debugging` for diagnosis only work, and with
  `testing-engineering` or `verification` when the request is test strategy or
  evidence only and no Go implementation is requested.
- Do not activate on “go or no go”, “go to market”, a quoted or historical Go
  mention, a pasted `go.mod` or test log transformation, or a request that
  explicitly forbids changing or testing the Go package.

## Concurrency and lifetime decisions

- Give every goroutine a clear owner, stop condition, and terminal observation
  path. A goroutine started by a request or component must not silently outlive
  that owner unless the design explicitly promotes it to a longer lived owner.
- Bound concurrency at the admission point. A semaphore or worker pool must
  make acquisition, work, result delivery, and shutdown cancellation aware;
  `N` workers does not make an unbounded queue or an uncancellable dependency
  safe.
- Add to a `sync.WaitGroup` before starting a goroutine, call `Done` on every
  exit path, and wait from the owner. Do not copy a mutex, wait group, or other
  synchronization value after first use. Prefer explicit ownership over a
  shared “fire and forget” helper.
- Let the sending side or resource owner close a channel exactly once. A
  receiver that has finished consuming must not close a channel it does not
  own. A result channel may remain open if its owner does not promise closure,
  but that contract must be explicit.
- Protect every shared map, slice, and state invariant with one documented
  synchronization or ownership rule. Use the race detector to find exercised
  conflicting accesses; do not treat timing, a mutex shaped field, or a clean
  run as proof that unexercised paths are safe.

## Context and cancellation boundaries

- Pass `context.Context` as the first parameter on the call path that follows a
  request, job, or component lifetime. Do not store a request context in a
  struct or use context values for ordinary optional arguments. Do not pass a
  nil context; use `context.TODO()` only as a temporary explicit gap.
- Call `cancel` for every derived context on all control flow paths, normally
  with `defer cancel()` at the owner. A cancel function signals cancellation; it
  does not wait for the operation to stop.
- Verify that each downstream operation observes cancellation and has a real
  transport, database, timer, or process deadline. Context cannot interrupt a
  function that ignores it and blocks forever. Fix that dependency, enforce a
  real deadline, or isolate it behind a killable process boundary before
  claiming leak free shutdown.
- A wrapper goroutine that lets the caller return does not terminate the blocked
  call. If a dependency is intentionally non cooperative, test caller
  responsiveness separately, release the dependency through its documented
  escape path, and label permanent stall cleanup as unproven.
- Treat `context.WithoutCancel` as an explicit lifetime promotion. Record the
  new owner, deadline, cleanup, and terminal observation instead of using it to
  hide a request leak.

## Failure discriminators

- If a test hangs, distinguish blocked channel ownership, missing cancellation,
  an uncooperative dependency, leaked goroutines, lock ordering, and a missing
  `WaitGroup` join before adding a timeout.
- If a concurrent failure is nondeterministic, look for an actual data race,
  an unsynchronized ownership transfer, or a lost wake up before assuming
  scheduling alone. Race free Go programs receive stronger ordering guarantees
  than racy programs.
- If shutdown stalls, inspect waits, channel operations, downstream calls, and
  cleanup preventing the owner from observing termination. A process exiting
  after `main` returns does not prove background work completed.
- If an error path changes after wrapping, inspect sentinel or type identity and
  the package's documented abstraction boundary before changing error text.
- If a module works only in this checkout, test a standalone consumer with the
  declared minimum toolchain. Inspect `go.mod`, `go.sum`, `go.work`, `replace`,
  build tags, generated files, and the module list rather than trusting a
  local workspace replacement.

## Verification at the Go boundary

- Format changed Go files with `gofmt` and run `go vet` for affected packages
  when the repository supports it. Use the package's configured lint/static
  analysis only when it is available; do not claim an unavailable tool ran.
- Run focused `go test` for affected packages first, then the repository's
  authoritative broader command when public behavior changes. Keep tests in
  the owning package unless an external consumer contract requires a separate
  package.
- Run the Go race enabled test command for concurrent changes when the platform and runtime cost
  permit it. Exercise the actual shared state, cancellation, delivery, and
  shutdown paths; a clean race run is evidence only for those paths.
- Test success, expected errors, wrapped sentinel/type identity, deadline
  expiry, cancellation before work, cancellation while blocked, cancellation
  during result delivery, channel closure, and repeated shutdown when those
  boundaries are in scope.
- Use synchronization signals, not sleeps, to arrange concurrent tests. Use a
  timeout only as a test guard. A raw goroutine count is noisy evidence; pair it
  with an owned completion signal, repeated iterations, and resource cleanup.
- Use table driven tests for stable cases, fuzz tests for parser or input
  invariants, and benchmarks only for a stated performance claim with a
  representative workload and allocation evidence. Do not turn a unit mock
  into evidence of network, process, broker, disk, or crash durability.
- Check module, build tag, generated code, and public API diffs explicitly when
  they are touched. Re run source sensitive checks when the declared Go version
  or dependency graph changes.

## Completion evidence

- Package and caller contract, including zero value, interface, and error
  identity behavior affected by the change
- Goroutine, context, channel, resource, and synchronization ownership
- Focused package evidence plus `go vet` and race evidence when applicable
- Cancellation or shutdown evidence for background work, with unsupported
  dependency and storage/process checks stated explicitly
- Go version, module and build tag boundary, relevant source freshness, and any
  generated code check

Use [the maintained source map](references/sources.md) for version sensitive
facts, freshness policy, and source conflicts.
