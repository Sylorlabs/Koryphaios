# Source map

## Applied curation, 2026-09-06

[Handling Overload](https://sre.google/sre-book/handling-overload/) was inspected for resource limits and retry ownership. Adopt bounded work and explicit degradation. Do not require Google's topology, quota ratios, CPU heuristic, or retry count. Shared authority and general verification prose was removed; the parent retains state, topology and consumer boundary decisions. No runtime or skill qualification is implied.

`backend-engineering` is an individually authored V5 skill package; empirical qualification is tracked separately in the audit/evaluation ledger. These maintained sources bound factual guidance and guidance that is version sensitive; qualification is tested with held out routing that is aware of the hierarchy, paired tasks using the same model with and without the skill, and independent blind evaluation.

## Local review, 2026-10-17

The current entry point and the existing [durable jobs](durable-jobs.md) and [replay checkpoints](replay-checkpoints.md) references remain the starting contract. [State authority and concurrency](state-concurrency.md) adds the missing general state boundary: conflicting writers, isolation, derived state, retention, and migration. This review adds concrete assertions to the two existing task fixtures and ordinary routing paraphrases while retaining the prior routing regressions and scenario identities.

## Evaluation design and limits

- Hierarchy: root responsibility; the exact narrower child identifiers remain in `SKILL.md`. Adjacent contracts remain distinct from implementing backend state and recovery.
- Routing: authored examples and local runtime trigger checks are regression evidence, not an independent measurement of routing generalization. Full catalog resolution is a separate boundary. Cases edited during this review cannot count as newly blind evidence.
- Whole task evaluation: the two existing scenario IDs and `fixture://` starting states remain compatible with the external harness. Its job implementation uses maps and synchronous worker calls; its sync scorer reuses the same state object after interruption. These checks can expose duplicate logical effects but do not establish real durable restart, parallel worker isolation, lease expiry, queue acknowledgment, or cursor expiry behavior.
- Added fixture assertions describe required evidence and label unavailable boundaries. They do not expand the external deterministic scorer. Paired execution, calibrated runtime verification, and independent semantic review remain separate evaluation work; this package review makes no new qualification claim.

## Maintained sources

- **SWEBOK**: https://www.computer.org/education/bodies-of-knowledge/software-engineering
  - Scope: IEEE Computer Society landing page and its v4.0a update notice, inspected 2026-10-17. The full guide was not inspected.
  - Use: Orientation and professional responsibility. This landing page does not support specific isolation or durability claims.
  - Verified: 2026-10-17; refresh after 180 days.
- **Google SRE book**: https://sre.google/sre-book/table-of-contents/
  - Scope: Google Site Reliability Engineering book as available 2026-09-04
  - Use: Navigation only; consult an inspected chapter for behavioral guidance. This entry was not refreshed during the local review.
  - Verified: 2026-09-04; refresh after 365 days.
- **Handling Overload**: https://sre.google/sre-book/handling-overload/
  - Scope: Google SRE book chapter 21, resource limits and Deciding to Retry sections inspected 2026-10-17.
  - Adopt: Bound active and waiting work, reject excess load explicitly, and own retries at a defined layer so retries do not multiply across dependencies.
  - Reject: Google's CPU heuristic, cluster topology, quota ratios, and retry counts as universal defaults. A healthy request rate alone does not prove resource bounds.
  - Verified: 2026-10-17; refresh after 365 days.
- **Making retries safe with idempotent APIs**: https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/
  - Scope: Amazon Builders' Library article sections on request identity, atomic mutation, semantic equivalence, late requests, and changed intent inspected 2026-10-17.
  - Adopt: Caller and operation scoped intent, atomic deduplication with effects, compatible duplicate results, payload conflict handling, and an explicit retention horizon. Applied in `durable-jobs.md` and adapted to logical replay guards in `replay-checkpoints.md`.
  - Reject: Payload equality as proof of duplicate intent and EC2 token lifetime as a generic expiry rule. The article does not make external stores part of a local transaction.
  - Verified: 2026-10-17; refresh after 365 days.
- **PostgreSQL transaction isolation**: https://www.postgresql.org/docs/18/transaction-iso.html
  - Scope: PostgreSQL 18 section 13.2, inspected 2026-10-17.
  - Adopt: Inspect actual isolation, protect invariants across writers, and retry the full transaction after serialization failure. Applied in `state-concurrency.md` and the durable transition guidance.
  - Limit: PostgreSQL isolation and locking semantics do not transfer automatically to another engine, filesystem, or adapter. No PostgreSQL dependency is required.
  - Verified: 2026-10-17; refresh after 365 days.
- **Microsoft Graph delta query overview**: https://learn.microsoft.com/en-us/graph/delta-query-overview
  - Scope: Opaque state tokens, empty pages, replays, and synchronization reset sections, inspected 2026-10-17; published source revision `90b4773e1dd61222be4e5feea3cfeeb162115c9f`.
  - Adopt: Treat cursors as opaque, continue through empty pages when instructed, expect replay, and inspect reset semantics. Applied as a concrete feed example in `replay-checkpoints.md`.
  - Limit: Graph reports entity state, not a universal stable change ID. Its resource specific token durations and reset codes are examples; the actual feed must supply the identity and recovery contract.
  - Verified: 2026-10-17; refresh after 180 days.
- **Compensating Transaction pattern**: https://learn.microsoft.com/en-us/azure/architecture/patterns/compensating-transaction
  - Scope: Azure Architecture Center guidance on concurrent work, resumable compensation, and irreversible steps, inspected 2026-10-17; published source revision `498e83a207cfd512b396489e95ed3f791b372364`.
  - Adopt: Persist compensation progress, make recovery repeatable, preserve concurrent changes, and acknowledge irreversible effects. Applied in `durable-jobs.md`.
  - Reject: The introduction's preference for eventual consistency as a universal architecture rule. Do not require Azure, microservices, or a saga when a local transaction suffices. Compensation is a new domain operation, not guaranteed restoration of a historical snapshot.
  - Verified: 2026-10-17; refresh after 365 days.

## Interpretation rules

- Prefer the primary official/spec/reference source over community conventions when they conflict.
- Resolve the actual product, language, runtime, provider, platform, protocol, or standard version before applying details that can drift.
- Treat examples as examples, not proof that the current repository/runtime behaves the same way.
- Preserve unknowns and source conflicts explicitly; do not merge incompatible guidance into a false universal rule.
- Keep operational checks in the real target environment whenever the claim depends on runtime behavior.
