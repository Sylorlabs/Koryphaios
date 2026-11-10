# Source map

## Applied curation, 2026-09-06

[Handling Overload](https://sre.google/sre-book/handling-overload/) was inspected for rejection costs and retry amplification. Adopt explicit retry ownership and observable overload behavior. No global retry count, fixed quota or Google RPC stack is prescribed. Tests must use the service's actual protocol, authorization and consumer contract.

`network-service-backend` is an individually authored V5 skill package; empirical qualification is tracked separately in the audit/evaluation ledger. These maintained sources bound factual guidance that varies by version; qualification is tested with held out routing that is aware of the hierarchy, paired tasks that run skill and no skill modes of the same model, and independent blind evaluation.

## Qualification basis

- Hierarchy: broader backend-engineering; narrower children edge-cdn, networking-systems, realtime-systems, serverless-platforms.
- Routing: five positive, five negative cases that are near neighbors, three compound/ambiguous, and three adversarial held out cases through the real resolver.
- Evaluation of full tasks: two individual scenarios with six falsifiable checks, pairing of skill and no skill runs of the same model, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **HTTP semantics**: https://www.rfc-editor.org/rfc/rfc9110
  - Scope: RFC 9110 HTTP Semantics
  - Use: HTTP method, status, representation, caching, and protocol semantics.
  - Verified: 2026-09-04; refresh after 365 days.
- **SWEBOK**: https://www.computer.org/education/bodies-of-knowledge/software-engineering
  - Scope: IEEE Computer Society SWEBOK landing guidance as available 2026-09-04
  - Use: Software engineering lifecycle, construction, testing, maintenance, and professional practice baseline.
  - Verified: 2026-09-04; refresh after 180 days.

## Interpretation rules

- Prefer the primary official/spec/reference source over community conventions when they conflict.
- Resolve the actual product, language, runtime, provider, platform, protocol, or standard version before applying details that can drift.
- Treat examples as examples, not proof that the current repository/runtime behaves the same way.
- Preserve unknowns and source conflicts explicitly; do not merge incompatible guidance into a false universal rule.
- Keep operational checks in the real target environment whenever the claim depends on runtime behavior.
