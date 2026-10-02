---
name: relational-data-modeling
description: Design relational schemas around invariants, keys, normalization, lifecycle, transactions, and query access patterns. Use when the request specifically requires relational schema, database schema, foreign key design, normalization database; prefer a narrower child only when its boundary is established.
---

# Relational Data Modeling

## Responsibility

Start from entities, identities, invariants, lifecycle, cardinality, ownership, retention, and access patterns. Encode durable constraints in the database when it is the authority, normalize by default, and denormalize only with an explicit consistency and refresh contract. Treat nullability and time as domain decisions.

Verification focus: Validate representative inserts, updates, deletes, concurrent transactions, migrations, uniqueness, referential integrity, and high-value query plans against realistic data shapes.

Failure boundaries: Do not use JSON columns to postpone every modeling decision, rely solely on application validation for database invariants, or choose surrogate keys without understanding natural uniqueness.

## Hierarchy and routing

- Broader skills: backend-engineering.
- Narrower children: mysql-engineering, postgres-engineering, sqlite-engineering.
- Required skills: verification.

## Decision rules

- Model identities, ownership, lifecycle, cardinality, nullability, time semantics, and deletion behavior before selecting tables or columns.
- Encode invariants at the database boundary when every writer must obey them. Distinguish natural uniqueness from the choice of a surrogate primary key so both are represented when needed.
- Normalize to make each durable fact have a clear authority. Denormalize only when a measured access need justifies an explicit refresh, consistency, and repair contract.
- Use foreign keys when the database owns the referenced relationship and lifecycle. Define cascade, restrict, set-null, or application-managed deletion from domain semantics rather than convenience.
- Treat JSON columns as appropriate for genuinely flexible or opaque subdocuments, not as a substitute for known relational invariants that need queryability and constraints.

## Observable checks

- Attempt representative valid and invalid inserts, updates, and deletes to prove uniqueness, nullability, checks, and referential behavior.
- Exercise concurrent writes for invariants that can race, using the target engine's transaction semantics.
- Run migrations from realistic prior schemas and verify both data preservation and constraint establishment.
- Inspect high-value query plans against representative data shapes after normalization, denormalization, or key changes.
- Record retention, deletion, timezone, and historical-model assumptions that are product decisions and cannot be proven from SQL documentation alone.

## Completion evidence

- Entity, identity, ownership, and invariant model with explicit denormalization contracts where used.
- Constraint, concurrency, migration, and representative query evidence for the engine in scope.
- Explicit product-semantic unknowns such as retention, deletion, or historical-time policy.

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
