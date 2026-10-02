---
name: distributed-debugging
description: Debug failures spanning processes, services, queues, nodes, replicas, retries, or partial availability by reconstructing causal state across boundaries. Use when one logical operation crosses independent components and local evidence alone cannot establish where the contract first failed.
---

# Distributed Debugging

Start with one logical operation and correlate its stable identity across every relevant boundary: request/trace ID, message/event ID, entity/version, attempt number, deployment version, acknowledgement, and durable state transition. Normalize clocks only as supporting evidence; do not infer causality from timestamps alone when retries, buffering, or skew can reorder observations.

Model the delivery and consistency contract before diagnosing it. Distinguish accepted from durably recorded, sent from acknowledged, acknowledged from processed, attempted from committed, and current from stale/read-replica state. Test delay, loss, duplication, reordering, retries, partitions, stale reads, version skew, and partial dependency failure only where the system can actually exhibit them and the exercise is authorized. Prefer captured traces or isolated reproductions for diagnosis; a request to explain an outage does not authorize disrupting a live service.

Reconstruct the first boundary where the observed history becomes impossible under the intended contract. Compare evidence across services rather than trusting any one component's success log. When observability is insufficient, identify the smallest missing correlation/version evidence and add instrumentation only when authorized; do not invent a causal story from missing data.

For an authorized fix, correct the owning contract or state transition, then prove recovery behavior as well as the nominal path: retry/replay, idempotency, stale-state rejection, redelivery, failover, or reconciliation as appropriate. Preserve one cross-boundary regression or deterministic simulation when feasible.

Use parent `debugging` for the overall reproduce/hypothesize/fix/regress discipline. Use `concurrency-debugging` for shared-process scheduling defects, `deterministic-debugging` for one captured payload/state path, and `performance-debugging` when the primary failure is measured latency/resource behavior rather than distributed correctness.

Use [the maintained source map](references/sources.md) for trace-correlation and troubleshooting guidance.
