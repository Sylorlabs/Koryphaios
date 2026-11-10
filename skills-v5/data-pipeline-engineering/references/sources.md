# Source map

This map uses current Apache Airflow documentation as primary evidence for retry safe task behavior, stable input partitions, persisted task and asset state, and bounded backfill controls. Airflow APIs are conditional. The pipeline contract applies across orchestrators only after the target source, sink, and state guarantees are inspected.

## Adopted principles

- A retried task should produce the same logical result for the same logical input. Airflow 3.3.2 recommends transaction like task outcomes, repeatable reruns, and reads and writes scoped to a stable partition or logical interval.
- A task should not depend on the latest mutable input when a rerun may happen later. A stable logical interval, immutable landing reference, or source cursor makes the input boundary reproducible.
- A checkpoint, submitted job identifier, watermark, or row count needs a persistence boundary that matches its required lifetime. Airflow 3.3.2 distinguishes task scoped state for retry recovery from asset scoped state for cross run watermarks.
- Historical reprocessing needs an explicit range, reprocess rule, concurrency limit, and overlap policy. Airflow backfill controls are an example of those controls, not a universal scheduler contract.
- Tasks may run on different workers, so correctness cannot depend on an unstated local file handoff in distributed execution.

## Conditional or non adopted recipes

- Airflow DAGs, task and asset state stores, XCom, `data_interval_start`, and Airflow backfill commands are implementation recipes for Airflow deployments, not mandatory pipeline architecture.
- UPSERT is one duplicate safe destination pattern, not a universal requirement. Partition replacement, transactional merge, or another idempotent write can satisfy the same invariant.
- No orchestrator, storage system, message broker, or medallion architecture is mandated.

## Verification scope

Documentation establishes scheduler and state store behavior. It does not prove destination durability, source ordering, schema compatibility, deduplication, recovery after process loss, backfill overlap safety, or reconciliation for a target pipeline. Verify repeat run determinism, checkpoint timing, partial failure recovery, bounded backfill overlap, late and duplicate input, schema drift, malformed row policy, and source to destination reconciliation in the actual source and destination systems.

## Maintained sources

- **Apache Airflow documentation root**: https://airflow.apache.org/docs/
  - Scope: Apache Airflow documentation navigation inspected 2026-10-17.
  - Use: Version and concept navigation only. This root does not establish a destination guarantee.
  - Verified: 2026-10-17; refresh after 60 days.
- **Apache Airflow Best Practices**: https://airflow.apache.org/docs/apache-airflow/stable/best-practices.html
  - Scope: Apache Airflow 3.3.2 best practices inspected 2026-10-17.
  - Use: Repeatable task outcomes, stable partition reads and writes, distributed worker boundaries, and executable DAG checks.
  - Verified: 2026-10-17; refresh after 60 days.
- **Task and Asset State Store Overview**: https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/task-and-asset-state-store.html
  - Scope: Apache Airflow 3.3.2 task and asset state store overview inspected 2026-10-17.
  - Use: Conditional examples for retry scoped state, cross run watermarks, and state retention boundaries.
  - Verified: 2026-10-17; refresh after 60 days.
- **Apache Airflow Backfill**: https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/backfill.html
  - Scope: Apache Airflow 3.3.2 backfill documentation inspected 2026-10-17.
  - Use: Bounded historical ranges, reprocess behavior, concurrency controls, run ordering, and dry run behavior.
  - Verified: 2026-10-17; refresh after 60 days.

## Interpretation rules

- Prefer the primary official source over community conventions when they conflict.
- Resolve the actual orchestrator, source, sink, schema, and runtime version before applying version sensitive details.
- Treat examples as examples, not proof that the target pipeline behaves the same way.
- Preserve unknowns and source conflicts explicitly. Do not merge incompatible guidance into a false universal rule.
- Keep operational checks in the real target source and destination when the claim depends on runtime behavior.
