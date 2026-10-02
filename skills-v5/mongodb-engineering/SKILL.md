---
name: mongodb-engineering
description: Engineer MongoDB document models, indexes, transactions, aggregation, sharding, and schema evolution around access patterns. Use when the request specifically requires mongodb, mongo collection, mongo aggregation, mongo index; prefer a narrower child only when its boundary is established.
---

# Mongodb Engineering

## Responsibility

Model documents around ownership, atomic update boundaries, cardinality, growth, and dominant access patterns. Decide embed versus reference explicitly, enforce validation where appropriate, and understand multikey indexes, aggregation memory, transactions, replica consistency, and shard-key consequences.

Verification focus: Inspect explain plans and index coverage, test document growth and migration, concurrent updates, transaction/retry behavior, read/write concern, and representative aggregation cardinalities.

Failure boundaries: Do not model every relation as embedded, use unbounded arrays, add indexes without write/storage cost analysis, or assume eventual consistency is acceptable without a product contract.

## Hierarchy and routing

- Broader skills: backend-engineering.
- No narrower bundled child is declared.
- Required skills: verification.

## Decision rules

- Choose embedding when data is owned and commonly read with its parent and the relationship can stay within document growth limits. Choose references when independent lifecycle, many-to-many relationships, or duplication costs dominate.
- Treat the single document as the default atomic write boundary. Use multi-document transactions only when an invariant genuinely spans documents and the operational cost is acceptable.
- Design indexes from concrete query predicates, sort order, cardinality, and multikey behavior. Account for index storage and write amplification before adding coverage.
- Make document growth, array bounds, schema validation, read concern, write concern, and shard-key assumptions explicit when they affect correctness or operability.
- Keep aggregation pipelines tied to representative cardinalities. A syntactically valid pipeline is not evidence that memory use, index use, or execution shape is acceptable.

## Observable checks

- Capture `explain` output for representative reads and aggregations and verify expected index use, examined-document counts, sort behavior, and stage shape.
- Exercise embedded and referenced updates at the actual atomicity boundary, including concurrent updates when lost-update behavior matters.
- Test migrations against realistic document sizes and array cardinalities, including documents near known growth limits.
- Verify configured read and write concerns, transaction retry behavior, and shard routing where those features are part of the design.
- Record any claim that depends on production distribution, cluster topology, or workload as unverified until measured in that environment.

## Completion evidence

- Document-model decision with ownership, cardinality, growth, and atomicity rationale.
- Representative query or aggregation plans plus migration and concurrency results when applicable.
- Explicit unresolved evidence for cluster topology, production distribution, or workload-dependent claims.

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
