# State authority and concurrency

Read when a backend changes shared state, enforces a limit, maintains derived state, or changes persisted representations. These decisions apply to files and application cores as well as databases; they do not require a distributed service.

## Protect the invariant, not just a write

1. Name the authority and every writer. Check identity, tenant or owner scope, authorization, and transition preconditions at that boundary. A cached permission result or caller supplied owner ID must not authorize a different resource. A denied operation must leave durable state and external effects unchanged.
2. Identify the competing read and write sets. Atomic replacement prevents a torn value but does not prevent lost updates. A version check on one entity does not protect an invariant across several entities or a predicate such as remaining capacity. Use a supported atomic conditional mutation, durable constraint, shared lock, or sufficient transaction isolation, and handle rejection explicitly. Check affected rows or the conditional result rather than returning success after losing a race.
3. Inspect the actual engine, adapter, isolation level, lock scope, and commit behavior. A transaction at the default isolation level is not universally serializable. A conflict or deadlock can require retrying the entire transaction, including its reads, with a bounded budget. Keep external effects out of a retried transaction unless the effect boundary independently makes replay safe. PostgreSQL 18 isolation documentation is an example of these distinctions, not a guarantee for another engine.
4. Give caches, indexes, and aggregates a freshness and repair contract relative to authoritative state. Publish or invalidate only from committed state through a recoverable path. Define whether a stale read is admissible; never silently convert unavailable or unknown state into an empty, absent, or successful result.

## Evolve and retire state safely

When a task changes storage, inspect representative prior versions, incomplete records, and concurrent old writers. Establish migration ownership and interruption semantics before backfill or destructive replacement. Preserve an intact readable state until the replacement is validated. Separate a reversible application release from an irreversible data conversion; do not promise rollback when the old reader cannot interpret the new data. Test forward recovery when that is the supported path.

Bound retained identities, caches, logs, pending work, and cleanup batches without deleting evidence still required for retries, replay, or repair. Tombstones and idempotency records are correctness state when old inputs can return. Make the retention horizon and behavior outside it explicit.

## Evidence

Force competing operations to read the same old state with a barrier or deterministic schedule, then allow them to commit. Assert the domain invariant, the losing caller's result, and unchanged unrelated or other tenant state. Merely starting two promises or sleeping does not prove overlap. Include a writer outside the process when claiming protection across processes. Check actual committed reads after success, denial, cancellation, and a conflict; use the real store for isolation claims. For schema changes, reopen realistic migrated state and interrupt at a meaningful conversion boundary. Label simulated storage, missing migrations, and unsupported writer topologies explicitly.

See [the source map](sources.md) for the source boundaries behind isolation, retries, and recovery guidance.
