# Source map

## Adopted principles

- Query plans are evidence about planner choices and, with `ANALYZE`, observed execution. Planner statistics and real row distributions can change those choices materially.
- Indexes are workload-specific structures with read benefits and write/storage costs. Partial or expression indexes are conditional optimizations.
- MVCC and isolation semantics define concurrency behavior. Serializable transactions can abort with serialization failures and therefore require a retry contract.
- Native constraints are the durable database mechanism for invariants such as uniqueness, checks, and references when PostgreSQL owns that rule.

## Conditional recipes

- `EXPLAIN ANALYZE` is conditional on safely executing the statement. Plain `EXPLAIN` is appropriate when execution could mutate or overload the target.
- Serializable isolation, advisory locks, JSONB, generated columns, partial indexes, expression indexes, and extensions are not universal defaults.
- Replica, vacuum, and extension guidance remains conditional on the actual deployment and version.

## Verification scope

PostgreSQL documentation defines SQL, planner, MVCC, isolation, constraint, and index semantics. It does not prove target-table statistics, parameter distributions, lock contention, extension availability, replica state, or production latency. Verify those in the actual environment.

The six URLs below were reopened on 2026-11-07 and registered individually in `kory.json`; refresh within 60 days. Indexes and Concurrency Control were reviewed at chapter-introduction depth, while planner statistics, isolation, constraints, and EXPLAIN were read as specific sections. Reject inferring a deployed server version from the moving `current` documentation alias.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader relational-data-modeling.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **PostgreSQL EXPLAIN**: https://www.postgresql.org/docs/current/sql-explain.html
  - Scope: PostgreSQL current EXPLAIN documentation inspected 2026-11-07; resolve the target server's major version separately.
  - Use: plan options, runtime execution evidence, and buffer reporting.
- **PostgreSQL planner statistics**: https://www.postgresql.org/docs/current/planner-stats.html
  - Scope: PostgreSQL current documentation checked 2026-11-07.
  - Use: cardinality-estimation inputs and statistics behavior.
- **PostgreSQL indexes**: https://www.postgresql.org/docs/current/indexes.html
  - Scope: PostgreSQL current documentation checked 2026-11-07.
  - Use: index capabilities and tradeoff framing.
- **PostgreSQL MVCC and transaction isolation**: https://www.postgresql.org/docs/current/mvcc.html and https://www.postgresql.org/docs/current/transaction-iso.html
  - Scope: PostgreSQL current documentation checked 2026-11-07.
  - Use: concurrency, visibility, isolation, and serialization failure semantics.
- **PostgreSQL constraints**: https://www.postgresql.org/docs/current/ddl-constraints.html
  - Scope: PostgreSQL current documentation checked 2026-11-07.
  - Use: database-enforced invariant semantics.
