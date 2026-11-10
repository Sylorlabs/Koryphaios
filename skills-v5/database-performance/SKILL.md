---
name: database-performance
description: Diagnose slow database queries, tail-latency regressions, plan mistakes, contention, and performance-sensitive database migrations. Use when the goal is to improve or preserve database latency, throughput, or write availability; engine-specific feature or DDL questions alone belong to the engine skill.
---

# Database Performance

## Establish the workload before choosing a fix

Identify the database engine and **actual version**, authorization to execute changes, and whether evidence is from production, a representative clone, or a synthetic fixture. Capture the precise query and bind values or proposed migration, table schema/indexes/constraints, row counts and skew, planner statistics, concurrent reads/writes and long transactions, and the user's latency or availability target. For migrations, record staging and production sizes **as a ratio**, plus write rate and transaction lifetime; a fast rehearsal on a much smaller table does not establish production lock safety.

Separate the clock being measured: request/queue time, connection acquisition, lock waits, planning, query execution, I/O/spill, and client/network work. Segment p50/p95/p99 by the parameter or tenant associated with the regression; a healthy median can conceal one tenant's p99. An operation dominated by waits calls for contention or connection diagnosis before plan tuning.

## Make a discriminating decision

- **Wrong estimated rows or a plan specific to one tenant:** compare estimated and actual cardinality, filter selectivity, buffer reads, and chosen access paths for both ordinary and worst case parameters. Inspect the prepared statement **generic versus custom plan** decision before crediting statistics or an index. PostgreSQL generic plans cannot make choices specific to a tenant's values; extended statistics help only when the relevant values can inform planning. Read [plans that vary by parameter](references/parameter-sensitive-plans.md) when selectivity, skew, plan caching, or a proposed index drives the case.
- **Reasonable estimates, slow execution:** determine whether many rows/index tuples are visited, heap fetches or sorts spill, the working set exceeds cache, or storage I/O dominates. Test the smallest change that addresses the observed operator; do not force an index merely because one exists.
- **Lock queue or DDL blocking writers:** identify the holder, waiter, lock level, and transaction age. Distinguish a short metadata operation's _lock acquisition delay_ from its execution time. For backfills on large tables, constraints, index builds, and migrations that add a required column, read [online migrations](references/online-migrations.md) before proposing DDL.
- **New index or global setting proposed:** compare the full existing index definitions, including leading prefixes and sort keys. A smaller prefix index can sometimes help, but require measured benefit before paying write, storage, vacuum, and costs to competing queries. Prefer a narrower proven change at the statistics, query, or statement level over a global session policy.

Rank plausible interventions against the requested objective and measured side effects. Keep a record of rejected alternatives with the evidence that disqualified each, including regressions outside the slow query. Preserve query results, constraints, transaction isolation, and the semantics of the application's concurrent writers.

## Observe and verify safely

- Start with plans that explain without executing, and with observations that only read. PostgreSQL `EXPLAIN ANALYZE` **executes** statements, including writes and side effects from user authored functions. Use it only on an authorized safe target; a rollback does not undo every external effect.
- Compare before and after under representative cardinality, bind distribution, plan cache behavior, cache condition, write rate, and concurrent sessions. Use repeated latency distributions (especially the affected p99), actual plans where safe, and wait/buffer counters. Don't declare success from one warm run or a lower estimated cost.
- For index, statistics, or query changes, check the main read, a small and a large parameter case, representative writes, and an adjacent query. For migrations, include behavior under blocked locks and timeouts, recovery from an interrupted backfill, constraint and index validity, write delays, and query plans after the migration. Set acceptance/abort bounds relative to the workload, not a universal threshold.
- If there is no executable fixture, credentials, or authorized test target, give a ranked, falsifiable plan and mark runtime checks **unavailable**. Label simulated, inferred, stale, and measured results separately; never substitute documentation or synthetic data for production measurements.

## Hierarchy and completion

`performance-debugging` supplies the broader measurement method; this skill decides the database execution and concurrency changes. Compose the appropriate database engine specialist when exact SQL, feature support, or locking semantics are version dependent. `gpu-compute` is adjacent only if an accelerator is separately requested and justified by transfer/correctness costs; for ordinary relational tuning report `gpu-compute: not selected`. On relational migration tasks, note `mongodb-engineering: not applicable` where the specialist boundary is being recorded.

Route from the current request, not from quoted history or a technology name alone. A request for PostgreSQL, MySQL, MongoDB, or Redis feature/DDL semantics without a performance symptom belongs to that engine skill. Compose the engine skill with this one when the request also asks why work is slow, how a plan changes, or how write availability is affected. A request that only verifies an already-designed migration belongs to the verification boundary unless performance diagnosis is still requested.

## Evidence labels and claim limits

Use one of these labels for every material observation:

- **Observed live:** collected from the target production system under an authorized procedure. Include engine/version, time window, workload slice, and the measurement boundary.
- **Observed representative:** collected from a clone or test target whose data scale, distribution, bind values, cache state, and concurrency are stated. Explain which production properties remain unrepresented.
- **Synthetic:** produced by a fixture, generated data, simulation, or harness. A synthetic fixture may use a real database engine, but it does not establish production p95/p99, lock safety, or write impact unless those target properties were reproduced and measured.
- **Inferred:** derived from documentation, an estimated plan, source inspection, or a hypothesis. It explains a possible mechanism and is not a runtime result.
- **Unavailable:** the target, credentials, safe execution boundary, or required measurement was not reachable. Keep the missing check visible instead of filling it with a synthetic result.

Do not turn a synthetic latency, lock wait, row estimate, or successful rehearsal into a production claim. When evidence classes disagree, preserve the observation and lower the claim to the strongest supported class. Documentation can establish that a mechanism is possible; it cannot establish that the current workload has that mechanism.

## Promotion-ready completion record

Report the actual environment, target symptom, measured evidence, root-cause hypothesis, chosen change, rejected alternatives, and results before and after with sample conditions. Include:

1. Engine/version, authorization boundary, data scale and skew, staging-to-production ratio, bind distribution, cache condition, concurrency, and measurement boundary.
2. Evidence labels for every plan, latency, wait, I/O, write, storage, and constraint observation.
3. A successful case, a negative or stress case, and abort/recovery evidence when applicable. For synthetic tasks, identify the fixture checks that ran and the real checks that remain unavailable.
4. The selected hierarchy boundary and composed specialist rationale, including `gpu-compute: not selected` for ordinary relational tuning and `mongodb-engineering: not applicable` for relational migrations.

Use [the maintained source map](references/sources.md) to verify claims sensitive to engine or version. Source documentation and a synthetic fixture support a falsifiable plan; they do not substitute for authorized evidence from the target workload.
