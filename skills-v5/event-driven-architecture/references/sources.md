# Source map

This map uses AsyncAPI for message-contract vocabulary and Kafka for concrete partition, ordering, offset, and delivery examples. Kafka-specific mechanisms remain conditional implementation evidence.

## Adopted principles

- Asynchronous contracts distinguish messages, channels, and operations. Message identity, correlation, payload schema, and channel semantics should not be collapsed into one undocumented broker topic convention.
- Ordering guarantees have scope. Kafka documents ordering within a partition, which supports the broader decision to declare the business ordering boundary explicitly.
- Consumer progress and replay are separate from event identity. Kafka offsets can be moved and records reconsumed, so consumers must define replay-safe side effects.
- Broker delivery semantics do not prove exactly-once business effects outside the broker and its supported transaction boundary.

## Conditional or non-adopted recipes

- AsyncAPI documents are optional contract artifacts. Do not require AsyncAPI when another schema or contract mechanism already serves the repository.
- Kafka partitions, consumer groups, transactions, and offsets are Kafka recipes. Other brokers can satisfy the same conceptual boundaries differently.
- Outbox, inbox, dead-letter queue, and schema-registry products are conditional patterns, not mandatory architecture.

## Verification scope

Verify duplicate, delayed, reordered, missing, poison, schema-evolved, and replayed messages at the actual broker and consumer boundary. Verify authoritative-state publication recovery separately from broker acceptance. Do not infer business exactly-once behavior from documentation alone.

## Primary sources

- AsyncAPI latest reference: https://www.asyncapi.com/docs/reference/specification/latest
  - Existing navigation source retained from 2026-09-04.
- AsyncAPI Specification 3.1.0: https://www.asyncapi.com/docs/reference/specification/v3.1.0
  - Adopted for message, channel, operation, and correlation concepts.
  - Verified 2026-09-06.
- Apache Kafka documentation: https://kafka.apache.org/documentation/
  - Existing source retained from 2026-09-04 and refreshed 2026-09-06 for partition ordering and consumer concepts.
- Kafka design: https://kafka.apache.org/40/design/design/
  - Conditional source for offsets, redelivery, transactions, and Kafka-specific delivery semantics.
  - Verified 2026-09-06.
