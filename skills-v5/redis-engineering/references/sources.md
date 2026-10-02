# Source map

## Adopted principles

- Eviction policy is part of the data-loss contract, not merely a tuning setting. Redis documents distinct policies and their behavior under `maxmemory` pressure.
- Redis transactions do not support rollback. Errors can occur before execution or within the executed command sequence, so callers must verify the resulting state and design invariants accordingly.
- Cache, coordination, stream, queue, and authoritative-store uses have different durability and recovery needs and should not share one blanket operating recipe.

## Conditional recipes

- A particular eviction policy, persistence mode, cluster layout, distributed-lock algorithm, or stream pattern is not adopted universally.
- Redis documentation may describe behavior added in recent versions, such as newer eviction features. Resolve the deployed version before using version-sensitive guidance.

## Verification scope

Official documentation establishes command, transaction, and eviction semantics. It does not prove memory pressure, failover loss windows, hot-key distribution, persistence latency, or managed-service configuration in the target deployment. Those require runtime evidence.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader backend-engineering.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **Redis eviction**: https://redis.io/docs/latest/develop/reference/eviction/
  - Scope: Redis latest documentation checked 2026-09-06.
  - Use: `maxmemory` and eviction-policy semantics; version-sensitive features require deployed-version confirmation.
- **Redis transactions**: https://redis.io/docs/latest/develop/using-commands/transactions/
  - Scope: Redis latest documentation checked 2026-09-06.
  - Use: `MULTI`, `EXEC`, `WATCH`, transaction errors, and no-rollback semantics.
