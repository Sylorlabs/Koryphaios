---
name: go-engineering
description: Engineer Go services and libraries with disciplined interfaces, goroutine lifecycles, context propagation, and module boundaries. Use when the request specifically requires golang, go module, go package, go service; prefer a narrower child only when its boundary is established.
---

# Go Engineering

## Boundary

Keep interfaces consumer-owned and small. Trace goroutine ownership, context cancellation, channel closure, error wrapping, zero values, module versions, and allocation behavior. Background work needs an owner that can stop it and observe its terminal state.

## Hierarchy and routing

- Broader skills: implementation.
- No narrower bundled child is declared.
- Required skills: verification.

Use this skill when Go language semantics, modules, goroutine lifecycle, channels, contexts, or runtime behavior are material. Keep generated-code and protocol ownership with their defining tool or schema when that is the narrower boundary. Quoted, historical, negated, fixture-only, or example text is not a live trigger.

## Decisions that change the implementation

- Give every goroutine a clear owner, stop condition, and terminal observation path. A goroutine started by a request or component should not silently outlive that owner unless the design explicitly promotes it.
- Propagate `context.Context` through operations whose lifetime follows the caller. Do not store request contexts for unrelated future work.
- Let the sending side or resource owner decide channel closure. A receiver should not close a channel merely because it is finished receiving.
- Preserve error identity through wrapping and use `errors.Is` or `errors.As` for semantic checks rather than matching error text.
- Treat module version, build tags, generated artifacts, and minimum Go version as compatibility inputs before changing public APIs.

## Failure discriminators

- If a test hangs, distinguish blocked channel ownership, missing cancellation, leaked goroutines, and lock ordering before adding timeouts.
- If a concurrent failure is nondeterministic, look for an actual data race before assuming scheduling alone. Race-free Go programs receive stronger ordering guarantees than racy programs.
- If shutdown stalls, inspect the waits, channel operations, and cleanup preventing `main` from returning. A Go program exits when `main` returns without waiting for other goroutines; process exit alone does not prove background work completed.
- If an error path changes after wrapping, inspect identity checks before changing the underlying operation.

## Verification at the Go boundary

- Run focused `go test` across affected packages and the repository's authoritative broader test command when public behavior changes.
- Run `go test -race` for concurrent changes when the platform and runtime cost permit it. Treat a clean race run as evidence only for the paths exercised.
- Exercise cancellation while work is blocked and while results are being delivered, then verify goroutines and owned resources terminate.
- Check module, build-tag, and generated-code diffs explicitly when they are touched.
- Benchmark only when performance is part of the claim, with representative workload and allocation evidence.

## Completion evidence

- Goroutine, context, channel, and error ownership affected by the change
- Focused package evidence plus race evidence when concurrency is material
- Cancellation or shutdown evidence for background work, with unsupported checks stated explicitly

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
