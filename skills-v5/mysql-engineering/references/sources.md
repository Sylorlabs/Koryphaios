# Source map

## Adopted principles

- Composite-index usefulness depends on leading columns and workload shape. MySQL 8.4 documents leftmost-prefix lookup behavior directly.
- InnoDB next-key locking combines record and gap locking, so concurrency behavior depends on the indexed access path.
- Indexes improve selected reads but add storage and write cost. Index design therefore remains a workload tradeoff verified with plans.

## Conditional recipes

- Covering or composite indexes are conditional optimizations, not mandatory schema patterns.
- Gap-lock avoidance, isolation changes, generated columns, and replication-specific techniques are version and workload dependent and are not universal defaults.
- Adopt the distinction between optimizer estimates and executed `EXPLAIN ANALYZE` evidence. Adapt execution to a bounded authorized environment; reject the assumption that adding `EXPLAIN` makes every diagnostic non-mutating or free of production load.

## Verification scope

The manual defines MySQL and InnoDB semantics. It does not prove optimizer choices, lock contention, collation behavior under application inputs, replica lag, or migration safety in the target system. Verify those with the actual version, schema, data distribution, and topology.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader relational-data-modeling.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **MySQL 8.4 multiple-column indexes**: https://dev.mysql.com/doc/refman/8.4/en/multiple-column-indexes.html
  - Scope: MySQL 8.4, checked 2026-11-07.
  - Use: leftmost-prefix behavior and composite-index lookup semantics.
- **MySQL 8.4 InnoDB next-key locking**: https://dev.mysql.com/doc/refman/8.4/en/innodb-next-key-locking.html
  - Scope: MySQL 8.4, checked 2026-11-07.
  - Use: record-plus-gap locking and phantom prevention behavior.
- **MySQL 8.4 EXPLAIN**: https://dev.mysql.com/doc/refman/8.4/en/explain.html
  - Scope: MySQL 8.4, checked 2026-11-07.
  - Use: optimizer estimates versus actual statement execution by `EXPLAIN ANALYZE`; not a guarantee of harmless diagnosis.
- **MySQL 8.4 optimization and indexes**: https://dev.mysql.com/doc/refman/8.4/en/optimization-indexes.html
  - Scope: MySQL 8.4, checked 2026-11-07.
  - Use: index benefit and write/storage cost tradeoff.
