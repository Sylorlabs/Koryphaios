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
- Choose expiration and eviction policy from the data-loss contract. A cache may tolerate eviction; authoritative or coordination state often cannot.
- Use Redis transactions, scripts, or single commands only for invariants they actually provide. Redis transactions serialize queued commands but do not provide rollback after runtime command errors.
- Treat distributed locks as leases whose authority can end while a worker is paused. Expiry alone does not prove an old holder can no longer perform an external side effect. Protect publication or other external effects with a fencing token, source revision, monotonic version, or an atomic server-side check-and-effect at the real side-effect boundary. A separate ownership check immediately before a later write still has a time-of-check/time-of-use race.
- Put a concrete upper bound on lease TTL and renewal duration derived from the operation and recovery contract. Reject unbounded or merely positive TTLs when the design claims leases are bounded.
- Design key shape and cluster slotting around access locality and hot-key risk before assuming horizontal scale fixes contention.

## Observable checks

For Streams, distinguish pending ownership, last delivery time, application effect identity and acknowledgement. A crash after the effect but before acknowledgement must remain reclaimable after the idle threshold while replay converges without another effect. Do not reset the idle timestamp merely because an early claim was denied. Exercise this sequence and the bounded poison message path in retained regression tests; distinguish a local model from an actual Redis consumer group run.

- Force TTL expiry and configured eviction pressure and verify the application response to missing state.
- Exercise transaction or script failure cases, including errors that occur after `EXEC`, and verify the resulting state rather than assuming rollback.
- Reconnect clients and, where in scope, exercise failover with the configured persistence and replication mode.
- Replay duplicate work through queue, stream, or retry paths and verify idempotency or deduplication at the real side-effect boundary.
- For lease-controlled refresh or publication, pause one worker past expiry, let a newer owner acquire and publish, then resume the stale worker and prove it cannot overwrite the newer result. Exercise this against the publication/versioning mechanism, not only against lock release or renewal.
- Load-test representative key distributions to expose hot keys, stampedes, memory pressure, and serialization cost when those claims matter.

## Completion evidence

- Redis role, durability, TTL, and eviction decision for the data in scope.
- Atomicity, expiry/eviction, retry, and reconnect results actually exercised.
- Explicit unknowns for failover, cluster topology, and production key distribution when not tested.

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
