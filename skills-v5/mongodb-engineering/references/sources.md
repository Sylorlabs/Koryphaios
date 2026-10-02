# Source map

## Adopted principles

- Embed or reference from ownership, read locality, relationship shape, and duplication cost rather than from a blanket denormalization rule. MongoDB documents embedding and referencing as alternatives with different use cases.
- Treat a single document as the native atomic write boundary. Multi-document transactions exist for invariants that truly span documents, not as a reason to ignore document boundaries.
- Evaluate indexes as read benefits with storage and write costs, and verify execution with `explain` rather than assuming a declared index is useful.

## Conditional recipes

- Embedding is conditional on bounded growth and access locality. It is not adopted as a universal MongoDB architecture.
- References and distributed transactions are conditional tools for independent lifecycle or cross-document invariants. They are not mandatory defaults.
- Sharding, read concern, and write concern choices remain topology and durability decisions that must be resolved against the target deployment.

## Verification scope

Documentation establishes MongoDB semantics and supported mechanisms. It does not prove the target collection's cardinality, index selectivity, aggregation memory profile, replication behavior, or latency. Those claims require current `explain` output, representative data, and deployment evidence.

The four specific pages below were reopened on 2026-09-06 and registered in `kory.json`; refresh within 60 days. Adapt their modeling and plan evidence to the target server version. The manual index remains a discovery source with its inherited date, not a replacement for these specific records.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader backend-engineering.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **MongoDB data modeling best practices**: https://www.mongodb.com/docs/manual/data-modeling/best-practices/
  - Scope: current MongoDB manual, checked 2026-09-06.
  - Use: single-document atomicity, embedding/reference tradeoffs, and index cost framing.
- **Embedded data in your MongoDB schema**: https://www.mongodb.com/docs/manual/data-modeling/embedding/
  - Scope: current MongoDB manual, checked 2026-09-06.
  - Use: embedding benefits, read locality, atomic update boundary, and document size constraint.
- **Reference data in your MongoDB schema**: https://www.mongodb.com/docs/manual/data-modeling/referencing/
  - Scope: current MongoDB manual, checked 2026-09-06.
  - Use: conditions that favor references over embedding.
- **MongoDB explain results**: https://www.mongodb.com/docs/manual/reference/explain-results/
  - Scope: current MongoDB manual, checked 2026-09-06.
  - Use: observable query-plan evidence.
