---
name: postgres-engineering
description: Engineer PostgreSQL schemas, queries, transactions, indexes, extensions, replication, and operational behavior. Use when the request specifically requires postgresql, postgres query, postgres index, psql; prefer a narrower child only when its boundary is established.
---

# Postgres Engineering

## Responsibility

Confirm PostgreSQL version, schema ownership, isolation needs, extension availability, and workload. Use constraints, partial/expression indexes, generated columns, JSONB, CTEs, locks, advisory locks, and advanced types only when they match the invariant and access pattern. Inspect MVCC and vacuum implications for paths with heavy write traffic.

Verification focus: Use EXPLAIN with representative parameters/data, test lock and transaction behavior, migration rollback or forward recovery, constraint violations, and statistics similar to production. Validate replicas/extensions separately when relevant.

Failure boundaries: Do not cargo-cult indexes, trust estimated plans without data context, hold transactions across external work, or use serializable isolation without handling retries.

## Hierarchy and routing

- Broader skills: relational-data-modeling.
- No narrower bundled child is declared.
- Required skills: verification.

## Decision rules

- Resolve the PostgreSQL major version, extension availability, schema ownership, transaction isolation, and workload before selecting version-sensitive syntax or behavior.
- Encode durable invariants with native constraints when PostgreSQL is the authority. Use application checks as additional context, not a replacement for database-enforced uniqueness or referential rules that must survive all writers.
- Design indexes from actual predicates, ordering, selectivity, and write cost. Partial and expression indexes are conditional tools for stable predicates or expressions, not default patterns.
- Read plans as estimates plus runtime evidence. Cardinality estimates, actual rows, buffer activity, parameter sensitivity, and table statistics all matter before attributing a performance cause.
- Keep transactions as short as the invariant allows. If serializable isolation is selected, design for serialization failures and retries rather than treating them as exceptional bugs.

## Observable checks

- Use `EXPLAIN` with representative parameters and `EXPLAIN ANALYZE` only when executing the statement is safe. Capture actual rows and buffer evidence when performance claims depend on them.
- Verify constraint violations directly for uniqueness, nullability, checks, and foreign-key behavior that the change relies on.
- Exercise concurrent transactions for the isolation or lock behavior being claimed, including serialization retry behavior when relevant.
- Test migration forward recovery or rollback strategy against a realistic prior schema and data shape.
- Validate extension, replica, vacuum, and production-statistics claims separately; source documentation does not prove those deployment conditions.

## Completion evidence

Tie each claimed invariant to an executed database result or an explicit unavailable status. Keep schema changes, constraint rejection, concurrent transaction outcomes, representative query plans and migration recovery distinct. A model of database behavior cannot establish PostgreSQL lock semantics or plan performance. Document the relational design boundary and why PostgreSQL specific mechanisms are needed; do not imply unobserved replicas, extensions or production statistics were checked.

For bounded evaluation artifacts, preserve the task's literal evidence categories and numeric quantities in machine-readable output. If verification requires a 20-worker concurrency check, record the numeric value `20`; if the task verifies a constraint, include the literal category `constraint` rather than only a synonym such as FK. Candidate-visible shell or tool limitations do not establish that evaluator-managed PostgreSQL or Docker is unavailable. Report PostgreSQL/Docker as unavailable only when the runtime command being reported actually failed.

- PostgreSQL version and invariant decisions tied to schema and workload evidence.
- Representative plans, constraint checks, and concurrency or migration results for the changed boundary.
- Explicit deployment-only unknowns for replicas, extensions, vacuum behavior, and production statistics.

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
