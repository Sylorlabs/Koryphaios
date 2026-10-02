# Source map

## Adopted principles

- Kafka records are ordered within a partition, not globally across a topic. Partition key design therefore determines both ordering scope and distribution.
- Replay and duplicate delivery must be part of consumer design. Progress markers only become meaningful when related to the durability boundary of state and side effects.
- Backpressure, poison-event handling, and recovery are first-class stream behavior, not exceptional cleanup paths.

## Conditional recipes

- Kafka is a reference for partitioned-log semantics, not a mandatory broker or stream processor.
- Exactly-once features, transactions, state stores, watermarking strategies, dead-letter topics, and checkpoint formats are platform-specific recipes and are not imposed universally.
- Version-scoped Kafka design pages should not be generalized to a different broker or Kafka release without checking the target version.

## Verification scope

Kafka documentation establishes topic, partition, key, ordering, and consumer-group concepts. It does not prove application idempotency, sink atomicity, partition skew, late-data behavior, production throughput, or replay correctness. Those require end-to-end tests with the selected processor and sink.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader distributed-backend.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **Apache Kafka documentation**: https://kafka.apache.org/documentation/
  - Scope: current Kafka documentation checked 2026-09-06.
  - Use: topic, partition, key, ordering, replication, and consumer concepts.
- **Apache Kafka 4.0 design documentation**: https://kafka.apache.org/40/design/design/
  - Scope: Kafka 4.0 version-scoped design reference checked 2026-09-06.
  - Use: delivery and storage design details only when the target version is compatible; not treated as a universal current-version rule.
