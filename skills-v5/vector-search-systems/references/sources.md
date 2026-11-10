# Source map

`vector-search-systems` is individually authored for V5; empirical qualification is tracked separately in the audit/evaluation ledger. Vector index behavior is engine/version specific: exact-vs-ANN semantics, operator classes, filter execution, iterative scans, quantization, maintenance and capacity limits must be checked against the actual store/version rather than generalized from one implementation.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader backend-engineering.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **pgvector reference implementation**: https://github.com/pgvector/pgvector
  - Scope: pgvector repository/README as available 2026-10-04.
  - Use: exact nearest-neighbor default, HNSW/IVFFlat recall-speed/build tradeoffs, distance-specific operator classes, filter behavior, iterative scans, partial indexes/partitioning, tenant considerations, quantization, maintenance/scaling and exact-vs-ANN recall monitoring.
  - Verified: 2026-11-03; refresh after 30 days.
- **PostgreSQL partial indexes**: https://www.postgresql.org/docs/current/indexes-partial.html
  - Scope: current PostgreSQL documentation as available 2026-09-05.
  - Use: predicate-specific indexes for workloads where selective metadata/tenant subsets justify separate indexing.
  - Verified: 2026-09-05; refresh after 90 days.
- **PostgreSQL table partitioning**: https://www.postgresql.org/docs/current/ddl-partitioning.html
  - Scope: current PostgreSQL documentation as available 2026-09-05.
  - Use: partition layout, pruning and operational semantics when vector workloads are partitioned by tenant/category/time or another bounded key.
  - Verified: 2026-09-05; refresh after 90 days.
- **PostgreSQL EXPLAIN**: https://www.postgresql.org/docs/current/sql-explain.html
  - Scope: current PostgreSQL query-plan reference as available 2026-09-05.
  - Use: observable plan/runtime evidence for exact/ANN/filter query execution rather than assumptions about which index path the planner used.
  - Verified: 2026-09-05; refresh after 90 days.

## Interpretation rules

- This skill starts with a fixed representation contract. Provider/model/task/dimension/normalization compatibility and re-embedding belong to `embedding-systems`; record that identity only so the store uses the correct vector type/distance operator.
- Establish an exact nearest-neighbor reference before ANN tuning and compare Recall@K/overlap plus latency on identical queries. ANN speed without measured quality loss is incomplete evidence.
- Treat metadata filtering and tenant isolation as correctness. Determine whether filters are applied before/during/after ANN search and test selective filters, returned-k shortfalls and unauthorized-neighbor canaries.
- Tune search breadth and index parameters empirically for the workload. HNSW/IVF heuristics, defaults and iterative-scan behavior are implementation/version specific.
- Measure build/resource/storage as well as query latency. Include p50/p95/p99 under concurrency, index memory, build time and maintenance costs.
- Upserts/deletes/freshness need explicit ID, consistency and visibility contracts. Verify duplicate prevention, delete lag and required vacuum/compaction/rebuild behavior.
- Quantization/half precision can trade memory for recall. Include the engine's required reranking path and compare to the full-precision exact/reference results.
- Index migration is a data-system migration: build/backfill or dual-write, catch up updates, shadow old/new/exact queries, verify coverage/filter/recall/latency/freshness, then switch readers with a tested rollback.
