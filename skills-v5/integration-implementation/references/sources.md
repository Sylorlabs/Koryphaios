# Source map

## Retry ownership and partial outcomes

- **REL05-BP03 Control and limit retry calls**: https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/rel_mitigate_interaction_failure_limit_retries.html
  - Opened 2026-09-06; refresh within 90 days. Adopt bounded retries and an explicit retry layer; inspect built-in SDK behavior before adding another retry mechanism.
  - Adapt backoff, jitter, timeout, and stopping policy to the provider contract and total operation deadline. Reject universal retry counts and the assumption that transient failure proves a mutation did not commit.
  - AWS examples do not require AWS, a particular SDK, or retries for every operation. Replay safety still comes from the actual idempotency and reconciliation contract.

`implementation` owns general patch discipline; this skill owns cross-system translation and failure semantics. Email, payment, and webhook children own their specific lifecycles. Source curation is independent implementation review, not empirical qualification.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader implementation; narrower children email-delivery, payment-integration, webhook-integration.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **SWEBOK**: https://www.computer.org/education/bodies-of-knowledge/software-engineering
  - Scope: IEEE Computer Society SWEBOK landing guidance as available 2026-09-04
  - Use: software lifecycle background only; not provider-specific error, cancellation, or retry evidence.
  - Verified: 2026-09-04; refresh after 180 days.
