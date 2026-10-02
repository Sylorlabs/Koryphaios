---
name: distributed-backend
description: Engineer distributed systems with explicit consistency, partition, retry, ordering, ownership, and operability models. Use when the request specifically requires distributed system, multi-region, consensus, event driven services.
---

# Distributed Backend

## Responsibility

Require evidence that distribution is necessary. Define data and command ownership, consistency guarantees, ordering, clocks, identity, partition behavior, durability, replication, leader or coordination model, delivery semantics, idempotency, backpressure, retry budgets, failure detection, reconciliation, and disaster recovery. Make unavailable or uncertain states explicit instead of implying exactly-once behavior.

Minimize cross-boundary coordination and preserve debuggability. Document invariants and which component enforces each one. Test concurrency, duplication, reordering, delay, partitions, clock skew, node loss, recovery, schema evolution, overload, replay, and operator procedures with deterministic simulation or fault injection where possible. Do not introduce microservices, queues, orchestration, or eventual consistency as fashion.

## Hierarchy and routing

- Broader skills: backend-engineering.
- Narrower children: event-driven-architecture, stream-processing.

## Professional practice

### Operating contract

Design multi-node coordination around partial failure, independent clocks, and split ownership.

### Execution sequence

1. Name nodes, authorities, state partitions, messages, clocks, and failure model.
2. Choose consistency, ordering, replication, and conflict semantics explicitly.
3. Design idempotency, deduplication, reconciliation, membership, and recovery.
4. Instrument identities and causal traces before optimizing.
5. Test loss, delay, duplication, reordering, partition, failover, and mixed versions.

### Decisions that must be explicit

- Authoritative state and conflict resolution.
- Required ordering and consistency level per operation.
- Failure detector and membership assumptions.
- Availability behavior under partition and recovery.

### Failure and recovery discipline

- Wall-clock timestamps are trusted as causality.
- Retries amplify duplicate effects.
- Two nodes become authority without reconciliation.
- Clean-cluster tests hide partition and upgrade behavior.

### Evidence required before completion

- State/authority and message model.
- Fault-injection and reconciliation traces.
- Mixed-version and recovery tests.
- Bounded consistency and availability claims.

### Anti-misinterpretation boundaries

- Do not invoke distributed complexity for hypothetical scale.
- Do not promise exactly-once without defining the boundary.
- Do not hide conflict loss.
- Do not infer production lifetime safety from a short stress run.

## Completion evidence

- Consistency and failure model
- Fault-injection or simulation evidence

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
