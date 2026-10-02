---
name: sqlite-engineering
description: Engineer SQLite storage with transaction, locking, WAL, migration, durability, embedding, and file-lifecycle discipline. Use when the request specifically requires sqlite, sqlite database, sqlite wal, sqlite migration; prefer a narrower child only when its boundary is established.
---

# Sqlite Engineering

## Responsibility

Treat SQLite as an embedded database with file and process semantics, not a tiny network server. Confirm library version, journaling mode, busy timeout, foreign keys, synchronous level, connection pooling, and expected concurrency. Keep migrations compatible with SQLite DDL limits and app upgrade paths.

Verification focus: Exercise concurrent readers/writers, crash/reopen behavior where risk warrants it, migration from real prior schemas, foreign-key enforcement, WAL checkpointing, and backup/restore or file replacement flows.

Failure boundaries: Do not open unbounded connections, assume foreign keys are always enabled, copy live database files casually, or use network-filesystem deployments without validated locking semantics.

## Hierarchy and routing

- Broader skills: relational-data-modeling.
- No narrower bundled child is declared.
- Required skills: verification.

## Decision rules

- Treat SQLite as an embedded database whose file, process, journaling, and connection lifecycle are part of correctness. Resolve the linked SQLite version and compile/runtime settings before relying on optional behavior.
- Choose rollback journal or WAL from concurrency and deployment constraints. WAL allows readers and a writer to proceed concurrently, but still has a single writer and relies on same-host shared-memory behavior in normal use.
- Make foreign-key enforcement explicit for every connection path that depends on it. A declared foreign key is not enough if the runtime connection has enforcement disabled.
- Keep write transactions short and define busy handling from expected contention. `BEGIN`, `DEFERRED`, `IMMEDIATE`, and `EXCLUSIVE` change when write conflicts surface.
- Use SQLite-supported backup mechanisms for live databases rather than casually copying a database file whose journal or WAL state may be active.

## Observable checks

- Inspect runtime SQLite version plus relevant PRAGMAs for journal mode, foreign keys, synchronous mode, and busy timeout or handler behavior.
- Run concurrent reader/writer and writer/writer tests representative of the application's connection model.
- Attempt a foreign-key violation on each relevant connection setup to prove enforcement is active.
- Exercise migration from a real prior schema and verify reopen behavior after interruption where migration risk warrants it.
- Verify backup and restore from the mechanism actually used, including WAL/checkpoint behavior when WAL mode is enabled.

## Completion evidence

- Runtime version and connection PRAGMAs relevant to concurrency, durability, and referential integrity.
- Concurrency, migration, foreign-key, and backup/restore evidence actually exercised.
- Explicit unknowns for filesystem locking, crash behavior, or deployment topology not reproduced.

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
