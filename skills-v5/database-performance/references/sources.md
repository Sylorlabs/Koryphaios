# Source map

This map uses PostgreSQL planner and DDL documentation as concrete primary references for how to read plans and bound migrations. PostgreSQL syntax and planner details are conditional; the transferable practice is to compare optimizer estimates with observed execution on representative data and to measure lock behavior at the target engine boundary.

## Adopted principles

- Read the plan actually chosen by the optimizer and compare estimated rows with actual rows when runtime execution evidence is available.
- Keep planner statistics representative enough for the tested workload. PostgreSQL documents that planner choices depend on statistics and that sampled statistics can vary.
- Treat indexes as selective access paths with overhead across the whole system rather than universal improvements.
- Use representative data and parameters. Plans from small or differently distributed data are not evidence for the production workload.

## Conditional recipes and recipes not adopted

- `EXPLAIN (ANALYZE, BUFFERS)` is a PostgreSQL recipe. Use the target engine's equivalent elsewhere.
- PostgreSQL extended statistics are conditional when correlated columns cause cardinality errors; they are not a general requirement.
- Planner hints, forced indexes, and configuration changes specific to the engine are not default recommendations. First identify the observed estimate or cost mismatch.

## Verification scope

Verify actual plans, row estimate accuracy, latency distributions, cache conditions, lock or connection waits, spills, and I/O at the target engine boundary. Source documentation explains possible mechanisms but does not prove the current workload has that mechanism.

## Evidence classes and claim limits

- **Observed live** means a measurement from the target production system under an authorized procedure. Record the engine/version, time window, workload slice, and measurement boundary.
- **Observed representative** means a clone or test target with its scale, distribution, bind values, cache condition, and concurrency stated. Call out what differs from production.
- **Synthetic** means a fixture, generated dataset, simulation, or harness. It can test that a procedure distinguishes plans, waits, aborts, or resumes. It does not prove production p95/p99, lock safety, or write impact unless the target workload properties were reproduced and measured.
- **Inferred** means documentation, source inspection, an estimated plan, or a hypothesis. It supports a mechanism or next check, not a claim about the current workload.
- **Unavailable** means the target or authorized measurement was not reachable. Keep that gap explicit.

The package's full-task fixtures are synthetic by contract. They are useful for checking whether a response asks for engine/version, scale ratio, parameter classes, lock evidence, and recovery evidence. They are not real database runs and cannot establish a production result. A real engine run against synthetic data remains synthetic workload evidence unless its relationship to the target is measured and stated.

## Primary sources

- **PostgreSQL documentation root**: https://www.postgresql.org/docs/current/
  - Scope: Current PostgreSQL documentation navigation for SQL, transactions, locking, indexes, planning, replication, and operations, rechecked 2026-10-19.
  - Use: Navigation only; apply details from the actual engine/version.
  - Verified: 2026-10-19; refresh after 45 days.
- **Using EXPLAIN**: https://www.postgresql.org/docs/current/using-explain.html
  - Scope: PostgreSQL 18 current documentation as available 2026-10-20.
  - Use: Plan structure and estimated versus actual execution evidence. `EXPLAIN ANALYZE` executes the statement and can have side effects.
  - Verified: 2026-10-20; refresh after 45 days.
- **Statistics Used by the Planner**: https://www.postgresql.org/docs/current/planner-stats.html
  - Scope: PostgreSQL 18 current documentation as available 2026-10-20.
  - Use: Selectivity, sampled statistics, and correlated-column considerations.
  - Verified: 2026-10-20; refresh after 45 days.
- **Indexes**: https://www.postgresql.org/docs/current/indexes.html
  - Scope: PostgreSQL 18 current documentation as available 2026-10-20.
  - Use: Access paths and system-wide read, write, storage, and maintenance tradeoffs.
  - Verified: 2026-10-20; refresh after 45 days.

## PostgreSQL 17 operational decisions (verified 2026-10-10)

These sources pinned to a specific version supplement, rather than replace, the earlier PostgreSQL 18 planning references. Use the engine's **actual** version; a service that is compatible with PostgreSQL may implement different behavior.

- [PREPARE](https://www.postgresql.org/docs/17/sql-prepare.html): a generic plan does not depend on bind values; `EXPLAIN EXECUTE` distinguishes it from a custom plan. Confirm this before claiming statistics for a specific tenant fixed parameter skew.
  - Verified: 2026-10-10; refresh after 45 days.
- [Planner statistics](https://www.postgresql.org/docs/17/planner-stats.html): extended `mcv` / dependency statistics are populated by `ANALYZE`; sample quality and predicate type bound their usefulness.
  - Verified: 2026-10-10; refresh after 45 days.
- [EXPLAIN](https://www.postgresql.org/docs/17/sql-explain.html): `EXPLAIN ANALYZE` runs the statement and can incur side effects; an estimated or generic plan alone cannot demonstrate runtime improvement.
  - Verified: 2026-10-10; refresh after 45 days.
- [ALTER TABLE](https://www.postgresql.org/docs/17/sql-altertable.html): most DDL acquires `ACCESS EXCLUSIVE` unless stated otherwise. A validated proving `CHECK` skips the `SET NOT NULL` scan, and separate `VALIDATE CONSTRAINT` takes `SHARE UPDATE EXCLUSIVE`.
  - Verified: 2026-10-10; refresh after 45 days.
- [CREATE INDEX](https://www.postgresql.org/docs/17/sql-createindex.html): concurrent builds permit writes but can wait on old snapshots, cannot run in a transaction block, and may leave invalid indexes requiring recovery.
  - Verified: 2026-10-10; refresh after 45 days.
- [CREATE TABLE / DEFAULT](https://www.postgresql.org/docs/17/sql-createtable.html): default expressions cannot reference another column of the row; SQL presented as a `DEFAULT` that derives a value must be checked before executable use.
  - Verified: 2026-10-10; refresh after 45 days.

**Source versus fixture:** Synthetic plan changes, lock times and estimates at production scale are scenario observations only. A generic plan cannot become specific to a parameter merely because extended statistics were added. If a supplied experiment suggests that result, distinguish the measured candidate outcome from the unproven mechanism, and verify whether planning switched to custom. Likewise, a schematic migration statement may describe intent without being legal PostgreSQL SQL. Preserve the observed symptom while correcting the executable strategy.

## Maintained local playbooks

- [Plans that vary by parameter](parameter-sensitive-plans.md) applies the source facts to tenant skew, generic/custom plans, and neighboring workload checks. It does not claim that a synthetic plan improvement is a production improvement.
- [Bounded online migrations and backfills](online-migrations.md) applies the DDL source facts to lock budgets, batch checkpoints, constraint validation, invalid-index recovery, and abort/resume evidence. It does not claim that a staging rehearsal proves production lock safety.
