---
name: event-driven-architecture
description: Design event-driven systems with clear event semantics, ownership, ordering, delivery, schema evolution, replay, and side-effect boundaries. Use when the request specifically requires event driven architecture, domain event, message broker architecture, event bus; prefer a narrower child only when its boundary is established.
---

# Event Driven Architecture

When you repair a durability boundary, walk the crash matrix explicitly, because each cell is a separate obligation. Before commit, a failure leaves neither the state row nor the outbox record. At or after commit, a failure may leave both, never the row alone. After broker publish but before acknowledgement, a retry republishes the same event under the same stable identity and version, so the consumer sees the event twice. After acknowledgement but before cleanup, a retry must not resurrect a second logical event. A consumer applies the effect once per stable identity and records that it observed a duplicate, and the outbox record is cleared only once publication is acknowledged. State plainly that the transport is at least once and that no exactly-once delivery is claimed, and keep the crash matrix, the duplicate observation count and the boundary description in the evidence artifact rather than only in prose.

Schema evolution is two independent jobs and the fixture scores them apart. In a compatibility envelope the producer must keep emitting every field that an older consumer still reads, even when a richer representation already carries the same information: a redundant legacy field next to the new collection, not instead of it. The legacy scalar also has to be one of the values the old generation accepts: a customer whose preferred method is a new one still ships a compatible preference derived from an older contact they do have, while the rich collection preserves the new method. A compatibility producer rejects nothing the modern producer accepts; it only narrows the legacy scalar. Upgraded decoders must treat an unrecognised enum value as an explicit unknown or fallback that the caller can observe, never as a fatal decode, so a future producer cannot break a deployed consumer. Do not widen the old generation's accepted values while doing this, because its narrowness is the point: it must still reject a value it never knew, which is exactly what puts the event in the dead-letter queue. An incompatible delivery to an old consumer is captured in a dead-letter queue with the original payload, and a replay through the upgraded consumer drains it and reports how many messages recovered. Both behaviours, plus historical replay of an old event through the new decoder, belong in the regression suite.

## Responsibility

Distinguish commands, domain events, integration events, notifications, and change data streams. Define producer ownership, the authoritative source, the event envelope, ordering scope, delivery guarantee, idempotency boundary, outbox/inbox or equivalent recovery boundary, replay, retention, dead letter policy, routing, and consumer side effects.

## Operating contract

Write the contract before choosing a broker feature. For each message flow, record:

- **Role and authority:** whether the message is a command, domain event, integration event, notification, or change data record; which component owns the decision; and which store or upstream system is authoritative when delivery is delayed or conflicted.
- **Stable envelope:** an immutable logical `event_id` for one business occurrence, `event_type`, `schema_version`, producer, occurred-at time, aggregate or subject identity, ordering key and sequence when applicable, correlation/causation identifiers, and tenant or authorization scope when those affect processing. A transport offset, delivery attempt, timestamp, or payload hash is not a substitute for logical identity.
- **Contract surface:** required and optional fields, nullability, unknown field behavior, enum policy, units, redaction, retention, and whether consumers may read producer storage. Publish the contract they need; never make undocumented database columns part of the event API.
- **Boundary:** the authoritative state commit and event durability boundary are explicit. If they cannot be atomic, use an outbox, change log, transactional publisher, reconciliation job, or another named mechanism that makes the missing event window observable and recoverable.
- **Delivery:** state the guarantee for every hop and the end to end consequence: at most once, at least once, or a stronger bounded claim with its exact transaction boundary. Define retry ownership, timeout ambiguity, acknowledgement/checkpoint timing, backoff and retry budget. A broker acknowledgement proves only the broker step.
- **Effects:** name every externally visible side effect and the durable idempotency or reconciliation authority that protects it. Reuse the same logical identity on retry, replay, and schema representation changes. Define the conflict result when an identity is reused with different business content.
- **Ordering:** state the smallest business scope that requires order, its ordering key, sequence or version rule, gap and late event behavior, and whether an event can be corrected. Partition or connection order is not global order, and arrival order is not causality.
- **Recovery:** define retention and replay authority, consumer progress, restart behavior, reconciliation, and cleanup conditions. A replay must pass through normal authorization, validation, idempotency, and side effect controls.

## Transferable decisions

- Name the message role first. A command asks an owner to act; an event states that something happened; a notification tells a recipient about state; a change-data record mirrors storage change. Different roles imply different ownership and coupling.
- Define event identity, producer ownership, schema version, ordering scope, retention, and replay meaning before selecting broker features.
- Keep logical event identity stable across representation upgrades. A schema version describes decoding, not a new business occurrence; replaying the same occurrence in a newer representation must still hit the same idempotency boundary. Preserve existing public identifiers, even if they contain a version like suffix, rather than renaming them during an unrelated durability repair.
- Treat delivery guarantees as properties of the whole path, not of one hop. Broker delivery does not by itself make a side effect exactly once; consumer idempotency or reconciliation must cover redelivery.
- Publish only from a recoverable boundary with authoritative state. An outbox is one option when database commit and event publication cannot be atomic, not a universal architecture requirement. Do not delete a pending record until the declared publication confirmation and cleanup invariant hold.
- Scope ordering to the business invariant that needs it. Global ordering is usually stronger and more expensive than per entity or per partition ordering. If a gap blocks one key, prove that unrelated keys continue according to the contract.
- Make idempotency durable at the same boundary as the protected effect, or reconcile against an authority that makes repeats safe. A process local set proves only process local suppression and must not be presented as restart safety.
- Treat schema evolution as a coexistence problem. Prefer an additive, tolerant reader rollout; specify old reader behavior for unknown fields and enum values; preserve an old supported representation until consumers migrate; and test historical replay through both versions. A version label without a compatibility rule is not a migration plan.
- Treat a poison event as an operational state, not an infinite retry loop. Bound attempts and delay, preserve the original envelope and failure context in a dead letter record, isolate unrelated traffic at the intended ordering scope, expose an operator action, and redrive with the original logical identity after correction.
- Separate source selection from routing. Route keyed event time windows, partition state, watermarks, and backpressure to `stream-processing`; route connection/fan out/resume behavior to `realtime-systems`; route caller visible request/response contracts to `api-contract-design`. This skill owns asynchronous event boundaries and consumer effects.

## Observable checks

- Deliver the same event twice and verify the consumer's externally visible effect is duplicate safe or explicitly reconciled.
- Delay and reorder events within and across the declared ordering scope, then verify state converges according to the contract.
- Introduce an unknown additive field and an older supported schema version to verify consumer compatibility behavior.
- Replay a bounded historical range and confirm replay does not bypass normal idempotency, authorization, or side effect controls.
- Inject a poison event and verify retry, quarantine or dead letter handling, operator visibility, and recovery without blocking unrelated traffic beyond the intended scope.
- Map each requested check to an executed assertion and result. A passing outbox crash test does not establish delayed/reordered delivery, schema compatibility, bounded replay, or consumer reconciliation. Record unexercised checks explicitly; catch expected injected crashes in tests so the recovery assertions actually run.
- Force a timeout or crash after a durable effect but before acknowledgement, restart the consumer, and verify the replayed event is recognized without a second effect and that progress advances only after the durable boundary.
- Verify a missing publication through authoritative-state reconciliation or an outbox retry, rather than treating broker absence alone as proof of data loss. Exercise a sequence gap and show whether the affected key waits, repairs, or converges by the declared rule.
- Verify dead letter redrive after the poison condition is corrected, including original `event_id`, attempt history, authorization, and duplicate handling. Confirm one poison key does not silently stall unrelated keys.

## Failure boundaries

Do not use events to hide synchronous dependencies, publish before authoritative state commits without a recovery model, or let consumers depend on undocumented producer database fields. Do not claim exactly once business effects from a broker setting alone.

Do not treat an offset, acknowledgement, successful enqueue, schema parse, or clean process duplicate test as proof of end to end correctness. Do not discard an event merely because it is old, out of order, or unknown without a declared version, retention, gap, or quarantine policy.

## Hierarchy and routing

- Broader skills: distributed-backend.
- No narrower bundled child is declared.
- Required skills: verification, reliability-verification.

Route here for event semantics, producer and consumer ownership, asynchronous coupling, delivery, replay, and side effect boundaries. Route continuous keyed state and event time window computation to `stream-processing`, and route request/response APIs to the relevant API child.

## Completion evidence

- A compact contract record covering message role, source of truth, envelope identity, ownership, routing, ordering scope, delivery and acknowledgement boundaries, retention, replay, schema compatibility, retry budget, dead letter envelope, and consumer effects.
- A verification matrix mapping each requested assertion to an executed test or observed result, including duplicate, delayed, reordered, missing, schema-evolved, poison, dead letter redrive, restart, and bounded replay cases.
- Evidence that producer publication and authoritative state have a recoverable boundary, including the crash/failure point, pending or reconciled state, and cleanup condition.
- Consumer idempotency or reconciliation evidence for externally visible side effects across a restart, with the logical identity preserved through replay and schema representation changes.
- Explicit status for every unexercised check: unavailable, simulated, inferred, stale, unresolved, or not applicable. Do not turn an evaluator-owned paired run or routing observation into agent-observed evidence.

Routing, hierarchy selection, and paired skill/no skill provenance are owned by the evaluator. Do not create selection narratives at the meta level or claim evidence from paired runs as work the agent observed; keep the deliverable focused on event behavior, consumer boundaries, and the requested boundary with neighboring scope.

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
