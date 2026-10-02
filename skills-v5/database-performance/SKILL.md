---
name: database-performance
description: Diagnose and improve database performance using workload evidence, query plans, contention, cache, storage, and concurrency behavior. Use when the request specifically requires slow query, database performance, query plan, database contention; prefer a narrower child only when its boundary is established.
---

# Database Performance

## Responsibility

Capture the exact query, parameters, schema, statistics, data distribution, concurrency, and latency/resource symptom before tuning. Inspect logical work, plan operators, index selectivity, cardinality estimates, locking, cache, I/O, and connection pressure as separate hypotheses.

## Transferable decisions

- Reproduce the exact query shape and parameter distribution before changing schema or indexes. Plan choice depends on selectivity, statistics, data size, ordering, and available access paths.
- Separate estimated plan quality from observed execution. Large estimate-to-actual row errors point toward statistics, correlation, or predicate-model issues before they point toward a missing index.
- Treat indexes as a read, write, storage, and maintenance tradeoff. An index that helps one query can add cost to the rest of the workload.
- Distinguish execution time from queueing, locks, connection saturation, network time, cache state, and storage I/O. Query-plan tuning does not repair a wait outside the plan.
- Compare like with like: same representative data, parameters, cache condition, concurrency, and measurement boundary.

## Observable checks

- Capture actual plans and runtime counters only within an authorized execution boundary. PostgreSQL `EXPLAIN ANALYZE` executes the query, including writes and function side effects. Inspect an estimated plan first when execution is unsafe; use an isolated representative target for mutating tests. Do not assume transaction rollback reverses external effects.
- Compare estimated versus actual cardinalities at the nodes where cost diverges most and inspect statistics or data correlation there.
- Record a latency distribution across repeated representative runs rather than only the single fastest execution.
- Observe lock waits, active connections, memory or spill indicators, and storage I/O when those can dominate response time.
- For an index or query rewrite, exercise the main read path plus representative writes and at least one competing query that shares the changed table.

## Failure boundaries

Do not optimize from query text alone, add indexes for every predicate, trust one warm benchmark, or trade correctness or isolation for latency without an explicit decision. Do not force a plan before identifying why the optimizer preferred another plan.

Keep the boundary with `performance-debugging` and `gpu-compute` explicit in the decision record. Database performance work diagnoses database execution and resource behavior; it does not imply moving the query to GPU compute. If an accelerator is proposed, record it as a separate specialist decision with its own data-transfer, correctness, and measurement evidence.

## Hierarchy and routing

- Broader skills: performance-debugging.
- No narrower bundled child is declared.
- Required skills: verification, performance-verification.

Route here when the primary question is why database work is slow or resource-heavy. Route engine-specific DDL, transaction, or feature behavior to the matching database-engine skill and compose this skill only when performance diagnosis is part of the request.

## Completion evidence

- Before and after actual plans for an authorized change, or estimated plans and explicit runtime-evidence gaps when execution is not safe or in scope.
- Latency distribution and test conditions, including data scale, parameters, cache state, and concurrency.
- Evidence for estimate error, locks, spills, I/O, or connection pressure when cited as the bottleneck.
- Write-path or competing-query checks for index changes.
- The selected hierarchy boundary, including why database tuning does or does not involve broader performance debugging or GPU compute.
- An explicit boundary record: `performance-debugging` is the broader methodology and `gpu-compute` is a separate adjacent concern; for a relational database task, state `gpu-compute: out of scope` or `not selected` in the result.
- For migration reports, include the actual engine/version, production scale and concurrency, and the staging-to-production size relationship (for example, `400x smaller`); state `mongodb-engineering: not applicable` when the task is relational.

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
