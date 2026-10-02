# Source map

This map uses current Apache Airflow documentation as primary evidence for retry-safe task and partition concepts. Airflow APIs are conditional; checkpoint, repeatability, backfill, and reconciliation decisions apply across orchestrators.

## Adopted principles

- Retried work should produce the same logical result for the same logical input. Airflow 3.3.1 recommends transaction-like tasks, repeatable reruns, and partition-specific reads and writes.
- A pipeline should not depend on the latest mutable input when the same run may execute later. A stable logical interval or source checkpoint makes reruns reproducible.
- State such as watermarks or submitted job IDs may need durable storage across retries or runs. The storage boundary must match recovery semantics.
- Tasks can run on different workers, so correctness cannot depend on an unstated local-file handoff in distributed execution.

## Conditional or non-adopted recipes

- Airflow DAGs, task state stores, XCom, and `data_interval_start` are implementation recipes for Airflow deployments, not mandatory pipeline architecture.
- UPSERT is one duplicate-safe destination pattern, not a universal requirement. Partition replacement, transactional merge, or another idempotent write can satisfy the same invariant.
- No orchestrator, storage system, message broker, or medallion architecture is mandated.

## Verification scope

Verify repeat-run determinism, checkpoint timing, partial-failure recovery, backfill overlap, late and duplicate input, schema drift, malformed-row policy, and source-to-destination reconciliation in the actual source and destination systems. Scheduler documentation alone cannot prove destination durability.

## Primary sources

- Apache Airflow documentation root: https://airflow.apache.org/docs/
  - Existing navigation source retained from 2026-09-04.
- Airflow 3.3.1 Best Practices: https://airflow.apache.org/docs/apache-airflow/stable/best-practices.html
  - Adopted for repeatable task outcomes, partition-specific reads and writes, distributed-worker file boundaries, and DAG testing.
  - Verified 2026-09-06.
- Task and Asset State Store Overview: https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/task-and-asset-state-store.html
  - Conditional reference for persisted watermark and retry state in Airflow.
  - Verified 2026-09-06.
