# Source map

## Applied curation, 2026-09-06

[Handling Overload](https://sre.google/sre-book/handling-overload/) was inspected for multi-layer retries and dependency overload. Adopt bounded retries at an identified owner, not Google's illustrative limits. The child retains its partial failure, conflict and reconciliation responsibilities. A general operating checklist no longer duplicates the parent. Fault-model claims still need executed evidence.

`distributed-backend` is an individually authored V5 skill package; empirical qualification is tracked separately in the audit/evaluation ledger. These maintained sources bound factual and version-sensitive guidance; qualification is tested with hierarchy-aware held-out routing, paired same-model skill/no-skill tasks, and independent blind evaluation.

## Qualification basis

- Hierarchy: broader backend-engineering; narrower children event-driven-architecture, stream-processing.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **Google SRE book**: https://sre.google/sre-book/table-of-contents/
  - Scope: Google Site Reliability Engineering book as available 2026-09-04
  - Use: Reliability, monitoring, incident response, capacity, release, and distributed-systems operating practices.
  - Verified: 2026-09-04; refresh after 365 days.

## Interpretation rules

- Prefer the primary official/spec/reference source over community conventions when they conflict.
- Resolve the actual product, language, runtime, provider, platform, protocol, or standard version before applying details that can drift.
- Treat examples as examples, not proof that the current repository/runtime behaves the same way.
- Preserve unknowns and source conflicts explicitly; do not merge incompatible guidance into a false universal rule.
- Keep operational checks in the real target environment whenever the claim depends on runtime behavior.
