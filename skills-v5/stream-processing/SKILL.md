---
name: stream-processing
description: Engineer streaming systems with event-time, ordering, delivery guarantees, state, partitions, replay, and backpressure. Use when the request specifically requires stream processing, kafka stream, event stream, consumer group; prefer a narrower child only when its boundary is established.
---

# Stream Processing

## Responsibility

Define event identity, keys, ordering scope, event time versus processing time, watermarking, delivery semantics, state stores, partition ownership, and replay behavior. Where delivery can repeat, make consumers idempotent or deduplicating. Control backpressure explicitly.

Verification focus: Exercise duplicates, reordering, partition rebalance, consumer restart, poison messages, lag spikes, replay from offsets, state recovery, and schema evolution with representative throughput.

Failure boundaries: Do not claim global order from partition order, commit offsets before durable effects without understanding loss windows, or hide poison events in infinite retry loops.

## Hierarchy and routing

- Broader skills: distributed-backend.
- No narrower bundled child is declared.
- Required skills: verification, reliability-verification.

## Decision rules

- Define event identity, partition key, ordering scope, event time, processing time, and replay authority before selecting delivery or state processing mechanics.
- State whether event IDs are global or unique only within a key/partition. Scope deduplication and keyed window state accordingly, and test two keys with overlapping local IDs when that is the contract. Preserve an existing aggregate query API while verifying per-key isolation; describing a partition key does not establish isolation if the implementation ignores it.
- Respect the actual broker or processor ordering guarantee. Kafka orders records within each partition, so a keying decision also determines ordering and how load is distributed.
- Assume delivery can repeat unless the complete source, processor, state, and sink path proves a stronger guarantee. Make external side effects idempotent or deduplicated at their durable boundary.
- Align offset or checkpoint advancement with durable effects. Advancing progress before an effect is durable creates loss windows; advancing after can create replay and duplicate windows.
- Define handling for poison events, backpressure, late data, and replay explicitly so failures do not create infinite retry or silent loss.
- Bound every retained state class, including window aggregates, deduplication keys, timers, buffers, and checkpoint or recovery state. Evict each class only when its watermark and replay horizon cannot require it again. If corrections or retractions remain possible, preserve the minimal state needed for that contract instead of allowing unbounded growth.

## Event time window repair

- For a fixed window of size `windowMs`, assign an accepted event to `floor(eventTimeMs / windowMs) * windowMs`, independent of arrival time or the watermark. Reject it as too late only when `eventTimeMs < watermarkMs - allowedLatenessMs`; the exact cutoff remains admissible. Count each stable event identity at most once, including retries after restore. Reordered events within the policy update their original window, with a correction or upsert if a result was already published.
- Advance watermarks monotonically. After each advancement, expire **both** dedup identities **and** window aggregates whose entire event time interval is beyond the permitted correction and replay horizon. For a bucket with an exclusive end, `[start, start + windowMs)`, it becomes final once `start + windowMs <= watermarkMs - allowedLatenessMs`. Remove that bucket from the live count map and its identity entries. Evicting `seen` while retaining `counts` leaks state. Queries for retired buckets must use the documented store of finalized results or return the empty value specified by the live state API, never stale retained aggregates.
- Persist the current watermark, counts for active windows, and corresponding dedup identities in one restorable checkpoint. On recovery, reapply retention against the restored watermark before admitting more events. Verify an old window is initially countable and disappears after a large watermark jump, while a new window and only its live identities remain. Check bounds for aggregate and dedup state separately.

## Checkpoint and external sink repair

- With source delivery that may repeat and a sink that conditionally applies a stable event ID, guarantee logically exactly once **effects** without claiming exactly once transport. Store the idempotency record at the same durable boundary as the effect. Prefer the sink's actual `applyOnce(id, delta)` operation when supplied; a processor local `seen` set will not survive reconstruction, and unconditional `effects.set(id, previous + delta)` will apply a replay twice.
- The sequence for each event is: optional injected failure before writing; await sink success or confirmation that the identity was already applied; optional injected failure after sink success but before checkpoint; then advance the source checkpoint or offset. When a failure occurs after the sink write, the offset must remain behind the durable effect. A fresh processor replaying the event must recognize the sink ID, leave its value unchanged, then advance the offset. For a partial batch, checkpoint only the durable prefix and replay the remainder.
- Preserve the processor method's visible completion contract. If callers distinguish applied from duplicate events, the method returns an explicit outcome string such as `'applied'` or `'duplicate'` on _every successful path_, including replay of a previously committed effect, and it returns that string rather than a boolean, a counter, or a result object. A method that performs the correct effect but returns `undefined` or a bare boolean still violates that interface, because a caller or a test cannot distinguish the outcome without re-reading the sink. Translate the sink's own result instead of forwarding it: a conditional apply that answers a boolean (`true` when this call wrote the effect, `false` when the identity was already present) must be mapped onto the processor's outcome vocabulary, so `return this.sink.applyOnce(id, delta)` is wrong when the method contract promises `'applied'` or `'duplicate'`, because the caller then receives `false` and cannot tell a duplicate from a failed write. Test the returned status, sink contents, exception timing, and checkpoint position with a new processor instance sharing the persistent sink.

## Observable checks

- Inject duplicate and reordered events and verify the consumer's state and side effects against the declared ordering and idempotency contract.
- Trigger consumer restart or partition rebalance and verify progress recovery plus any replayed effects.
- Replay from a known offset or checkpoint and compare resulting state with the expected deterministic outcome where the design promises determinism.
- Advance event time or the watermark far beyond completed windows and verify aggregate state, dedup state, timers, and buffers converge to a bounded steady state while finalized results remain correct.
- Send malformed or poison events and verify bounded retry, quarantine, skip, or stop behavior with observable accounting.
- Create lag or backpressure at representative throughput and measure queue growth, processing latency, and recovery after pressure is removed.

## Completion evidence

- Partitioning, ordering, progress, replay, and effect decisions for the stream boundary.
- Duplicate, rebalance or restart, poison event, replay, and backpressure evidence actually exercised.
- Explicit unknowns for production throughput, skew, broker topology, and sink behavior.

Routing, hierarchy selection, and paired skill/no skill provenance are evaluator-owned. Do not create meta-level selection narratives or claim paired-run evidence as agent-observed work; keep the deliverable focused on stream behavior, durable effect boundaries, and concrete broker or sink scope.

Use [the maintained source map](references/sources.md) for facts that depend on versions or conflicting sources.
