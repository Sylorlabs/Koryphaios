# Source map

## Applied curation, 2026-09-06

[Handling Overload](https://sre.google/sre-book/handling-overload/) was inspected for rejection costs and retry amplification. Adopt explicit retry ownership and observable overload behavior. No global retry count, fixed quota or Google RPC stack is prescribed. Tests must use the service's actual protocol, authorization and consumer contract.

`network-service-backend` is an individually authored V5 skill package; empirical qualification is tracked separately in the audit/evaluation ledger. These maintained sources bound factual and version-sensitive guidance; qualification is tested with hierarchy-aware held-out routing, paired same-model skill/no-skill tasks, and independent blind evaluation.

## Qualification basis

- Hierarchy: broader backend-engineering; narrower children edge-cdn, networking-systems, realtime-systems, serverless-platforms.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **HTTP semantics**: https://www.rfc-editor.org/rfc/rfc9110
  - Scope: RFC 9110 HTTP Semantics
  - Use: HTTP method, status, representation, caching, and protocol semantics.
  - Verified: 2026-09-04; refresh after 365 days.
- **SWEBOK**: https://www.computer.org/education/bodies-of-knowledge/software-engineering
  - Scope: IEEE Computer Society SWEBOK landing guidance as available 2026-09-04
  - Use: Software engineering lifecycle, construction, testing, maintenance, and professional-practice baseline.
  - Verified: 2026-09-04; refresh after 180 days.

## Interpretation rules

- Prefer the primary official/spec/reference source over community conventions when they conflict.
- Resolve the actual product, language, runtime, provider, platform, protocol, or standard version before applying details that can drift.
- Treat examples as examples, not proof that the current repository/runtime behaves the same way.
- Preserve unknowns and source conflicts explicitly; do not merge incompatible guidance into a false universal rule.
- Keep operational checks in the real target environment whenever the claim depends on runtime behavior.
