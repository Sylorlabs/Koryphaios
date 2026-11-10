# Source map

## Adopted principles

- Kafka records are ordered within a partition, not globally across a topic. Partition key design therefore determines both ordering scope and distribution.
- Replay and duplicate delivery must be part of consumer design. Progress markers only become meaningful when related to the durability boundary of state and side effects.
- Backpressure, handling of poison events, and recovery are core stream behavior rather than exceptional cleanup.

## Conditional recipes

- Kafka documents the semantics of partitioned logs; it is not a mandatory broker or stream processor.
- Claims about exactly once processing, transactions, state stores, watermarking, dead letter topics, and checkpoint formats depend on the actual platform and cannot be imposed universally.
- Kafka design pages written for a specific version must not be generalized to another broker or release without checking compatibility.

## Verification scope

Kafka documentation establishes topic, partition, key, ordering, and consumer group concepts. It does not prove application idempotency, sink atomicity, partition skew, handling of late data, production throughput, or replay correctness. Those require tests across the selected processor and sink.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader distributed-backend.
- Routing: five positive, five negative cases about neighboring skills, three compound or ambiguous, and three adversarial withheld cases through the real resolver.
- Full task evaluation: two individual scenarios with six falsifiable checks, pairing on the same model with and without the skill, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **Apache Kafka documentation**: https://kafka.apache.org/documentation/
  - Scope: current Kafka documentation checked 2026-09-06.
  - Use: topic, partition, key, ordering, replication, and consumer concepts.
- **Apache Kafka 4.0 design documentation**: https://kafka.apache.org/40/design/design/
  - Scope: Kafka 4.0 design reference checked 2026-09-06.
  - Use: delivery and storage details only when the target version is compatible; never assume the version applies universally.
