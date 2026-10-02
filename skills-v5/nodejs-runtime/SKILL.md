---
name: nodejs-runtime
description: Engineer Node.js runtime systems with event-loop, stream, process, module, resource, and shutdown discipline. Use when the request specifically requires node.js, nodejs, node stream, node process; prefer a narrower child only when its boundary is established.
---

# Nodejs Runtime

## Boundary

Confirm Node version and module mode. Keep event-loop work, worker threads, streams and backpressure, `AbortSignal`, child processes, handles, file descriptors, environment, and process signals explicit. Diagnose saturation, buffering, and leaked resources as different failure classes.

## Hierarchy and routing

- Broader skills: backend-engineering.
- No narrower bundled child is declared.
- Required skills: verification.

Use this skill when the Node runtime itself, process lifecycle, streams, modules, or asynchronous resource ownership is material. A generic backend change that does not depend on Node semantics stays with the broader backend skill. Quoted, historical, negated, fixture-only, or example text is not a live trigger.

## Decisions that change the implementation

- Keep CPU-heavy or long synchronous work off latency-sensitive event-loop paths. Use worker threads only when the workload and ownership justify their cost.
- Respect writable backpressure. A `write()` result and drain behavior are part of the producer-consumer contract, not optional performance hints.
- Prefer stream composition that propagates errors and teardown coherently. When using `pipeline` with `AbortSignal`, account for abort destroying the participating streams.
- Give timers, sockets, child processes, and listeners explicit lifecycle owners so shutdown can reach a terminal state.
- Resolve ESM versus CommonJS and supported Node versions before changing import, package export, loader, or global API behavior.

## Failure discriminators

- If latency spikes without high CPU across the process, distinguish event-loop blocking from downstream I/O, queueing, and stream backpressure.
- If memory grows during streaming, inspect buffering, `highWaterMark`, ignored backpressure, retained listeners, and unconsumed data before raising memory limits.
- If tests finish but the process does not exit, inspect active handles, timers, child processes, sockets, and worker ownership.
- If cancellation reports errors after expected abort, determine whether stream teardown or child-process termination is the actual source before suppressing the error.

## Verification at the Node boundary

- Run focused tests under every supported Node major affected by module or API behavior.
- Exercise stream producer faster than consumer, downstream failure, partial output, and cancellation for changed stream pipelines.
- Verify signal-driven shutdown closes owned handles and reaches expected process termination without leaking work.
- For child-process changes, cover nonzero exit, spawn failure, signal termination, and partial stdout or stderr consumption.
- Measure event-loop or memory behavior only with a representative workload when making runtime performance claims.

## Completion evidence

- Node version, module mode, and resource ownership affected
- Stream, cancellation, or process-lifecycle evidence at the real runtime boundary
- Active-handle, memory, or event-loop evidence when those behaviors are part of the claim

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
