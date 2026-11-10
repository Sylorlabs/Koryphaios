---
name: data-pipeline-engineering
description: Engineer batch and incremental data pipelines with lineage, idempotency, schema evolution, backfills, partitioning, and recovery. Use when the request specifically requires etl pipeline, data pipeline, incremental load, data backfill; prefer a narrower child only when its boundary is established.
---

# Data Pipeline Engineering

## Responsibility

Define source authority, event and record identity, watermark, partition, schema, transformation lineage, retry semantics, and destination guarantees. State the source snapshot or cursor, the sink commit boundary, and which state survives a worker or process restart. Design backfills and reprocessing as first class paths that cannot silently double count or overwrite newer truth.

## Transferable decisions

- Define the unit of repeatability first: record, source offset, time window, or partition. Advance its checkpoint only after the corresponding destination state is durable.
- Namespace progress by the source's real ordering domain. A scalar offset is valid for one ordered partition/shard; multiple independently ordered partitions require independent progress unless the source proves a global order.
- Keep event identity separate from entity identity. Deduplicate a delivery by its stable event key, then apply the event to the entity only when its source order or version is authoritative for that entity.
- Treat event identity as global across sink dispositions. The same logical event must not be accepted once and quarantined again merely because validation changes on replay.
- Separate event time, source update time, ingestion time, and scheduler time. Choose the watermark from the field that matches source correction and late arrival behavior.
- Make reruns deterministic for the same logical input. Replace the same partition, upsert by stable identity, or use another write pattern whose duplicate behavior is explicit.
- Treat backfill as a first class execution mode. Define historical selection, overlap with current runs, overwrite precedence, and reconciliation before an incident requires it.
- For file or feed inputs, preserve an immutable raw landing keyed by file and row identity. Classify additive fields, compatible representation changes, and incompatible changes separately; record the parser or schema version used for every normalized or quarantined row.
- Give malformed rows and schema drift explicit states such as reject, quarantine, stop, or versioned adaptation. State the schema and version compatibility rule and how quarantined records reenter after a compatible parser or schema arrives. Silent loss is not recovery.
- Keep checkpoint and deduplication state in the same durability model as the sink guarantee. Rolling back an in memory cursor on the same object is replay simulation, not proof that a process restart preserves deduplication or progress.

## Observable checks

- Run the same logical partition twice and compare destination state for duplicates or divergent results.
- Inject a failure after partial destination work and verify a reconstructed process and store resume or replace state without advancing past missing data. If the fixture has no persistent store, label durable restart verification unavailable and test only the replay behavior it can actually observe.
- Exercise one late update, one duplicate record, one empty interval, one malformed record, and one relevant schema change.
- Backfill a bounded historical range while a current run exists and verify checkpoint ownership and overlap behavior.
- Reconcile source and destination counts or business totals at pipeline grain and report lag, rejected records, and unresolved gaps separately.

## Failure boundaries

Do not use processing time when event time defines correctness, assume exactly once from retries alone, discard bad rows without accounting, or let a backfill bypass normal quality gates. Do not derive a retryable partition from wall clock `now()` when the run needs a stable logical interval.

## Hierarchy and routing

- Broader skills: `data-analysis`.
- No narrower bundled child is declared.
- Required skills: `verification`, `data-analysis`.

Route here for batch or scheduled movement and transformation across source and destination systems, especially checkpoints, partitions, retries, backfills, and reconciliation. Route continuous event time stateful computation to `stream-processing` and warehouse model semantics to `analytics-engineering`.

## Completion evidence

- Declared source identity, partition or watermark semantics, checkpoint boundary, and destination write guarantee.
- Repeat run and partial failure recovery results for a representative logical partition, distinguishing replay simulation from process durable restart evidence.
- Late, duplicate, malformed, empty window, and schema change results relevant to the pipeline.
- Versioned schema compatibility and one event identity rule spanning accepted, rejected, and quarantined dispositions.
- Bounded backfill and source to destination reconciliation output.
- Source versions and freshness status for any scheduler or storage behavior used to justify a decision.

Use [the maintained source map](references/sources.md) for version sensitive facts and source conflicts.
