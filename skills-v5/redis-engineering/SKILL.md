---
name: redis-engineering
description: Engineer Redis usage around data structures, atomicity, TTL, persistence, clustering, eviction, and failure semantics. Use when the request specifically requires redis, redis cache, redis stream, redis cluster; prefer a narrower child only when its boundary is established.
---

# Redis Engineering

## Responsibility

Define whether Redis is a cache, coordination service, queue, stream, rate limiter, or authoritative store because durability and recovery differ. Choose data structures and Lua/transactions for the invariant, make TTL and eviction explicit, and model cluster slotting, failover, hot keys, and stampedes.

Verification focus: Exercise expiry, eviction, reconnect, failover assumptions, duplicate/replayed work, atomic operations, serialization compatibility, and load patterns with realistic key distributions.

Failure boundaries: Do not treat cache presence as truth, use KEYS in production paths, depend on distributed locks without fencing/expiry analysis, or let retry loops multiply writes.

## Hierarchy and routing

- Broader skills: backend-engineering.
- No narrower bundled child is declared.
- Required skills: verification.

## Decision rules

- First classify Redis as cache, coordination state, queue or stream, rate limiter, or authoritative data. Persistence, eviction, and recovery requirements depend on that role.
- Choose expiration and eviction policy from the data loss contract. A cache may tolerate eviction; authoritative or coordination state often cannot.
- Use Redis transactions, scripts, or single commands only for invariants they actually provide. Redis transactions serialize queued commands but do not provide rollback after runtime command errors.
- For a refresh lease with a single primary, acquire with a unique token per acquisition and an atomic `SET key token NX PX ttl`. Release only by comparing that token and deleting in the **same Redis operation**: `DELEX key IFEQ token` requires Redis 8.4+, while earlier versions need a compare and delete script. Renew only with an operation that compares token and expiry, supported by the pinned deployment. A separate `GET` followed by `DEL` or `PEXPIRE` races with expiry and reassignment.
- Preserve an existing lock API while adding fencing or expiry safety. Inspect its starting signatures and caller assertions first: if `acquire(owner, now, ttl)` returns a Boolean, keep `true` for acquisition and `false` for contention; do not change it to a lease object or `null` to expose a fence. Store the token/fence in lock state or expose it separately. Change a method signature only when correctness requires it, such as adding the clock to `release(owner, now)` in a deterministic TTL simulator.
- Treat distributed locks as leases whose authority can end while a worker is paused. Expiry alone does not prove an old holder can no longer perform an external side effect. Protect publication or other external effects with a fencing token, source revision, monotonic version, or an atomic check and effect performed server side at the real side effect boundary. A separate ownership check immediately before a later write still leaves a time of check to time of use race.
- Distinguish the random ownership token used for conditional lock release from an **ordered fencing value**. A random token cannot establish which worker is newer; the destination must atomically reject a fence/revision older than its last accepted value. Verify that the fence issuer cannot reuse or roll back accepted values after restart or failover, or use a durable source revision enforced at the destination instead.
- Put a concrete upper bound on lease TTL and renewal duration derived from the operation and recovery contract. Reject unbounded or merely positive TTLs when the design claims leases are bounded.
- Treat a lock command that times out or a lost reply as an unknown outcome until reconciled; confirm Redis version, primary/replication topology, script support, and key access across slots before relying on atomicity or failover behavior. If the lock disappears or the primary changes, cache publication still needs its own stale writer protection.
- Design key shape and cluster slotting around access locality and hot key risk before assuming horizontal scale fixes contention.

## Observable checks

For Streams, distinguish pending ownership, last delivery time, application effect identity and acknowledgement. A crash after the effect but before acknowledgement must remain reclaimable after the idle threshold while replay converges without another effect. Do not reset the idle timestamp merely because an early claim was denied. Exercise this sequence and the bounded poison message path in retained regression tests; distinguish a local model from an actual Redis consumer group run.

- For Redis Streams consumer groups, persist an idempotency key at the **actual side effect store**, using a stable business operation identity where retries may receive different stream IDs. Apply or detect the durable effect before `XACK`; `XACK` removes an entry from the pending list, not the business effect. Make dead letter publication and acknowledgement recoverable after a crash, with a finite retry budget and DLQ handling that tolerates duplicates.
- Use `XPENDING` to inspect pending age and owners; recover idle messages with `XAUTOCLAIM` only where the server supports it (Redis 6.2+). A **successful** claim resets the pending idle age; a claim rejected as too early must leave it unchanged. `XAUTOCLAIM JUSTID` does not increment the delivery counter, so do not build a poison message budget solely on that counter when using `JUSTID`.
- Before removing a stale consumer, stop new delivery under its name, claim or acknowledge its pending work, then confirm `XGROUP DELCONSUMER` reports **zero** pending entries. Deleting a consumer with pending entries makes those entries unclaimable from the group's PEL; a positive count of deleted pending entries requires loss/reconciliation reporting, not a successful recovery claim. Verify the drain and a deliberately premature removal separately on a disposable stream.
- Run `XAUTOCLAIM` as a bounded cursor scan until its returned cursor reaches `0-0`; an empty claimed batch does not prove all pending entries were inspected or were idle long enough. Schedule later passes for newly eligible entries. On Redis 7.0+, separately count deleted/trimmed stream IDs that `XAUTOCLAIM` purges from the PEL; those IDs were **not** processed or safely dead lettered and need reconciliation. Test partial pages, no eligible entries, and a missing payload with the pinned version's reply shape.
- When simulating Redis TTL, inject a clock into every operation that reads lease state, including release. Test release at the exact expiration boundary **without any successor**, as well as after a replacement owner acquires. Redis itself treats an expired key as absent; a simulator that releases an expired lease successfully has hidden that failure.
- Retain existing assertions about acquisition return values alongside new lease tests. For a Boolean `acquire`, assert successful acquisition is exactly `true` and contended acquisition exactly `false`; also assert an expired release without a successor fails, and a stale owner cannot release or renew a successor's lease. Rewriting public tests to accept a new return type does not establish compatibility.
- Retain named Streams regressions for crash before effect, crash after durable effect but before `XACK`, early claim rejection, claim after the idle threshold, competing claim/duplicate replay, recovery after consumer removal, and bounded poison handling that reaches the DLQ. Assert both the side effect count and the final pending/ack state; a successful process return alone is insufficient.
- When repairing a supplied Streams model, inspect its existing public API and baseline behavior before editing. Preserve unrelated exported types and coordination classes if Streams and locks share a source file. If the starter already passes crash/replay and poison handling, keep that behavior and add the missing executable regression coverage and evidence instead of rewriting working code. Preserve method arguments visible to callers and the exposed pending/effect/DLQ state unless the task explicitly requires changing them.
- In a clocked pending recovery model, make the regression order observable: crash after applying one effect but before ack leaves one pending message; a claim below the idle threshold fails without changing its pending timestamp; an eligible claim resets that timestamp; replay acks the message with the original effect count still equal to one. Exercise poison delivery repeatedly until its finite retry limit sends the message to the DLQ and acknowledges it; further delivery must not duplicate the DLQ entry. Include a separate crash before effect path and a stale or removed consumer path. Store a parseable verification artifact and execute the new tests before declaring those behaviors verified.
- For each evaluated scenario, keep an executable verification matrix tying expiry, eviction, reconnect, failover, duplicate/replayed work, atomicity, serialization compatibility, and skewed key load to named tests and observed assertions. Exercise eviction by dropping lease/cache state, reconnect by changing client availability/authority, replay by repeating an effect, serialization by decoding old/new payloads, and key skew through a deterministic hot key workload. These may use narrowly scoped fault injection when the starting fixture is synthetic; state clearly which checks used real Redis, an in memory model, or were unavailable. Describing a risk or including it in metadata does not demonstrate verification.
- Force TTL expiry and configured eviction pressure and verify the application response to missing state.
- Exercise transaction or script failure cases, including errors that occur after `EXEC`, and verify the resulting state rather than assuming rollback.
- Reconnect clients and, where in scope, exercise failover with the configured persistence and replication mode.
- Replay duplicate work through queue, stream, or retry paths and verify idempotency or deduplication at the real side effect boundary.
- For refresh or publication controlled by a lease, pause one worker past expiry, let a newer owner acquire and publish, then resume the stale worker and prove it cannot overwrite the newer result. Exercise this against the publication/versioning mechanism, not only against lock release or renewal.
- Load test representative key distributions to expose hot keys, stampedes, memory pressure, and serialization cost when those claims matter.

## Completion evidence

- Redis role, durability, TTL, and eviction decision for the data in scope.
- Atomicity, expiry/eviction, retry, and reconnect results actually exercised.
- Explicit unknowns for failover, cluster topology, and production key distribution when not tested.
- Only report successful tests, builds, and metadata validation for commands whose actual execution evidence is available. Identify unavailable or simulated checks explicitly.

Use [the maintained source map](references/sources.md) for version sensitive facts and source conflicts.
