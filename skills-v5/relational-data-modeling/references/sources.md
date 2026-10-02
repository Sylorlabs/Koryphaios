# Source map

## Adopted principles

- Database constraints are executable invariants for data the database owns. Uniqueness, checks, nullability, and foreign keys should be modeled from domain rules rather than delegated only to one application path.
- Normalization and denormalization are authority and consistency decisions. Denormalized state needs a refresh and repair contract because it duplicates facts.
- Engine-specific behavior belongs in the MySQL, PostgreSQL, or SQLite child once that engine boundary is established.

## Conditional recipes

- Surrogate keys, foreign keys, normalization level, JSON columns, cascades, soft deletion, and temporal modeling are conditional choices, not universal templates.
- PostgreSQL pages are used here for concrete constraint semantics, not to imply that every relational engine behaves identically. Route engine-specific execution details to the established child skill.

## Verification scope

SQL-engine documentation can establish available constraint semantics for that engine. It cannot determine the product's identity, ownership, retention, deletion, or historical-time rules. Those require explicit domain evidence plus migration and concurrency checks in the selected engine.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader backend-engineering; narrower children mysql-engineering, postgres-engineering, sqlite-engineering.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **PostgreSQL constraints**: https://www.postgresql.org/docs/current/ddl-constraints.html
  - Scope: PostgreSQL current documentation checked 2026-09-06.
  - Use: concrete semantics for checks, not-null, uniqueness, primary keys, and foreign keys.
- **PostgreSQL transaction isolation**: https://www.postgresql.org/docs/current/transaction-iso.html
  - Scope: PostgreSQL current documentation checked 2026-09-06.
  - Use: concrete example of concurrency semantics that must be delegated to the chosen engine rather than generalized across engines.
