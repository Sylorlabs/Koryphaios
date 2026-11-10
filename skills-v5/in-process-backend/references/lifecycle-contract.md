# Lifecycle contract and evidence receipt

Use this worksheet for a stateful module that remains in the host process. It keeps ownership, state, schedule, and evidence decisions visible without prescribing a service or framework.

## Boundary record

Record the current requested responsibility, caller entrypoint, host runtime, process topology, state authority, restart model, and adjacent responsibility. State why a service, daemon, broker, or distributed coordinator is not required. A fixture or task name is not topology evidence.

## Ownership table

| Resource                        | Created or borrowed | Lifetime owner | Release or join path | Late use guard |
| ------------------------------- | ------------------- | -------------- | -------------------- | -------------- |
| Durable store or adapter        |                     |                |                      |                |
| Worker, task, or refresh flight |                     |                |                      |                |
| Timer, listener, or callback    |                     |                |                      |                |
| Temporary file or buffer        |                     |                |                      |                |

For every created resource, state the partial initialization unwind order. For every borrowed resource, state who may close it. Close admission before waiting for accepted work, then join or cancel participants, dispose registrations, and mark the owner closed.

## State and linearization record

| State or transition | Owner | Precondition | Commit or linearization point | Durable identity | Caller result | Recovery action |
| ------------------- | ----- | ------------ | ----------------------------- | ---------------- | ------------- | --------------- |
|                     |       |              |                               |                  |               |                 |

Keep `effect applied`, `durably recorded`, and `acknowledged` distinct when a crash can occur between them. A timeout after dispatch is `unknown` until an operation record or authoritative read reconciles it.

## Schedule and fault matrix

Exercise the sequential control and named interleavings. Do not use elapsed time as proof that a schedule occurred.

| Schedule or fault                         | Expected terminal state                    | Required observation                                           |
| ----------------------------------------- | ------------------------------------------ | -------------------------------------------------------------- |
| Duplicate callers or workers              | One logical owner, or an explicit conflict | Both reads, claim/commit order, and effect count               |
| Cancellation or close before work         | Contractual rejection or cancellation      | No late effect, callback, timer, or retained waiter            |
| Failure before durable commit             | Retry or terminal failure by policy        | Fresh owner sees authoritative state                           |
| Failure after effect before recording     | Reconcile or safely replay                 | Stable logical identity and no duplicate non idempotent effect |
| Timeout with a non cooperative dependency | Bounded public settlement                  | New work can acquire the released slot; late result is ignored |
| Recovery followed by new work             | Useful operation succeeds                  | Old generation cannot mutate the new owner                     |

For a simulated scheduler, phase driver, fake clock, map, or in memory restart, label the receipt `simulated`. It verifies the model's transitions only. Real SQLite durability, process restart, OS thread scheduling, dependency behavior, resource retention, and production recovery require the corresponding host boundary.

## Evidence receipt

Retain the exact command, source revision, runtime identity, fixture or store identity, schedule IDs actually executed, observed state and effect counts, cleanup result, and failures. Mark each claim as `observed`, `simulated`, `unavailable`, `inferred`, `stale`, or `unresolved`. A passing source inspection, generated artifact, or happy path is not a host runtime receipt.
