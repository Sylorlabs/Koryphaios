---
name: distributed-backend
description: Engineer distributed systems with explicit consistency, partition, retry, ordering, ownership, and operability models. Use when the request specifically requires distributed system, multi-region, consensus, event driven services.
---

# Distributed Backend

## Responsibility

First establish that state or commands really cross process, host, or failure domain boundaries. If a single process or one durable authority is sufficient, keep the design there. When distribution is required, define data and command ownership, consistency guarantees per operation, ordering, clocks, identity, partition behavior, durability, replication, leader or coordination model, delivery semantics, idempotency, backpressure, retry budgets, failure detection, reconciliation, and disaster recovery. Make stale, unavailable, and unknown outcome states explicit instead of implying exactly once behavior.

Minimize cross boundary coordination and preserve debuggability. Document each invariant, its authority, and the evidence that can falsify it. Test concurrency, duplication, reordering, delay, partitions, clock skew, node loss, recovery, schema evolution, overload, replay, and operator procedures with deterministic simulation or fault injection where possible. Do not introduce microservices, queues, orchestration, or eventual consistency as fashion.

## Hierarchy and routing

- Broader skills: backend-engineering.
- Narrower children: event-driven-architecture, stream-processing.

## Professional practice

### Operating contract

Design multi node coordination around partial failure, independent clocks, and split ownership. Treat the following as separate decisions:

- **Authority:** identify the writer, quorum, lease/fencing mechanism, or reconciliation rule. A lease is not authority merely because a local wall clock says it has expired. Encode the fencing decision as an explicit boolean admission predicate at the write or dispatch entry point, so `true` means the caller still holds authority and `false` means it was fenced or rejected. Keep the committed command record, token, and any diagnostic detail on a separate accessor or result object: a caller that only wants to know whether its write was admitted must not have to parse a payload to find out, and a fenced writer must receive `false` rather than a successful-looking record.
- **Consistency:** state the read and write guarantee for each operation, including what is rejected or stale during a partition. Do not use one global label such as “eventual” to hide stronger or weaker operations.
- **Delivery:** assume loss, duplication, delay, and reordering unless the transport contract proves otherwise. Define the acknowledgement boundary and the effect boundary separately.
- **Identity:** carry a stable command or event identity, origin, version, and causal or fencing metadata through retries and replay. Scope deduplication keys to the operation and retention window.
- **Retry ownership:** choose one layer to retry a remote operation, cap attempts and total work, use backoff with jitter, and surface an unknown outcome for reconciliation when the response is lost after the effect may have committed.
- **Recovery:** specify the replay source, checkpoint or snapshot boundary, membership or leadership transition, conflict rule, and the condition that permits normal writes again.

### Execution sequence

1. Name nodes, authorities, state partitions, messages, clocks, and failure model.
2. Establish the operation matrix: consistency, ordering, replication, conflict, acknowledgement, and availability under a partition.
3. Define command/event identity, deduplication scope, retention or compaction boundary, and the result of an interrupted or ambiguous attempt.
4. Assign one retry owner and an end to end budget; distinguish retryable failure, permanent rejection, cancellation, and unknown commit.
5. Design reconciliation, membership or fencing, restart/replay, and the exact recovery gate.
6. Instrument identities, attempt numbers, versions, tokens, partition state, and causal traces before optimizing.
7. Test loss, delay, duplication, reordering, partition, failover, replay, mixed versions, and restart with deterministic clocks and fault injection.

### Bounded repository repairs

When the task supplies a repository fixture and explicit acceptance checks, treat it as a bounded repair rather than an open ended architecture exercise.

- Inspect the implementation and tests that enforce the requested coordination contract, then make the smallest change that satisfies that invariant.
- Run focused deterministic tests as soon as the core behavior is implemented; resolve those failures before expanding analysis or documentation.
- Prioritize executable authority, consistency, replay, and recovery behavior plus the required negative-path evidence over additional design prose.
- Preserve the supplied public method signatures and their plain behavior. Do not add preconditions, confirmation flags, or throwing guards that the acceptance contract does not name: a documented call must still succeed when its stated inputs are valid, and an ordering requirement is the caller's responsibility rather than an excuse to make that call fail.
- Do not expand into unstated topology, disaster recovery, schema evolution, observability, or operator redesign once the acceptance contract has enough evidence.
- Produce required evidence artifacts from observed behavior; do not delay the implementation for an exhaustive survey of distributed-systems concerns.
- Under a fixed task budget, complete the minimum acceptance and evidence contract first: implement the invariant, run the named success and failure/recovery checks, write the required result/verification artifacts, and label anything unavailable or unresolved. Once those artifacts prove every requested check, stop instead of spending the remaining budget on optional exploration or prose.

### Decisions that must be explicit

- Authoritative state and conflict resolution.
- Required ordering and consistency level per operation.
- Failure detector and membership assumptions.
- Availability behavior under partition and recovery.
- Retry owner, attempt budget, backoff, and unknown outcome reconciliation.
- Idempotency key scope, durable deduplication, expiry, compaction, and settled state retention.
- Recovery source, fencing or epoch transition, replay boundary, and operator stop conditions.

### Failure and recovery discipline

- Reject wall clock timestamps as proof of causality or authority.
- Bound retry ownership so retries do not amplify duplicate effects across layers.
- Do not let two nodes become authority without an explicit reconciliation or fencing rule.
- Do not treat clean cluster tests as evidence for partition, failover, replay, or mixed version behavior.
- When deduplication identities expire or compact, define the shared replay/retention boundary first. Preserve settled contribution separately from retained identities so merge, restart, and failover cannot count old work again or resurrect inputs that are already outside the replay window.
- Do not infer that a timeout means “not committed.” Query a durable operation record or reconcile by identity before issuing a new effect.
- Do not declare recovery complete when replicas merely reconnect. Verify convergence, stale writer rejection, replay accounting, and the resumed write gate.

### Evidence required before completion

- State/authority and message model.
- Fault injection and reconciliation traces.
- Mixed version and recovery tests.
- Bounded consistency and availability claims.
- Retry and idempotency evidence that distinguishes duplicate suppression from a lost legitimate operation.
- A recovery trace showing authority transition, replay or reconciliation, and the first accepted post recovery write.

### Avoiding misinterpretation

- Do not invoke distributed complexity for hypothetical scale.
- Do not promise exactly-once without defining the boundary.
- Do not hide conflict loss.
- Do not infer production lifetime safety from a short stress run.

## Completion evidence

- Consistency and failure model
- Fault injection or simulation evidence
- Operation level retry, idempotency, and replay boundary
- Recovery and reconciliation trace

### Routing and scope boundary

- `distributed-backend` owns cross-node authority, consistency, partition, retry, idempotency, replay, and recovery behavior.
- `event-driven-architecture` owns event contracts and event-oriented integration when the request does not require the cross-node consistency or recovery analysis above.
- `stream-processing` owns windows, watermarks, offsets, and stateful stream execution when those are the current responsibility rather than a supporting transport.
- `network-service-backend` owns listener, protocol, and request/response behavior after network-path concerns are isolated.
- `local-service-backend` owns a single-host process or IPC boundary. `in-process-backend` owns coordination that does not cross a process boundary.

Routing, hierarchy selection, and paired skill/no skill provenance are evaluator-owned. Do not spend the task budget creating meta-level selection narratives or claiming paired-run evidence as agent-observed work. Package-local checks validate metadata and bounded trigger behavior only; they do not establish a live broker, quorum, storage engine, clock, partition, failover, or production guarantee.

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
