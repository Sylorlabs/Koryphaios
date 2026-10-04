---
name: stream-processing
description: Engineer streaming systems with event-time, ordering, delivery guarantees, state, partitions, replay, and backpressure. Use when the request specifically requires stream processing, kafka stream, event stream, consumer group; prefer a narrower child only when its boundary is established.
---

# Stream Processing

## Responsibility

Define event identity, keys, ordering scope, event-time versus processing-time, watermarking, delivery semantics, state stores, partition ownership, and replay behavior. Make consumers idempotent or deduplicating where delivery can repeat and control backpressure explicitly.

Verification focus: Exercise duplicates, reordering, partition rebalance, consumer restart, poison messages, lag spikes, replay from offsets, state recovery, and schema evolution with representative throughput.

Failure boundaries: Do not claim global order from partition order, commit offsets before durable effects without understanding loss windows, or hide poison events in infinite retry loops.

## Hierarchy and routing

- Broader skills: distributed-backend.
- No narrower bundled child is declared.
- Required skills: verification, reliability-verification.

## Decision rules

- Define event identity, partition key, ordering scope, event time, processing time, and replay authority before selecting delivery or state-processing mechanics.
- Treat ordering as scoped to the broker or processor guarantee actually provided. Kafka ordering is partition-scoped, so a keying decision is also an ordering and load-distribution decision.
- Assume delivery can repeat unless the complete source, processor, state, and sink path proves a stronger guarantee. Make external side effects idempotent or deduplicated at their durable boundary.
- Align offset or checkpoint advancement with durable effects. Advancing progress before an effect is durable creates loss windows; advancing after can create replay and duplicate windows.
- Define poison-event handling, backpressure, late-data policy, and replay behavior explicitly so failure does not become infinite retry or silent loss.
- Bound every retained state class, not only deduplication identities. Define when window aggregates, dedup keys, timers, buffers, and recovery/checkpoint state become final or obsolete, and evict them only after the watermark/replay horizon can no longer require them. If corrections or retractions remain possible, preserve the minimal state needed for that contract instead of silently growing state forever.

## Observable checks

- Inject duplicate and reordered events and verify the consumer's state and side effects against the declared ordering and idempotency contract.
- Trigger consumer restart or partition rebalance and verify progress recovery plus any replayed effects.
- Replay from a known offset or checkpoint and compare resulting state with the expected deterministic outcome where the design promises determinism.
- Advance event time or the watermark far beyond completed windows and verify aggregate state, dedup state, timers, and buffers converge to a bounded steady state while finalized results remain correct.
- Send malformed or poison events and verify bounded retry, quarantine, skip, or stop behavior with observable accounting.
- Create lag or backpressure at representative throughput and measure queue growth, processing latency, and recovery after pressure is removed.

## Completion evidence

- Partitioning, ordering, progress, replay, and side-effect decisions for the stream boundary.
- Duplicate, rebalance/restart, poison-event, replay, and backpressure evidence actually exercised.
- Explicit unknowns for production throughput, skew, broker topology, and sink behavior.

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
