# Source map

This map uses PostgreSQL's planner documentation as a concrete primary reference for plan-reading principles. PostgreSQL syntax and planner details are conditional; the transferable practice is to compare optimizer estimates with observed execution on representative data.

## Adopted principles

- Read the plan actually chosen by the optimizer and compare estimated rows with actual rows when runtime execution evidence is available.
- Keep planner statistics representative enough for the tested workload. PostgreSQL documents that planner choices depend on statistics and that sampled statistics can vary.
- Treat indexes as selective access paths with system-wide overhead rather than universal improvements.
- Use representative data and parameters. Plans from small or differently distributed data are not evidence for the production workload.

## Conditional or non-adopted recipes

- `EXPLAIN (ANALYZE, BUFFERS)` is a PostgreSQL recipe. Use the target engine's equivalent elsewhere.
- PostgreSQL extended statistics are conditional when correlated columns cause cardinality errors; they are not a general requirement.
- Planner hints, forced indexes, and engine-specific configuration changes are not default recommendations. First identify the observed estimate or cost mismatch.

## Verification scope

Verify actual plans, row-estimate accuracy, latency distributions, cache conditions, lock or connection waits, spills, and I/O at the target engine boundary. Source documentation explains possible mechanisms but does not prove the current workload has that mechanism.

## Primary sources

- PostgreSQL documentation root: https://www.postgresql.org/docs/current/
  - Existing navigation source retained from 2026-09-04.
- Using EXPLAIN: https://www.postgresql.org/docs/current/using-explain.html
  - Adopted for plan structure and estimated versus actual execution evidence.
  - Verified 2026-09-06 against PostgreSQL 18 current docs.
- Statistics Used by the Planner: https://www.postgresql.org/docs/current/planner-stats.html
  - Adopted for selectivity, sampled statistics, and correlated-column considerations.
  - Verified 2026-09-06.
- Indexes: https://www.postgresql.org/docs/current/indexes.html
  - Adopted for the tradeoff that indexes improve access paths while adding system overhead.
  - Verified 2026-09-06.
