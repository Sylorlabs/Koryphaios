# Source map

This map uses AsyncAPI and CloudEvents for message-contract vocabulary and Kafka for concrete partition, ordering, offset, and delivery examples. Kafka-specific mechanisms remain conditional implementation evidence.

## Adopted principles

- Asynchronous contracts distinguish messages, channels, and operations. Message identity, correlation, payload schema, and channel semantics should not be collapsed into one undocumented broker topic convention.
- An event envelope can carry logical identity, type, source, time, subject, and repository-defined correlation information independently of a broker offset. Adopt CloudEvents only when its envelope is part of the repository contract; otherwise preserve the repository's established equivalent fields.
- Ordering guarantees have scope. Kafka documents ordering within a partition, which supports the broader decision to declare the business ordering boundary explicitly.
- Consumer progress and replay are separate from event identity. Kafka offsets can be moved and records reconsumed, so consumers must define replay-safe side effects.
- Broker delivery semantics do not prove exactly-once business effects outside the broker and its supported transaction boundary.
- Dead-letter handling is an application recovery contract, not a universal guarantee supplied by a broker. Preserve the original event identity, payload or durable reference, failure class, attempt history, first-failed time, and re-drive authorization; define retention and whether re-drive returns to the original ordering scope.
- Schema compatibility, enum tolerance, and consumer rollout order are repository decisions. Official contract vocabulary can inform the shape, but it cannot prove that a particular old consumer accepts a new field or value.

## Conditional or non-adopted recipes

- AsyncAPI documents are optional contract artifacts. Do not require AsyncAPI when another schema or contract mechanism already serves the repository.
- CloudEvents is an optional envelope convention. Do not add a second identity or version field merely to follow it; map the existing logical event identity and schema policy if the convention is adopted.
- Kafka partitions, consumer groups, transactions, and offsets are Kafka recipes. Other brokers can satisfy the same conceptual boundaries differently.
- Outbox, inbox, dead-letter queue, and schema-registry products are conditional patterns, not mandatory architecture.
- A source map records version-sensitive facts and provenance; it does not replace a local contract, a consumer compatibility test, a fault-injection result, or an operator recovery record.

## Verification scope

Verify duplicate, delayed, reordered, missing, poison, evolved schema, and replayed messages at the actual broker and consumer boundary. Verify recovery of publication to authoritative state separately from broker acceptance. Verify dead-letter re-drive and cleanup separately from initial quarantine. Do not infer business exactly once behavior from documentation alone.

## Evidence map

| Requested concern       | Contract decision                                                                                                 | Minimum observed evidence                                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Identity and contracts  | Stable logical `event_id`, type, version, source, subject, correlation, ordering key, and compatibility rules     | Old and new representations decode according to the stated rule; representation changes do not change the idempotency key      |
| Delivery and recovery   | Per-hop guarantee, retry owner, acknowledgement boundary, authoritative state, and publication recovery mechanism | Injected crash or publish failure leaves a pending/reconcilable record and later produces one logical event                    |
| Ordering and routing    | Business ordering scope, gap/late policy, and neighboring skill boundary                                          | Duplicate, delayed, and reordered inputs produce the declared result; unrelated keys are not blocked beyond the declared scope |
| Idempotency and replay  | Durable effect/idempotency boundary, conflict behavior, replay horizon, and authorization rule                    | Restart/replay repeats delivery without repeating the external effect and advances progress only after durability              |
| Poison and dead letters | Bounded retry, quarantine envelope, operator visibility, re-drive identity, and retention                         | Poison traffic is isolated, observable, and recoverable after correction without losing original identity                      |

The table is a verification plan, not a claim that documentation proves runtime behavior. Mark rows that cannot be exercised as unavailable, simulated, inferred, stale, unresolved, or not applicable.

## Primary sources

- AsyncAPI latest reference: https://www.asyncapi.com/docs/reference/specification/latest
  - Existing navigation source retained from 2026-09-04.
- AsyncAPI Specification 3.1.0: https://www.asyncapi.com/docs/reference/specification/v3.1.0
  - Adopted for message, channel, operation, and correlation concepts.
  - Verified 2026-09-06.
- CloudEvents Specification 1.0.2: https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md
  - Conditional envelope reference for event identity, type, source, subject, and time; correlation remains a repository or extension mapping.
  - Verified 2026-09-06.
- Apache Kafka documentation: https://kafka.apache.org/documentation/
  - Existing source retained from 2026-09-04 and refreshed 2026-11-07 for partition ordering and consumer concepts.
- Kafka design: https://kafka.apache.org/40/design/design/
  - Conditional source for offsets, redelivery, transactions, and Kafka-specific delivery semantics.
  - Verified 2026-11-07.
