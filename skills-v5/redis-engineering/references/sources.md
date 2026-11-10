# Source map

## Adopted principles

- Eviction policy is part of the data loss contract, not merely a tuning setting. Redis documents distinct policies and their behavior under `maxmemory` pressure.
- Redis transactions do not support rollback. Errors can occur before execution or within the executed command sequence, so callers must verify the resulting state and design invariants accordingly.
- Cache, coordination, stream, queue, and authoritative store uses have different durability and recovery needs and should not share one blanket operating recipe.
- A lease with a single primary is acquired with `SET NX PX` and a unique token. Redis's documented safe release compares that token in the delete operation: `DELEX IFEQ` is available starting in Redis 8.4, with a Lua compare and delete for earlier versions. Compare and extend also requires one atomic operation, and the lease does not fence writes to an external store.
- Redis Streams consumer groups track pending entries separately from application effects. Claiming an eligible pending entry resets its idle age, while a claim rejected for insufficient idle time does not. `XAUTOCLAIM JUSTID` does not increment attempted deliveries; acknowledgement and effect deduplication require separate application decisions.

## Conditional recipes

- A particular eviction policy, persistence mode, cluster layout, distributed lock algorithm, or stream pattern is not adopted universally.
- Redis documentation may describe behavior added in recent versions, such as newer eviction features. Resolve the deployed version before using guidance tied to the version.
- Check support on a Redis server or a managed service for `DELEX IFEQ` (8.4+), `XAUTOCLAIM` (6.2+), and the cluster slot placement of any script that uses multiple keys before recommending those commands. An in memory clocked fixture is a model of expected semantics; it does not verify actual expiry timing, replication/failover, or external side effect atomicity.

## Verification scope

Official documentation establishes command, transaction, and eviction semantics. It does not prove memory pressure, failover loss windows, hot key distribution, persistence latency, or managed service configuration in the target deployment. Those require runtime evidence.

For lease fixes, execute the release at the exact TTL with **no successor** and stale release/renewal after a successor, then test versioned publication against a paused worker. For Streams, inspect the real pending list before and after early/eligible claims, crash and replay across `XACK`, and DLQ/ack recovery. Label tests as simulator only or Redis backed; record the Redis version, topology, command results, and negative paths before asserting runtime safety.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader backend-engineering.
- Routing: five positive, five negative near neighbors, three compound/ambiguous, and three adversarial held out cases through the real resolver.
- Full task evaluation: two individual scenarios with six falsifiable checks, skill and no skill pairing with the same model, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **Redis eviction**: https://redis.io/docs/latest/develop/reference/eviction/
  - Scope: Redis latest documentation checked 2026-09-06.
  - Use: `maxmemory` and eviction policy semantics; version sensitive features require deployed version confirmation.
- **Redis transactions**: https://redis.io/docs/latest/develop/using-commands/transactions/
  - Scope: Redis latest documentation checked 2026-09-06.
  - Use: `MULTI`, `EXEC`, `WATCH`, transaction errors, and semantics with no rollback.
- **Redis distributed locks**: https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/
  - Scope: Redis current lock pattern documentation checked 2026-10-10; `DELEX IFEQ` requires Redis 8.4+.
  - Use: `SET NX PX` unique tokens; atomic compare and delete via `DELEX IFEQ` or Lua; bounded lease extension, fencing, and failover limitations.
- **Redis SET**: https://redis.io/docs/latest/commands/set/
  - Scope: Redis current command reference checked 2026-10-10.
  - Use: `NX`, `PX`, and conditional options that depend on the version for lease acquisition.
- **Redis XAUTOCLAIM**: https://redis.io/docs/latest/commands/xautoclaim/
  - Scope: Command available since Redis 6.2; current reference checked 2026-10-10.
  - Use: eligible pending messages, idle reset on claim, cursor scan, the `JUSTID` delivery count caveat, and deleted entry replies that depend on the version.
- **Redis XPENDING and XACK**: https://redis.io/docs/latest/commands/xpending/ and https://redis.io/docs/latest/commands/xack/
  - Scope: Redis current command references checked 2026-10-10; `XPENDING IDLE` filter requires Redis 6.2+.
  - Use: inspecting pending ownership/age and separating consumer group acknowledgement from durable business effects.
