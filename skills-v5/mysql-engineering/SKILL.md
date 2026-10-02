---
name: mysql-engineering
description: Engineer MySQL and InnoDB schemas, indexes, transactions, replication, SQL modes, and operational compatibility. Use when the request specifically requires mysql, innodb, mysql query, mysql index; prefer a narrower child only when its boundary is established.
---

# Mysql Engineering

## Responsibility

Confirm MySQL version, SQL mode, character set/collation, InnoDB behavior, replication topology, and workload. Design composite indexes around leftmost-prefix access, understand next-key locking and isolation, and make timestamp/JSON/generated-column behavior explicit across versions.

Verification focus: Inspect EXPLAIN plans, lock contention, transaction boundaries, migration behavior, collation-sensitive queries, replica lag/compatibility, and realistic row distributions.

Failure boundaries: Do not assume PostgreSQL semantics transfer directly, ignore SQL modes or collations, depend on implicit type coercion, or add redundant indexes that amplify write cost.

## Hierarchy and routing

- Broader skills: relational-data-modeling.
- No narrower bundled child is declared.
- Required skills: verification.

## Decision rules

- Resolve MySQL version, storage engine, SQL mode, character set, and collation before relying on type, comparison, DDL, or locking behavior.
- Order composite indexes around actual equality, range, ordering, and covering needs. Leftmost-prefix behavior is a design constraint, not a reason to add every predicate column to one index.
- Treat InnoDB locking as index-dependent. Next-key and gap locking can change contention and phantom behavior, so transaction design must include the access path.
- Prefer explicit types and constraints over implicit coercion. Treat generated columns, JSON behavior, and timestamp semantics as version-sensitive features.
- Evaluate redundant indexes against write amplification, storage, and optimizer usefulness before retaining them.

## Observable checks

- Capture `EXPLAIN` for representative parameters and distributions. `EXPLAIN ANALYZE` executes the supported statement, so use an authorized, bounded test environment where its load and effects are safe; do not treat it as a read-only plan preview.
- Verify composite-index use for both intended leftmost-prefix queries and important queries that omit leading columns.
- Reproduce concurrent transaction behavior for ranges that can trigger next-key or gap locks when contention matters.
- Test collation-sensitive comparisons, strict-mode failures, and migration behavior on the target MySQL version.
- Measure replica lag or topology behavior only when replication is in scope; documentation alone does not establish deployment behavior.

## Completion evidence

- Version, SQL-mode, collation, and storage-engine assumptions relevant to the decision.
- Representative plan and locking evidence for changed queries or indexes.
- Migration and compatibility results, with replication claims left explicit when unverified.

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
